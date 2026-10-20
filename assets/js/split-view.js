// Vista "Dividir": miniaturas, selección, partes y generación de los archivos.
import { PdfSource, Thumbnailer, renderInto, PasswordCancelled } from './pdf-doc.js';
import { runQpdf } from './jobs.js';
import {
  parsePages, toRangeString, prettyRanges, plural, formatBytes, safeFileName, ensurePdfExt, baseName, uniqueNames,
} from './pages.js';
import {
  $, el, icon, toast, confirmDialog, askPassword, progress, isAbort, isPdfFile, downloadFile, ResultsPanel,
} from './ui.js';

const PART_VARS = ['--p1', '--p2', '--p3', '--p4', '--p5', '--p6', '--p7', '--p8'];
const DARK_TEXT_PARTS = new Set([2]); // el amarillo necesita texto oscuro
const BOX_RATIO = 1 / 1.414; // proporción de la caja de cada miniatura (A4 vertical)
const THUMB_RENDER_WIDTH = 300;

const S = {
  file: null,
  source: null,
  thumbs: null,
  numPages: 0,
  base: '',
  cells: [], // índice = número de página
  visible: new Set(),
  observer: null,
  selected: new Set(),
  rot: new Map(), // página -> giro extra (90, 180 o 270)
  anchor: null,
  focus: 1,
  mode: 'parts',
  parts: [],
  nextPartId: 1,
  everyN: 10,
  tagTimer: 0,
  loadToken: 0,
};

let results;
let viewerPage = 0;
let viewerTask = null;
let viewerSeq = 0;

const view = () => $('#view-split');
const pagesEl = () => $('#split-pages');

function partColor(i) {
  return `var(${PART_VARS[i % PART_VARS.length]})`;
}

/* ================================================================== carga del archivo */

function hasWork() {
  return S.parts.length > 0 || S.selected.size > 0;
}

export async function loadSplitFile(file) {
  if (!isPdfFile(file)) {
    toast(`“${file.name}” no parece un PDF.`, { type: 'error' });
    return;
  }
  if (S.source && hasWork()) {
    const ok = await confirmDialog({
      title: 'Abrir otro PDF',
      text: 'Se van a descartar las partes y la selección actuales. Los archivos ya generados se mantienen.',
      ok: 'Abrir el nuevo',
    });
    if (!ok) return;
  }
  teardown();
  const token = ++S.loadToken;
  showState('loading');
  $('#split-loading-text').textContent = `Abriendo “${file.name}”…`;
  try {
    const source = await PdfSource.open(file, { askPassword: (retry) => askPassword({ fileName: file.name, retry }) });
    if (token !== S.loadToken) {
      // Mientras se abría, se eligió otro archivo.
      source.destroy();
      return;
    }
    S.file = file;
    S.source = source;
    S.numPages = source.numPages;
    S.base = safeFileName(baseName(file.name));
    S.thumbs = new Thumbnailer(source, { width: THUMB_RENDER_WIDTH });
    S.thumbs.onEvict = onEvict;
    let ratio = BOX_RATIO;
    try {
      const first = await source.doc.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      ratio = vp.width / vp.height;
    } catch {}
    buildGrid(ratio);
    showState('ready');
    $('#split-name').textContent = file.name;
    $('#split-name').title = file.name;
    $('#split-meta').replaceChildren(el('span', {}, formatBytes(file.size)), el('span', {}, plural(S.numPages, 'página', 'páginas')));
    $('#goto').max = String(S.numPages);
    $('#every-n').max = String(S.numPages);
    if (!(S.everyN <= S.numPages)) {
      S.everyN = Math.min(10, S.numPages);
      $('#every-n').value = String(S.everyN);
    }
    renderParts();
    updateAll();
  } catch (err) {
    if (token !== S.loadToken) return;
    teardown();
    showState('empty');
    if (!(err instanceof PasswordCancelled)) toast(`No se pudo abrir “${file.name}”: ${err.message}`, { type: 'error' });
  }
}

function teardown() {
  S.observer?.disconnect();
  S.observer = null;
  S.thumbs?.destroy();
  S.thumbs = null;
  S.source?.destroy();
  S.source = null;
  S.file = null;
  S.numPages = 0;
  S.cells = [];
  S.visible.clear();
  S.selected.clear();
  S.rot.clear();
  S.anchor = null;
  S.focus = 1;
  S.parts = [];
  pagesEl().replaceChildren();
  updateSelection();
}

function showState(state) {
  const v = view();
  v.classList.toggle('is-empty', state !== 'ready');
  $('#split-drop').hidden = state !== 'empty';
  $('#split-loading').hidden = state !== 'loading';
  pagesEl().hidden = state !== 'ready';
  $('#split-toolbar').hidden = state !== 'ready';
}

