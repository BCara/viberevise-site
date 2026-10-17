/*
 * VibeRevise: error reports.
 *
 * When something in VibeRevise breaks, a short report goes to the developer so
 * it can be fixed without anyone having to write in. One file for every place
 * the code runs: the landing pages, the web app, and the extension's popup,
 * settings page, background worker and content script.
 *
 * What a report holds, and nothing else:
 *   brand, surface (site, app or extension) and part (popup, editor, ...)
 *   the error's message and stack, and the script file and line it came from
 *   the page's path on our own site (never the address of a document)
 *   the version, and the browser's user agent
 *   the time it arrived
 *
 * What it never holds: the document, its address or file name, any text from
 * it, comments, names, or AI keys. Messages and stacks are scrubbed before they
 * leave: every address that is not one of our own scripts becomes <url>, and
 * anything shaped like a key or token becomes <redacted>. store/PRIVACY.md says
 * the same thing in plain words; change one, change the other.
 *
 * Reports go straight to a Firestore collection whose rules accept new reports
 * of exactly this shape and refuse everything else, reads included
 * (firestore.rules). At most MAX_PER_PAGE go from one page load, and the same
 * error is only sent once. Sending can never throw, and a failed send is
 * dropped silently, never reported.
 *
 *   <script src="lib/errors.js" data-surface="app" data-version="0.17.0"></script>
 *     installs itself, for pages that only need the defaults
 *   VibeReviseErrors.install({ surface, part, version, own, transport })
 *     installs explicitly; see install() below
 *   VibeReviseErrors.report(err, kind)
 *     reports an error that was caught, but should not have happened
 */
