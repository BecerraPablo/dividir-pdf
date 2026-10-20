// Piezas de interfaz compartidas: avisos, diálogos, progreso, descargas y lista de resultados.
import { formatBytes, plural } from './pages.js';
import { makeZipFile } from './jobs.js';
import { removePack } from './storage.js';

export const $ = (sel, root = document) => root.querySelector(sel);

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Crea un elemento: el('button', { class: 'btn', onclick }, 'Texto', otroNodo) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/* ------------------------------------------------------------------ avisos */

export function toast(message, { type = 'info', timeout = 7000 } = {}) {
  const box = $('#toasts');
  const close = el('button', { 'aria-label': 'Cerrar aviso' }, '×');
  const t = el('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, el('p', {}, message), close);
  const remove = () => t.remove();
  close.addEventListener('click', remove);
  box.append(t);
  if (timeout) setTimeout(remove, timeout);
  return remove;
}

/* ------------------------------------------------------------------ diálogos */

export function confirmDialog({ title, text, ok = 'Aceptar' }) {
  const dlg = $('#confirm-dlg');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text || '';
  $('#confirm-ok').textContent = ok;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

export function askPassword({ fileName, retry }) {
  const dlg = $('#password-dlg');
  const input = $('#password-input');
  $('#password-title').textContent = retry ? 'Contraseña incorrecta' : 'PDF protegido';
  $('#password-text').textContent = retry
    ? `Probá de nuevo con la contraseña de “${fileName}”.`
    : `“${fileName}” pide contraseña para abrirlo.`;
  input.value = '';
  dlg.returnValue = '';
  dlg.showModal();
  input.focus();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? input.value : null), { once: true });
  });
}

/* ------------------------------------------------------------------ progreso */

class ProgressDialog {
  constructor() {
    this.dlg = $('#progress-dlg');
    this.bar = $('#progress-bar');
    this.fill = this.bar.firstElementChild;
    this.controller = null;
    $('#progress-cancel').addEventListener('click', () => this.controller?.abort());
    // Esc no cierra el diálogo: hay que usar "Cancelar".
    this.dlg.addEventListener('cancel', (e) => e.preventDefault());
  }

  open(title, text = '') {
    this.controller = new AbortController();
    $('#progress-title').textContent = title;
    $('#progress-text').textContent = text;
    $('#progress-step').textContent = '';
    $('#progress-pct').textContent = '';
    this.set(null);
    if (!this.dlg.open) this.dlg.showModal();
    return this.controller.signal;
  }

  step(text) {
    $('#progress-step').textContent = text;
  }

  /** fraction entre 0 y 1, o null para indeterminado */
  set(fraction) {
    if (fraction == null || !Number.isFinite(fraction)) {
      this.bar.classList.add('indeterminate');
      this.fill.style.width = '';
      $('#progress-pct').textContent = '';
      return;
    }
    const f = Math.max(0, Math.min(1, fraction));
    this.bar.classList.remove('indeterminate');
    this.fill.style.width = `${(f * 100).toFixed(1)}%`;
    $('#progress-pct').textContent = `${Math.floor(f * 100)} %`;
  }

  close() {
    this.controller = null;
    if (this.dlg.open) this.dlg.close();
  }
}

let progressSingleton = null;
export function progress() {
  progressSingleton ??= new ProgressDialog();
  return progressSingleton;
}

export function isAbort(err) {
  return err?.name === 'AbortError';
}

/* ------------------------------------------------------------------ archivos */

export function isPdfFile(file) {
  return file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
}

const liveUrls = new Map(); // File -> url

function urlFor(file) {
  let url = liveUrls.get(file);
  if (!url) {
    url = URL.createObjectURL(file);
    liveUrls.set(file, url);
  }
  return url;
}

export function releaseUrl(file) {
  const url = liveUrls.get(file);
  if (url) {
    URL.revokeObjectURL(url);
    liveUrls.delete(file);
  }
}

