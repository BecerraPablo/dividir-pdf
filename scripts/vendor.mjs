// Copia las librerías de node_modules a /vendor y aplica el parche a qpdf.js.
//
//   npm install
//   npm run vendor
//
// El sitio no tiene paso de build: lo que queda en /vendor se sube tal cual a GitHub Pages.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const vendor = join(root, 'vendor');

function copy(from, to) {
  const src = join(nm, from);
  if (!existsSync(src)) throw new Error(`Falta ${src}. ¿Corriste "npm install"?`);
  const dst = join(vendor, to);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
}

// ---------- PDF.js (build "legacy": incluye polyfills para navegadores no tan nuevos)
rmSync(join(vendor, 'pdfjs'), { recursive: true, force: true });
copy('pdfjs-dist/legacy/build/pdf.min.mjs', 'pdfjs/pdf.min.mjs');
copy('pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs');
copy('pdfjs-dist/cmaps', 'pdfjs/cmaps');
copy('pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts');
copy('pdfjs-dist/iccs', 'pdfjs/iccs');
for (const f of ['openjpeg.wasm', 'openjpeg_nowasm_fallback.js', 'qcms_bg.wasm', 'jbig2.wasm',
  'jbig2_nowasm_fallback.js', 'LICENSE_OPENJPEG', 'LICENSE_QCMS', 'LICENSE_JBIG2',
  'LICENSE_PDFJS_OPENJPEG', 'LICENSE_PDFJS_QCMS', 'LICENSE_PDFJS_JBIG2']) {
  copy(`pdfjs-dist/wasm/${f}`, `pdfjs/wasm/${f}`);
}
copy('pdfjs-dist/LICENSE', 'pdfjs/LICENSE');

// ---------- client-zip
rmSync(join(vendor, 'client-zip'), { recursive: true, force: true });
copy('client-zip/index.js', 'client-zip/index.js');
copy('client-zip/LICENSE.txt', 'client-zip/LICENSE.txt');

// ---------- qpdf (WebAssembly) + parche
// Los archivos LICENSE/NOTICE de qpdf, libjpeg-turbo y zlib ya están versionados en vendor/qpdf.
copy('@neslinesli93/qpdf-wasm/dist/qpdf.wasm', 'qpdf/qpdf.wasm');
let js = readFileSync(join(nm, '@neslinesli93/qpdf-wasm/dist/qpdf.js'), 'utf8');

// El "glue" de Emscripten viene minificado. Estos reemplazos están anclados a la versión 0.3.0;
// si alguno no aparece exactamente una vez, el script se detiene en vez de generar algo roto.
const patches = [
  {
    why: 'Dispositivos: avisar al abrir/cerrar (para saber dónde empieza y termina cada PDF de salida)',
    from: 'open(g){g.seekable=!1},close(){d?.buffer?.length&&d(10)},',
    to: 'open(g){g.seekable=!1;d?.onopen?.(g)},close(g){d?.onclose?.(g);d?.buffer?.length&&d(10)},',
  },
  {
    why: 'Dispositivos: escritura en bloque en lugar de una llamada a JS por cada byte (~4x más rápido)',
    from: 'write(g,h,k,m){for(var n=0;n<m;n++)try{d(h[k+n])}catch(l){throw new G.oa(29);}',
    to: 'write(g,h,k,m){if(d.bulk){try{d.bulk(h,k,m)}catch(l){throw new G.oa(29);}m&&(g.node.mtime=g.node.ctime=Date.now());return m}for(var n=0;n<m;n++)try{d(h[k+n])}catch(l){throw new G.oa(29);}',
  },
  {
    why: 'Exponer FS.createDevice (en el build minificado no está exportado)',
    from: 'Object.assign(G,{init:G.Pa,',
    to: 'Object.assign(G,{createDevice:G.Ga,init:G.Pa,',
  },
];
for (const p of patches) {
  const count = js.split(p.from).length - 1;
  if (count !== 1) throw new Error(`Parche no aplicable (${count} coincidencias): ${p.why}`);
  js = js.replace(p.from, p.to);
}
js = `/* qpdf ${'12.2.0'} compilado a WebAssembly por @neslinesli93/qpdf-wasm 0.3.0 (ISC).\n` +
  ` * qpdf: Apache-2.0 (ver LICENSE.txt / NOTICE.md). Parcheado por scripts/vendor.mjs:\n` +
  patches.map((p) => ` *  - ${p.why}\n`).join('') + ' */\n' + js;
mkdirSync(join(vendor, 'qpdf'), { recursive: true });
writeFileSync(join(vendor, 'qpdf/qpdf.js'), js);

console.log('vendor/ actualizado.');
