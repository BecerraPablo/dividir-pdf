// Vista "Unir": lista de PDF ordenable, rango opcional por archivo y unión con qpdf.
import { probePdf, PasswordCancelled } from './pdf-doc.js';
import { runQpdf } from './jobs.js';
import { parsePages, toRangeString, plural, formatBytes, safeFileName, ensurePdfExt } from './pages.js';
import {
  $, el, icon, toast, confirmDialog, askPassword, progress, isAbort, isPdfFile, downloadFile, ResultsPanel,
} from './ui.js';

const M = {
  items: [], // { id, file, status: 'loading'|'ready'|'error', numPages, password, thumb, rangeText, pages, error }
  nextId: 1,
  queue: Promise.resolve(),
  nameEdited: false,
  dragId: null,
};

let results;

/* ================================================================== agregar archivos */

export function addMergeFiles(files) {
  const pdfs = [];
  for (const f of files) {
    if (isPdfFile(f)) pdfs.push(f);
    else toast(`“${f.name}” no parece un PDF y no se agregó.`, { type: 'error' });
  }
  if (!pdfs.length) return;
  for (const file of pdfs) {
    const item = { id: M.nextId++, file, status: 'loading', numPages: 0, password: null, thumb: null, rangeText: '', pages: null, error: null };
    M.items.push(item);
    // De a uno por vez: abrir varios PDF enormes en paralelo no gana nada y gasta memoria.
    M.queue = M.queue.then(() => probe(item));
  }
  render();
}

async function probe(item) {
  if (!M.items.includes(item)) return;
  try {
    const info = await probePdf(item.file, {
      askPassword: (retry) => askPassword({ fileName: item.file.name, retry }),
      thumbWidth: 128,
    });
    item.numPages = info.numPages;
    item.password = info.password;
    item.thumb = info.thumb;
    item.status = 'ready';
  } catch (err) {
    item.status = 'error';
    item.error = err instanceof PasswordCancelled ? 'Falta la contraseña: este archivo no se va a incluir.' : `No se pudo leer: ${err.message}`;
  }
  if (!M.items.includes(item)) {
    if (item.thumb) URL.revokeObjectURL(item.thumb.url);
    return;
  }
  computeRange(item);
  if (!M.nameEdited && M.items[0] === item) $('#merge-name').value = defaultName();
  render();
}

function defaultName() {
  const first = M.items[0];
  if (!first) return 'unido.pdf';
  return ensurePdfExt(safeFileName(`${first.file.name.replace(/\.pdf$/i, '')}_unido`));
}

function computeRange(item) {
  if (item.status !== 'ready') {
    item.pages = null;
    return;
  }
  const text = item.rangeText.trim();
  if (!text) {
    item.pages = null; // todas
    item.error = null;
    return;
  }
  const r = parsePages(text, item.numPages);
  item.error = r.error;
  item.pages = r.error ? null : r.pages;
}

function pagesOf(item) {
  if (item.status !== 'ready') return 0;
  return item.pages ? item.pages.length : item.numPages;
}

/* ================================================================== lista */

function render() {
  const list = $('#files');
  const has = M.items.length > 0;
  $('#view-merge').classList.toggle('is-empty', !has);
  $('#merge-drop').hidden = has;
  list.hidden = !has;
  $('#merge-toolbar').hidden = !has;

  list.replaceChildren(...M.items.map((it, i) => renderItem(it, i)));
  updateSummary();
}

