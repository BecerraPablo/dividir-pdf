// Arranque: pestañas, arrastrar y soltar archivos y limpieza del almacenamiento temporal.
import { initStorage, releaseSession } from './storage.js';
import { initSplit, loadSplitFile } from './split-view.js';
import { initMerge, addMergeFiles, isReorderDrag } from './merge-view.js';
import { toast, isPdfFile } from './ui.js';

function unsupported() {
  const missing = [];
  if (typeof Worker === 'undefined') missing.push('Web Workers');
  if (typeof WebAssembly === 'undefined') missing.push('WebAssembly');
  if (typeof FileReader === 'undefined') missing.push('FileReader');
  return missing;
}

/* ------------------------------------------------------------------ pestañas */

const TABS = { split: 'tab-split', merge: 'tab-merge' };
let current = 'split';

function selectTab(name, { focus = false, push = true } = {}) {
  current = name;
  for (const [key, id] of Object.entries(TABS)) {
    const tab = document.getElementById(id);
    const on = key === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !on;
    if (on && focus) tab.focus();
  }
  if (push) history.replaceState(null, '', name === 'merge' ? '#unir' : '#dividir');
}

function initTabs() {
  const list = document.querySelector('.tabs');
  list.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) selectTab(tab.id === TABS.merge ? 'merge' : 'split');
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    selectTab(current === 'split' ? 'merge' : 'split', { focus: true });
  });
  const fromHash = () => selectTab(/unir/i.test(location.hash) ? 'merge' : 'split', { push: false });
  window.addEventListener('hashchange', fromHash);
  fromHash();
}

/* ------------------------------------------------------------------ arrastrar archivos */

function hasFiles(e) {
  return [...(e.dataTransfer?.types || [])].includes('Files');
}

function initDragAndDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || isReorderDrag()) return;
    depth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e) || isReorderDrag()) return;
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || isReorderDrag()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e) || isReorderDrag()) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    if (current === 'merge') {
      addMergeFiles(files);
      return;
    }
    const pdfs = files.filter(isPdfFile);
    if (!pdfs.length) {
      toast('Eso no parece un PDF.', { type: 'error' });
      return;
    }
    if (pdfs.length > 1) {
      // Varios archivos en "Dividir": seguramente se quieren unir.
      selectTab('merge');
      addMergeFiles(pdfs);
      toast('Soltaste varios PDF: los agregué en “Unir”.');
      return;
    }
    loadSplitFile(pdfs[0]);
  });
}

/* ------------------------------------------------------------------ inicio */

async function main() {
  const missing = unsupported();
  if (missing.length) {
    toast(`Este navegador no tiene lo necesario (${missing.join(', ')}). Probá con Chrome, Edge o Firefox actualizados.`, { type: 'error', timeout: 0 });
    return;
  }
  initTabs();
  initSplit();
  initMerge();
  initDragAndDrop();
  await initStorage();
  // Borrar los temporales de esta pestaña al cerrarla (ver sw.js).
  window.addEventListener('pagehide', (e) => {
    if (!e.persisted) releaseSession();
  });
}

main().catch((err) => {
  console.error(err);
  toast(`Error al iniciar: ${err.message}`, { type: 'error', timeout: 0 });
});
