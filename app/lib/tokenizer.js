/*
 * VibeRevise — source tokenizer.
 *
 * PURPOSE
 * -------
 * Given the raw text of an HTML file, find every span of that text which the
 * HTML parser will turn into a text node, and record it as a pair of character
 * offsets into the original string.
 *
 * This is half of the offset map. The other half is the real DOM, which the
 * browser has already built for us (see mapping.js). We deliberately do NOT
 * build a tree here: building a second, subtly-different tree and trusting it
 * is how you end up rewriting someone's file. All we need from the source is
 * "where does the text live", and all we need from the DOM is "which text node
 * is which". mapping.js then pairs them up and *verifies* every pair.
 *
 * COMMENTS
 * --------
 * scan() records comments too, as {start, end, data, bogus}. VibeRevise stores
 * a user's notes as ordinary HTML comments — invisible in a browser, plainly
 * readable in a text editor, and carried along whenever the file is sent
 * anywhere — so it needs to find the ones already in a file as well as write
 * new ones.
 *
 * `bogus` marks the constructs that are not written as comments but which the
 * parser turns into comment nodes anyway: <![if !IE]>, <?php ... ?>, </3>. They
 * are recorded so the sequence still lines up with the DOM, and skipped for
 * every other purpose. The doctype is NOT one of these — it becomes a
 * DocumentType node, not a comment — so it is not recorded at all.
 *
 * TAGS
 * ----
 * scan() also records every start and end tag it walks past, as {start, end,
 * name, isEnd}. Nothing is inferred from them here — no tree, no nesting, no
 * implied elements. They are raw positions, which mapping.js pairs with the
 * real elements the browser built, the same way text spans are paired with text
 * nodes. Knowing where an element's tags sit in the file is what makes it
 * possible to INSERT a sibling: an insertion is a zero-length splice at the
 * offset just past a closing tag.
 *
 * WHAT COUNTS AS A SPAN
 * ---------------------
 * Every text run is emitted, including whitespace-only runs and the contents of
 * <script>/<style>/<head>. That is on purpose: the DOM contains text nodes for
 * all of those too, so emitting them keeps the two sequences the same shape and
 * makes alignment trivial in the common case. Deciding what the *user* may edit
 * is a separate, later filter (mapping.js#isEditable) applied to the DOM side.
 *
 * Skipped entirely, because the parser produces no text node for them:
 *   tags, HTML comments (incl. conditional comments), the doctype,
 *   processing instructions and bogus comments.
 *
 * PARSER QUIRKS HANDLED
 * ---------------------
 *  - Raw text / RCDATA elements (<script>, <style>, <title>, <textarea>, ...)
 *    swallow their content: one span, no nested markup, and for raw text no
 *    character-reference decoding. Their end tag is found by scanning, since
 *    "</div>" inside a <script> string literal is just text.
 *  - <pre>, <textarea> and <listing> eat one immediately-following newline.
 *    The span starts *after* that newline so the byte stays put in the source
 *    and is never part of anything we splice.
 *  - Single-quoted (and unquoted) attribute values may contain ">", so tags are
 *    scanned attribute-by-attribute rather than with indexOf('>').
 *  - A "<" that is not followed by a letter, "!", "?" or "/" is literal text
 *    ("a < b"), exactly as the parser treats it.
 *
 * KNOWN DIVERGENCES (both safe — they cost editability, never bytes)
 * ------------------------------------------------------------------
 *  - <noscript> is treated as raw text, which is correct in a browser with
 *    scripting enabled (our only target). With scripting disabled its contents
 *    parse as real markup and this tokenizer's span will not match the DOM;
 *    alignment then leaves those nodes unmapped and therefore uneditable.
 *  - Foreign content (SVG/MathML) parsing subtleties and foster parenting
 *    (text yanked out of a <table>) can reorder or reshape things. Again the
 *    verification step catches the mismatch and drops editability.
 *
 * No offset is ever derived from a case-folded copy of the source: toLowerCase()
 * can change a string's length for some code points, which would shift offsets.
 * Only short, already-extracted tag names are lowercased.
 */
