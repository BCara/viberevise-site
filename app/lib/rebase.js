/*
 * VibeRevise — the file changed underneath us.
 *
 * Someone (often another AI tool) rewrites the file on disk while VibeRevise
 * has unsaved edits against the version it opened. After a reload the page is
 * the new file, and the edits were made to the old one. This works out which
 * parts of the old file are still there, untouched, so an edit to one of them
 * can go straight back on, and which parts were changed, so an edit there is
 * shown as a clash rather than written over somebody else's words.
 *
 * Line by line, deliberately. An HTML paragraph is usually a line, so a line
 * the other tool did not touch is a paragraph it did not touch. A finer diff
 * would find more "unchanged" fragments inside rewritten paragraphs, and an
 * edit placed on a fragment of a sentence that was rewritten around it is
 * exactly the silent mess this is here to avoid.
 *
 * Pure functions, no DOM: the editor, both hosts and the node tests share it.
 */
(function (root) {
  'use strict';

  // Past this many cells, the middle of the files is too different to be
  // worth an exact answer, and it is reported as one changed block.
  var MAX_CELLS = 25000000;

  // Lines with their terminators, so the pieces rejoin into the text.
  function lines(text) {
    var out = [];
    var re = /[^\n]*\n|[^\n]+$/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (!m[0]) break;
      out.push(m[0]);
    }
    return out;
  }

  /*
   * { equal: [...], hunks: [...] }, each entry { aStart, aEnd, bStart, bEnd }
   * in character offsets. Together they cover both texts, in order.
   */
  function diff(a, b) {
    var x = lines(a), y = lines(b);
    var ids = new Map();
    function id(s) {
      var v = ids.get(s);
      if (v === undefined) { v = ids.size; ids.set(s, v); }
      return v;
    }
    var xi = x.map(id), yi = y.map(id);

    // Pairs of matching line indexes, in order.
    var pairs = [];
    var lo = 0;
    while (lo < xi.length && lo < yi.length && xi[lo] === yi[lo]) { pairs.push([lo, lo]); lo++; }
    var hiX = xi.length, hiY = yi.length;
    var tail = [];
    while (hiX > lo && hiY > lo && xi[hiX - 1] === yi[hiY - 1]) { hiX--; hiY--; tail.push([hiX, hiY]); }

    var n = hiX - lo, m = hiY - lo;
    if (n && m && n * m <= MAX_CELLS) {
      var table = [];
      for (var i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
      for (i = n - 1; i >= 0; i--) {
        for (var j = m - 1; j >= 0; j--) {
          table[i][j] = xi[lo + i] === yi[lo + j] ? table[i + 1][j + 1] + 1
            : Math.max(table[i + 1][j], table[i][j + 1]);
        }
      }
      i = 0; j = 0;
      while (i < n && j < m) {
        if (xi[lo + i] === yi[lo + j]) { pairs.push([lo + i, lo + j]); i++; j++; }
        else if (table[i + 1][j] >= table[i][j + 1]) i++;
        else j++;
      }
    }
    for (var t = tail.length - 1; t >= 0; t--) pairs.push(tail[t]);

    // Line starts in characters.
    function starts(ls) {
      var s = [0];
      for (var k = 0; k < ls.length; k++) s.push(s[k] + ls[k].length);
      return s;
    }
    var sx = starts(x), sy = starts(y);

    var equal = [], hunks = [];
    var pa = 0, pb = 0;   // next unclaimed line in each
    function flushHunk(toA, toB) {
      if (toA > pa || toB > pb) hunks.push({ aStart: sx[pa], aEnd: sx[toA], bStart: sy[pb], bEnd: sy[toB] });
    }
    for (var p = 0; p < pairs.length; p++) {
      var ia = pairs[p][0], ib = pairs[p][1];
      flushHunk(ia, ib);
      var last = equal[equal.length - 1];
      if (last && last.aEnd === sx[ia] && last.bEnd === sy[ib]) {
        last.aEnd = sx[ia + 1];
        last.bEnd = sy[ib + 1];
      } else {
        equal.push({ aStart: sx[ia], aEnd: sx[ia + 1], bStart: sy[ib], bEnd: sy[ib + 1] });
      }
      pa = ia + 1; pb = ib + 1;
    }
    flushHunk(x.length, y.length);
    return { equal: equal, hunks: hunks, same: a === b };
  }

  // [start, end) in the old text, wholly inside an unchanged stretch, as the
  // same range in the new text. Null if any of it was changed.
  function mapRange(d, start, end) {
    for (var i = 0; i < d.equal.length; i++) {
      var e = d.equal[i];
      if (start >= e.aStart && end <= e.aEnd) {
        return { start: e.bStart + (start - e.aStart), end: e.bStart + (end - e.aStart) };
      }
    }
    return null;
  }

  // A position between characters (where something was to be inserted). Its
  // edges count: just after an unchanged closing tag is still just after it.
  function mapPoint(d, offset) {
    for (var i = 0; i < d.equal.length; i++) {
      var e = d.equal[i];
      if (offset >= e.aStart && offset <= e.aEnd) return e.bStart + (offset - e.aStart);
    }
    return null;
  }

  // The changed block an old offset falls in, if it falls in one.
  function hunkAt(d, offset) {
    for (var i = 0; i < d.hunks.length; i++) {
      var h = d.hunks[i];
      if (offset >= h.aStart && offset < h.aEnd) return h;
      if (h.aStart === h.aEnd && offset === h.aStart) return h;
    }
    return null;
  }

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

  // The readable words of a piece of HTML, for showing what changed.
  function textOf(html) {
    return String(html)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&(#?\w+);/g, function (all, name) {
        if (ENTITIES[name] !== undefined) return ENTITIES[name];
        if (/^#\d+$/.test(name)) return String.fromCharCode(+name.slice(1));
        if (/^#x[0-9a-f]+$/i.test(name)) return String.fromCharCode(parseInt(name.slice(2), 16));
        return all;
      })
      .replace(/\s+/g, ' ')
      .trim();
  }

  // How alike two passages are, 0..1, by the words they share.
  function similarity(a, b) {
    var wa = words(a), wb = words(b);
    if (!wa.size && !wb.size) return 1;
    var common = 0;
    wa.forEach(function (w) { if (wb.has(w)) common++; });
    return common / (wa.size + wb.size - common);
  }
  function words(s) {
    var set = new Set();
    String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).forEach(function (w) { if (w) set.add(w); });
    return set;
  }

  /*
   * Carry the changes that turned `from` into `to` across to `base`, wherever
   * the text they changed is still in `base` as it was. Used for the review
   * point: once VibeRevise has saved its own edits into the file, they must
   * stop looking like something another tool did.
   */
  function transplant(base, from, to) {
    if (base === from) return to;
    var ours = diff(from, to);
    var where = diff(from, base);
    var cuts = [];
    ours.hunks.forEach(function (h) {
      var m = h.aStart === h.aEnd
        ? (function (p) { return p == null ? null : { start: p, end: p }; })(mapPoint(where, h.aStart))
        : mapRange(where, h.aStart, h.aEnd);
      if (m) cuts.push({ start: m.start, end: m.end, text: to.slice(h.bStart, h.bEnd) });
    });
    cuts.sort(function (x, y) { return y.start - x.start; });
    var out = base;
    cuts.forEach(function (c) { out = out.slice(0, c.start) + c.text + out.slice(c.end); });
    return out;
  }

  var api = {
    diff: diff,
    transplant: transplant,
    mapRange: mapRange,
    mapPoint: mapPoint,
    hunkAt: hunkAt,
    textOf: textOf,
    similarity: similarity,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VibeReviseRebase = api;
})(typeof self !== 'undefined' ? self : globalThis);
