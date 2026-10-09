/*
 * VibeRevise — offset map.
 *
 * Pairs each live DOM text node with the exact span of the original source file
 * it came from. This is the foundation the whole extension rests on: if a node
 * is mapped, we can rewrite its text by splicing [start,end) in the source and
 * leave every other byte of the file alone. If a node cannot be mapped with
 * certainty, it is simply not editable. There is no third option — we never
 * guess at an offset.
 *
 * HOW THE PAIRING WORKS
 * ---------------------
 * Two independent sequences, both in document order:
 *   A. source spans, from tokenizer.js
 *   B. DOM text nodes, from a manual walk (which descends into <template>.content,
 *      since a TreeWalker will not)
 *
 * For a well-formed file these are the same length and pair up 1:1 by index,
 * which is the fast path. Files exist where they do not, because the parser
 * invents, moves or discards text:
 *   - whitespace before the doctype is dropped
 *   - text inside a <table> but outside a cell is foster-parented *before* the
 *     table, i.e. it moves relative to source order
 *   - malformed markup can cause re-parsing
 * so there is a slow path: anchor on text that occurs exactly once on both
 * sides, take the longest increasing run of those anchors (patience-diff
 * style), then fill the gaps between anchors. Anything still unpaired stays
 * unpaired.
 *
 * One case is not a failure but genuinely has no answer: the parser sometimes
 * MERGES text from several places in the file into one text node. The common
 * example is at the end of every document —
 *
 *     ...</footer>\n</body>\n</html>\n
 *
 * where the newline inside <body>, the one after </body> and the one after
 * </html> all end up appended to the same text node, because "after body" and
 * "after after body" both insert their whitespace back into the body element.
 * One node, three source spans, with </body> and </html> sitting between them.
 * There is no single range we could splice without swallowing that markup, so
 * such nodes are identified ('merged-spans'), excluded from editing, and their
 * spans marked consumed so the rest of the document stays in step. Foster
 * parenting out of a <table> can do the same thing to non-whitespace text.
 *
 * Every pair — fast path or slow — is then verified: the source span, once
 * newline-normalised and entity-decoded the way the parser would, must equal
 * the node's text exactly, and span indices must strictly increase across the
 * document. A pair that fails verification is discarded, not repaired.
 *
 * COMPARING SOURCE TO DOM
 * -----------------------
 * The parser transforms text on its way into the DOM, so raw source bytes are
 * never compared directly:
 *   1. newlines: "\r\n" and lone "\r" both become "\n"
 *   2. character references: "&amp;" becomes "&", "&nbsp;" becomes U+00A0, ...
 *      Decoding is done by the browser itself (via a detached <textarea>, which
 *      is RCDATA, so markup in the string stays literal) rather than by a
 *      hand-rolled entity table that could drift from the spec.
 * Order matters: normalise newlines first, then decode, because "&#13;" is a
 * literal CR that the parser does *not* normalise.
 * Raw-text content (<script>, <style>) is newline-normalised but NOT decoded,
 * because the parser does not decode it either.
 */