(function (root) {
  'use strict';

  // Content is raw text: single text node, character references NOT decoded.
  var RAWTEXT = ['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'];
  // Content is RCDATA: single text node, character references ARE decoded.
  var RCDATA = ['title', 'textarea'];
  // These eat one immediately-following newline.
  var NEWLINE_EATERS = ['pre', 'textarea', 'listing'];

  function has(list, name) { return list.indexOf(name) !== -1; }
  function isAlpha(ch) {
    return !!ch && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'));
  }
  function isSpace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
  }

  /*
   * Read one tag starting at `i` (which must point at '<').
   * Returns { end, name, isEnd } where `end` is the offset just past the '>'.
   * Attribute values are scanned with quote awareness so that
   *   <a href='/x?a=1>2'>  or  <img alt=a>b>
   * do not terminate the tag early.
   */
  function readTag(source, i) {
    var len = source.length;
    var p = i + 1;
    var isEnd = false;
    if (source[p] === '/') { isEnd = true; p++; }

    var nameStart = p;
    while (p < len && !isSpace(source[p]) && source[p] !== '/' && source[p] !== '>') p++;
    var name = source.slice(nameStart, p).toLowerCase();

    while (p < len) {
      var ch = source[p];
      if (ch === '>') { p++; break; }
      if (isSpace(ch) || ch === '/') { p++; continue; }

      // Attribute name.
      while (p < len && !isSpace(source[p]) && source[p] !== '/' &&
             source[p] !== '>' && source[p] !== '=') p++;

      // Optional "= value", possibly with whitespace around the '='.
      var q = p;
      while (q < len && isSpace(source[q])) q++;
      if (source[q] === '=') {
        q++;
        while (q < len && isSpace(source[q])) q++;
        var quote = source[q];
        if (quote === '"' || quote === "'") {
          var close = source.indexOf(quote, q + 1);
          q = close === -1 ? len : close + 1;
        } else {
          while (q < len && !isSpace(source[q]) && source[q] !== '>') q++;
        }
        p = q;
      }
    }
    return { start: i, end: p, name: name, isEnd: isEnd };
  }

  // Case-insensitive check for a tag name at `at`, requiring a proper terminator
  // so that "</scriptx" does not close a <script>.
  function nameMatchesAt(source, at, name) {
    if (source.substr(at, name.length).toLowerCase() !== name) return false;
    var after = source[at + name.length];
    return after === undefined || after === '>' || after === '/' || isSpace(after);
  }

  // Find where a raw-text/RCDATA element's content ends: the offset of the '<'
  // of its matching end tag, or end-of-file if it is never closed.
  function findRawTextEnd(source, from, name) {
    var len = source.length;
    var p = from;
    while (p < len) {
      var idx = source.indexOf('<', p);
      if (idx === -1) return len;
      if (source[idx + 1] === '/' && nameMatchesAt(source, idx + 2, name)) return idx;
      p = idx + 1;
    }
    return len;
  }

  /*
   * scan(source) -> { spans, tags }, both in source order.
   *
   * span = {
   *   start, end   character offsets into `source`; source.slice(start,end) === raw
   *   raw          the exact original bytes of this text run
   *   kind         'text' | 'rawtext' | 'rcdata'  (drives entity decoding)
   *   eaten        newline the parser discarded just before this span, if any;
   *                it lives *outside* [start,end) and is never spliced
   * }
   *
   * tag = {
   *   start, end   character offsets; source.slice(start,end) is the whole tag
   *   name         lower-cased tag name
   *   isEnd        true for </p>, false for <p>
   * }
   */
  function scan(source) {
    var spans = [];
    var tags = [];
    var comments = [];
    var len = source.length;
    var i = 0;
    var textStart = 0;
    // Set immediately after a <pre>/<textarea>/<listing> start tag; consumed by
    // the very next span (or cleared if a tag follows instead).
    var eatNewline = false;

    function push(start, end, kind) {
      var eaten = '';
      if (eatNewline) {
        eatNewline = false;
        if (source[start] === '\n') {
          eaten = '\n'; start += 1;
        } else if (source[start] === '\r') {
          eaten = source[start + 1] === '\n' ? '\r\n' : '\r';
          start += eaten.length;
        }
      }
      // The run may have consisted solely of the eaten newline, in which case
      // the parser produced no text node and we must not emit a span.
      if (end <= start) return;
      spans.push({
        start: start, end: end, raw: source.slice(start, end),
        kind: kind, eaten: eaten
      });
    }

    function flushText(end) {
      if (end <= textStart) { eatNewline = false; return; }
      push(textStart, end, 'text');
    }

    /*
     * Skip a construct that yields no text node, from '<' at i to just past '>'.
     * `asComment` says whether the parser will nonetheless produce a comment
     * node for it, which is true of everything here except the doctype.
     */
    function skipTo(closeFrom, asComment) {
      var from = i;
      var close = source.indexOf('>', closeFrom);
      i = close === -1 ? len : close + 1;
      if (asComment) {
        comments.push({
          start: from, end: i,
          data: source.slice(from + 1, close === -1 ? len : close),
          bogus: true,
        });
      }
      textStart = i;
    }

    while (i < len) {
      if (source[i] !== '<') { i++; continue; }

      var next = source[i + 1];

      // Comment (this also covers conditional comments, which are comments).
      if (next === '!' && source[i + 2] === '-' && source[i + 3] === '-') {
        flushText(i);
        var close = source.indexOf('-->', i + 4);
        var stop = close === -1 ? len : close + 3;
        comments.push({
          start: i, end: stop,
          data: source.slice(i + 4, close === -1 ? len : close),
          bogus: false,
        });
        i = stop;
        textStart = i;
        continue;
      }

      // Doctype (a DocumentType node), or CDATA-ish / processing instruction /
      // bogus comment (all of which become comment nodes).
      if (next === '!' || next === '?') {
        flushText(i);
        skipTo(i + 2, !/^<!doctype/i.test(source.substr(i, 9)));
        continue;
      }

      if (next === '/') {
        flushText(i);
        if (!isAlpha(source[i + 2])) { skipTo(i + 2, true); continue; } // bogus comment
        var endTag = readTag(source, i);
        tags.push(endTag);
        i = endTag.end;
        textStart = i;
        continue;
      }

      if (isAlpha(next)) {
        flushText(i);
        var tag = readTag(source, i);
        tags.push(tag);
        i = tag.end;
        textStart = i;
        var name = tag.name;

        // <plaintext> turns the rest of the file into one text node.
        if (name === 'plaintext') {
          push(i, len, 'rawtext');
          i = len; textStart = len;
          continue;
        }

        // Note: a "/>" on a raw-text element does NOT self-close it in HTML —
        // <script/> opens a script element — so the flag is intentionally ignored.
        if (has(RAWTEXT, name) || has(RCDATA, name)) {
          if (has(NEWLINE_EATERS, name)) eatNewline = true;
          var stop = findRawTextEnd(source, i, name);
          push(i, stop, has(RAWTEXT, name) ? 'rawtext' : 'rcdata');
          i = stop; textStart = i;
          continue;
        }

        if (has(NEWLINE_EATERS, name)) eatNewline = true;
        continue;
      }

      // A bare '<' in running text.
      i++;
    }
    flushText(len);
    return { spans: spans, tags: tags, comments: comments };
  }

  // The text spans on their own — by far the most common thing to want.
  function tokenize(source) { return scan(source).spans; }

  root.VibeReviseTokenizer = { scan: scan, tokenize: tokenize, readTag: readTag };

  // CommonJS, for use outside a browser. The browser global above is what the
  // Chrome extension's injected scripts bind to; `module` is undefined there,
  // so this is skipped and nothing changes for them.
  if (typeof module !== 'undefined' && module.exports) module.exports = root.VibeReviseTokenizer;
})(typeof self !== 'undefined' ? self : globalThis);
