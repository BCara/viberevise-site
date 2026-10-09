/*
 * VibeRevise — the web app.
 *
 * The extension edits the page it was injected into. This edits a file you
 * choose, rendered into an iframe, and the editor is told to work on that
 * document instead of this one. Everything below the editor — the tokenizer,
 * the offset map, the islands, the structures — is the same code, unchanged.
 *
 * WHY AN IFRAME
 * -------------
 * The offset map pairs spans of the source text with nodes of the DOM the
 * browser built from exactly those bytes. So the document has to be really
 * parsed, by the real parser, and left alone afterwards. An iframe written to
 * with document.write() gives precisely that, and keeps the user's CSS from
 * leaking into the app's chrome or the other way round.
 *
 * It is sandboxed with allow-same-origin and NOT allow-scripts. That pairing is
 * the point: no script inside the user's document can run — it could otherwise
 * reach `parent` and take over the app, since the frame shares this origin —
 * while this page keeps full DOM access to edit it. (allow-same-origin together
 * WITH allow-scripts is the combination that is unsafe; this is the other one.)
 *
 * SAVING
 * ------
 * Three routes, best first, decided by what the browser actually offers:
 *
 *   1. A file handle — Chrome, Edge and Opera on the desktop. The file the user
 *      opened is rewritten in place. No copy, no Downloads folder, no dialog
 *      after the first one. This is the thing the extension cannot do at all:
 *      Chrome will not let an extension write to a file:// path.
 *   2. The share sheet — Android. Hands the edited file to whichever app it
 *      came from. Offered only when navigator.canShare() agrees, because iOS
 *      Safari has been known to accept the call and share the text instead.
 *   3. A download. Always available, always last.
 */
'use strict';

var els = {
  open: document.getElementById('open'),
  openMain: document.getElementById('open-main'),
  save: document.getElementById('save'),
  frame: document.getElementById('frame'),
  welcome: document.getElementById('welcome'),
  filename: document.getElementById('filename'),
  toast: document.getElementById('toast'),
  saveStory: document.getElementById('save-story'),
  saveStoryTitle: document.getElementById('save-story-title'),
  dropHint: document.getElementById('drop-hint'),
};

var current = {
  name: 'document.html',
  handle: null,      // a FileSystemFileHandle, when the browser gave us one
  source: '',
};

var CAN_HANDLE = typeof window.showOpenFilePicker === 'function';

var RECENTS_KEY = 'viberevise:recent-network-documents';

// --- your name ----------------------------------------------------------------

// Stored in this browser only.
var STORE = {
  author: 'viberevise:author',
  commentsVisible: 'viberevise:comments-visible',
};

function readStore(key) {
  try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
}
function writeStore(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (e) { /* a private window may refuse; the setting just will not stick */ }
}

var SETTINGS = {
  get: function (key) {
    var raw = readStore(STORE[key] || key);
    // The editor stores a boolean here; localStorage only holds strings.
    if (key === 'commentsVisible') return Promise.resolve(raw === 'true');
    return Promise.resolve(raw);
  },
  set: function (key, value) {
    writeStore(STORE[key] || key, value === true ? 'true' : (value || ''));
    return Promise.resolve();
  },
};

var RECENTS_MAX = 6;

// --- AI, with your own key -----------------------------------------------------

/*
 * The app has no background worker to hide a key in, so it makes the request
 * itself, straight from this page to the provider. The key is kept in this
 * origin's storage and nowhere else; the document being edited cannot read it,
 * because its frame is sandboxed without scripts (see the top of this file).
 */
var AI = window.VibeReviseAI;
var AI_KEY = 'viberevise:ai';

function readAIConfig() {
  try {
    var raw = localStorage.getItem(AI_KEY);
    return raw ? AI.normaliseConfig(JSON.parse(raw)) : null;
  } catch (e) { return null; }
}

function writeAIConfig(cfg) {
  try {
    if (cfg) {
      localStorage.setItem(AI_KEY, JSON.stringify({
        provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey,
        access: cfg.access,
      }));
    } else {
      localStorage.removeItem(AI_KEY);
    }
    return true;
  } catch (e) { return false; }    // a private window may refuse
}

/*
 * The editing session, kept through a reload, under the file's name. This
 * app's own storage on this device; never sent anywhere. A file too big to
 * keep is simply not kept, and the editor says so.
 */
