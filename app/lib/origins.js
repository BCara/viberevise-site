/*
 * VibeRevise — what will we touch?
 *
 * One place decides which documents VibeRevise is willing to edit, because the
 * answer is a security boundary and a correctness boundary at the same time,
 * and it needs to read the same in the service worker and in the popup.
 *
 * THREE KINDS
 * -----------
 *   'file'  a file:// document. The original bytes are on disk.
 *   'lan'   an http(s):// document served from this machine or this private
 *           network. The original bytes are whatever the server sends back,
 *           and where the server allows it, Save writes them back.
 *   'copy'  any other http(s) page. Read and edited the same way, but SAVE
 *           ALWAYS PRODUCES A FILE, never a write to the server. Somebody
 *           else's website is not ours to write to, and nothing in this code
 *           is allowed to think otherwise.
 *
 * WHY WRITE-BACK IS PRIVATE-ONLY
 * ------------------------------
 * 'lan' is a document-served-as-a-file: a NAS, a `python -m http.server`, a
 * static Express mount, a docs preview. Re-fetching it returns the same bytes
 * the browser parsed, which is what makes a conditional PUT safe to offer.
 *
 * A public origin gets no such assumption. It may render per request, and the
 * site is not the user's to overwrite in any case. So 'copy' never probes for
 * PUT and never performs one: the result of editing is a file the user now
 * has, which they can read, send on, or hand to something else to apply.
 *
 * WHAT CAN GO WRONG ON A PUBLIC PAGE, AND WHY IT IS SAFE
 * -----------------------------------------------------
 * The thing VibeRevise relies on — the bytes it re-fetched being the bytes the
 * browser parsed — is routinely false on the open web. A page built in the
 * browser serves a near-empty shell, so the source has none of the text that
 * is on screen. A page rendered per request returns something different the
 * second time.
 *
 * Both fail SAFE rather than silently: mapping.js verifies every span against
 * its node and refuses to make unverified text editable, and content.js
 * refuses outright when too little lines up. The cost of allowing 'copy' is
 * therefore a clear "this page will not work, here is why", not a corrupted
 * file. That is a price worth paying for the pages that do work, which is most
 * documentation, most articles, and most server-rendered sites.
 *
 * A 'file' or 'lan' path must still end in .html/.htm/.xhtml, because an
 * extensionless route on a private server is more likely to be an application
 * than a document. 'copy' does not require it: a hosted document very often
 * has no extension at all, and the coverage check is the real gate anyway.
 *
 * None of this needs standing host access. activeTab grants the active tab on
 * a user gesture, and that is still the whole permission story.
 */
(function (root) {
  'use strict';

  var HTML_PATH = /\.x?html?$/i;

  /*
   * Loopback, RFC1918 private space, link-local, IPv6 unique-local, mDNS .local
   * names — and the 100.64.0.0/10 shared-address range, which is where
   * Tailscale and other WireGuard meshes put their nodes. A machine reachable
   * over a private mesh is the same kind of machine as one on the LAN.
   */
  function isPrivateHost(hostname) {
    var h = (hostname || '').toLowerCase();

    // IPv6 arrives from URL.hostname wrapped in brackets.
    if (h.charAt(0) === '[') h = h.slice(1, -1);

    if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
    if (/\.localhost$/.test(h)) return true;
    if (/\.local$/.test(h)) return true;

    // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;

    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (!m) return false;
    var a = +m[1], b = +m[2], c = +m[3], d = +m[4];
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;

    if (a === 127) return true;                        // loopback
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a === 169 && b === 254) return true;           // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10, meshes
    return false;
  }

  /*
   * classify(url) -> { kind, host } | { kind: null, reason }
   *
   * `reason` is a code the popup turns into a sentence, so that "no" always
   * comes with a "because".
   */
  function classify(url) {
    var u;
    try { u = new URL(url); } catch (e) { return { kind: null, reason: 'unparseable' }; }

    if (u.protocol === 'file:') {
      if (!HTML_PATH.test(u.pathname)) return { kind: null, reason: 'not-html' };
      return { kind: 'file', host: '' };
    }

    if (u.protocol === 'http:' || u.protocol === 'https:') {
      if (!isPrivateHost(u.hostname)) return { kind: 'copy', host: u.host };
      if (!HTML_PATH.test(u.pathname)) return { kind: null, reason: 'not-html' };
      return { kind: 'lan', host: u.host };
    }

    return { kind: null, reason: 'unsupported-scheme' };
  }

  function isEditable(url) { return classify(url).kind !== null; }

  /*
   * What to call the file this URL would be saved as.
   *
   * A path ending in .html is already a name, and keeping it means a document
   * saved from a NAS lands under the name it has there. Anything else is a
   * hosted page with no name of its own — example.com/ , or
   * example.com/docs/getting-started — so one is built from the host and the
   * path, because "page.html" in a Downloads folder tells nobody anything.
   *
   * Everything outside [A-Za-z0-9._-] becomes a hyphen. That is stricter than
   * any filesystem needs, and deliberately so: this string becomes a download
   * filename, and a path separator or a control character in it is somebody
   * else's URL deciding where a file lands.
   */
  function downloadName(url) {
    var u;
    try { u = new URL(url); } catch (e) { return 'page.html'; }

    var parts = u.pathname.split('/').filter(Boolean).map(function (seg) {
      try { return decodeURIComponent(seg); } catch (e) { return seg; }
    });
    var last = parts.length ? parts[parts.length - 1] : '';
    if (HTML_PATH.test(last)) return last.replace(/[^A-Za-z0-9._-]+/g, '-');

    var stem = [u.hostname].concat(parts).join('-')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      // A run of dots collapses to one. "../.." cannot traverse once the
      // separators are gone, but a filename containing ".." is a thing nobody
      // wants to have to reason about twice.
      .replace(/\.{2,}/g, '.')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 120)
      .replace(/[-.]+$/, '');
    return (stem || 'page') + '.html';
  }

  // May Save write back to where the document came from? Only for a server on
  // the user's own network, and only then if it says it accepts PUT. Asked as
  // its own question so that no caller has to remember that 'copy' means no.
  function mayWriteBack(kind) { return kind === 'lan'; }

  /*
   * Does an OPTIONS response say this resource implements PUT?
   *
   * `headers` is anything with a .get(name) — a fetch Response's Headers, or a
   * plain stand-in in a test.
   *
   * ONLY the Allow header counts. Access-Control-Allow-Methods is deliberately
   * ignored, and the distinction is the whole reason this function exists:
   *
   *   Allow                        RFC 9110 10.2.1 — the methods this resource
   *                                actually implements. A capability.
   *   Access-Control-Allow-Methods  which methods a CROSS-ORIGIN caller is
   *                                permitted to attempt. A policy, and one that
   *                                says nothing about whether they will work.
   *
   * The widely used `cors` middleware answers every OPTIONS with
   * "GET,HEAD,PUT,PATCH,POST,DELETE" by default. Reading that as a capability
   * makes every ordinary static file server look like it accepts write-backs,
   * and the first save 404s.
   */
  function acceptsWriteBack(headers) {
    if (!headers || typeof headers.get !== 'function') return false;
    return /(^|,)\s*PUT\s*(,|$)/i.test(headers.get('Allow') || '');
  }

  root.VibeReviseOrigins = {
    classify: classify,
    isEditable: isEditable,
    mayWriteBack: mayWriteBack,
    downloadName: downloadName,
    isPrivateHost: isPrivateHost,
    acceptsWriteBack: acceptsWriteBack,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.VibeReviseOrigins;
})(typeof self !== 'undefined' ? self : globalThis);