export function downloadFile(file) {
  const a = el('a', { href: urlFor(file), download: file.name, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
}

export function openFile(file) {
  window.open(urlFor(file), '_blank', 'noopener');
}

/* ------------------------------------------------------------------ resultados */

const MAX_LISTED = 150;

/** Lista de archivos generados, agrupados por tanda. Vive dentro del panel lateral. */
export class ResultsPanel {
  constructor(container, { zipName }) {
    this.container = container;
    this.zipName = zipName;
    this.groups = [];
  }

  add({ files, warnings = [], storage = 'opfs', packs = [], title }) {
    const group = { id: Date.now() + Math.random(), files, warnings, storage, packs, title, zip: null };
    this.groups.unshift(group);
    this.render();
    this.container.querySelector('.results')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return group;
  }

  async remove(group) {
    this.groups = this.groups.filter((g) => g !== group);
    for (const f of group.files) releaseUrl(f);
    if (group.zip) releaseUrl(group.zip.file);
    this.render();
    // Esperar un poco por si hay una descarga en curso leyendo el archivo.
    setTimeout(() => {
      for (const p of group.packs) removePack(p);
      if (group.zip?.packName) removePack(group.zip.packName);
    }, 20000);
  }

  async downloadZip(group, button) {
    if (group.zip) {
      downloadFile(group.zip.file);
      return;
    }
    const prog = progress();
    const signal = prog.open('Armando el ZIP', plural(group.files.length, 'archivo', 'archivos'));
    try {
      const zip = await makeZipFile(group.files, this.zipName(group), {
        signal,
        onProgress: (done, total) => prog.set(total ? done / total : null),
      });
      group.zip = zip;
      prog.close();
      downloadFile(zip.file);
      if (button) button.lastChild.textContent = 'Descargar ZIP';
    } catch (err) {
      prog.close();
      if (!isAbort(err)) toast(`No se pudo armar el ZIP: ${err.message}`, { type: 'error' });
    }
  }

  async downloadEach(group) {
    for (const f of group.files) {
      downloadFile(f);
      await new Promise((r) => setTimeout(r, 450));
    }
  }

  render() {
    this.container.replaceChildren(...this.groups.map((g) => this.renderGroup(g)));
  }

  renderGroup(group) {
    const total = group.files.reduce((s, f) => s + f.size, 0);
    const many = group.files.length > 1;
    const head = el('div', { class: 'results-head' },
      el('h3', {}, group.title || (many ? `Listo: ${plural(group.files.length, 'archivo', 'archivos')}` : 'Listo')),
      el('button', { class: 'link', onclick: () => this.remove(group) }, 'Borrar'));

    const actions = el('div', { class: 'results-actions' });
    if (many) {
      const zipBtn = el('button', { class: 'btn primary', onclick: (e) => this.downloadZip(group, e.currentTarget) },
        icon('download'), group.zip ? 'Descargar ZIP' : `Descargar todo en ZIP (${formatBytes(total)})`);
      actions.append(zipBtn);
      if (group.files.length <= 20) {
        actions.append(el('button', { class: 'btn', onclick: () => this.downloadEach(group) }, 'Descargar uno por uno'));
      }
    } else {
      const f = group.files[0];
      actions.append(el('button', { class: 'btn primary', onclick: () => downloadFile(f) }, icon('download'), `Descargar (${formatBytes(f.size)})`));
    }

    const list = el('ul', { class: 'results-list' });
    group.files.slice(0, MAX_LISTED).forEach((f) => {
      list.append(el('li', { class: 'result' },
        el('span', { class: 'r-name', title: f.name }, f.name),
        el('span', { class: 'r-size' }, formatBytes(f.size)),
        el('button', { class: 'icon-btn', 'aria-label': `Ver ${f.name}`, title: 'Ver', onclick: () => openFile(f) }, icon('eye')),
        el('button', { class: 'icon-btn', 'aria-label': `Descargar ${f.name}`, title: 'Descargar', onclick: () => downloadFile(f) }, icon('download'))));
    });

    const section = el('section', { class: 'results', 'aria-label': 'Archivos generados' }, head, actions, list);
    if (group.files.length > MAX_LISTED) {
      section.append(el('p', { class: 'results-more' }, `…y ${plural(group.files.length - MAX_LISTED, 'archivo más', 'archivos más')} (están todos en el ZIP).`));
    }
    if (group.storage === 'memory') {
      section.append(el('p', { class: 'notice' }, 'Quedaron en memoria (¿ventana privada?): descargalos y tocá “Borrar”.'));
    }
    if (group.warnings.length) {
      section.append(el('p', { class: 'notice' }, `qpdf avisó: ${group.warnings.slice(0, 3).join(' / ')}`));
    }
    return section;
  }
}