function renderItem(it, i) {
  const thumb = el('div', { class: 'fthumb' });
  if (it.thumb) thumb.append(el('img', { src: it.thumb.url, alt: '' }));
  else if (it.status === 'loading') thumb.append(el('div', { class: 'spinner', style: { width: '22px', height: '22px', borderColor: 'rgba(0,0,0,.15)', borderTopColor: 'var(--mat)' } }));

  const meta = el('div', { class: 'fmeta' }, el('span', {}, formatBytes(it.file.size)));
  if (it.status === 'ready') {
    meta.append(el('span', {}, plural(it.numPages, 'página', 'páginas')));
    meta.append(el('label', {}, 'Páginas',
      el('input', {
        class: `input${it.error ? ' invalid' : ''}`, value: it.rangeText, placeholder: 'todas', spellcheck: 'false',
        'data-f': 'range', 'aria-label': `Páginas de ${it.file.name} (vacío = todas)`,
      })));
  } else if (it.status === 'loading') {
    meta.append(el('span', {}, 'Leyendo…'));
  }

  const info = el('div', { class: 'finfo' }, el('span', { class: 'fname', title: it.file.name }, it.file.name), meta);
  info.append(el('span', { class: 'ferror', hidden: !it.error }, it.error || ''));

  const actions = el('div', { class: 'factions' },
    el('button', { class: 'icon-btn', 'data-act': 'up', 'aria-label': `Subir ${it.file.name}`, title: 'Subir', disabled: i === 0 }, icon('up')),
    el('button', { class: 'icon-btn', 'data-act': 'down', 'aria-label': `Bajar ${it.file.name}`, title: 'Bajar', disabled: i === M.items.length - 1 }, icon('down')),
    el('button', { class: 'icon-btn', 'data-act': 'remove', 'aria-label': `Quitar ${it.file.name}`, title: 'Quitar' }, icon('x')));

  const grip = el('span', { class: 'grip', title: 'Arrastrá para cambiar el orden', 'aria-hidden': 'true' }, icon('grip'));
  return el('li', { class: 'file', 'data-id': it.id }, grip, el('span', { class: 'order' }, String(i + 1)), thumb, info, actions);
}

function updateSummary() {
  const ready = M.items.filter((it) => it.status === 'ready');
  const loading = M.items.some((it) => it.status === 'loading');
  const invalid = ready.some((it) => it.error);
  const total = ready.reduce((s, it) => s + pagesOf(it), 0);
  const bytes = M.items.reduce((s, it) => s + it.file.size, 0);

  $('#merge-count').textContent = plural(M.items.length, 'archivo', 'archivos');
  $('#merge-meta').replaceChildren(el('span', {}, formatBytes(bytes)), el('span', {}, plural(total, 'página', 'páginas')));

  const btn = $('#merge-run');
  const sum = $('#merge-summary');
  btn.disabled = loading || invalid || ready.length < 1 || (ready.length < 2 && !ready.some((it) => it.pages));
  btn.textContent = ready.length > 1 ? `Unir ${ready.length} PDF` : 'Unir PDF';
  if (loading) sum.textContent = 'Leyendo…';
  else if (invalid) sum.textContent = 'Hay rangos con errores.';
  else if (!ready.length || (ready.length < 2 && !ready.some((it) => it.pages))) sum.textContent = '';
  else {
    const skipped = M.items.length - ready.length;
    sum.textContent = `${plural(total, 'página', 'páginas')}${skipped ? ` · ${plural(skipped, 'archivo omitido', 'archivos omitidos')}` : ''}`;
  }
}

function move(id, delta) {
  const i = M.items.findIndex((it) => it.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= M.items.length) return;
  const [it] = M.items.splice(i, 1);
  M.items.splice(j, 0, it);
  if (!M.nameEdited) $('#merge-name').value = defaultName();
  render();
  $(`#files li[data-id="${id}"] [data-act="${delta < 0 ? 'up' : 'down'}"]`)?.focus();
}

function removeItem(id) {
  const i = M.items.findIndex((it) => it.id === id);
  if (i < 0) return;
  const [it] = M.items.splice(i, 1);
  if (it.thumb) URL.revokeObjectURL(it.thumb.url);
  if (!M.nameEdited) $('#merge-name').value = defaultName();
  render();
}

/* ================================================================== arrastrar para ordenar */

