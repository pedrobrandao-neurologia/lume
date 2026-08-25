// sw.js — cache offline do Lume (app shell + vendor + fontes).
const VERSION = 'lume-v0.6.0'
const PRECACHE = [
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/ingest.js',
  './js/thumbs.js',
  './js/mip.js',
  './js/roi.js',
  './js/oblique.js',
  './js/zip-read.js',
  './vendor/niivue.min.js',
  './vendor/dcm2niix/index.jpeg.js',
  './vendor/dcm2niix/worker.jpeg.js',
  './vendor/dcm2niix/dcm2niix.jpeg.js',
  './vendor/dcm2niix/dcm2niix.jpeg.wasm',
  './fonts/archivo-wdth.woff2',
  './fonts/source-sans-3.woff2',
  './fonts/jetbrains-mono.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
]

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// cache-first: o app funciona offline; a rede só é usada para o que não estiver no cache
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(
      (hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone()
        caches.open(VERSION).then((c) => c.put(e.request, copy)).catch(() => {})
        return res
      })
    )
  )
})
