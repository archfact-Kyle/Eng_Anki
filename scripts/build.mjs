// Build: bundle src/ into ONE self-contained HTML, in two flavours.
//   dist/artifact/index.html → for the claude.ai artifact (no manifest / service worker)
//   dist/pwa/                → for GitHub Pages: index.html + manifest + sw.js + icons (home-screen app, offline)
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (...p) => path.join(root, ...p);

// Bump this whenever you ship, so installed phones drop the old offline cache.
const CACHE_VERSION = 'ankiwords-v8';

const result = await build({
  entryPoints: [r('src/main.js')],
  bundle: true, format: 'iife', minify: true, target: 'safari15', write: false, define: { __APP_VERSION__: JSON.stringify(CACHE_VERSION) }, logLevel: 'warning',
});
const js = result.outputFiles[0].text;
if (js.toLowerCase().includes('</script')) throw new Error('bundle contains </script> — would break inlining');

const shell = await readFile(r('src/shell.html'), 'utf8');
const inject = (html) => html.split('/*BUNDLE*/').join(js); // split/join: no $-pattern surprises

await mkdir(r('dist/artifact'), { recursive: true });
await mkdir(r('dist/pwa'), { recursive: true });

await writeFile(r('dist/artifact/index.html'), inject(shell.replace('<!--PWA-->', '')));
await writeFile(r('dist/pwa/index.html'), inject(shell.replace('<!--PWA-->',
  '<link rel="manifest" href="manifest.webmanifest">\n<link rel="apple-touch-icon" href="icon-180.png">\n<link rel="icon" href="icon-192.png">')));

await writeFile(r('dist/pwa/manifest.webmanifest'), JSON.stringify({
  name: '영어 문장 Anki', short_name: '영어 Anki', start_url: './', scope: './', display: 'standalone',
  background_color: '#f6f7f9', theme_color: '#1f6feb', lang: 'ko',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
}, null, 1));

await writeFile(r('dist/pwa/sw.js'), `const C='${CACHE_VERSION}';const A=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png','./icon-180.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(A)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r;}).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))));});
`);

// the app compares this with its own build to offer '앱 새로고침' when a new version is online
await writeFile(r('dist/pwa/version.json'), JSON.stringify({ v: CACHE_VERSION, built: new Date().toISOString() }));

for (const f of await readdir(r('public'))) await copyFile(r('public', f), r('dist/pwa', f));

const kb = (Buffer.byteLength(js) / 1024).toFixed(1);
console.log(`built dist/artifact/index.html and dist/pwa/ (bundle ${kb} KB, cache ${CACHE_VERSION})`);