function sessionFor(name) {
  var key = 'viberevise:session:' + name;
  return {
    load: function () {
      try { var raw = localStorage.getItem(key); return Promise.resolve(raw ? JSON.parse(raw) : null); }
      catch (e) { return Promise.resolve(null); }
    },
    save: function (snap) {
      try { localStorage.setItem(key, JSON.stringify(snap)); return Promise.resolve(); }
      catch (e) { return Promise.reject(e); }
    },
    clear: function () {
      try { localStorage.removeItem(key); } catch (e) { /* nothing to clear */ }
      return Promise.resolve();
    },
  };
}

/*
 * What the open file holds now, so the editor can notice another program
 * changing it. Through the handle when there is one, or the address it was
 * fetched from; null when it cannot be told. Bringing the changes in is a
 * fresh load of the new text, with the kept session carrying the edits over.
 */
function watchFor() {
  var url = current.url || null;
  return {
    read: function () {
      if (current.handle) {
        return current.handle.getFile().then(function (f) { return f.text(); }).catch(function () { return null; });
      }
      if (url) {
        return fetch(url, { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : null; })
          .catch(function () { return null; });
      }
      return Promise.resolve(null);
    },
    bringIn: function () {
      return this.read().then(function (text) {
        if (text != null) return load(text, current.name, current.handle, current.url);
      });
    },
    bringInLabel: 'Bring the changes in',
  };
}

// Handed to the editor as options.ai.
var AI_HOST = {
  status: function () {
    var cfg = readAIConfig();
    if (!cfg) return Promise.resolve({ configured: false, problem: 'Not set up yet.' });
    var problem = AI.configProblem(cfg);
    var host = '';
    try { host = new URL(cfg.baseUrl).host; } catch (e) { /* reported by problem */ }
    return Promise.resolve(problem ? { configured: false, problem: problem, host: host }
                                   : { configured: true, label: AI.describe(cfg), host: host, access: cfg.access });
  },
  complete: function (request) {
    var cfg = readAIConfig();
    if (!cfg) return Promise.resolve({ ok: false, message: 'AI is not set up.' });
    return AI.complete(cfg, request, function (url, init) { return fetch(url, init); });
  },
  openSettings: function () { openSettings(true); },
};

// --- chrome ------------------------------------------------------------------

var toastTimer = 0;
function toast(message, tone) {
  els.toast.textContent = message;
  els.toast.className = 'toast' + (tone ? ' ' + tone : '');
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { els.toast.hidden = true; }, 5000);
}

/*
 * Say up front how saving will work here, because it differs by browser and
 * finding out at save time is the wrong moment. Firefox and Safari do not
 * implement the file pickers — Mozilla considers them harmful — so those users
 * get a download and should know before they start.
 */
function describeSaving() {
  if (CAN_HANDLE) {
    els.saveStoryTitle.textContent = 'Saving';
    els.saveStory.textContent =
      'Save writes straight back to the file you opened. No copy, nothing in ' +
      'your Downloads folder.';
    return;
  }
  els.saveStoryTitle.textContent = 'Saving in this browser';
  els.saveStory.textContent =
    'This browser will not let a web page write to a file, so Save gives you ' +
    'the edited copy to put back yourself. Chrome or Edge on a computer can ' +
    'write in place.';
  els.dropHint.hidden = true;     // no drag and drop worth speaking of on touch
}

// --- opening -----------------------------------------------------------------

async function openWithPicker() {
  var handles;
  try {
    handles = await window.showOpenFilePicker({
      types: [{
        description: 'HTML document',
        accept: { 'text/html': ['.html', '.htm', '.xhtml'] },
      }],
      multiple: false,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return;   // they changed their mind
    throw err;
  }
  var handle = handles[0];
  var file = await handle.getFile();
  await load(await file.text(), file.name, handle);
}

function openWithInput() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.html,.htm,.xhtml,text/html';
  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (file) file.text().then(function (text) { load(text, file.name, null); });
  });
  input.click();
}

function openFile() {
  (CAN_HANDLE ? openWithPicker() : Promise.resolve(openWithInput()))
    .catch(function (err) { toast('Could not open that file: ' + err.message, 'warn'); });
}

