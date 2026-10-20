/*
 * Worker clásico que ejecuta qpdf (WebAssembly) sobre los PDF elegidos por el usuario.
 *
 * Cómo maneja archivos de varios GB sin cargarlos en memoria:
 *  - Entrada: los File se montan con WORKERFS a través de un "blob perezoso". qpdf solo lee
 *    lo que necesita, en bloques de 16 MiB con una pequeña caché LRU.
 *  - Salida: cada PDF que escribe qpdf va a un "dispositivo" cuyo contenido se vuelca de
 *    corrido a un archivo del almacenamiento privado del navegador (OPFS). Si OPFS no está
 *    disponible (o se queda sin cuota) se usa memoria como respaldo.
 *  - Varias salidas de una misma corrida (--split-pages) se guardan una detrás de otra en un
 *    único archivo; el hilo principal las separa con Blob.slice, sin copiar datos.
 */
'use strict';

importScripts('../../vendor/qpdf/qpdf.js');
const createQpdf = self.Module;
const WASM_URL = new URL('../../vendor/qpdf/qpdf.wasm', self.location.href).href;
const TMP_ROOT = 'dividir-pdf-tmp';

/* ------------------------------------------------------------------ entrada perezosa */

const NativeFileReaderSync = self.FileReaderSync;
// Cada lectura síncrona tiene un costo fijo (~1-2 ms) y qpdf suele recorrer el archivo de
// punta a punta para armar la lista de páginas: conviene leer bloques grandes.
const BLOCK = 16 * 1024 * 1024;
const MAX_BLOCKS = 6;

class LazySlice {
  constructor(src, start, end) {
    this.src = src;
    this.start = start;
    this.end = end;
    this.size = end - start;
  }
}

class LazyBlob {
  constructor(file) {
    this.file = file;
    this.size = file.size;
    this.blocks = new Map();
  }

  slice(start = 0, end = this.size) {
    const s = Math.max(0, Math.min(start, this.size));
    const e = Math.max(s, Math.min(end, this.size));
    return new LazySlice(this, s, e);
  }

  block(reader, index) {
    let data = this.blocks.get(index);
    if (data) {
      this.blocks.delete(index);
      this.blocks.set(index, data);
      return data;
    }
    const start = index * BLOCK;
    data = new Uint8Array(reader.readAsArrayBuffer(this.file.slice(start, Math.min(this.size, start + BLOCK))));
    this.blocks.set(index, data);
    if (this.blocks.size > MAX_BLOCKS) this.blocks.delete(this.blocks.keys().next().value);
    return data;
  }

  read(reader, start, end) {
    const length = end - start;
    if (length <= 0) return new ArrayBuffer(0);
    if (length >= BLOCK) return reader.readAsArrayBuffer(this.file.slice(start, end));
    const out = new Uint8Array(length);
    let pos = start;
    while (pos < end) {
      const index = Math.floor(pos / BLOCK);
      const data = this.block(reader, index);
      const from = pos - index * BLOCK;
      const n = Math.min(end - pos, data.length - from);
      if (n <= 0) break; // el archivo cambió mientras se leía
      out.set(data.subarray(from, from + n), pos - start);
      pos += n;
    }
    return out.buffer;
  }
}

// WORKERFS crea su lector con `new FileReaderSync()`. Lo reemplazamos por uno que entiende
// los LazySlice y delega todo lo demás al lector nativo.
self.FileReaderSync = class FileReaderSync {
  constructor() {
    this.native = new NativeFileReaderSync();
  }
  readAsArrayBuffer(blob) {
    return blob instanceof LazySlice ? blob.src.read(this.native, blob.start, blob.end) : this.native.readAsArrayBuffer(blob);
  }
  readAsText(blob, encoding) {
    return this.native.readAsText(blob instanceof LazySlice ? blob.src.file.slice(blob.start, blob.end) : blob, encoding);
  }
};

/* ------------------------------------------------------------------ salida */

function quotaError(message) {
  const e = new Error(message || 'No hay espacio suficiente en el almacenamiento del navegador.');
  e.quota = true;
  return e;
}

class PackSink {
  constructor() {
    this.pos = 0; // bytes recibidos
    this.written = 0; // bytes ya volcados al destino
    this.stage = new Uint8Array(8 * 1024 * 1024);
    this.stageLen = 0;
    this.segments = [];
    this.current = null;
    this.chunks = null; // modo memoria
    this.opfs = null; // { dir, name, handle, fileHandle }
    this.failure = null;
  }

  async open(sessionDir, packName, preferMemory) {
    if (!preferMemory && self.navigator?.storage?.getDirectory) {
      try {
        const root = await navigator.storage.getDirectory();
        const tmp = await root.getDirectoryHandle(TMP_ROOT, { create: true });
        const dir = await tmp.getDirectoryHandle(sessionDir, { create: true });
        const fileHandle = await dir.getFileHandle(packName, { create: true });
        const handle = await fileHandle.createSyncAccessHandle();
        handle.truncate(0);
        this.opfs = { dir, name: packName, handle, fileHandle };
        return 'opfs';
      } catch {
        this.opfs = null;
      }
    }
    this.chunks = [];
    return 'memory';
  }