function clearDropMarks() {
  document.querySelectorAll('#files .drop-before, #files .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
}

function setupDrag(list) {
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li.file');
    if (li) li.draggable = !!e.target.closest('.grip');
  });
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li.file');
    if (!li || !li.draggable) return;
    M.dragId = Number(li.dataset.id);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-orden', String(M.dragId));
  });
  list.addEventListener('dragover', (e) => {
    if (M.dragId == null) return;
    e.preventDefault();
    e.stopPropagation();
    const li = e.target.closest('li.file');
    clearDropMarks();
    if (!li || Number(li.dataset.id) === M.dragId) return;
    const r = li.getBoundingClientRect();
    li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  list.addEventListener('drop', (e) => {
    if (M.dragId == null) return;
    e.preventDefault();
    e.stopPropagation();
    const li = e.target.closest('li.file');
    const fromId = M.dragId;
    M.dragId = null;
    clearDropMarks();
    if (!li || Number(li.dataset.id) === fromId) return render();
    const r = li.getBoundingClientRect();
    const after = e.clientY >= r.top + r.height / 2;
    const from = M.items.findIndex((it) => it.id === fromId);
    const [it] = M.items.splice(from, 1);
    let to = M.items.findIndex((x) => x.id === Number(li.dataset.id));
    if (after) to++;
    M.items.splice(to, 0, it);
    if (!M.nameEdited) $('#merge-name').value = defaultName();
    render();
  });
  list.addEventListener('dragend', () => {
    M.dragId = null;
    clearDropMarks();
    list.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
  });
}

export function isReorderDrag() {
  return M.dragId != null;
}

/* ================================================================== unir */

async function run() {
  const ready = M.items.filter((it) => it.status === 'ready' && !it.error);
  if (!ready.length) return;
  const name = ensurePdfExt(safeFileName($('#merge-name').value, 'unido'));
  const total = ready.reduce((s, it) => s + pagesOf(it), 0);
  const prog = progress();
  const signal = prog.open('Uniendo', `${plural(ready.length, 'archivo', 'archivos')} · ${plural(total, 'página', 'páginas')}`);
  prog.step(name);
  try {
    const r = await runQpdf({
      inputs: ready.map((it) => ({ file: it.file, password: it.password })),
      pages: ready.map((it, i) => ({ input: i, range: it.pages ? toRangeString(it.pages) : `1-${it.numPages}` })),
      outputs: [{ name }],
      trimResources: ready.some((it) => it.pages),
    }, { signal, onProgress: (d, t) => prog.set(d / t) });
    prog.close();
    results.add({ files: r.files, warnings: r.warnings, storage: r.storage, packs: [r.packName].filter(Boolean), title: 'Listo' });
    downloadFile(r.files[0]);
  } catch (err) {
    prog.close();
    if (isAbort(err)) toast('Se canceló la unión.');
    else toast(`No se pudieron unir los PDF: ${err.message}`, { type: 'error', timeout: 15000 });
  }
}

/* ================================================================== inicio */

export function initMerge() {
  results = new ResultsPanel($('#merge-results'), {
    zipName: () => 'unidos.zip',
  });

  const input = $('#file-merge');
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    if (files.length) addMergeFiles(files);
  });
  $('#merge-pick').addEventListener('click', () => input.click());
  $('#merge-add').addEventListener('click', () => input.click());

  $('#merge-sort').addEventListener('click', () => {
    const coll = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
    M.items.sort((a, b) => coll.compare(a.file.name, b.file.name));
    if (!M.nameEdited) $('#merge-name').value = defaultName();
    render();
  });
  $('#merge-clear').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Quitar todos los archivos', text: 'La lista va a quedar vacía. Los PDF ya generados se mantienen.', ok: 'Quitar todos' });
    if (!ok) return;
    for (const it of M.items) if (it.thumb) URL.revokeObjectURL(it.thumb.url);
    M.items = [];
    M.nameEdited = false;
    $('#merge-name').value = 'unido.pdf';
    render();
  });

  const list = $('#files');
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('li.file').dataset.id);
    if (btn.dataset.act === 'up') move(id, -1);
    else if (btn.dataset.act === 'down') move(id, 1);
    else removeItem(id);
  });
  list.addEventListener('input', (e) => {
    if (e.target.dataset.f !== 'range') return;
    const id = Number(e.target.closest('li.file').dataset.id);
    const it = M.items.find((x) => x.id === id);
    it.rangeText = e.target.value;
    computeRange(it);
    e.target.classList.toggle('invalid', !!it.error);
    const errEl = e.target.closest('li.file').querySelector('.ferror');
    errEl.hidden = !it.error;
    errEl.textContent = it.error || '';
    updateSummary();
  });
  setupDrag(list);

  $('#merge-name').addEventListener('input', () => {
    M.nameEdited = $('#merge-name').value.trim() !== '';
  });
  $('#merge-name').addEventListener('change', (e) => {
    if (e.target.value.trim()) e.target.value = ensurePdfExt(safeFileName(e.target.value));
  });
  $('#merge-run').addEventListener('click', run);
  render();
}