(function (root) {
  'use strict';

  // Both brands report to the one Firebase project. Spelled in two pieces so
  // the brand rename (sites/brand-app.js, pack-extension.js) leaves it alone,
  // while BRAND below is renamed as it should be.
  var PROJECT = 'vibe' + 'revise';
  var DB = 'projects/' + PROJECT + '/databases/(default)/documents';
  var ENDPOINT = 'https://firestore.googleapis.com/v1/' + DB + ':commit';
  var BRAND = 'viberevise';

  var MAX_PER_PAGE = 20;
  var LIMITS = { part: 40, message: 1000, stack: 4000, source: 300, page: 300, version: 40, browser: 300 };

  var config = null;
  var sent = Object.create(null);
  var count = 0;

  // ---- scrubbing -----------------------------------------------------------

  // Our own script addresses are kept, because they say where the error is.
  // Anything else could be a document's address, so it goes.
  function ownUrl(u) {
    return /^(chrome|moz)-extension:\/\//.test(u) ||
      (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) &&
       u.indexOf(location.origin + '/') === 0);
  }

  function scrub(s, max) {
    s = String(s == null ? '' : s)
      .replace(/\b(?:[a-z][a-z0-9+.-]*):\/\/[^\s)'"<>]*/gi, function (u) {
        // Drop a query or hash, but keep the :line:column after it.
        return ownUrl(u) ? u.replace(/[?#].*?(?=(?::\d+)*$)/, '') : '<url>';
      })
      .replace(/(?:\b[A-Za-z]:\\|(?<![\w/])\/(?:Users|home)\/)[^\s)'"<>]*/g, '<path>')
      .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '<redacted>')
      .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '<redacted>')
      .replace(/\b(?:Bearer|x-api-key:?)\s+\S+/gi, '<redacted>')
      .replace(/[A-Za-z0-9_\-+/=]{40,}/g, '<redacted>');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  // ---- building a report ---------------------------------------------------

  function describe(err) {
    if (err && typeof err === 'object') {
      var msg = err.message != null ? err.message : String(err);
      if (err.name && err.name !== 'Error' && msg.indexOf(err.name) !== 0) msg = err.name + ': ' + msg;
      return { message: msg, stack: err.stack || '' };
    }
    return { message: String(err), stack: '' };
  }

  function build(kind, err, source) {
    var d = describe(err);
    var r = {
      brand: BRAND,
      surface: config.surface,
      part: config.part,
      kind: kind,
      message: scrub(d.message || '(no message)', LIMITS.message),
    };
    if (d.stack) r.stack = scrub(d.stack, LIMITS.stack);
    if (source) r.source = scrub(source, LIMITS.source);
    // The page's path, but only on our own site: in the extension, the page is
    // the user's document, and its address is theirs.
    if (config.surface !== 'extension' && typeof location !== 'undefined') {
      r.page = scrub(location.pathname, LIMITS.page);
    }
    if (config.version) r.version = scrub(config.version, LIMITS.version);
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      r.browser = navigator.userAgent.slice(0, LIMITS.browser);
    }
    return r;
  }

  // ---- sending -------------------------------------------------------------

  function id() {
    try { if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID(); } catch (e) { /* fall through */ }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  // A report as Firestore's REST API wants it, with the arrival time set by
  // the server, which is what the rules check it against.
  function toWrite(r) {
    var fields = {};
    Object.keys(r).forEach(function (k) {
      if (k === 'at') return;
      fields[k] = typeof r[k] === 'number' ? { integerValue: String(r[k]) } : { stringValue: String(r[k]) };
    });
    return {
      writes: [{
        update: { name: DB + '/errors/' + id(), fields: fields },
        updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
        currentDocument: { exists: false },
      }],
    };
  }

  // Sends a finished report. Exposed for the extension's background worker,
  // which sends on behalf of content scripts; it re-bounds every field, so a
  // report relayed from a page cannot carry more than one built here.
  function send(r) {
    try {
      if (!r || typeof r !== 'object') return;
      var clean = {};
      Object.keys(LIMITS).concat(['brand', 'surface', 'kind']).forEach(function (k) {
        if (typeof r[k] === 'string' && r[k]) clean[k] = k === 'browser' ? r[k].slice(0, LIMITS[k]) : scrub(r[k], LIMITS[k] || 40);
      });
      if (!clean.message || !clean.part) return;
      clean.brand = BRAND;
      if (typeof fetch !== 'function') return;
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toWrite(clean)),
        keepalive: true,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }).catch(function () { /* dropped: never report a failed report */ });
    } catch (e) { /* the reporter must never be the thing that breaks */ }
  }

  // A copy being developed or tested on this computer, whose errors are the
  // developer's own business and would only bury real ones.
  function local() {
    return typeof location !== 'undefined' && config.surface !== 'extension' &&
      (location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/.test(location.hostname));
  }

  function report(err, kind, source) {
    try {
      if (!config || count >= MAX_PER_PAGE || (local() && !config.reportLocal)) return;
      var r = build(kind || 'report', err, source);
      var key = r.kind + '|' + r.message + '|' + (r.source || '');
      if (sent[key]) return;
      sent[key] = true;
      count++;
      config.transport(r);
    } catch (e) { /* as above */ }
  }

  // ---- catching ------------------------------------------------------------

  function onError(e) {
    var file = e && e.filename;
    // "Script error." with no file is a cross-origin script, such as another
    // extension's, telling us nothing; and errors from scripts that are not
    // ours are not ours to report.
    if (!file || !config.own(file)) return;
    report(e.error || e.message, 'error', file + ':' + (e.lineno || 0) + ':' + (e.colno || 0));
  }

  function onRejection(e) {
    var reason = e && e.reason;
    var stack = reason && reason.stack;
    // A rejection carries no file. Keep it only if its stack runs through one
    // of our scripts, or if it has no stack at all on a page that is all ours.
    if (stack) {
      if (!stackIsOurs(stack)) return;
    } else if (config.surface === 'extension' && config.part === 'content') {
      return;
    }
    report(reason == null ? 'Unhandled rejection' : reason, 'rejection');
  }

  function stackIsOurs(stack) {
    var urls = String(stack).match(/(?:chrome|moz)-extension:\/\/[^\s)]+|https?:\/\/[^\s)]+/g) || [];
    return urls.some(function (u) { return config.own(u); });
  }

  /*
   * opts.surface    'site', 'app' or 'extension'
   * opts.part       where in it: 'page', 'editor', 'popup', 'background', ...
   * opts.version    shown in reports; the extension's manifest version by default
   * opts.own(url)   whether a script address is ours; by default, this origin
   *                 or this extension
   * opts.reportLocal  report from localhost and file: pages too, which are
   *                 otherwise skipped as a developer's own copy
   * opts.transport  how a finished report leaves; by default, send() directly.
   *                 A content script passes a message to the background worker,
   *                 so nothing is sent from the user's page itself.
   */
  function install(opts) {
    if (config) return api;
    opts = opts || {};
    var version = opts.version;
    try {
      if (!version && root.chrome && root.chrome.runtime && root.chrome.runtime.getManifest) {
        version = root.chrome.runtime.getManifest().version;
      }
    } catch (e) { /* not an extension context */ }
    config = {
      surface: opts.surface || 'app',
      part: String(opts.part || 'page').slice(0, LIMITS.part),
      version: version || '',
      own: opts.own || ownUrl,
      transport: opts.transport || send,
      reportLocal: !!opts.reportLocal,
    };
    if (opts.brand) BRAND = opts.brand;
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('error', onError, true);
      root.addEventListener('unhandledrejection', onRejection);
    }
    return api;
  }

  var api = { install: install, report: report, send: send, scrub: scrub };
  root.VibeReviseErrors = api;

  // <script src=".../errors.js" data-surface="..."> installs on load.
  var me = typeof document !== 'undefined' && document.currentScript;
  if (me && me.dataset && me.dataset.surface) {
    install({
      surface: me.dataset.surface,
      part: me.dataset.part,
      version: me.dataset.version,
      brand: me.dataset.brand,
      reportLocal: me.dataset.reportLocal === 'true',
    });
  }
})(typeof self !== 'undefined' ? self : this);