  begin(name) {
    if (this.current) this.end();
    this.current = { name, start: this.pos };
  }

  end() {
    if (!this.current) return;
    this.current.end = this.pos;
    if (this.current.end > this.current.start) this.segments.push(this.current);
    this.current = null;
  }

  bulk(heap, offset, length) {
    if (length <= 0) return;
    const src = new Uint8Array(heap.buffer, heap.byteOffset + offset, length);
    if (length > this.stage.length / 2) {
      this.flushStage();
      this.emit(src, false);
    } else {
      if (this.stageLen + length > this.stage.length) this.flushStage();
      this.stage.set(src, this.stageLen);
      this.stageLen += length;
    }
    this.pos += length;
  }

  flushStage() {
    if (!this.stageLen) return;
    this.emit(this.stage.subarray(0, this.stageLen), true);
    this.stageLen = 0;
  }

  emit(data, isStage) {
    try {
      if (this.opfs) {
        let off = 0;
        while (off < data.length) {
          const want = data.length - off;
          const n = this.opfs.handle.write(off ? data.subarray(off) : data, { at: this.written + off });
          // Al quedarse sin cuota, Chrome puede devolver un valor absurdo en vez de lanzar error.
          if (!(n > 0 && n <= want)) throw new DOMException('Sin espacio en OPFS', 'QuotaExceededError');
          off += n;
        }
      } else {
        // Hay que copiar: `data` apunta a la memoria de qpdf o al búfer intermedio.
        this.chunks.push(isStage ? data.slice() : new Uint8Array(data));
      }
    } catch (e) {
      // qpdf solo ve un error de E/S genérico; guardamos la causa real para informarla.
      this.failure ??= e;
      throw e;
    }
    this.written += data.length;
  }

  async finish() {
    this.end();
    this.flushStage();
    if (this.opfs) {
      const size = this.opfs.handle.getSize();
      this.opfs.handle.flush();
      this.opfs.handle.close();
      const file = await this.opfs.fileHandle.getFile();
      if (size !== this.written || file.size !== this.written) {
        await this.discard();
        throw quotaError(`El archivo temporal quedó incompleto (${file.size} de ${this.written} bytes).`);
      }
      return { blob: file, storage: 'opfs', packName: this.opfs.name };
    }
    const blob = new Blob(this.chunks, { type: 'application/pdf' });
    this.chunks = null;
    return { blob, storage: 'memory', packName: null };
  }

  async discard() {
    if (this.opfs) {
      try { this.opfs.handle.close(); } catch {}
      try { await this.opfs.dir.removeEntry(this.opfs.name); } catch {}
      this.opfs = null;
    }
    this.chunks = null;
  }
}

/* ------------------------------------------------------------------ texto de qpdf */

class LineCollector {
  constructor(onLine) {
    this.bytes = [];
    this.onLine = onLine;
    this.decoder = new TextDecoder();
  }
  byte(b) {
    const v = b & 255;
    if (v === 10) this.flush();
    else if (this.bytes.length < 4000) this.bytes.push(v);
  }
  flush() {
    if (!this.bytes.length) return;
    const line = this.decoder.decode(new Uint8Array(this.bytes));
    this.bytes = [];
    this.onLine(line);
  }
}