/* ================================================================== grilla de miniaturas */

function makeTemplate() {
  const tpl = el('div', { class: 'pg', role: 'option', 'aria-selected': 'false', tabindex: '-1' },
    el('div', { class: 'pg-box' },
      el('div', { class: 'sheet-wrap' },
        el('div', { class: 'sheet' }, el('span', { class: 'ph' }), el('span', { class: 'partbar' })),
        el('span', { class: 'crop', 'aria-hidden': 'true' }),
        el('button', { class: 'pg-zoom', tabindex: '-1' }, icon('zoom')))),
    el('div', { class: 'pg-foot' }, el('span', { class: 'pg-num' }), el('span', { class: 'tags' })));
  return tpl;
}

function buildGrid(ratio) {
  const grid = pagesEl();
  grid.style.setProperty('--ar', String(ratio));
  grid.classList.toggle('tall', ratio <= BOX_RATIO);
  const tpl = makeTemplate();
  const frag = document.createDocumentFragment();
  S.cells = new Array(S.numPages + 1);
  for (let n = 1; n <= S.numPages; n++) {
    const c = tpl.cloneNode(true);
    c.dataset.n = n;
    c.id = `pg-${n}`;
    c.setAttribute('aria-label', `Página ${n}`);
    c.querySelector('.ph').textContent = n;
    c.querySelector('.pg-num').textContent = n;
    c.querySelector('.pg-zoom').setAttribute('aria-label', `Ver la página ${n} en grande`);
    S.cells[n] = c;
    frag.append(c);
  }
  grid.append(frag);
  S.cells[1].tabIndex = 0;

  S.observer = new IntersectionObserver(onIntersect, { root: $('#split-mat'), rootMargin: '700px 0px' });
  for (let n = 1; n <= S.numPages; n++) S.observer.observe(S.cells[n]);
}

function onIntersect(entries) {
  for (const e of entries) {
    const n = Number(e.target.dataset.n);
    if (e.isIntersecting) {
      S.visible.add(n);
      requestThumb(n);
    } else {
      S.visible.delete(n);
    }
  }
}

function rotOf(n) {
  return S.rot.get(n) || 0;
}

function requestThumb(n) {
  const cell = S.cells[n];
  if (!cell || !S.thumbs) return;
  const rot = rotOf(n);
  const shown = cell.dataset.loaded === '1' && Number(cell.dataset.rot || 0) === rot;
  if (shown || cell.dataset.loading === String(rot)) return;
  const hit = S.thumbs.cached(n, rot);
  if (hit) {
    applyThumb(n, hit, rot);
    return;
  }
  cell.dataset.loading = String(rot);
  const thumbs = S.thumbs;
  thumbs.request(n, () => S.visible.has(n) && S.thumbs === thumbs && rotOf(n) === rot, rot)
    .then((res) => {
      if (S.thumbs === thumbs && rotOf(n) === rot) applyThumb(n, res, rot);
    })
    .catch((err) => {
      if (err?.name !== 'AbortError' && S.thumbs === thumbs) {
        cell.querySelector('.ph').textContent = '⚠';
        cell.title = `No se pudo dibujar la página ${n}`;
      }
    })
    .finally(() => {
      if (cell.dataset.loading === String(rot)) delete cell.dataset.loading;
    });
}

function applyThumb(n, { url, w, h }, rot = 0) {
  const cell = S.cells[n];
  if (!cell) return;
  const sheet = cell.querySelector('.sheet');
  let img = sheet.querySelector('img');
  if (!img) {
    img = el('img', { alt: '', decoding: 'async', draggable: 'false' });
    sheet.prepend(img);
  }
  img.src = url;
  const wrap = cell.querySelector('.sheet-wrap');
  const ratio = w / h;
  wrap.style.setProperty('--ar', String(ratio));
  wrap.classList.toggle('tall', ratio <= BOX_RATIO);
  wrap.classList.toggle('wide', ratio > BOX_RATIO);
  sheet.querySelector('.ph').hidden = true;
  cell.dataset.loaded = '1';
  cell.dataset.rot = String(rot);
}

/* ================================================================== giros */

function rotatePages(pages, delta) {
  if (!S.numPages || !pages.length) return;
  for (const n of pages) {
    const r = (rotOf(n) + delta) % 360;
    if (r) S.rot.set(n, r);
    else S.rot.delete(n);
    const cell = S.cells[n];
    cell.classList.toggle('rotated', !!r);
    if (S.visible.has(n)) requestThumb(n); // la miniatura vieja queda hasta que llega la nueva
    else if (cell.dataset.loaded === '1') cell.dataset.loaded = '0';
  }
  updateRun();
}

