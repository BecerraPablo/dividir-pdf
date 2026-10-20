/*
 * Service worker mínimo. No intercepta pedidos (no tiene "fetch") ni guarda nada en caché:
 * solo borra los archivos temporales de una pestaña que se cerró.
 *
 * La pestaña no puede borrarlos sola al cerrarse: el navegador corta las tareas asíncronas
 * que quedan pendientes en "pagehide". Este worker sigue vivo unos segundos más, espera a
 * que la pestaña libere su Web Lock (señal de que ya no existe) y recién ahí borra su carpeta.
 */
const TMP_ROOT = 'dividir-pdf-tmp';
const LOCK_PREFIX = 'dividir-pdf:';
const SESSION_RE = /^s-[a-z0-9]+-[a-z0-9]+$/;

self.addEventListener('install', () => self.skipWaiting());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Borra la carpeta si ninguna pestaña la tiene tomada. Devuelve false si sigue en uso. */
async function removeIfFree(dir, name) {
  if (!self.navigator.locks) {
    await dir.removeEntry(name, { recursive: true }).catch(() => {});
    return true;
  }
  return self.navigator.locks.request(LOCK_PREFIX + name, { ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await dir.removeEntry(name, { recursive: true }).catch(() => {});
    return true;
  });
}

async function cleanup(session) {
  let dir;
  try {
    const root = await self.navigator.storage.getDirectory();
    dir = await root.getDirectoryHandle(TMP_ROOT);
  } catch {
    return; // no hay nada que borrar
  }
  if (session && SESSION_RE.test(session)) {
    // La pestaña que avisó todavía puede estar cerrándose: reintentar unos segundos.
    for (let i = 0; i < 40; i++) {
      if (await removeIfFree(dir, session)) break;
      await sleep(250);
    }
  }
  // De paso, lo que hayan dejado otras pestañas que ya no existen.
  const others = [];
  for await (const [name] of dir.entries()) {
    if (name !== session && SESSION_RE.test(name)) others.push(name);
  }
  for (const name of others) await removeIfFree(dir, name);
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'cleanup') event.waitUntil(cleanup(event.data.session).catch(() => {}));
});
