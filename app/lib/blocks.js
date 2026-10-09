/*
 * VibeRevise — adding a block.
 *
 * Everything here is about answering one question: if the user asks for "another
 * one of these", what exactly gets written into the file, and at which offset?
 *
 * An insertion is a ZERO-LENGTH splice. Nothing existing is replaced, so the
 * promise holds unchanged: every byte that was there before is still there,
 * with a new run of text sitting between two of them. Because nothing is
 * written until save, an insertion also cannot invalidate any other offset —
 * every edit is still measured against the original source.
 *
 * The anchor is derived from the element map (mapping.js), which knows where
 * each element's tags sit in the file.
 */
(function (root) {
  'use strict';

  // Elements that are containers for a document rather than content in it.
  // Adding a sibling to one of these is never what the user means.
  var NOT_A_BLOCK = ['BODY', 'HTML', 'HEAD'];

  function view(el) {
    return (el.ownerDocument && el.ownerDocument.defaultView) || window;
  }

  /*
   * The block an island lives in: walk up until the element is not laid out
   * inline. `<p>Hello <strong>bold</strong></p>` gives the <p> from either
   * island, which is what "another one of these" should mean.
   *
   * Computed display is used rather than a tag list, because a document is free
   * to make a <span> a block or a <div> inline, and the user is going by what
   * they can see.
   */
  function blockFor(island) {
    var win = view(island);
    for (var el = island.parentElement; el; el = el.parentElement) {
      if (NOT_A_BLOCK.indexOf(el.tagName) !== -1) return null;
      if (!el.parentElement) return null;
      var display = win.getComputedStyle(el).display;
      if (display !== 'inline' && display !== 'contents') return el;
    }
    return null;
  }

  // The file's line ending, so an inserted line matches the ones around it.
  function newlineOf(source) {
    return source.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  }

  /*
   * The whitespace at the start of the line `offset` sits on, or '' if there is
   * anything else on that line. Used so an inserted block lines up with the one
   * it was added from rather than jamming against the left margin.
   */
  function indentOf(source, offset) {
    var lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    var indent = source.slice(lineStart, offset);
    return /^[ \t]*$/.test(indent) ? indent : '';
  }

  /*
   * Where a new sibling for `block` should be spliced in, as
   * { offset, before, after } — the inserted text is before + markup + after.
   *
   * Two cases:
   *   - the block has a closing tag: go straight after it, with a newline and
   *     matching indent in front
   *   - the block was never closed (<p>one<p>two): go immediately before
   *     whatever starts next, with the newline and indent trailing instead, so
   *     the following tag still begins its own line
   *
   * Returns null when neither is available, in which case nothing is offered.
   */
  function anchorFor(map, source, block) {
    var range = map.elements.get(block);
    if (!range) return null;

    var newline = newlineOf(source);

    if (range.endTag) {
      var indent = indentOf(source, range.startTag ? range.startTag.start : range.endTag.start);
      return { offset: range.endTag.end, before: newline + indent, after: '' };
    }

    // Unclosed: anchor on the next sibling that we do know the position of.
    for (var sib = block.nextElementSibling; sib; sib = sib.nextElementSibling) {
      var sibRange = map.elements.get(sib);
      if (sibRange && sibRange.startTag) {
        return {
          offset: sibRange.startTag.start,
          before: '',
          after: newline + indentOf(source, sibRange.startTag.start),
        };
      }
    }
    return null;
  }

  /*
   * What the new element should be: the same tag, and the same class so it
   * picks up the same styling.
   *
   * Nothing else is copied. `id` in particular must not be — duplicating one
   * would put two elements with the same id in the document — and copying
   * arbitrary attributes risks carrying over something that referred to this
   * element specifically.
   */
  function templateFor(block) {
    return {
      tag: block.localName,
      className: block.getAttribute('class') || '',
    };
  }

  // The markup for a new block holding `inner` (already escaped).
  function markup(template, inner) {
    var open = '<' + template.tag +
      (template.className ? ' class="' + template.className.replace(/"/g, '&quot;') + '"' : '') +
      '>';
    return open + inner + '</' + template.tag + '>';
  }

  root.VibeReviseBlocks = {
    blockFor: blockFor,
    anchorFor: anchorFor,
    templateFor: templateFor,
    markup: markup,
    newlineOf: newlineOf,
    indentOf: indentOf,
  };
})(typeof self !== 'undefined' ? self : globalThis);