/** Giros para qpdf: posiciones (1, 2, …) dentro de `pageList`, agrupadas por ángulo. */
function rotationsFor(pageList) {
  const by = new Map();
  pageList.forEach((n, i) => {
    const r = rotOf(n);
    if (!r) return;
    if (!by.has(r)) by.set(r, []);
    by.get(r).push(i + 1);
  });
  return [...by].map(([angle, pos]) => ({ angle, range: toRangeString(pos) }));
}

function onEvict(n) {
  const cell = S.cells[n];
  if (!cell || S.visible.has(n)) return;
  cell.querySelector('.sheet img')?.remove();
  cell.querySelector('.ph').hidden = false;
  cell.dataset.loaded = '0';
}

function firstVisiblePage() {
  const mat = $('#split-mat');
  const top = mat.getBoundingClientRect().top;
  let best = null;
  for (const n of S.visible) {
    const r = S.cells[n].getBoundingClientRect();
    if (r.bottom > top && (best == null || n < best)) best = n;
  }
  return best;
}

function setThumbSize(px) {
  const anchor = firstVisiblePage();
  view().style.setProperty('--thumb-w', `${px}px`);
  if (anchor) S.cells[anchor].scrollIntoView({ block: 'start' });
}

function gotoPage(n, { select = false } = {}) {
  if (!S.numPages) return;
  const page = Math.max(1, Math.min(S.numPages, Math.round(n)));
  const cell = S.cells[page];
  cell.scrollIntoView({ block: 'center' });
  focusCell(page);
  if (select) toggle(page, true);
}

function focusCell(n) {
  const prev = S.cells[S.focus];
  if (prev) prev.tabIndex = -1;
  S.focus = n;
  const cell = S.cells[n];
  cell.tabIndex = 0;
  cell.focus({ preventScroll: true });
  cell.scrollIntoView({ block: 'nearest' });
}

function columns() {
  const cells = S.cells;
  if (cells.length < 3) return 1;
  const top = cells[1].offsetTop;
  let c = 1;
  while (c + 1 < cells.length && cells[c + 1].offsetTop === top) c++;
  return c;
}

/* ================================================================== selección */

function toggle(n, force) {
  const on = force ?? !S.selected.has(n);
  if (on) S.selected.add(n);
  else S.selected.delete(n);
  paintSel(n);
}

function paintSel(n) {
  const cell = S.cells[n];
  if (!cell) return;
  const on = S.selected.has(n);
  cell.classList.toggle('sel', on);
  cell.setAttribute('aria-selected', on ? 'true' : 'false');
}

function selectRange(a, b, on = true) {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  for (let n = lo; n <= hi; n++) toggle(n, on);
}

function setSelection(pages) {
  const next = new Set(pages);
  const changed = new Set([...S.selected, ...next]);
  S.selected = next;
  for (const n of changed) paintSel(n);
  updateSelection();
}

function sortedSelection() {
  return [...S.selected].sort((a, b) => a - b);
}

function updateSelection() {
  const count = S.selected.size;
  $('#selbar').hidden = count === 0;
  $('#add-selection').disabled = count === 0;
  if (count) {
    $('#sel-count').textContent = `${plural(count, 'página seleccionada', 'páginas seleccionadas')}`;
    const text = prettyRanges(sortedSelection());
    $('#sel-which').textContent = text;
    $('#sel-which').title = text;
  }
}

function onGridClick(e) {
  const cell = e.target.closest('.pg');
  if (!cell) return;
  const n = Number(cell.dataset.n);
  if (e.target.closest('.pg-zoom')) {
    openViewer(n);
    return;
  }
  if (e.shiftKey && S.anchor != null) {
    selectRange(S.anchor, n, true);
  } else {
    toggle(n);
    S.anchor = n;
  }
  focusCell(n);
  updateSelection();
}

function onGridKey(e) {
  const cell = e.target.closest('.pg');
  if (!cell) return;
  const n = Number(cell.dataset.n);
  const cols = columns();
  let next = null;
  switch (e.key) {
    case 'ArrowRight': next = n + 1; break;
    case 'ArrowLeft': next = n - 1; break;
    case 'ArrowDown': next = n + cols; break;
    case 'ArrowUp': next = n - cols; break;
    case 'Home': next = 1; break;
    case 'End': next = S.numPages; break;
    case ' ':
    case 'Enter':
      e.preventDefault();
      if (e.shiftKey && S.anchor != null) selectRange(S.anchor, n, true);
      else {
        toggle(n);
        S.anchor = n;
      }
      updateSelection();
      return;
    case 'a':
    case 'A':
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        selectAll();
      }
      return;
    case 'Escape':
      if (S.selected.size) {
        e.preventDefault();
        setSelection([]);
      }
      return;
    default:
      if (e.key === 'z' || e.key === 'Z') openViewer(n);
      return;
  }
  e.preventDefault();
  next = Math.max(1, Math.min(S.numPages, next));
  if (e.shiftKey) {
    if (S.anchor == null) S.anchor = n;
    selectRange(S.anchor, next, true);
    updateSelection();
  }
  focusCell(next);
}