const TRANSLATIONS = [
  [/invalid password/i, 'contraseña incorrecta'],
  [/can't find PDF header|not a PDF file/i, 'no es un PDF válido'],
  [/unable to find trailer dictionary while recovering damaged file/i, 'el archivo está dañado y no se pudo reparar'],
  [/file is damaged/i, 'el archivo está dañado'],
  [/^WARNING:\s*/i, 'Aviso: '],
];

function cleanMessage(line) {
  let msg = line
    .replace(/^[^:]*this\.program:\s*/, '')
    .replace(/\/in\/f(\d+)\.pdf/g, (m, i) => `archivo ${Number(i) + 1}`)
    .replace(/\/out\/[^:\s]+/g, 'salida')
    .trim();
  for (const [re, es] of TRANSLATIONS) msg = msg.replace(re, es);
  return msg;
}

/* ------------------------------------------------------------------ trabajos */

function splitOutputNames(count, groupSize) {
  // Replica el nombre que qpdf usa con --split-pages y el patrón "o-%d.pdf":
  // números con ceros a la izquierda según la cantidad total de páginas.
  const pad = String(count).length;
  const names = [];
  for (let first = 1; first <= count; first += groupSize) {
    const last = Math.min(count, first + groupSize - 1);
    let range = String(first).padStart(pad, '0');
    if (groupSize > 1) range += '-' + String(last).padStart(pad, '0');
    names.push(`o-${range}.pdf`);
  }
  return names;
}

async function runJob(job) {
  const { id, inputs, pages, split = 0, count = 0, outputs, trimResources, sessionDir, packName, preferMemory } = job;
  const names = split > 0 ? splitOutputNames(count, split) : ['o.pdf'];
  if (names.length !== outputs.length) throw new Error('Cantidad de salidas inconsistente.');

  const sink = new PackSink();
  await sink.open(sessionDir, packName, preferMemory);
  const messages = [];
  let lastPercent = -1;

  const onLine = (line) => {
    const m = /write progress: (\d+)%/.exec(line);
    if (m) {
      const p = Number(m[1]);
      if (!split && p !== lastPercent) {
        lastPercent = p;
        self.postMessage({ type: 'progress', id, done: p, total: 100 });
      }
      return;
    }
    if (line.trim()) messages.push(cleanMessage(line));
  };
  const out = new LineCollector(onLine);
  const err = new LineCollector(onLine);

  let qpdf;
  try {
    qpdf = await createQpdf({
      locateFile: () => WASM_URL,
      noInitialRun: true,
      preRun: [(m) => m.FS.init(null, (b) => out.byte(b), (b) => err.byte(b))],
    });
  } catch (e) {
    await sink.discard();
    throw new Error('No se pudo iniciar el motor PDF (qpdf): ' + (e?.message || e));
  }

  const FS = qpdf.FS;
  FS.mkdir('/in');
  FS.mount(qpdf.WORKERFS, { blobs: inputs.map((inp, i) => ({ name: `f${i}.pdf`, data: new LazyBlob(inp.file) })) }, '/in');
  FS.mkdir('/out');

  let finished = 0;
  names.forEach((devName, i) => {
    const writer = () => {
      throw new Error('escritura byte a byte no esperada');
    };
    writer.bulk = (heap, off, len) => sink.bulk(heap, off, len);
    writer.onopen = (stream) => {
      if ((stream.flags & 3) !== 0) sink.begin(outputs[i].name);
    };
    writer.onclose = (stream) => {
      if ((stream.flags & 3) === 0) return;
      sink.end();
      finished++;
      if (split) self.postMessage({ type: 'progress', id, done: finished, total: names.length });
    };
    // El lector nunca se usa, pero el dispositivo tiene que ser legible: qpdf abre con "wb+".
    FS.createDevice('/out', devName, () => null, writer);
  });

  const args = [
    '--empty',
    '--warning-exit-0',
    '--progress',
    '--stream-data=preserve', // copia los streams tal cual: rápido y sin pérdida
    '--object-streams=generate', // comprime los objetos pequeños
    `--remove-unreferenced-resources=${trimResources ? 'yes' : 'no'}`,
    '--pages',
  ];
  for (const p of pages) {
    args.push(`/in/f${p.input}.pdf`);
    const pw = inputs[p.input].password;
    if (pw) args.push(`--password=${pw}`);
    args.push(p.range);
  }
  args.push('--');
  if (split > 0) args.push(`--split-pages=${split}`, '/out/o-%d.pdf');
  else args.push('/out/o.pdf');

  let rc;
  let thrown = null;
  try {
    rc = qpdf.callMain(args);
  } catch (e) {
    if (e && e.name === 'ExitStatus') rc = e.status;
    else thrown = e;
  }
  out.flush();
  err.flush();

  const failure = sink.failure || thrown;
  if (failure) {
    await sink.discard();
    const quota = failure?.name === 'QuotaExceededError' || /quota/i.test(String(failure?.message));
    if (quota) throw quotaError();
    throw new Error('qpdf falló: ' + (failure?.message || failure));
  }
  if (rc !== 0) {
    await sink.discard();
    const detail = messages.filter((m) => !/operation succeeded/.test(m)).slice(-4).join('\n');
    const e = new Error(detail || `qpdf terminó con código ${rc}`);
    e.password = /contraseña incorrecta|invalid password/i.test(detail);
    throw e;
  }

  const result = await sink.finish();
  if (sink.segments.length !== outputs.length) {
    throw new Error(`Se esperaban ${outputs.length} archivos de salida y se generaron ${sink.segments.length}.`);
  }
  const warnings = messages.filter((m) => /^aviso|warning|dañado/i.test(m) && !/operation succeeded/i.test(m));
  return { ...result, segments: sink.segments, warnings };
}

self.onmessage = async (event) => {
  const job = event.data;
  if (job?.type !== 'run') return;
  try {
    const result = await runJob(job);
    self.postMessage({ type: 'done', id: job.id, ...result });
  } catch (e) {
    self.postMessage({ type: 'error', id: job.id, message: String(e?.message || e), quota: !!e?.quota, password: !!e?.password });
  }
};