(function (root) {
  'use strict';

  var Tokenizer = root.VibeReviseTokenizer;

  // Text inside these never becomes editable: it is code, metadata, or inert
  // content, not prose the user is looking at.
  var BLOCKED = [
    'SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'TEMPLATE', 'NOSCRIPT', 'TEXTAREA',
    'XMP', 'IFRAME', 'NOEMBED', 'NOFRAMES', 'PLAINTEXT'
  ];

  function normalizeNewlines(s) { return s.replace(/\r\n?/g, '\n'); }

  var decoder = null;
  function decodeRefs(s) {
    if (s.indexOf('&') === -1) return s;           // fast path: nothing to decode
    if (!decoder) decoder = document.createElement('textarea');
    decoder.innerHTML = s;
    return decoder.value;
  }

  // What the parser would have put in the DOM for this span.
  function expectedText(span) {
    var s = normalizeNewlines(span.raw);
    return span.kind === 'rawtext' ? s : decodeRefs(s);
  }

  /*
   * All text nodes under `root`, in document order.
   * <template> contents live in a separate DocumentFragment that a normal walk
   * would miss, which would desync the two sequences, so we step into it at the
   * template's position.
   */
  function collectTextNodes(root, out) {
    out = out || [];
    for (var n = root.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        out.push(n);
      } else if (n.nodeType === 1) {
        if (n.tagName === 'TEMPLATE' && n.content) collectTextNodes(n.content, out);
        else if (n.firstChild) collectTextNodes(n, out);
      }
      // Comments and the doctype contribute no text nodes.
    }
    return out;
  }

  /*
   * Comment nodes, in document order, mirroring collectTextNodes.
   */
  function collectComments(root, out) {
    out = out || [];
    for (var n = root.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 8) {
        out.push(n);
      } else if (n.nodeType === 1) {
        if (n.tagName === 'TEMPLATE' && n.content) collectComments(n.content, out);
        else if (n.firstChild) collectComments(n, out);
      }
    }
    return out;
  }

  var COMMENT_LOOKAHEAD = 8;

  /*
   * Pair DOM comment nodes with the comments in the source.
   *
   * Only real <!-- --> comments are paired. The constructs the parser turns
   * into comment nodes without their being written as comments — <![if !IE]>,
   * <?php ?>, </3> — are recorded by the tokenizer purely so the sequence lines
   * up, and are deliberately left unpaired: rewriting one would be rewriting
   * something whose meaning we do not understand.
   *
   * Matching is in document order and requires the text to be identical, with a
   * short lookahead to step over the unpaired ones. A comment that cannot be
   * matched exactly is simply not editable.
   */
  function mapComments(doc, tokens) {
    var nodes = collectComments(doc);
    var byNode = new WeakMap();
    var paired = [];
    var ti = 0;

    for (var ni = 0; ni < nodes.length; ni++) {
      var data = nodes[ni].data;
      for (var k = ti; k < tokens.length && k < ti + COMMENT_LOOKAHEAD; k++) {
        if (tokens[k].bogus) continue;
        if (normalizeNewlines(tokens[k].data) !== data) continue;
        byNode.set(nodes[ni], tokens[k]);
        paired.push({ node: nodes[ni], token: tokens[k] });
        ti = k + 1;
        break;
      }
    }
    return { byNode: byNode, paired: paired, nodes: nodes };
  }

  // ---------------------------------------------------------------------------
  // Sequence alignment
  // ---------------------------------------------------------------------------

  // Longest increasing subsequence, returned as indices into `values`.
  function longestIncreasing(values) {
    var tails = [];      // tails[k] = index into values of the smallest tail of an LIS of length k+1
    var prev = new Array(values.length).fill(-1);
    for (var i = 0; i < values.length; i++) {
      var lo = 0, hi = tails.length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (values[tails[mid]] < values[i]) lo = mid + 1; else hi = mid;
      }
      if (lo > 0) prev[i] = tails[lo - 1];
      if (lo === tails.length) tails.push(i); else tails[lo] = i;
    }
    var out = [];
    if (!tails.length) return out;
    for (var k = tails[tails.length - 1]; k !== -1; k = prev[k]) out.push(k);
    return out.reverse();
  }

  // Longest common subsequence over two short string arrays; returns [ai, bi] pairs.
  function lcsPairs(a, b, a0, a1, b0, b1) {
    var n = a1 - a0, m = b1 - b0;
    var table = new Uint32Array((n + 1) * (m + 1));
    var w = m + 1;
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        table[i * w + j] = a[a0 + i] === b[b0 + j]
          ? table[(i + 1) * w + (j + 1)] + 1
          : Math.max(table[(i + 1) * w + j], table[i * w + (j + 1)]);
      }
    }
    var pairs = [];
    var x = 0, y = 0;
    while (x < n && y < m) {
      if (a[a0 + x] === b[b0 + y]) { pairs.push([a0 + x, b0 + y]); x++; y++; }
      else if (table[(x + 1) * w + y] >= table[x * w + (y + 1)]) x++;
      else y++;
    }
    return pairs;
  }

  var GAP_DP_LIMIT = 300;      // above this, fall back to a bounded greedy scan
  var GREEDY_LOOKAHEAD = 32;

  /*
   * align(a, b) -> Int32Array of length b.length, holding for each element of
   * `b` the index in `a` it pairs with, or -1 for "no confident pairing".
   */
  function align(a, b) {
    var map = new Int32Array(b.length).fill(-1);
    var i;

    // Fast path: same shape, every element equal.
    if (a.length === b.length) {
      var identical = true;
      for (i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) { identical = false; break; }
      }
      if (identical) {
        for (i = 0; i < a.length; i++) map[i] = i;
        return map;
      }
    }

    // Anchors: strings appearing exactly once in each sequence are unambiguous.
    var countA = new Map(), firstA = new Map(), countB = new Map();
    for (i = 0; i < a.length; i++) {
      countA.set(a[i], (countA.get(a[i]) || 0) + 1);
      if (!firstA.has(a[i])) firstA.set(a[i], i);
    }
    for (i = 0; i < b.length; i++) countB.set(b[i], (countB.get(b[i]) || 0) + 1);

    var anchors = [];   // in b order
    for (i = 0; i < b.length; i++) {
      if (countB.get(b[i]) === 1 && countA.get(b[i]) === 1) {
        anchors.push([firstA.get(b[i]), i]);
      }
    }
    // Anchors must also be increasing in a; drop the ones that cross over.
    var keepIdx = longestIncreasing(anchors.map(function (p) { return p[0]; }));
    var kept = keepIdx.map(function (k) { return anchors[k]; });

    function fillGap(a0, a1, b0, b1) {
      var an = a1 - a0, bn = b1 - b0;
      if (an <= 0 || bn <= 0) return;
      if (an === bn) {
        // Same count: pair positionally, but only where the text actually agrees.
        var ok = true;
        for (var k = 0; k < an; k++) {
          if (a[a0 + k] !== b[b0 + k]) { ok = false; break; }
        }
        if (ok) {
          for (var k2 = 0; k2 < an; k2++) map[b0 + k2] = a0 + k2;
          return;
        }
      }
      if (an <= GAP_DP_LIMIT && bn <= GAP_DP_LIMIT) {
        var pairs = lcsPairs(a, b, a0, a1, b0, b1);
        for (var p = 0; p < pairs.length; p++) map[pairs[p][1]] = pairs[p][0];
        return;
      }
      // Large ragged gap: two pointers, bounded forward search, exact matches only.
      var ai = a0, bi = b0;
      while (ai < a1 && bi < b1) {
        if (a[ai] === b[bi]) { map[bi] = ai; ai++; bi++; continue; }
        var found = -1;
        for (var s = 1; s <= GREEDY_LOOKAHEAD && ai + s < a1; s++) {
          if (a[ai + s] === b[bi]) { found = ai + s; break; }
        }
        if (found !== -1) { map[bi] = found; ai = found + 1; bi++; }
        else bi++;
      }
    }

    var prevA = -1, prevB = -1;
    for (var k = 0; k <= kept.length; k++) {
      var ai2 = k < kept.length ? kept[k][0] : a.length;
      var bi2 = k < kept.length ? kept[k][1] : b.length;
      fillGap(prevA + 1, ai2, prevB + 1, bi2);
      if (k < kept.length) map[bi2] = ai2;
      prevA = ai2; prevB = bi2;
    }
    return map;
  }

  // ---------------------------------------------------------------------------

  function isBlocked(node) {
    for (var p = node.parentNode; p; p = p.parentNode) {
      if (p.nodeType === 11) {                     // DocumentFragment => <template>
        return true;
      }
      if (p.nodeType === 1) {
        var tag = (p.tagName || '').toUpperCase();
        if (BLOCKED.indexOf(tag) !== -1) return true;
        if (p.hasAttribute && p.hasAttribute('data-viberevise-ui')) return true;
        // A comment rendered into the document is the editor's own note, not
        // the author's prose. It is edited from the margin card like every
        // other comment, so letting it be typed into directly as well would
        // give one piece of text two owners.
        if (p.hasAttribute && p.hasAttribute('data-vr-comment')) return true;
      }
    }
    return false;
  }

  function isWhitespaceOnly(text) { return !/\S/.test(text); }

  /*
   * Pair each DOM element with the tags in the source that produced it.
   *
   * One recursive walk over the tree the browser already built, consuming tag
   * tokens in order. Letting the DOM drive is what keeps this small: the
   * recursion mirrors the nesting, so the awkward cases fall out for free.
   *
   *   - Nested elements of the same name need no depth counting, because the
   *     inner one consumes its own tags inside the outer one's recursion.
   *   - Implied elements — <html>, <head>, <body>, the <tbody> the parser
   *     inserts into every table — have no start tag in the source. The next
   *     token will not match their name, so nothing is consumed and they are
   *     left unmapped.
   *   - Unclosed elements — <p>one<p>two — have no end tag, so the token after
   *     their children does not match either, and endTag stays null.
   *
   * Every pairing is then verified against the text map: an element's tags must
   * actually bracket the source spans of the text inside it. If they do not,
   * the walk has drifted out of step with the source (foster parenting can do
   * this) and the element is dropped rather than trusted.
   *
   * `spanOf` deliberately holds only the spans of EDITABLE text. Runs of
   * whitespace are all identical to each other, so when the parser discards
   * some of them — the whitespace before a doctype, say — the aligner has no
   * way to tell which "\n" in the source a given "\n" in the DOM came from, and
   * may pair it with an equally plausible earlier one. That never matters for
   * editing, because whitespace is never spliced, but it would make an element
   * look as though its text began before its own start tag.
   *
   * Returns a WeakMap of element -> { startTag, endTag }, either of which may be
   * null. Elements that could not be paired at all are absent.
   */
  function mapElements(doc, tags, spanOf) {
    var byElement = new WeakMap();
    var cursor = 0;

    function peek() { return cursor < tags.length ? tags[cursor] : null; }

    // Walks `node`'s children, returning the span of source covered by the text
    // inside them as [min, max], or null when they contain no mapped text.
    function walk(node) {
      var min = Infinity;
      var max = -Infinity;

      for (var child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          var span = spanOf.get(child);
          if (span) {
            if (span.start < min) min = span.start;
            if (span.end > max) max = span.end;
          }
          continue;
        }
        if (child.nodeType !== 1) continue;

        var name = (child.localName || child.nodeName).toLowerCase();
        var record = { startTag: null, endTag: null };

        var tag = peek();
        if (tag && !tag.isEnd && tag.name === name) { record.startTag = tag; cursor++; }

        var inner = (name === 'template' && child.content) ? walk(child.content) : walk(child);

        tag = peek();
        if (tag && tag.isEnd && tag.name === name) { record.endTag = tag; cursor++; }

        // The tags must bracket the text they supposedly contain.
        if (inner && record.startTag && record.startTag.end > inner[0]) record.startTag = null;
        if (inner && record.endTag && record.endTag.start < inner[1]) record.endTag = null;

        if (record.startTag || record.endTag) byElement.set(child, record);

        var lo = record.startTag ? record.startTag.start : (inner ? inner[0] : Infinity);
        var hi = record.endTag ? record.endTag.end : (inner ? inner[1] : -Infinity);
        if (lo < min) min = lo;
        if (hi > max) max = hi;
      }

      return min === Infinity ? null : [min, max];
    }

    walk(doc);
    return byElement;
  }

  /*
   * build(source, doc) -> {
   *   records: [ { node, span, editable, reason } ... ]   // document order
   *   stats:   { spans, nodes, mapped, editable }
   * }
   *
   * `span` is null when the node could not be mapped. Only records with
   * editable === true may ever be handed to the editing UI, and only their
   * spans may ever be spliced.
   */
  function build(source, doc) {
    var scanned = Tokenizer.scan(source);
    var spans = scanned.spans;
    var nodes = collectTextNodes(doc);

    var spanKeys = spans.map(expectedText);
    var nodeKeys = nodes.map(function (n) { return n.data; });
    var map = align(spanKeys, nodeKeys);

    var records = [];
    var lastSpanIndex = -1;
    var mapped = 0, editable = 0;

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var si = map[i];
      var span = null;
      var reason = '';

      if (si === -1) {
        // Before calling it unmapped, check whether this node is several
        // consecutive source spans that the parser glued together (see the
        // header). Such a node is explained, but still not editable: no single
        // range covers it without also covering the markup in between.
        var runEnd = lastSpanIndex + 1;
        var acc = '';
        while (runEnd < spans.length && acc.length < nodeKeys[i].length) {
          acc += spanKeys[runEnd];
          runEnd++;
        }
        if (acc === nodeKeys[i] && runEnd - (lastSpanIndex + 1) > 1) {
          reason = 'merged-spans';
          lastSpanIndex = runEnd - 1;   // those spans are accounted for
        } else {
          reason = 'unmapped';
        }
      } else if (spanKeys[si] !== nodeKeys[i]) {
        // Belt and braces: align() should never produce an inexact pair.
        reason = 'text-mismatch';
      } else if (si <= lastSpanIndex) {
        // Offsets must march forward with the document, or a later splice could
        // invalidate an earlier one.
        reason = 'out-of-order';
      } else {
        span = spans[si];
        lastSpanIndex = si;
        mapped++;
      }

      var canEdit = false;
      if (span) {
        if (span.kind !== 'text') reason = 'raw-text';
        else if (isWhitespaceOnly(node.data)) reason = 'whitespace';
        else if (isBlocked(node)) reason = 'blocked-ancestor';
        else { canEdit = true; editable++; }
      }
      records.push({ node: node, span: span, editable: canEdit, reason: canEdit ? '' : reason });
    }

    // Element boundaries, for inserting new blocks. Built from the text map, so
    // it inherits its verification — see mapElements for why only editable
    // spans are trusted here.
    var spanOf = new WeakMap();
    for (var j = 0; j < records.length; j++) {
      if (records[j].editable) spanOf.set(records[j].node, records[j].span);
    }
    var elements = mapElements(doc, scanned.tags, spanOf);
    var comments = mapComments(doc, scanned.comments);

    return {
      records: records,
      elements: elements,
      comments: comments,
      tags: scanned.tags,
      stats: {
        spans: spans.length, nodes: nodes.length,
        mapped: mapped, editable: editable
      }
    };
  }

  root.VibeReviseMap = {
    build: build,
    mapElements: mapElements,
    mapComments: mapComments,
    collectComments: collectComments,
    collectTextNodes: collectTextNodes,
    expectedText: expectedText,
    normalizeNewlines: normalizeNewlines,
    align: align,
    BLOCKED: BLOCKED
  };
})(typeof self !== 'undefined' ? self : globalThis);