function selectAll() {
  setSelection(Array.from({ length: S.numPages }, (_, i) => i + 1));
}

function invertSelection() {
  const out = [];
  for (let n = 1; n <= S.numPages; n++) if (!S.selected.has(n)) out.push(n);
  setSelection(out);
}

/* ================================================================== partes */

function autoName(p, index) {
  if (S.mode === 'parts' && p.mode === 'range' && !p.error) {
    return p.from === p.to ? `${S.base}_p${p.from}.pdf` : `${S.base}_p${p.from}-${p.to}.pdf`;
  }
  return `${S.base}_parte${index + 1}.pdf`;
}

function computePart(p) {
  p.error = null;
  if (p.mode === 'range') {
    const from = Number(p.from);
    const to = Number(p.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) p.error = 'Completá “desde” y “hasta”.';
    else if (from < 1 || to < 1 || from > S.numPages || to > S.numPages) p.error = `Las páginas van de 1 a ${S.numPages}.`;
    else if (from > to) p.error = '“Desde” no puede ser mayor que “hasta”.';
    p.pages = p.error ? [] : Array.from({ length: to - from + 1 }, (_, i) => from + i);
  } else {
    const r = parsePages(p.text, S.numPages);
    p.error = r.error;
    p.pages = r.pages;
  }
}

function addPart(init) {
  const p = {
    id: S.nextPartId++,
    mode: 'range',
    from: 1,
    to: S.numPages,
    text: '',
    name: '',
    nameEdited: false,
    pages: [],
    error: null,
    ...init,
  };
  computePart(p);
  S.parts.push(p);
  renderParts();
  updateAll();
  const li = $(`#parts li[data-id="${p.id}"]`);
  li?.scrollIntoView({ block: 'nearest' });
  return p;
}

function addRangePart() {
  if (!S.numPages) return;
  const last = [...S.parts].reverse().find((p) => p.mode === 'range' && !p.error);
  let from = last ? Number(last.to) + 1 : 1;
  if (from > S.numPages) from = 1;
  const p = addPart({ mode: 'range', from, to: S.numPages });
  $(`#parts li[data-id="${p.id}"] input[data-f="from"]`)?.focus();
}

function addSelectionPart() {
  const pages = sortedSelection();
  if (!pages.length) return;
  const contiguous = pages[pages.length - 1] - pages[0] === pages.length - 1;
  if (contiguous) addPart({ mode: 'range', from: pages[0], to: pages[pages.length - 1] });
  else addPart({ mode: 'list', text: prettyRanges(pages).replace(/–/g, '-') });
  if (S.mode !== 'parts') setMode('parts');
  setSelection([]);
}

function removePart(id) {
  S.parts = S.parts.filter((p) => p.id !== id);
  renderParts();
  updateAll();
}

function switchPartMode(p) {
  if (p.mode === 'range') {
    p.mode = 'list';
    p.text = p.error ? '' : (p.from === p.to ? String(p.from) : `${p.from}-${p.to}`);
  } else {
    const pages = p.pages.length ? p.pages : [1];
    p.mode = 'range';
    p.from = Math.min(...pages);
    p.to = Math.max(...pages);
  }
  computePart(p);
  renderParts();
  updateAll();
  $(`#parts li[data-id="${p.id}"] input:not(.part-name)`)?.focus();
}

