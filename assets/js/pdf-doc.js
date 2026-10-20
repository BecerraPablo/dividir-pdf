// Apertura de PDFs con PDF.js leyendo el archivo por rangos (nunca entero en memoria)
// y generación de miniaturas con cola, prioridades y caché limitada.
import * as pdfjs from '../../vendor/pdfjs/pdf.min.mjs';

const BASE = new URL('../../vendor/pdfjs/', import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', BASE).href;

// PDF.js guarda en memoria cada fragmento que lee y no los suelta hasta cerrar el documento.
// Con archivos enormes, después de leer esta cantidad se cierra y se vuelve a abrir.
const RECYCLE_AFTER_BYTES = 384 * 1024 * 1024;

let sharedWorker = null;
function pdfWorker() {
  if (!sharedWorker || sharedWorker.destroyed) sharedWorker = new pdfjs.PDFWorker({ name: 'pdfjs' });
  return sharedWorker;
}

class FileRangeTransport extends pdfjs.PDFDataRangeTransport {
  constructor(file, counter) {
    super(file.size, null);
    this.file = file;
    this.counter = counter;
    this.aborted = false;
  }
  requestDataRange(begin, end) {
    this.counter.bytes += end - begin;
    this.file.slice(begin, end).arrayBuffer().then(
      (buf) => { if (!this.aborted) this.onDataRange(begin, new Uint8Array(buf)); },
      (err) => console.error('No se pudo leer el archivo', err),
    );
  }
  abort() {
    this.aborted = true;
  }
}

export class PasswordCancelled extends Error {}

function friendlyError(err) {
  const name = err?.name || '';
  if (name === 'InvalidPDFException') return new Error('El archivo no es un PDF válido o está dañado.');
  if (name === 'PasswordException') return new Error('El PDF está protegido con contraseña.');
  if (name === 'MissingPDFException') return new Error('No se pudo leer el archivo.');
  return new Error(err?.message || String(err));
}

/** Un PDF abierto con PDF.js. Se puede "reciclar" para liberar memoria. */
export class PdfSource {
  constructor(file) {
    this.file = file;
    this.password = null;
    this.counter = { bytes: 0 };
    this.task = null;
    this.doc = null;
    this.numPages = 0;
    this.ready = Promise.resolve(); // se reemplaza mientras se recicla
    this.activeRenders = 0; // renders fuera de la cola de miniaturas (vista ampliada)
  }

  /** `askPassword(retry)` devuelve la contraseña o null para cancelar. */
  static async open(file, { askPassword } = {}) {
    const src = new PdfSource(file);
    await src.load(askPassword);
    return src;
  }

  async load(askPassword) {
    this.counter = { bytes: 0 };
    const task = pdfjs.getDocument({
      range: new FileRangeTransport(this.file, this.counter),
      worker: pdfWorker(),
      rangeChunkSize: 64 * 1024,
      disableAutoFetch: true,
      disableStream: true,
      password: this.password ?? undefined,
      cMapUrl: new URL('cmaps/', BASE).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', BASE).href,
      wasmUrl: new URL('wasm/', BASE).href,
      iccUrl: new URL('iccs/', BASE).href,
      enableXfa: false,
      verbosity: 0,
    });
    let cancelled = false;
    task.onPassword = async (update, reason) => {
      const retry = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
      const pw = askPassword ? await askPassword(retry) : null;
      if (pw == null) {
        cancelled = true;
        task.destroy();
        return;
      }
      this.password = pw;
      update(pw);
    };
    try {
      const doc = await task.promise;
      this.task = task;
      this.doc = doc;
      this.numPages = doc.numPages;
    } catch (err) {
      if (cancelled) throw new PasswordCancelled('Se canceló la contraseña');
      throw friendlyError(err);
    }
  }

  get needsRecycle() {
    return this.file.size > RECYCLE_AFTER_BYTES && this.counter.bytes > RECYCLE_AFTER_BYTES;
  }

  recycle() {
    const old = this.task;
    this.task = null;
    this.doc = null;
    this.ready = (async () => {
      await old?.destroy();
      await this.load(null);
    })();
    return this.ready;
  }

  destroy() {
    this.task?.destroy();
    this.task = null;
    this.doc = null;
  }
}

/** Abre, cuenta páginas, saca la miniatura de la primera página y cierra (para "Unir"). */
export async function probePdf(file, { askPassword, thumbWidth = 120 } = {}) {
  const src = await PdfSource.open(file, { askPassword });
  try {
    let thumb = null;
    try {
      const t = new Thumbnailer(src, { width: thumbWidth, maxCache: 1, concurrency: 1 });
      thumb = await t.render(1);
    } catch {
      /* la miniatura es opcional */
    }
    return { numPages: src.numPages, password: src.password, thumb };
  } finally {
    src.destroy();
  }
}

const canOffscreen = typeof OffscreenCanvas !== 'undefined' && 'convertToBlob' in OffscreenCanvas.prototype;

function makeCanvas(w, h) {
  if (canOffscreen) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasToBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), type, quality));
}

