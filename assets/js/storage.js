// Archivos temporales en el almacenamiento privado del navegador (OPFS).
// Cada pestaña usa su propia carpeta y la "reserva" con un Web Lock. Al cerrar la pestaña,
// un service worker (sw.js) borra su carpeta; si no se pudo, se borra la próxima vez que se
// abra la herramienta (las carpetas cuyo lock nadie tiene son de pestañas que ya no existen).

export const TMP_ROOT = 'dividir-pdf-tmp';
export const SESSION_DIR = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
const LOCK_PREFIX = 'dividir-pdf:';

export const opfsSupported = !!(navigator.storage && navigator.storage.getDirectory);

let cleaner = null; // registro del service worker que limpia al cerrar

async function tmpDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(TMP_ROOT, { create: true });
}

async function registerCleaner() {
  if (!('serviceWorker' in navigator)) return;
  try {
    cleaner = await navigator.serviceWorker.register(new URL('../../sw.js', import.meta.url));
  } catch {
    /* sin service worker (p. ej. ventana privada en Firefox): queda la limpieza al volver */
  }
}

export async function initStorage() {
  if (!opfsSupported) return;
  if (navigator.locks) {
    // La promesa nunca se resuelve: el lock dura lo que dure la pestaña.
    navigator.locks.request(LOCK_PREFIX + SESSION_DIR, () => new Promise(() => {})).catch(() => {});
  }
  registerCleaner();
  try {
    const dir = await tmpDir();
    const held = navigator.locks
      ? new Set(((await navigator.locks.query()).held || []).map((l) => l.name))
      : null;
    const now = Date.now();
    const stale = [];
    for await (const [name] of dir.entries()) {
      if (name === SESSION_DIR) continue;
      if (held) {
        if (held.has(LOCK_PREFIX + name)) continue;
      } else {
        // Sin Web Locks solo borramos lo que tenga más de un día.
        const created = parseInt(name.split('-')[1], 36);
        if (!(now - created > 864e5)) continue;
      }
      stale.push(name);
    }
    for (const name of stale) await dir.removeEntry(name, { recursive: true }).catch(() => {});
  } catch {
    /* OPFS no disponible (por ejemplo, ventana privada): se usará memoria */
  }
}

export async function removePack(packName) {
  if (!opfsSupported || !packName) return;
  try {
    const dir = await (await tmpDir()).getDirectoryHandle(SESSION_DIR);
    await dir.removeEntry(packName);
  } catch {
    /* puede estar en uso o no existir */
  }
}

export async function clearSession() {
  if (!opfsSupported) return;
  try {
    await (await tmpDir()).removeEntry(SESSION_DIR, { recursive: true });
  } catch {}
}

/** Al cerrar la pestaña: pedirle al service worker que borre esta sesión cuando ya no exista. */
export function releaseSession() {
  if (!opfsSupported) return;
  const sw = cleaner?.active || cleaner?.waiting || cleaner?.installing;
  sw?.postMessage({ type: 'cleanup', session: SESSION_DIR });
  clearSession(); // por las dudas; suele quedar cortado a mitad de camino
}

export async function freeSpace() {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    return quota - usage;
  } catch {
    return Infinity;
  }
}
