/*
 * VibeRevise: service worker.
 *
 * Two jobs, and neither is caching anyone's document.
 *
 *   1. Make the app installable. A browser will only offer "install" or a
 *      real Add to Home Screen for a page with a manifest and a worker.
 *   2. Make it work offline. That is not a nicety here: the whole premise is
 *      that your file never leaves the browser, so needing a network to edit
 *      it would be a strange contradiction. Once loaded, VibeRevise works on a
 *      plane.
 *
 * Only the app's own shell is cached: its markup, styles and the editor. The
 * documents you open are never stored by this worker, and never leave the tab.
 */
'use strict';

// Bump this to retire the previous cache. It is the app's shell version, not
// the extension's.
const CACHE = 'viberevise-shell-v13';

const SHELL = [
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'sample.html',
  'lib/errors.js',
  'lib/tokenizer.js',
  'lib/splice.js',
  'lib/origins.js',
  'lib/mapping.js',
  'lib/islands.js',
  'lib/blocks.js',
  'lib/structures.js',
  'lib/comments.js',
  'lib/prompt.js',
  'lib/ai.js',
  'lib/rebase.js',
  'lib/editor.js',
  'icons/icon192.png',
  'icons/icon512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/*
 * Cache first for the shell, network for everything else.
 *
 * A document fetched with ?src= is deliberately NOT cached: it belongs to
 * whoever served it, it may change, and a stale copy would be mapped against
 * offsets that no longer describe it.
 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  // AI requests are POSTs to the user's provider, so they pass straight
  // through: never cached, never touched.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // someone else's document

  event.respondWith(
    caches.match(req, { ignoreSearch: false }).then((hit) => {
      if (hit) return hit;
      return fetch(req).catch(() => caches.match('index.html'));
    })
  );
});