/*
 * A file that is not UTF-8 would have been decoded wrongly on the way in, and
 * writing it back would corrupt every non-ASCII character. The extension
 * refuses these rather than quietly mangling them, and so does this.
 */
function encodingProblem(source) {
  if (source.indexOf('�') !== -1) {
    return 'This file is not valid UTF-8. VibeRevise would corrupt it, so it will not open it.';
  }
  var meta = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(source.slice(0, 4096));
  if (meta) {
    var cs = meta[1].toLowerCase();
    if (cs !== 'utf-8' && cs !== 'utf8') {
      return 'This file declares charset "' + meta[1] + '". VibeRevise only handles UTF-8.';
    }
  }
  return null;
}

// Write the document into the frame with the real parser, and wait for it.
function render(source) {
  return new Promise(function (resolve) {
    var frame = els.frame;
    frame.hidden = false;
    var d = frame.contentDocument;
    d.open();
    d.write(source);
    d.close();

    // document.write is synchronous, so the DOM exists the moment it returns;
    // the wait is only to let layout settle before the editor measures against
    // real geometry.
    //
    // It cannot be a bare requestAnimationFrame. A hidden tab does not paint,
    // so rAF never fires there, and opening a document in a background tab
    // would hang for ever with no error. Whichever comes first wins.
    var settled = false;
    function ready() {
      if (settled) return;
      settled = true;
      resolve(d);
    }
    requestAnimationFrame(ready);
    setTimeout(ready, 50);
  });
}

// `url`: where a fetched document came from, so it can be read again.
async function load(source, name, handle, url) {
  var problem = encodingProblem(source);
  if (problem) { toast(problem, 'warn'); return; }

  current.source = source;
  current.name = name || 'document.html';
  current.handle = handle;
  current.url = url || null;

  var d = await render(source);
  var map = window.VibeReviseMap.build(source, d);

  if (!map.stats.editable) {
    toast('VibeRevise could not find any editable text in that file.', 'warn');
  }

  window.VibeReviseEditor.init({
    /*
     * The editor ignores synthetic events in the extension, because a page it
     * did not write could forge them. Here it may trust them, and not as a
     * concession: the document is in a frame sandboxed WITHOUT allow-scripts,
     * so nothing in it runs at all. The only code that can dispatch an event
     * into that document is this app. See the sandbox note at the top of this
     * file, and fromUser() in editor.js.
     */
    trustSynthetic: true,
    doc: d,
    source: source,
    map: map,
    filename: current.name,
    saveFile: saveFile,
    settings: SETTINGS,
    ai: AI ? AI_HOST : null,
    session: sessionFor(current.name),
    watch: watchFor(),
    fresh: true,
  });
  window.VibeReviseEditor.setActive(true);

  els.welcome.hidden = true;
  els.filename.hidden = false;
  els.filename.textContent = current.name;
  els.save.hidden = false;
  document.body.classList.add('editing');
  watchUnsaved();

  toast(map.stats.editable + ' editable text region' +
        (map.stats.editable === 1 ? '' : 's') + ' — click any of them and type.');
}

// --- saving ------------------------------------------------------------------

async function writeThroughHandle(text) {
  var writable = await current.handle.createWritable();
  await writable.write(new Blob([text], { type: 'text/html;charset=utf-8' }));
  await writable.close();
  return { ok: true, inPlace: true, where: 'Saved to ' + current.name };
}

function fileFor(text) {
  return new File([text], current.name, { type: 'text/html' });
}

async function shareFile(text) {
  await navigator.share({ files: [fileFor(text)], title: current.name });
  return { ok: true, where: 'Shared ' + current.name };
}

function downloadFile(text) {
  var url = URL.createObjectURL(new Blob([text], { type: 'text/html;charset=utf-8' }));
  var a = document.createElement('a');
  a.href = url;
  a.download = current.name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 60000);
  return { ok: true, where: 'Downloaded ' + current.name + ' — put it back over the original' };
}

/*
 * Handed to the editor as options.saveFile, so Save in its own bar comes here
 * rather than going near the extension's download plumbing.
 */
