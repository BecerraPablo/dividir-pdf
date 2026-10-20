// Ejecuta trabajos de qpdf y de ZIP en Web Workers y devuelve File listos para descargar.
import { SESSION_DIR, removePack } from './storage.js';

let seq = 0;
const PDF = 'application/pdf';

function abortError() {
  return new DOMException('Cancelado', 'AbortError');
}

function packName(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${++seq}.bin`;
}

/**
 * Corre un worker para un único trabajo y lo termina al final (así se libera toda la memoria).
 * `onDone(data)` transforma el mensaje 'done' del worker en el resultado.
 */
function runWorker(url, options, message, { onProgress, signal, onDone }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const worker = new Worker(url, options);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      finish(reject, abortError());
      // El worker ya no existe; damos un momento a que se libere el archivo antes de borrarlo.
      setTimeout(() => removePack(message.packName), 1500);
    };
    signal?.addEventListener('abort', onAbort);
    worker.onmessage = ({ data }) => {
      if (data.id !== message.id) return;
      if (data.type === 'progress') onProgress?.(data.done, data.total);
      else if (data.type === 'done') finish(resolve, onDone(data));
      else if (data.type === 'error') {
        const err = new Error(data.message);
        err.quota = !!data.quota;
        err.password = !!data.password;
        finish(reject, err);
      }
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      finish(reject, new Error(e.message
        ? `El proceso se detuvo inesperadamente: ${e.message}`
        : 'El proceso se detuvo inesperadamente. Puede que el navegador se haya quedado sin memoria.'));
    };
    worker.postMessage(message);
  });
}

/**
 * spec = {
 *   inputs:  [{ file: File, password?: string }],
 *   pages:   [{ input: number, range: "1-5,8" }],   // en orden de salida
 *   outputs: [{ name: "salida.pdf" }],              // una o varias (si split > 0)
 *   split:   0 | n,  count: páginas totales seleccionadas (solo si split > 0)
 *   trimResources: quitar recursos no usados de cada página (para extracciones parciales)
 * }
 * Devuelve { files: File[], warnings: string[], storage: 'opfs'|'memory', packName }
 */
export async function runQpdf(spec, opts = {}) {
  try {
    return await runQpdfOnce(spec, opts, false);
  } catch (err) {
    // Sin espacio en OPFS (por ejemplo en una ventana privada): reintentar en memoria.
    if (err.quota && !opts.signal?.aborted) return runQpdfOnce(spec, opts, true);
    throw err;
  }
}

function runQpdfOnce(spec, opts, preferMemory) {
  const message = {
    type: 'run',
    id: ++seq,
    inputs: spec.inputs.map((i) => ({ file: i.file, password: i.password || null })),
    pages: spec.pages,
    outputs: spec.outputs,
    split: spec.split || 0,
    count: spec.count || 0,
    trimResources: !!spec.trimResources,
    rotations: spec.rotations || [],
    sessionDir: SESSION_DIR,
    packName: packName('pdf'),
    preferMemory,
  };
  return runWorker(new URL('./qpdf-worker.js', import.meta.url), { name: 'qpdf' }, message, {
    ...opts,
    onDone: (data) => ({
      files: data.segments.map((s) => new File([data.blob.slice(s.start, s.end)], s.name, { type: PDF })),
      warnings: data.warnings || [],
      storage: data.storage,
      packName: data.packName,
    }),
  });
}

/** Empaqueta archivos en un ZIP (sin compresión: los PDF ya vienen comprimidos). */
export async function makeZipFile(files, zipName, opts = {}) {
  const once = (preferMemory) => runWorker(
    new URL('./zip-worker.js', import.meta.url),
    { type: 'module', name: 'zip' },
    {
      type: 'zip',
      id: ++seq,
      files: files.map((f) => ({ name: f.name, file: f })),
      sessionDir: SESSION_DIR,
      packName: packName('zip'),
      preferMemory,
    },
    {
      ...opts,
      onDone: (data) => ({ file: new File([data.blob], zipName, { type: 'application/zip' }), packName: data.packName }),
    },
  );
  try {
    return await once(false);
  } catch (err) {
    if (err.quota && !opts.signal?.aborted) return once(true);
    throw err;
  }
}
