# Dividir y unir PDF

Herramienta web para **dividir** un PDF en varios archivos y **unir** varios PDF en uno, pensada para archivos grandes (probada con PDF de más de 1 GB). Todo se procesa en el navegador: los archivos no se suben a ningún servidor.



## Qué hace

**Dividir**

- Muestra todas las páginas en miniatura (se dibujan a medida que aparecen en pantalla).
- Cada archivo de salida es una "parte". Una parte se arma con un rango **desde / hasta**, escribiendo páginas sueltas (`1-5, 8, 12-`) o seleccionando miniaturas.
- Selección con clic, `Shift` + clic para rangos, `Ctrl/Cmd + A` para todas, y botones Todas / Ninguna / Invertir.
- **Partes iguales:** cortar cada N páginas (con N = 1 se obtiene un PDF por página).
- **Extraer a un PDF:** saca las páginas seleccionadas en un solo archivo.
- Vista ampliada de cualquier página (lupa o tecla `Z`).
- **Girar** 90° a la izquierda o derecha, o 180°: las páginas seleccionadas, una parte o todo el documento. Sin partes, "Generar PDF girado" descarga el documento entero con los giros. El giro no recomprime nada.

**Unir**

- Agregá varios PDF, ordenalos arrastrando o con las flechas, y opcionalmente elegí qué páginas tomar de cada uno.

En ambos casos los resultados se descargan de a uno o todos juntos en un ZIP. También abre PDF protegidos con contraseña (la pide).

## Cómo maneja archivos de varios GB

| Parte | Cómo funciona |
| --- | --- |
| Miniaturas | [PDF.js](https://mozilla.github.io/pdf.js/) lee el archivo **por rangos** desde el disco (`File.slice`), así que nunca lo carga entero en memoria. Si un documento enorme ya leyó mucho, se reabre para liberar RAM. |
| Cortar y unir | [qpdf](https://qpdf.sourceforge.io/) compilado a WebAssembly, dentro de un Web Worker. El archivo se monta "perezoso": qpdf solo lee los bloques que necesita. Las páginas se copian sin recomprimir (`--stream-data=preserve`), sin pérdida de calidad. |
| Resultados | Se escriben directo en el almacenamiento privado del navegador ([OPFS](https://developer.mozilla.org/docs/Web/API/File_System_API/Origin_private_file_system)), no en memoria. Si no está disponible (por ejemplo, en una ventana privada) se usa memoria como respaldo. |
| Limpieza | Al cerrar la pestaña, un service worker mínimo (`sw.js`, no intercepta pedidos ni guarda caché) borra los temporales de esa pestaña. Si no llegara a hacerlo, se borran la próxima vez que se abra la herramienta. |
| Muchos archivos de salida | "Partes iguales" usa una sola pasada de qpdf (`--split-pages`): dividir 5.000 páginas en 5.000 PDF tarda segundos. |

## Navegadores

Probada en **Chrome/Chromium** (Edge usa el mismo motor). Firefox y Safari recientes tienen todo lo que usa (WebAssembly, workers, OPFS), pero no se probó en ellos. En el teléfono funciona, aunque está pensada para la computadora. Para archivos muy grandes conviene una ventana normal (no de incógnito): en incógnito el navegador limita el espacio temporal.

## Limitaciones

- Al dividir o unir no se conservan los **marcadores** (índice lateral) del PDF original. Los enlaces internos que apuntan a páginas que no quedan en el archivo se descartan.
- Los formularios y anotaciones de las páginas copiadas se conservan.
- Si un PDF está muy dañado, PDF.js puede no abrirlo aunque qpdf podría repararlo.

## Desarrollo

No hay paso de compilación: el sitio es HTML, CSS y JavaScript (módulos ES) más las librerías ya copiadas en `vendor/`.

```bash
python3 -m http.server 8080   # y abrir http://localhost:8080
```

Para actualizar las librerías:

```bash
npm install
npm run vendor   # copia PDF.js, qpdf y client-zip a vendor/ y aplica el parche a qpdf.js
```

`scripts/vendor.mjs` aplica tres reemplazos pequeños al "glue" de Emscripten de qpdf (escritura en bloque, avisos de apertura/cierre de dispositivos y exponer `FS.createDevice`). Si una versión nueva no coincide, el script se detiene en lugar de generar algo roto.

### Estructura

```
index.html
sw.js                  borra los temporales al cerrar la pestaña
assets/
  css/app.css
  js/app.js            arranque, pestañas, arrastrar y soltar
  js/split-view.js     vista Dividir
  js/merge-view.js     vista Unir
  js/pdf-doc.js        PDF.js: apertura por rangos y miniaturas
  js/jobs.js           ejecuta los trabajos en workers
  js/qpdf-worker.js    qpdf + lectura perezosa + salida a OPFS
  js/zip-worker.js     ZIP sin compresión
  js/storage.js        temporales en OPFS
  js/pages.js, ui.js   utilidades
vendor/                PDF.js, qpdf (wasm), client-zip
```

## Créditos y licencias

- [PDF.js](https://github.com/mozilla/pdf.js) — Apache 2.0
- [qpdf](https://github.com/qpdf/qpdf) — Apache 2.0, compilado a WebAssembly por [@neslinesli93/qpdf-wasm](https://github.com/neslinesli93/qpdf-wasm) (ISC); incluye libjpeg-turbo y zlib (ver `vendor/qpdf/`)
- [client-zip](https://github.com/Touffy/client-zip) — MIT
- Tipografía [Barlow](https://github.com/jpt/barlow) — SIL Open Font License
