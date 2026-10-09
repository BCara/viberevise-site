/*
 * VibeRevise — write-back.
 *
 * The saved file is the ORIGINAL source string with a handful of character
 * ranges replaced. It is never produced by serialising the DOM. That is the
 * whole point of the extension: serialising would re-indent the file, drop
 * comments, normalise attribute quoting and rewrite entities, none of which the
 * user asked for.
 *
 * Two rules keep that promise:
 *   1. Only spans belonging to text nodes the user actually changed are in the
 *      edit list. An untouched file produces an empty edit list, and an empty
 *      edit list returns the source unchanged — byte for byte, by construction.
 *   2. Edits are non-overlapping and applied against the ORIGINAL offsets.
 */
(function (root) {
  'use strict';

  /*
   * Escape text for insertion into element content.
   *
   * Deliberately minimal. Only the characters that would otherwise change how
   * the file parses are encoded, plus U+00A0, which is encoded because a raw
   * non-breaking space is invisible in an editor and easy to mangle later.
   * Everything else is written through as-is: the file is UTF-8 and stays UTF-8.
   *
   * ">" is not strictly required in text content, but is encoded anyway so that
   * a typed "]]>" or "-->" cannot combine with surrounding markup.
   *
   * Note the one-way trip this implies: a span originally written as "&#39;" or
   * "&quot;" decodes to "'" / '"' and, IF THE USER EDITS THAT SPAN, is written
   * back as the bare character. Only spans the user edited are affected; this
   * is documented in the README as a known limitation.
   */
  function escapeText(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\u00a0/g, '&nbsp;');
  }

  /*
   * The exact string to splice in for `span` when its text is now `text`.
   *
   * Beyond escaping, this restores the one transformation the parser applied on
   * the way in that we can see and undo: line endings. The DOM only ever hands
   * back "\n", because the parser normalises "\r\n" and "\r" as it tokenizes, so
   * a span that was CRLF in the file would silently become LF when written
   * back. Detect the original style and keep it.
   */
  function replacementFor(span, text) {
    var out = escapeText(text);
    if (span.raw.indexOf('\r\n') !== -1) out = out.replace(/\n/g, '\r\n');
    return out;
  }

  /*
   * applyEdits(source, edits) -> string
   *
   * edits: [ { start, end, replacement } ] with offsets into `source`.
   *
   * Conceptually this is "splice from the end of the file backwards, so that
   * offsets earlier in the file stay valid". It is implemented by walking the
   * edits forwards and collecting the untouched stretches between them, which
   * gives the identical result in a single pass and without repeatedly copying
   * a multi-megabyte string.
   *
   * Throws on overlapping or reversed ranges rather than producing a plausible
   * but wrong file.
   */
  function applyEdits(source, edits) {
    if (!edits || !edits.length) return source;

    var sorted = edits.slice().sort(function (x, y) { return x.start - y.start; });

    for (var i = 0; i < sorted.length; i++) {
      var e = sorted[i];
      if (!(e.start >= 0 && e.end >= e.start && e.end <= source.length)) {
        throw new Error('VibeRevise: edit range out of bounds (' + e.start + ',' + e.end + ')');
      }
      if (i > 0 && e.start < sorted[i - 1].end) {
        throw new Error('VibeRevise: overlapping edits at offset ' + e.start);
      }
    }

    var parts = [];
    var cursor = 0;
    for (var j = 0; j < sorted.length; j++) {
      parts.push(source.slice(cursor, sorted[j].start));
      parts.push(sorted[j].replacement);
      cursor = sorted[j].end;
    }
    parts.push(source.slice(cursor));
    return parts.join('');
  }

  root.VibeReviseSplice = {
    escapeText: escapeText,
    replacementFor: replacementFor,
    applyEdits: applyEdits
  };

  // CommonJS, for use outside a browser. The browser global above is what the
  // Chrome extension's injected scripts bind to; `module` is undefined there,
  // so this is skipped and nothing changes for them.
  if (typeof module !== 'undefined' && module.exports) module.exports = root.VibeReviseSplice;
})(typeof self !== 'undefined' ? self : globalThis);
