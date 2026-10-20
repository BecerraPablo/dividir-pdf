// Utilidades para listas de páginas: "1-5, 8, 10-" <-> [1,2,3,4,5,8,10,...]

/**
 * Interpreta un texto de páginas. Acepta números, rangos "a-b" (también descendentes),
 * "a-" (hasta el final), "-b" (desde el principio) y la palabra "fin"/"z" para la última.
 * Devuelve { pages: number[], error: string|null }. Respeta el orden escrito.
 */
export function parsePages(text, max) {
  const pages = [];
  const src = String(text || '').trim();
  if (!src) return { pages, error: 'Escribí al menos una página.' };
  const parts = src.split(/[,;\s]+/).filter(Boolean);
  const num = (s) => {
    if (/^(fin|final|ultima|última|z)$/i.test(s)) return max;
    if (!/^\d+$/.test(s)) return NaN;
    return Number(s);
  };
  for (const part of parts) {
    const m = /^([^-–]*)[-–]([^-–]*)$/.exec(part);
    let a;
    let b;
    if (m) {
      a = m[1] === '' ? 1 : num(m[1]);
      b = m[2] === '' ? max : num(m[2]);
    } else {
      a = b = num(part);
    }
    if (!Number.isInteger(a) || !Number.isInteger(b)) return { pages: [], error: `No entiendo "${part}".` };
    if (a < 1 || b < 1 || a > max || b > max) return { pages: [], error: `"${part}" está fuera de rango (1–${max}).` };
    if (a <= b) for (let i = a; i <= b; i++) pages.push(i);
    else for (let i = a; i >= b; i--) pages.push(i);
  }
  return { pages, error: null };
}

/** [1,2,3,5,8,9] -> "1-3,5,8-9" (sin espacios: formato que entiende qpdf). Respeta el orden. */
export function toRangeString(pages, sep = ',') {
  const out = [];
  let i = 0;
  while (i < pages.length) {
    const start = pages[i];
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    if (j === i) {
      // también compacta tramos descendentes de 3 o más
      let k = i;
      while (k + 1 < pages.length && pages[k + 1] === pages[k] - 1) k++;
      if (k - i >= 2) {
        out.push(`${start}-${pages[k]}`);
        i = k + 1;
        continue;
      }
      out.push(String(start));
    } else {
      out.push(`${start}-${pages[j]}`);
    }
    i = j + 1;
  }
  return out.join(sep);
}

/** Texto amigable para mostrar: "1–3, 5, 8–9". */
export function prettyRanges(pages) {
  return toRangeString(pages, ', ').replace(/-/g, '–');
}

export function plural(n, one, many) {
  return `${n.toLocaleString('es-AR')} ${n === 1 ? one : many}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const digits = u === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${v.toLocaleString('es-AR', { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${units[u]}`;
}

/** Nombre de archivo seguro (sin caracteres prohibidos en Windows/macOS). */
export function safeFileName(name, fallback = 'documento') {
  let n = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim();
  n = n.replace(/^\.+/, '');
  if (!n) n = fallback;
  if (n.length > 150) n = n.slice(0, 150);
  return n;
}

export function ensurePdfExt(name) {
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

export function baseName(fileName) {
  return String(fileName || 'documento').replace(/\.pdf$/i, '');
}

/** Asegura nombres únicos agregando " (2)", " (3)"… */
export function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    const key = n.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (!count) return n;
    const dot = n.lastIndexOf('.');
    const candidate = dot > 0 ? `${n.slice(0, dot)} (${count + 1})${n.slice(dot)}` : `${n} (${count + 1})`;
    seen.set(candidate.toLowerCase(), 1);
    return candidate;
  });
}
