/*
 * VibeRevise — editable islands.
 *
 * Each editable text node is wrapped in its own <span contenteditable>, so a
 * region of text is exactly one source span and one editing surface. The
 * browser cannot merge, split or delete markup across an island boundary,
 * which is what makes "editing the text cannot disturb the tags" true by
 * construction rather than by vigilance.
 *
 * These wrappers live only in the page's DOM. They are never serialised: the
 * file is written by splicing the original source string, so nothing here can
 * reach it.
 *
 * ISLAND VALUES
 * -------------
 * An island holds text and, if the user pressed Enter, <br> elements. Its value
 * is flattened to a plain string with U+0001 standing in for each <br>, which
 * makes comparison, history and serialisation trivial. U+0001 is stripped from
 * anything pasted in, so it can never occur in real content. U+0002 to U+0005
 * do the same for bold and italic the user added: see FMT_ATTR below.
 */
(function (root) {
  'use strict';

  var BR = '\u0001';
  var ATTR = 'data-vr-island';

  function wrap(node) {
    var span = node.ownerDocument.createElement('span');
    span.setAttribute(ATTR, '');
    node.parentNode.insertBefore(span, node);
    span.appendChild(node);
    return span;
  }

  /*
   * Put the island's children back where the island was and remove it.
   * The original text node object is moved, not cloned, so a map record still
   * points at the right node afterwards. normalize() is deliberately never
   * called: merging adjacent text nodes would collapse two source spans into
   * one node and invalidate the map.
   */
  function unwrap(span) {
    var parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }

  /*
   * Bold and italic the user added. An island may hold <strong> or <em>
   * elements VibeRevise made itself (marked with FMT_ATTR), and in the value
   * they are a pair of control characters each, the same trick as BR. So
   * history, comparison and the kept session all go on handling plain
   * strings, and save turns the pairs into tags.
   */
  var FMT_ATTR = 'data-vr-fmt';
  var MARK = { b: ['\u0002', '\u0003', 'strong'], i: ['\u0004', '\u0005', 'em'] };
  var MARKS_RE = /[\u0002-\u0005]/g;

  function fmtOf(node) {
    return node && node.nodeType === 1 && node.getAttribute && node.getAttribute(FMT_ATTR);
  }

  function readValue(el) {
    var out = '';
    for (var n = el.firstChild; n; n = n.nextSibling) {
      var f = fmtOf(n);
      if (n.nodeType === 3) out += n.data;
      else if (n.nodeType === 1 && n.tagName === 'BR') out += BR;
      else if (f && MARK[f]) out += MARK[f][0] + readValue(n) + MARK[f][1];
      else if (n.nodeType === 1) out += n.textContent;  // defensive: paste that slipped through
    }
    return out;
  }

  function writeValue(el, value) {
    var doc = el.ownerDocument;
    while (el.firstChild) el.removeChild(el.firstChild);
    var stack = [el];
    var text = '';
    function flush() {
      if (text) stack[stack.length - 1].appendChild(doc.createTextNode(text));
      text = '';
    }
    for (var i = 0; i < value.length; i++) {
      var ch = value.charAt(i);
      if (ch === BR) { flush(); stack[stack.length - 1].appendChild(doc.createElement('br')); }
      else if (ch === MARK.b[0] || ch === MARK.i[0]) {
        flush();
        var kind = ch === MARK.b[0] ? 'b' : 'i';
        var f = doc.createElement(MARK[kind][2]);
        f.setAttribute(FMT_ATTR, kind);
        stack[stack.length - 1].appendChild(f);
        stack.push(f);
      } else if (ch === MARK.b[1] || ch === MARK.i[1]) {
        flush();
        if (stack.length > 1) stack.pop();
      } else text += ch;
    }
    flush();
  }

  // The words alone, without the formatting marks.
  function plain(value) { return String(value || '').replace(MARKS_RE, ''); }

  // True when the island contains nothing but text, <br> and VibeRevise's own
  // formatting — i.e. nothing the browser or a paste sneaked in behind our back.
  function isClean(el) {
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) continue;
      if (n.nodeType === 1 && n.tagName === 'BR') continue;
      if (MARK[fmtOf(n)] && isClean(n)) continue;
      return false;
    }
    return true;
  }

  // Length of a child node in island-value terms.
  function lengthOf(node) {
    if (node.nodeType === 3) return node.data.length;
    if (MARK[fmtOf(node)]) {
      var n = 2;
      for (var c = node.firstChild; c; c = c.nextSibling) n += lengthOf(c);
      return n;
    }
    if (node.nodeType === 1 && node.tagName === 'BR') return 1;
    return (node.textContent || '').length;
  }

  /*
   * Where a DOM position — a (container, offset) pair, as a Range gives — falls
   * in the island's flattened value. Formatting counts one for each of its
   * marks, so a position just inside a bold run is one past one just before it.
   * Returns null for a point outside the island.
   */
  function indexAt(el, container, offset) {
    if (!el.contains(container)) return null;
    var idx = 0;
    function walk(parent) {
      if (parent === container) {
        var i = 0;
        for (var c = parent.firstChild; c && i < offset; c = c.nextSibling, i++) idx += lengthOf(c);
        return true;
      }
      for (var n = parent.firstChild; n; n = n.nextSibling) {
        if (n === container) { idx += offset; return true; }
        if (n.nodeType === 1 && n.contains(container)) {
          if (MARK[fmtOf(n)]) { idx += 1; return walk(n); }
          return true;                       // inside something foreign: its start
        }
        idx += lengthOf(n);
      }
      return false;
    }
    walk(el);
    return idx;
  }

  /*
   * Where the caret is, as an index into the island's flattened value.
   * Returns null when the selection is not inside this island.
   */
  function caretIndex(el) {
    var sel = el.ownerDocument.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    if (!el.contains(range.endContainer)) return null;
    return indexAt(el, range.endContainer, range.endOffset);
  }

  // The DOM position for `index`, clamped to fit: { node, offset }.
  function positionAt(el, index) {
    var idx = 0;
    function find(parent) {
      var k = 0;
      for (var n = parent.firstChild; n; n = n.nextSibling, k++) {
        if (n.nodeType === 3) {
          if (index <= idx + n.data.length) return { node: n, offset: Math.max(0, index - idx) };
          idx += n.data.length;
        } else if (MARK[fmtOf(n)]) {
          if (index <= idx) return { node: parent, offset: k };
          idx += 1;
          var inner = find(n);
          if (inner) return inner;
          if (index <= idx) return { node: n, offset: n.childNodes.length };
          idx += 1;
        } else {
          var len = lengthOf(n);
          if (index <= idx) return { node: parent, offset: k };
          if (index < idx + len) return { node: parent, offset: k + 1 };
          idx += len;
        }
      }
      return null;
    }
    return find(el) || { node: el, offset: el.childNodes.length };
  }

  // Put the caret at `index` in the island's flattened value, clamped to fit.
  function setCaret(el, index) {
    select(el, index, index);
  }

  // Select from `start` to `end` in the island's flattened value.
  function select(el, start, end) {
    var doc = el.ownerDocument;
    var sel = doc.getSelection();
    var range = doc.createRange();
    var a = positionAt(el, start);
    var b = end === start ? a : positionAt(el, end);
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  root.VibeReviseIslands = {
    BR: BR,
    ATTR: ATTR,
    wrap: wrap,
    unwrap: unwrap,
    readValue: readValue,
    writeValue: writeValue,
    isClean: isClean,
    caretIndex: caretIndex,
    indexAt: indexAt,
    setCaret: setCaret,
    select: select,
    plain: plain,
    FMT_ATTR: FMT_ATTR,
    MARK: MARK,
  };
})(typeof self !== 'undefined' ? self : globalThis);
