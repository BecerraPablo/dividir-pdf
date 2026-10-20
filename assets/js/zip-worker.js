// Worker (módulo) que arma un ZIP sin compresión y lo escribe en OPFS (o en memoria).
import { makeZip } from '../../vendor/client-zip/index.js';

const TMP_ROOT = 'dividir-pdf-tmp';

async function openSink(sessionDir, packName, preferMemory) {
  if (!preferMemory && self.navigator?.storage?.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      const tmp = await root.getDirectoryHandle(TMP_ROOT, { create: true });
      const dir = await tmp.getDirectoryHandle(sessionDir, { create: true });
      const fileHandle = await dir.getFileHandle(packName, { create: true });
      const handle = await fileHandle.createSyncAccessHandle();
      handle.truncate(0);
      let at = 0;
      return {
        write(chunk) {
          let off = 0;
          while (off < chunk.length) {
            const want = chunk.length - off;
            const n = handle.write(off ? chunk.subarray(off) : chunk, { at: at + off });
            // Sin cuota, Chrome puede devolver un valor absurdo en vez de lanzar error.
            if (!(n > 0 && n <= want)) throw new DOMException('Sin espacio', 'QuotaExceededError');
            off += n;
          }
          at += chunk.length;
        },
        async finish() {
          const size = handle.getSize();
          handle.flush();
          handle.close();
          const blob = await fileHandle.getFile();
          if (size !== at || blob.size !== at) throw new DOMException('ZIP incompleto', 'QuotaExceededError');
          return { blob, packName };
        },
        async discard() {
          try { handle.close(); } catch {}
          try { await dir.removeEntry(packName); } catch {}
        },
      };
    } catch {
      /* sigue en memoria */
    }
  }
  const chunks = [];
  return {
    write(chunk) { chunks.push(chunk); },
    async finish() { return { blob: new Blob(chunks, { type: 'application/zip' }), packName: null }; },
    async discard() { chunks.length = 0; },
  };
}

self.onmessage = async ({ data }) => {
  if (data?.type !== 'zip') return;
  const { id, files, sessionDir, packName, preferMemory } = data;
  let sink;
  try {
    sink = await openSink(sessionDir, packName, preferMemory);
    const total = files.reduce((s, f) => s + f.file.size, 0);
    let done = 0;
    let last = 0;
    const reader = makeZip(files.map((f) => ({ name: f.name, input: f.file, lastModified: new Date() }))).getReader();
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      sink.write(value);
      done += value.length;
      const now = Date.now();
      if (now - last > 150) {
        last = now;
        self.postMessage({ type: 'progress', id, done: Math.min(done, total), total });
      }
    }
    const result = await sink.finish();
    self.postMessage({ type: 'done', id, ...result });
  } catch (e) {
    await sink?.discard();
    const quota = e?.name === 'QuotaExceededError';
    self.postMessage({
      type: 'error',
      id,
      quota,
      message: quota ? 'No hay espacio suficiente en el almacenamiento del navegador para el ZIP.' : String(e?.message || e),
    });
  }
};