function renderParts() {
  const list = $('#parts');
  list.replaceChildren(...S.parts.map((p, i) => {
    const tag = el('span', { class: `tag${DARK_TEXT_PARTS.has(i % PART_VARS.length) ? ' light-text' : ''}` }, String(i + 1));
    const name = el('input', {
      class: 'input part-name', value: p.nameEdited ? p.name : autoName(p, i), spellcheck: 'false',
      'aria-label': `Nombre del archivo de la parte ${i + 1}`, 'data-f': 'name',
    });
    const remove = el('button', { class: 'icon-btn', 'data-act': 'remove', 'aria-label': `Quitar la parte ${i + 1}`, title: 'Quitar' }, icon('x'));
    const rotate = el('button', { class: 'icon-btn', 'data-act': 'rot', 'aria-label': `Girar 90° las páginas de la parte ${i + 1}`, title: 'Girar esta parte 90°' }, icon('rotr'));
    let body;
    if (p.mode === 'range') {
      body = el('div', { class: 'part-body' },
        el('label', {}, 'Desde', el('input', { class: 'input num', type: 'number', min: 1, max: S.numPages, value: p.from, 'data-f': 'from', inputmode: 'numeric' })),
        el('label', {}, 'hasta', el('input', { class: 'input num', type: 'number', min: 1, max: S.numPages, value: p.to, 'data-f': 'to', inputmode: 'numeric' })),
        el('span', { class: 'part-count' }));
    } else {
      body = el('div', { class: 'part-body' },
        el('input', { class: 'input pages-text', value: p.text, 'data-f': 'text', placeholder: 'Ej.: 1-5, 8, 12-', 'aria-label': `Páginas de la parte ${i + 1}`, spellcheck: 'false' }),
        el('span', { class: 'part-count' }));
    }
    const foot = el('div', { class: 'part-foot' },
      el('button', { class: 'link', 'data-act': 'mode' }, p.mode === 'range' ? 'Escribir páginas sueltas' : 'Usar desde / hasta'),
      el('button', { class: 'link', 'data-act': 'show' }, 'Seleccionar en miniaturas'));
    const li = el('li', { class: 'part', 'data-id': p.id },
      el('div', { class: 'part-head' }, tag, name, rotate, remove), body, foot, el('p', { class: 'part-error', hidden: true }));
    li.style.setProperty('--pc', partColor(i));
    tag.style.setProperty('--pc', partColor(i));
    return li;
  }));
  $('#parts-empty').hidden = S.parts.length > 0;
  S.parts.forEach((p, i) => refreshPartRow(p, i));
}

function refreshPartRow(p, i) {
  const li = $(`#parts li[data-id="${p.id}"]`);
  if (!li) return;
  li.querySelector('.part-count').textContent = p.error ? '' : plural(p.pages.length, 'pág.', 'págs.');
  const err = li.querySelector('.part-error');
  err.hidden = !p.error;
  err.textContent = p.error || '';
  li.querySelectorAll('input[data-f="from"], input[data-f="to"], input[data-f="text"]').forEach((inp) => {
    inp.classList.toggle('invalid', !!p.error);
  });
  const name = li.querySelector('.part-name');
  if (!p.nameEdited && document.activeElement !== name) name.value = autoName(p, i);
}

function onPartsInput(e) {
  const li = e.target.closest('li.part');
  if (!li) return;
  const p = S.parts.find((x) => x.id === Number(li.dataset.id));
  const i = S.parts.indexOf(p);
  const f = e.target.dataset.f;
  if (f === 'name') {
    p.name = e.target.value;
    p.nameEdited = e.target.value.trim() !== '';
    return;
  }
  if (f === 'from' || f === 'to') p[f] = e.target.value === '' ? NaN : Number(e.target.value);
  if (f === 'text') p.text = e.target.value;
  computePart(p);
  refreshPartRow(p, i);
  scheduleTags();
  updateRun();
}

function onPartsClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const li = btn.closest('li.part');
  const p = S.parts.find((x) => x.id === Number(li.dataset.id));
  if (!p) return;
  const act = btn.dataset.act;
  if (act === 'remove') removePart(p.id);
  else if (act === 'rot') rotatePages(p.pages, 90);
  else if (act === 'mode') switchPartMode(p);
  else if (act === 'show' && p.pages.length) {
    setSelection(p.pages);
    gotoPage(p.pages[0]);
  }
}

/* ================================================================== partes iguales */

function everyGroups() {
  const n = Math.max(1, Math.floor(Number(S.everyN) || 0));
  if (!S.numPages || !Number.isFinite(n)) return [];
  const groups = [];
  for (let first = 1; first <= S.numPages; first += n) {
    groups.push({ from: first, to: Math.min(S.numPages, first + n - 1) });
  }
  return groups;
}

function everyValid() {
  const n = Number(S.everyN);
  return Number.isInteger(n) && n >= 1 && n <= S.numPages;
}

function everyNames(groups) {
  const pad = String(S.numPages).length;
  const z = (x) => String(x).padStart(pad, '0');
  return groups.map((g) => (g.from === g.to ? `${S.base}_p${z(g.from)}.pdf` : `${S.base}_p${z(g.from)}-${z(g.to)}.pdf`));
}

function updateEvery() {
  const out = $('#every-summary');
  const input = $('#every-n');
  if (!S.numPages) {
    out.textContent = '';
    return;
  }
  if (!everyValid()) {
    input.classList.add('invalid');
    out.textContent = `Entre 1 y ${S.numPages}`;
    return;
  }
  input.classList.remove('invalid');
  const groups = everyGroups();
  const last = groups[groups.length - 1];
  const lastSize = last.to - last.from + 1;
  const n = Number(S.everyN);
  let text = plural(groups.length, 'archivo', 'archivos');
  if (n > 1 && lastSize !== n) text += ` (el último de ${lastSize})`;
  out.textContent = text;
}