// Save as: a new place to write, which Save then keeps using. Without a save
// picker (Firefox, Safari, phones) it is a download, which asks where anyway.
function saveFileAs(text) {
  if (typeof window.showSaveFilePicker !== 'function') return Promise.resolve(downloadFile(text));
  return window.showSaveFilePicker({
    suggestedName: current.name,
    startIn: current.handle || undefined,
    types: [{ description: 'HTML document', accept: { 'text/html': ['.html', '.htm'] } }],
  }).then(function (handle) {
    current.handle = handle;
    current.name = handle.name;
    els.filename.textContent = current.name;
    return writeThroughHandle(text);
  }, function (err) {
    if (err && err.name === 'AbortError') return { ok: false, message: 'Save cancelled' };
    return downloadFile(text);
  });
}

function saveFile(text, opts) {
  if (opts && opts.as) return saveFileAs(text);
  if (current.handle) {
    return writeThroughHandle(text).catch(function (err) {
      // Permission can lapse, or the file can have gone. Never lose the edits
      // over it — fall back rather than fail.
      console.warn('[VibeRevise] writing through the handle failed:', err);
      return downloadFile(text);
    });
  }

  if (navigator.canShare && navigator.canShare({ files: [fileFor(text)] })) {
    return shareFile(text).catch(function (err) {
      if (err && err.name === 'AbortError') return { ok: false, message: 'Sharing cancelled' };
      return downloadFile(text);
    });
  }

  return Promise.resolve(downloadFile(text));
}

// --- documents on your own network -------------------------------------------

/*
 * Anything on the user's own network: a NAS, a documents server, a static site
 * being previewed. Public origins are refused, and the refusal is worth stating
 * plainly because it looks arbitrary otherwise — the byte-preservation
 * guarantee rests on re-reading exactly the bytes the browser parsed, which
 * holds for a file server and does not hold for a page rendered per request.
 *
 * The same rule the extension applies to itself, from the same module.
 */
function networkProblem(value) {
  var u;
  try {
    u = new URL(value);
  } catch (e) {
    return 'That does not look like a web address. It should start with http://';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return 'Only http:// and https:// addresses.';
  }
  if (!window.VibeReviseOrigins.isPrivateHost(u.hostname)) {
    return u.hostname + ' is not on your own network, so VibeRevise will not ' +
           'open it. Addresses like 192.168.x.x, 10.x.x.x, localhost or a ' +
           '.local name are what it expects.';
  }
  if (!/\.x?html?$/i.test(u.pathname)) {
    return 'That path does not end in .html, .htm or .xhtml.';
  }
  return null;
}

function readRecents() {
  try {
    var raw = localStorage.getItem(RECENTS_KEY);
    var list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];     // private window, cleared storage, storage refused entirely
  }
}

function rememberRecent(url) {
  try {
    var list = readRecents().filter(function (u) { return u !== url; });
    list.unshift(url);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX)));
  } catch (e) { /* not worth failing an open over */ }
  renderRecents();
}

function forgetRecent(url) {
  try {
    localStorage.setItem(RECENTS_KEY,
      JSON.stringify(readRecents().filter(function (u) { return u !== url; })));
  } catch (e) { /* as above */ }
  renderRecents();
}

function renderRecents() {
  var list = readRecents();
  var wrap = document.getElementById('recents-wrap');
  var ul = document.getElementById('recents');
  wrap.hidden = list.length === 0;
  ul.textContent = '';

  list.forEach(function (url) {
    var li = document.createElement('li');

    var open = document.createElement('button');
    open.type = 'button';
    open.className = 'recent-open';
    var name = decodeURIComponent(url.split('/').pop().split('?')[0]) || url;
    open.innerHTML = '';
    var strong = document.createElement('span');
    strong.className = 'recent-name';
    strong.textContent = name;
    var where = document.createElement('span');
    where.className = 'recent-host';
    try { where.textContent = new URL(url).host; } catch (e) { where.textContent = url; }
    open.appendChild(strong);
    open.appendChild(where);
    open.addEventListener('click', function () { openNetwork(url); });

    var drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'recent-forget';
    drop.title = 'Forget this one';
    drop.setAttribute('aria-label', 'Forget ' + name);
    drop.textContent = '\u00d7';
    drop.addEventListener('click', function () { forgetRecent(url); });

    li.appendChild(open);
    li.appendChild(drop);
    ul.appendChild(li);
  });
}

function netMessage(text, tone) {
  var el = document.getElementById('net-msg');
  el.textContent = text || '';
  el.className = 'net-msg' + (tone ? ' ' + tone : '');
}