/** Renderiza una página dentro de un canvas visible (vista ampliada). */
export async function renderInto(source, n, canvas, maxW, maxH) {
  await source.ready; // si se está reabriendo el documento, esperar
  // Mientras haya un render acá, la cola de miniaturas no recicla el documento.
  source.activeRenders++;
  let page = null;
  let handedOff = false; // desde que existe la tarea, la libera su propia promesa
  try {
    page = await source.doc.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fit = Math.min(maxW / vp1.width, maxH / vp1.height);
    const vp = page.getViewport({ scale: fit * dpr });
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    canvas.style.width = `${Math.floor(vp1.width * fit)}px`;
    canvas.style.height = `${Math.floor(vp1.height * fit)}px`;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const task = page.render({ canvasContext: ctx, viewport: vp });
    handedOff = true;
    const rendered = page;
    return {
      promise: task.promise.finally(() => {
        rendered.cleanup();
        source.activeRenders--;
      }),
      cancel: () => task.cancel(),
    };
  } finally {
    if (!handedOff) {
      page?.cleanup();
      source.activeRenders--;
    }
  }
}

/**
 * Cola de miniaturas: renderiza a lo sumo `concurrency` a la vez, atiende primero lo pedido
 * más recientemente (lo que se está viendo) y descarta lo que dejó de estar visible.
 */
export class Thumbnailer {
  constructor(source, { width = 220, maxCache = 700, concurrency = 2 } = {}) {
    this.source = source;
    this.width = width;
    this.maxCache = maxCache;
    this.concurrency = concurrency;
    this.cache = new Map(); // n -> { url, w, h }
    this.pending = new Map(); // n -> { wanted, resolvers: [] }
    this.running = new Set();
    this.rendered = 0;
    this.lastCleanup = 0;
    this.busy = false; // limpiando o reabriendo el documento
    this.destroyed = false;
    this.onEvict = null;
  }

  cached(n) {
    const hit = this.cache.get(n);
    if (hit) {
      this.cache.delete(n);
      this.cache.set(n, hit);
    }
    return hit || null;
  }

  /** wanted() devuelve false si la miniatura ya no hace falta. */
  request(n, wanted = () => true) {
    const hit = this.cached(n);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      let p = this.pending.get(n);
      if (p) this.pending.delete(n); // reinsertar al final = más prioridad
      else p = { wanted, resolvers: [] };
      p.wanted = wanted;
      p.resolvers.push({ resolve, reject });
      this.pending.set(n, p);
      this.pump();
    });
  }

  /** ¿Toca liberar memoria? Cada 40 miniaturas se limpia; si ya se leyó mucho, se reabre. */
  maintenanceDue() {
    return this.source.needsRecycle || this.rendered - this.lastCleanup >= 40;
  }

  runMaintenance() {
    this.busy = true;
    const recycle = this.source.needsRecycle;
    const job = recycle ? this.source.recycle() : this.source.doc.cleanup();
    job
      .catch((e) => {
        if (recycle) console.error(e);
      })
      .finally(() => {
        this.busy = false;
        this.lastCleanup = this.rendered;
        this.pump();
      });
  }

  pump() {
    if (this.busy || this.destroyed) return;
    if (this.pending.size && this.maintenanceDue()) {
      // PDF.js no permite limpiar a mitad de un render: no se empiezan miniaturas nuevas y se
      // espera a que terminen las que están en curso (la última vuelve a llamar a pump()).
      if (this.running.size) return;
      if (this.source.activeRenders) {
        // la vista ampliada está dibujando: reintentar en un momento
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.pump(), 150);
        return;
      }
      this.runMaintenance();
      return;
    }
    while (this.running.size < this.concurrency && this.pending.size) {
      const entries = [...this.pending.entries()];
      let picked = null;
      for (let i = entries.length - 1; i >= 0; i--) {
        const [n, p] = entries[i];
        if (this.running.has(n)) continue;
        if (!p.wanted()) {
          this.pending.delete(n);
          p.resolvers.forEach((r) => r.reject(new DOMException('skip', 'AbortError')));
          continue;
        }
        picked = n;
        break;
      }
      if (picked == null) return;
      const p = this.pending.get(picked);
      this.pending.delete(picked);
      this.running.add(picked);
      this.render(picked)
        .then((res) => p.resolvers.forEach((r) => r.resolve(res)), (err) => p.resolvers.forEach((r) => r.reject(err)))
        .finally(() => {
          this.running.delete(picked);
          this.pump();
        });
    }
  }

  async render(n) {
    const page = await this.source.doc.getPage(n);
    try {
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(this.width / vp1.width, (this.width * 1.6) / vp1.height);
      const vp = page.getViewport({ scale });
      const w = Math.max(1, Math.round(vp.width));
      const h = Math.max(1, Math.round(vp.height));
      const canvas = makeCanvas(w, h);
      // Lienzo en CPU: se dibuja una vez y se lee para pasarlo a JPEG; evita subir cada
      // imagen de página a la GPU (con escaneos grandes eso acumula cientos de MB).
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.82);
      if (this.destroyed) throw new DOMException('destroyed', 'AbortError');
      const res = { url: URL.createObjectURL(blob), w, h };
      this.cache.set(n, res);
      this.rendered++;
      this.evict();
      return res;
    } finally {
      page.cleanup();
    }
  }

  evict() {
    while (this.cache.size > this.maxCache) {
      const [n, v] = this.cache.entries().next().value;
      this.cache.delete(n);
      this.onEvict?.(n, v.url);
      URL.revokeObjectURL(v.url);
    }
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.retryTimer);
    for (const p of this.pending.values()) p.resolvers.forEach((r) => r.reject(new DOMException('destroyed', 'AbortError')));
    this.pending.clear();
    for (const v of this.cache.values()) URL.revokeObjectURL(v.url);
    this.cache.clear();
  }
}