function setMode(mode) {
  S.mode = mode;
  document.querySelectorAll('#split-side .seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  $('#mode-parts').hidden = mode !== 'parts';
  $('#mode-every').hidden = mode !== 'every';
  renderParts();
  updateAll();
}

/* ================================================================== marcas en miniaturas */

function pageGroups() {
  // Devuelve, para cada página, la lista de índices de parte que la contienen.
  const map = new Array(S.numPages + 1);
  if (S.mode === 'every') {
    if (everyValid()) everyGroups().forEach((g, i) => { for (let n = g.from; n <= g.to; n++) map[n] = [i]; });
  } else {
    S.parts.forEach((p, i) => {
      if (p.error) return;
      for (const n of p.pages) {
        const arr = map[n] || (map[n] = []);
        if (arr[arr.length - 1] !== i) arr.push(i);
      }
    });
  }
  return map;
}

function scheduleTags() {
  clearTimeout(S.tagTimer);
  S.tagTimer = setTimeout(paintTags, 120);
}

function paintTags() {
  if (!S.numPages) return;
  const map = pageGroups();
  let prevKey = '';
  for (let n = 1; n <= S.numPages; n++) {
    const cell = S.cells[n];
    const list = map[n] || [];
    const key = list.join(',');
    if (cell._key !== key) {
      cell._key = key;
      const tags = cell.querySelector('.tags');
      const shown = list.slice(0, 3);
      tags.replaceChildren(...shown.map((i) => {
        const t = el('span', { class: `tag${DARK_TEXT_PARTS.has(i % PART_VARS.length) ? ' light-text' : ''}` }, String(i + 1));
        t.style.setProperty('--pc', partColor(i));
        return t;
      }));
      if (list.length > 3) {
        const more = el('span', { class: 'tag' }, `+${list.length - 3}`);
        more.style.setProperty('--pc', 'var(--ink-2)');
        tags.append(more);
      }
      const bar = cell.querySelector('.partbar');
      bar.style.setProperty('--pc', list.length ? partColor(list[0]) : 'transparent');
    }
    const cut = n > 1 && key !== prevKey && (key !== '' || prevKey !== '');
    cell.classList.toggle('cut', cut);
    prevKey = key;
  }
}

/* ================================================================== generar */

function plan() {
  if (!S.numPages) return null;
  if (S.mode === 'every') {
    if (!everyValid()) return null;
    const groups = everyGroups();
    return { kind: 'every', groups, names: everyNames(groups), pages: S.numPages };
  }
  if (!S.parts.length && S.rot.size) {
    // Sin partes pero con páginas giradas: el documento entero, girado.
    const all = Array.from({ length: S.numPages }, (_, i) => i + 1);
    return { kind: 'parts', parts: [{ pages: all }], names: [`${S.base}_girado.pdf`], pages: S.numPages };
  }
  const parts = S.parts.filter((p) => !p.error && p.pages.length);
  if (!parts.length || parts.length !== S.parts.length) return null;
  const names = uniqueNames(parts.map((p, i) => ensurePdfExt(safeFileName(p.nameEdited ? p.name : autoName(p, S.parts.indexOf(p)), `${S.base}_parte${i + 1}`))));
  const pages = parts.reduce((s, p) => s + p.pages.length, 0);
  return { kind: 'parts', parts, names, pages };
}

function updateRun() {
  const btn = $('#split-run');
  const sum = $('#split-summary');
  const pl = plan();
  if (!S.numPages) {
    btn.disabled = true;
    sum.textContent = '';
    return;
  }
  if (!pl) {
    btn.disabled = true;
    btn.textContent = 'Generar archivos';
    if (S.mode === 'parts' && S.parts.some((p) => p.error)) sum.textContent = 'Hay partes con errores.';
    else sum.textContent = '';
    return;
  }
  const count = pl.names.length;
  btn.disabled = false;
  if (pl.kind === 'parts' && !S.parts.length) btn.textContent = 'Generar PDF girado';
  else btn.textContent = count === 1 ? 'Generar 1 archivo' : `Generar ${count.toLocaleString('es-AR')} archivos`;
  sum.textContent = plural(pl.pages, 'página', 'páginas');
}

function updateAll() {
  updateEvery();
  scheduleTags();
  updateRun();
}

async function run() {
  const pl = plan();
  if (!pl || !S.file) return;
  const file = S.file;
  const input = { file, password: S.source.password };
  const prog = progress();
  const count = pl.names.length;
  const signal = prog.open('Generando', plural(count, 'archivo', 'archivos'));
  try {
    let out;
    if (pl.kind === 'every') {
      prog.step(count === 1 ? 'Copiando páginas…' : `Generando ${count.toLocaleString('es-AR')} archivos…`);
      const r = await runQpdf({
        inputs: [input],
        pages: [{ input: 0, range: `1-${S.numPages}` }],
        split: count > 1 ? Number(S.everyN) : 0,
        count: S.numPages,
        outputs: pl.names.map((name) => ({ name })),
        trimResources: count > 1,
        rotations: rotationsFor(Array.from({ length: S.numPages }, (_, i) => i + 1)),
      }, {
        signal,
        onProgress: (done, total) => {
          prog.set(done / total);
          if (count > 1) prog.step(`Archivo ${Math.min(done + 1, total).toLocaleString('es-AR')} de ${total.toLocaleString('es-AR')}`);
        },
      });
      out = { files: r.files, warnings: r.warnings, storage: r.storage, packs: [r.packName].filter(Boolean) };
    } else {
      out = { files: [], warnings: [], storage: 'opfs', packs: [] };
      for (let i = 0; i < pl.parts.length; i++) {
        const p = pl.parts[i];
        prog.step(`Parte ${i + 1} de ${pl.parts.length}: ${pl.names[i]}`);
        const r = await runQpdf({
          inputs: [input],
          pages: [{ input: 0, range: toRangeString(p.pages) }],
          outputs: [{ name: pl.names[i] }],
          trimResources: !(p.pages.length === S.numPages && p.pages[0] === 1 && p.pages[p.pages.length - 1] === S.numPages),
          rotations: rotationsFor(p.pages),
        }, {
          signal,
          onProgress: (done, total) => prog.set((i + done / total) / pl.parts.length),
        });
        out.files.push(...r.files);
        out.warnings.push(...r.warnings);
        if (r.storage === 'memory') out.storage = 'memory';
        if (r.packName) out.packs.push(r.packName);
      }
    }
    prog.close();
    results.add({ ...out, title: count === 1 ? 'Listo' : `Listo: ${plural(count, 'archivo', 'archivos')}` });
    if (out.files.length === 1) downloadFile(out.files[0]);
  } catch (err) {
    prog.close();
    if (isAbort(err)) toast('Se canceló la división.');
    else if (err.password) toast('La contraseña del PDF no es válida para procesarlo.', { type: 'error' });
    else toast(`No se pudo dividir el PDF: ${err.message}`, { type: 'error', timeout: 15000 });
  }
}

async function extractSelection() {
  const pages = sortedSelection();
  if (!pages.length || !S.file) return;
  const short = prettyRanges(pages).replace(/–/g, '-').replace(/, /g, '_');
  const name = ensurePdfExt(safeFileName(short.length <= 40 ? `${S.base}_p${short}` : `${S.base}_seleccion`));
  const prog = progress();
  const signal = prog.open('Extrayendo', plural(pages.length, 'página', 'páginas'));
  try {
    const r = await runQpdf({
      inputs: [{ file: S.file, password: S.source.password }],
      pages: [{ input: 0, range: toRangeString(pages) }],
      outputs: [{ name }],
      trimResources: pages.length !== S.numPages,
      rotations: rotationsFor(pages),
    }, { signal, onProgress: (d, t) => prog.set(d / t) });
    prog.close();
    results.add({ files: r.files, warnings: r.warnings, storage: r.storage, packs: [r.packName].filter(Boolean), title: 'Listo' });
    downloadFile(r.files[0]);
  } catch (err) {
    prog.close();
    if (isAbort(err)) toast('Se canceló la extracción.');
    else toast(`No se pudo extraer: ${err.message}`, { type: 'error', timeout: 15000 });
  }
}

/* ================================================================== vista ampliada */

async function openViewer(n) {
  const dlg = $('#viewer');
  if (!dlg.open) dlg.showModal();
  await showViewerPage(n);
}

async function showViewerPage(n) {
  if (!S.source) return;
  const seq = ++viewerSeq;
  viewerPage = Math.max(1, Math.min(S.numPages, n));
  $('#viewer-title').textContent = `Página ${viewerPage} de ${S.numPages.toLocaleString('es-AR')}`;
  $('#viewer-prev').disabled = viewerPage <= 1;
  $('#viewer-next').disabled = viewerPage >= S.numPages;
  updateViewerSelect();
  const body = $('#viewer-body');
  $('#viewer-spinner').hidden = false;
  viewerTask?.cancel();
  viewerTask = null;
  // Cada página se dibuja en un canvas nuevo que reemplaza al anterior recién al terminar:
  // al pasar páginas rápido no se mezclan dos renders en el mismo lienzo.
  const canvas = el('canvas', { id: 'viewer-canvas' });
  try {
    const rect = body.getBoundingClientRect();
    const task = await renderInto(S.source, viewerPage, canvas, rect.width - 32, rect.height - 32, rotOf(viewerPage));
    task.promise.catch(() => {}); // si se descarta, que no quede un rechazo sin atender
    if (seq !== viewerSeq) {
      task.cancel(); // ya se pidió otra página
      return;
    }
    viewerTask = task;
    await task.promise;
    if (seq === viewerSeq) $('#viewer-canvas').replaceWith(canvas);
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.warn(err);
  } finally {
    if (seq === viewerSeq) $('#viewer-spinner').hidden = true;
  }
}

function updateViewerSelect() {
  const on = S.selected.has(viewerPage);
  const b = $('#viewer-select');
  b.textContent = on ? 'Quitar de la selección' : 'Seleccionar';
  b.classList.toggle('mark', !on);
}

/* ================================================================== inicio */

export function initSplit() {
  results = new ResultsPanel($('#split-results'), {
    zipName: () => `${S.base || 'paginas'}_partes.zip`,
  });

  const fileInput = $('#file-split');
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (f) loadSplitFile(f);
  });
  $('#split-pick').addEventListener('click', () => fileInput.click());
  $('#split-change').addEventListener('click', () => fileInput.click());

  const grid = pagesEl();
  grid.addEventListener('click', onGridClick);
  grid.addEventListener('keydown', onGridKey);

  document.querySelectorAll('#split-toolbar [data-sel]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.sel;
    if (k === 'all') selectAll();
    else if (k === 'none') setSelection([]);
    else invertSelection();
  }));

  const sizeInput = $('#thumb-size');
  // El tamaño inicial lo decide el CSS (más chico en teléfonos): el control arranca en ese valor.
  const initialThumb = parseInt(getComputedStyle(view()).getPropertyValue('--thumb-w'), 10);
  if (initialThumb > 0) sizeInput.value = String(initialThumb);
  sizeInput.addEventListener('input', (e) => setThumbSize(Number(e.target.value)));
  const go = $('#goto');
  go.addEventListener('change', () => go.value && gotoPage(Number(go.value)));
  go.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && go.value) gotoPage(Number(go.value));
  });

  document.querySelectorAll('[data-rot-sel]').forEach((b) => b.addEventListener('click', () => {
    rotatePages(sortedSelection(), Number(b.dataset.rotSel));
  }));
  document.querySelectorAll('[data-rot-all]').forEach((b) => b.addEventListener('click', () => {
    rotatePages(Array.from({ length: S.numPages }, (_, i) => i + 1), Number(b.dataset.rotAll));
  }));
  $('#viewer-rotl').addEventListener('click', () => {
    rotatePages([viewerPage], 270);
    showViewerPage(viewerPage);
  });
  $('#viewer-rotr').addEventListener('click', () => {
    rotatePages([viewerPage], 90);
    showViewerPage(viewerPage);
  });
  $('#sel-to-part').addEventListener('click', addSelectionPart);
  $('#sel-extract').addEventListener('click', extractSelection);
  $('#sel-clear').addEventListener('click', () => setSelection([]));
  $('#add-range').addEventListener('click', addRangePart);
  $('#add-selection').addEventListener('click', addSelectionPart);

  const partsList = $('#parts');
  partsList.addEventListener('input', onPartsInput);
  partsList.addEventListener('click', onPartsClick);
  partsList.addEventListener('change', (e) => {
    // al salir del campo, normalizar el nombre
    if (e.target.dataset.f === 'name' && e.target.value.trim()) e.target.value = ensurePdfExt(safeFileName(e.target.value));
  });

  document.querySelectorAll('#split-side .seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#every-n').addEventListener('input', (e) => {
    S.everyN = e.target.value === '' ? NaN : Number(e.target.value);
    updateAll();
  });

  $('#split-run').addEventListener('click', run);

  // vista ampliada
  $('#viewer-close').addEventListener('click', () => $('#viewer').close());
  $('#viewer-prev').addEventListener('click', () => showViewerPage(viewerPage - 1));
  $('#viewer-next').addEventListener('click', () => showViewerPage(viewerPage + 1));
  $('#viewer-select').addEventListener('click', () => {
    toggle(viewerPage);
    S.anchor = viewerPage;
    updateSelection();
    updateViewerSelect();
  });
  $('#viewer').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' && viewerPage < S.numPages) showViewerPage(viewerPage + 1);
    else if (e.key === 'ArrowLeft' && viewerPage > 1) showViewerPage(viewerPage - 1);
    else if (e.key === ' ' && e.target === e.currentTarget) {
      e.preventDefault();
      $('#viewer-select').click();
    }
  });
  $('#viewer').addEventListener('close', () => {
    viewerSeq++; // descartar lo que estuviera por dibujarse
    viewerTask?.cancel();
    $('#viewer-spinner').hidden = true;
    if (S.cells[viewerPage]) focusCell(viewerPage);
  });
  $('#viewer').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close(); // clic en el fondo
  });

  showState('empty');
  updateRun();
}

export function splitHasDocument() {
  return !!S.source;
}