function openNetwork(url) {
  var problem = networkProblem(url);
  if (problem) { netMessage(problem, 'warn'); return; }

  netMessage('Fetching…');
  var from = null;
  resolveSrc(url)
    .then(function (resolved) { from = resolved; return fetch(resolved, { credentials: 'same-origin' }); })
    .then(function (r) {
      if (!r.ok) throw new Error('the server answered ' + r.status);
      return r.text();
    })
    .then(function (text) {
      var name = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'document.html';
      rememberRecent(url);
      netMessage('');
      // No file handle behind a fetched document, so Save shares or downloads.
      return load(text, name, null, from);
    })
    .catch(function (err) {
      netMessage('Could not open it — ' + err.message, 'warn');
    });
}

// --- wiring ------------------------------------------------------------------

// Ctrl/Cmd+S from the app's own bar, not only from inside the document.
window.addEventListener('keydown', function (e) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || (e.key || '').toLowerCase() !== 's') return;
  e.preventDefault();
  if (!current.source || !window.VibeReviseEditor) return;
  if (e.shiftKey) window.VibeReviseEditor.saveAs(); else window.VibeReviseEditor.save();
});

function watchUnsaved() {
  setInterval(function () {
    var s = window.VibeReviseEditor.status();
    els.save.disabled = s.unsaved === 0;
  }, 300);

  window.addEventListener('beforeunload', function (e) {
    if (window.VibeReviseEditor.status().unsaved > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/*
 * ?src=<url> opens a document straight into the editor.
 *
 * Convenient for a bookmark, and the seed of something larger: a link that
 * opens somebody else's document ready to be marked up is the whole shape of
 * sending a document out for review. The URL has to be same-origin or
 * CORS-permitted, and the file is fetched, not uploaded — nothing leaves the
 * browser either way.
 *
 * There is no file handle behind a fetched document, so Save will share or
 * download rather than write in place. That is stated when it opens rather
 * than discovered at save time.
 */
/*
 * A browser refuses fetch() from an https page to an http URL — mixed content,
 * decided before CORS is even looked at. The app has to be on https to be
 * installable, and documents on a home network are usually on plain http, so
 * that combination is the normal case rather than an edge one.
 *
 * Where the host offers /fetch, the request goes through it and arrives on this
 * origin instead. Where it does not — a static host with no backend — there is
 * nothing to be done in the page, and saying so beats a blocked request and a
 * console error nobody sees.
 */
var proxyAvailable = null;     // unknown until asked, then remembered

function hasProxy() {
  if (proxyAvailable !== null) return Promise.resolve(proxyAvailable);
  return fetch('fetch', { method: 'HEAD' })
    .then(function (r) {
      // 400 means it is there and wants a url; 404 means there is no proxy.
      proxyAvailable = r.status !== 404;
      return proxyAvailable;
    })
    .catch(function () { proxyAvailable = false; return false; });
}

/*
 * Where to fetch a document from, given where this page is running.
 *
 * Prefer the host's own /fetch when it has one. It is on this origin, so it is
 * reachable whenever the app itself is, and it solves two problems that would
 * otherwise bite in opposite situations:
 *
 *   - the page is on https and the document on http, which no browser will mix
 *   - the page is reached from outside the network the document lives on — over
 *     a mesh, say — so this device cannot route to 192.168.x at all, while the
 *     machine serving the app is sitting on that network and can
 *
 * Without a proxy, which is any static host, the page fetches directly and that
 * works whenever the browser can see the document's host itself.
 */
function resolveSrc(src) {
  var absolute = /^https?:\/\//i.test(src);
  if (!absolute) return Promise.resolve(src);

  return hasProxy().then(function (available) {
    if (available) return 'fetch?url=' + encodeURIComponent(src);

    if (location.protocol === 'https:' && /^http:\/\//i.test(src)) {
      throw new Error(
        'This page is on https and that document is on http, which browsers ' +
        'will not mix. Serve the document over https, or open the app over ' +
        'http, or download the file and open it with the button above.');
    }
    return src;
  });
}

function openFromQuery() {
  var src = new URLSearchParams(location.search).get('src');
  if (!src) return;
  var from = null;
  resolveSrc(src)
    .then(function (url) { from = url; return fetch(url, { credentials: 'same-origin' }); })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then(function (text) {
      // From the document's own URL, never the proxy wrapper around it.
      var name = decodeURIComponent(src.split('/').pop().split('?')[0]) || 'document.html';
      return load(text, name, null, from);
    })
    .catch(function (err) {
      toast('Could not open ' + src + ' — ' + err.message, 'warn');
    });
}

els.open.addEventListener('click', openFile);
els.openMain.addEventListener('click', openFile);

(function wireNetworkPanel() {
  var toggle = document.getElementById('net-toggle');
  var form = document.getElementById('net-form');
  var input = document.getElementById('net-url');

  toggle.addEventListener('click', function () {
    var opening = form.hidden;
    form.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    if (opening) input.focus();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var value = input.value.trim();
    if (value) openNetwork(value);
  });

  // Say what is wrong while they are still typing, not after they commit.
  input.addEventListener('input', function () {
    var value = input.value.trim();
    if (!value) { netMessage(''); return; }
    var problem = networkProblem(value);
    netMessage(problem || '', problem ? 'warn' : '');
  });

  renderRecents();
})();
els.save.addEventListener('click', function () { window.VibeReviseEditor.save(); });

// Drop a file anywhere. Only useful with a pointer, so it is not advertised on
// touch, but it costs nothing to leave working.
['dragover', 'drop'].forEach(function (type) {
  document.addEventListener(type, function (e) {
    e.preventDefault();
    if (type !== 'drop') return;
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) file.text().then(function (text) { load(text, file.name, null); });
  });
});

/*
 * Register the service worker, which is what makes the app installable and
 * lets it work with no network.
 *
 * It needs a secure context: https, or localhost. Served over plain http on a
 * LAN address it simply will not register, and the app still works — it just
 * cannot be installed from there. Nothing here treats that as an error.
 */
function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) {
    console.info('[VibeRevise] not a secure context, so no offline support or ' +
                 'install here. Serve over https and it appears.');
    return;
  }
  navigator.serviceWorker.register('sw.js').catch(function (err) {
    console.warn('[VibeRevise] the service worker did not register:', err);
  });
}

/*
 * A file opened from the operating system, once the app is installed and
 * registered as an HTML handler — double-clicking a document, or Open With.
 * The handle comes with it, so Save writes straight back to that file.
 */
function acceptLaunchedFile() {
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(function (params) {
    if (!params || !params.files || !params.files.length) return;
    var handle = params.files[0];
    handle.getFile()
      .then(function (file) { return file.text().then(function (t) { return [t, file.name]; }); })
      .then(function (pair) { return load(pair[0], pair[1], handle); })
      .catch(function (err) { toast('Could not open that file: ' + err.message, 'warn'); });
  });
}

// --- the settings dialog ----------------------------------------------------------

function openSettings(toAI) {
  var dlg = document.getElementById('settings');
  document.getElementById('set-author').value = readStore(STORE.author);
  fillAIForm(readAIConfig());
  settingsStatus('');
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
  if (toAI === true) {
    document.getElementById('ai-section').scrollIntoView({ block: 'start' });
    document.getElementById(readAIConfig() ? 'set-ai-model' : 'set-ai-key').focus();
  }
}

var aiEls = {
  provider: document.getElementById('set-ai-provider'),
  url: document.getElementById('set-ai-url'),
  model: document.getElementById('set-ai-model'),
  key: document.getElementById('set-ai-key'),
  hint: document.getElementById('set-ai-hint'),
  write: document.getElementById('set-ai-write'),
};
var aiLastProvider = 'anthropic';

/*
 * Switching provider fills in its address and default model, but only over
 * the previous provider's defaults — never over something the user typed.
 */
function applyAIPreset(next) {
  var was = AI.PROVIDERS[aiLastProvider];
  var now = AI.PROVIDERS[next];
  if (!aiEls.url.value.trim() || aiEls.url.value.trim() === was.baseUrl) aiEls.url.value = now.baseUrl;
  if (!aiEls.model.value.trim() || aiEls.model.value.trim() === was.model) aiEls.model.value = now.model;
  aiEls.hint.textContent = now.keyHint || '';
  aiEls.key.placeholder = now.keyRequired ? 'Paste your key' : 'Optional for a local server';
  aiLastProvider = next;
}

function fillAIForm(cfg) {
  if (!AI) return;
  cfg = cfg || AI.normaliseConfig({ provider: 'anthropic' });
  aiEls.provider.value = cfg.provider;
  aiLastProvider = cfg.provider;
  aiEls.url.value = cfg.baseUrl;
  aiEls.model.value = cfg.model;
  aiEls.key.value = cfg.apiKey;
  aiEls.write.checked = cfg.access === 'write';
  document.getElementById('set-ai-read').checked = cfg.access !== 'write';
  applyAIPreset(cfg.provider);
}

function readAIForm() {
  return AI.normaliseConfig({
    provider: aiEls.provider.value, baseUrl: aiEls.url.value,
    model: aiEls.model.value, apiKey: aiEls.key.value,
    access: aiEls.write.checked ? 'write' : 'read',
  });
}

// Something worth saving: a key, or a keyless local server with a model.
function aiFormInUse(cfg) {
  return !!(cfg.apiKey || (cfg.provider === 'custom' && cfg.baseUrl && cfg.model));
}

function tellEditorAI() {
  if (window.VibeReviseEditor && current.source) window.VibeReviseEditor.aiSettingsChanged();
}

function settingsStatus(text, tone) {
  var el = document.getElementById('set-status');
  el.textContent = text;
  el.className = 'hint' + (tone ? ' ' + tone : '');
}

(function wireSettings() {
  var dlg = document.getElementById('settings');
  document.getElementById('settings-open').addEventListener('click', function () { openSettings(); });

  if (AI) {
    Object.keys(AI.PROVIDERS).forEach(function (id) {
      var opt = document.createElement('option');
      opt.value = id;
      opt.textContent = AI.PROVIDERS[id].label;
      aiEls.provider.appendChild(opt);
    });
    aiEls.provider.addEventListener('change', function () { applyAIPreset(aiEls.provider.value); });

    // Tests what is in the form, saved or not, so a typo is found before Save.
    document.getElementById('set-ai-test').addEventListener('click', function () {
      var cfg = readAIForm();
      var problem = AI.configProblem(cfg);
      if (problem) { settingsStatus(problem, 'bad'); return; }
      settingsStatus('Asking ' + AI.describe(cfg) + ' for a one-word answer\u2026');
      AI.complete(cfg, AI.pingRequest(), function (url, init) { return fetch(url, init); })
        .then(function (res) {
          if (res.ok) settingsStatus('It works \u2014 ' + AI.describe(cfg) + ' answered. Press Save to keep it.', 'good');
          else settingsStatus(res.message, 'bad');
        });
    });
    document.getElementById('set-ai-forget').addEventListener('click', function () {
      writeAIConfig(null);
      fillAIForm(null);
      tellEditorAI();
      settingsStatus('Forgotten. The key is gone from this browser.', 'good');
    });
  } else {
    document.getElementById('ai-section').hidden = true;
  }
  document.getElementById('set-cancel').addEventListener('click', function () { dlg.close(); });

  document.getElementById('settings-form').addEventListener('submit', function () {
    var name = document.getElementById('set-author').value.replace(/\s+/g, ' ').trim().slice(0, 60);
    writeStore(STORE.author, name);
    // An open document picks the name up straight away.
    if (window.VibeReviseEditor && current.source) window.VibeReviseEditor.setAuthor(name);

    var message = 'Saved.';
    if (AI) {
      var cfg = readAIForm();
      if (aiFormInUse(cfg)) {
        writeAIConfig(cfg);
        var problem = AI.configProblem(cfg);
        message = problem ? 'Saved, but AI is not ready yet: ' + problem
                          : 'Saved. AI suggestions use ' + AI.describe(cfg) + '.';
      } else if (readAIConfig()) {
        writeAIConfig(null);        // the key field was cleared: that is "off"
        message = 'Saved. AI is off.';
      }
      tellEditorAI();
    }
    toast(message);
  });
})();

describeSaving();
registerWorker();
acceptLaunchedFile();
openFromQuery();

// Exposed for the test suite: driving a real file picker from a headless
// browser is not possible, so the suite calls load() directly with the bytes a
// picker would have handed over.
window.__vibeReviseApp = {
  load: load,
  saveFile: saveFile,
  settings: SETTINGS,
  current: current,
  canHandle: CAN_HANDLE,
  ai: AI_HOST,
  readAIConfig: readAIConfig,
  writeAIConfig: writeAIConfig,
};
