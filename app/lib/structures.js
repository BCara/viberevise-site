/*
 * VibeRevise — adding a structure.
 *
 * blocks.js answers "another one of THESE", where the answer is one element
 * holding one run of text. This answers "a table", where the answer is a small
 * tree holding many runs — a header row, body rows, a cell the user can click
 * into.
 *
 * CLONE FIRST
 * -----------
 * Every structure is built from a DONOR: an element of the same kind already in
 * the document. A table copies the donor's class and its column count; a list
 * copies the donor's class. That is not laziness, it is the only way the result
 * can be expected to look right — the document's stylesheet is not ours to
 * touch, so an inserted element has to be the kind of element the stylesheet
 * already has an opinion about. A table cloned from a table beside it inherits
 * whatever that document does to tables.
 *
 * Where the document has no donor, a plain skeleton is built with no class at
 * all. It will look like whatever the document does to a bare <table>, which
 * may be nothing. That is the honest outcome and it is better than inventing
 * styles: guessing at CSS would make VibeRevise responsible for appearance,
 * which is the one thing it has always refused.
 *
 * NOTHING IS COPIED FROM THE DONOR'S CONTENT
 * ------------------------------------------
 * Only its tag, its class and its shape. Not its text, not its ids, not its
 * other attributes — an id would be duplicated and any other attribute might
 * refer to that element specifically.
 *
 * WHAT REACHES THE FILE
 * ---------------------
 * markup() walks the tree that was built and emits it as text. It never
 * serialises anything the user wrote: the only markup it can produce is the
 * tags it constructed itself from the template, and the island values, escaped
 * on the way through by the caller's `serialise`. The island wrappers
 * themselves are editing scaffolding and are never emitted.
 */
(function (root) {
  'use strict';

  var INDENT = '  ';

  /*
   * The structures the toolbar offers, in the order it offers them.
   *
   * `donor` is the selector for an element of this kind already in the
   * document. `skeleton` says what to build when there is none.
   */
  var KINDS = [
    { id: 'table',     label: 'Table',         donor: 'table' },
    { id: 'bullets',   label: 'Bullet list',   donor: 'ul' },
    { id: 'numbers',   label: 'Numbered list', donor: 'ol' },
    { id: 'heading',   label: 'Heading',       donor: 'h1,h2,h3,h4,h5,h6' },
    { id: 'paragraph', label: 'Paragraph',     donor: 'p' },
    { id: 'quote',     label: 'Quote',         donor: 'blockquote' },
  ];

  function kindById(id) {
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i].id === id) return KINDS[i];
    return null;
  }

  function islandAttr() {
    return root.VibeReviseIslands.ATTR;
  }

  /*
   * The most relevant element of this kind, given where the user is.
   *
   * Nearest wins, in the order a person would expect: the one they are inside,
   * then the one just before them, then the last one in the document. A
   * document with several differently-shaped tables should give you the shape of
   * the one you were looking at.
   */
  function findDonor(doc, kind, near) {
    var sel = kind.donor;

    if (near && near.closest) {
      var enclosing = near.closest(sel);
      if (enclosing) return enclosing;
    }

    var all = doc.querySelectorAll(sel);
    if (!all.length) return null;
    if (!near) return all[all.length - 1];

    // The last one that starts before `near` — Node.compareDocumentPosition
    // rather than geometry, so it follows the document, not the layout.
    var best = null;
    for (var i = 0; i < all.length; i++) {
      var pos = near.compareDocumentPosition(all[i]);
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) best = all[i];
    }
    return best || all[0];
  }

  function classOf(el) {
    return (el && el.getAttribute('class')) || '';
  }

  // How many cells the donor's widest row has. Tables in the wild have ragged
  // rows; the widest is the one that will not look broken.
  function columnsOf(table) {
    var rows = table.querySelectorAll('tr');
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      var cells = 0;
      for (var c = rows[i].firstElementChild; c; c = c.nextElementSibling) {
        if (c.localName === 'td' || c.localName === 'th') cells++;
      }
      if (cells > n) n = cells;
    }
    return n || 3;
  }

  // --- building ---------------------------------------------------------------

  function make(doc, tag, className) {
    var el = doc.createElement(tag);
    if (className) el.setAttribute('class', className);
    return el;
  }

  function island(doc, into) {
    var span = doc.createElement('span');
    span.setAttribute(islandAttr(), '');
    span.setAttribute('contenteditable', 'true');
    into.appendChild(span);
    return span;
  }

  function buildTable(doc, donor) {
    var cols = donor ? columnsOf(donor) : 3;
    var table = make(doc, 'table', classOf(donor));
    var islands = [];

    // A header row only if the donor has one. A document whose tables are all
    // headerless should not suddenly acquire one.
    var wantsHead = !donor || !!donor.querySelector('thead') || !!donor.querySelector('th');

    // One row of `cellTag` cells, each with an island, appended to `into`.
    function addRow(into, cellTag) {
      var row = make(doc, 'tr', '');
      for (var c = 0; c < cols; c++) {
        var cell = make(doc, cellTag, '');
        islands.push(island(doc, cell));
        row.appendChild(cell);
      }
      into.appendChild(row);
    }

    if (wantsHead) {
      var thead = make(doc, 'thead', '');
      addRow(thead, 'th');
      table.appendChild(thead);
    }

    var tbody = make(doc, 'tbody', '');
    addRow(tbody, 'td');
    addRow(tbody, 'td');
    table.appendChild(tbody);

    return { element: table, islands: islands, cols: cols };
  }

  function buildList(doc, tag, donor) {
    var list = make(doc, tag, classOf(donor));
    var item = make(doc, 'li', '');
    // One item, not three. Enter at the end of a list item already starts the
    // next one, so the user extends it by typing rather than by deleting spares.
    var isl = island(doc, item);
    list.appendChild(item);
    return { element: list, islands: [isl] };
  }

  function buildLeaf(doc, tag, donor) {
    var el = make(doc, tag, classOf(donor));
    return { element: el, islands: [island(doc, el)] };
  }

  /*
   * build(doc, id, near) -> { element, islands, kind, donor, cols? }
   *
   * The element is a real subtree, not markup: it goes into the page so the
   * user can click into it, and its text is read back out of it at save time.
   */
  function build(doc, id, near) {
    var kind = kindById(id);
    if (!kind) return null;
    var donor = findDonor(doc, kind, near);
    var out;

    if (id === 'table') out = buildTable(doc, donor);
    else if (id === 'bullets') out = buildList(doc, 'ul', donor);
    else if (id === 'numbers') out = buildList(doc, 'ol', donor);
    else if (id === 'heading') out = buildLeaf(doc, donor ? donor.localName : 'h2', donor);
    else if (id === 'paragraph') out = buildLeaf(doc, 'p', donor);
    else if (id === 'quote') out = buildLeaf(doc, 'blockquote', donor);
    else return null;

    out.kind = kind;
    out.donor = donor;
    return out;
  }

  // --- back to text -----------------------------------------------------------

  function openTag(el) {
    var cls = classOf(el);
    return '<' + el.localName +
      (cls ? ' class="' + cls.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"' : '') +
      '>';
  }

  function isIsland(el) {
    return el.nodeType === 1 && el.hasAttribute(islandAttr());
  }

  // An element whose content is only islands can be written on one line:
  // <td>some text</td> reads better than three lines for four words.
  function isLeaf(el) {
    for (var n = el.firstElementChild; n; n = n.nextElementSibling) {
      if (!isIsland(n)) return false;
    }
    return true;
  }

  /*
   * markup(element, opts) -> string
   *
   * opts.newline   the file's line ending
   * opts.indent    the indent of the line the structure is being inserted on
   * opts.text      island -> the text to write for it, already escaped
   *
   * Only tags this module built are emitted. Whitespace text nodes in the built
   * tree are ignored: the layout here is generated, not copied.
   */
  function markup(element, opts) {
    var nl = opts.newline;
    var base = opts.indent || '';

    function emit(el, depth) {
      var pad = base + repeat(INDENT, depth);

      if (isLeaf(el)) {
        var inner = '';
        for (var n = el.firstElementChild; n; n = n.nextElementSibling) {
          if (isIsland(n)) inner += opts.text(n);
        }
        return pad + openTag(el) + inner + '</' + el.localName + '>';
      }

      var lines = [pad + openTag(el)];
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
        if (isIsland(c)) continue;      // scaffolding, never emitted
        lines.push(emit(c, depth + 1));
      }
      lines.push(pad + '</' + el.localName + '>');
      return lines.join(nl);
    }

    // The caller's anchor already supplies the newline and indent for the first
    // line, so the outermost element is emitted without its own pad.
    return emit(element, 0).replace(/^\s+/, '');
  }

  function repeat(s, n) {
    var out = '';
    for (var i = 0; i < n; i++) out += s;
    return out;
  }

  root.VibeReviseStructures = {
    KINDS: KINDS,
    kindById: kindById,
    findDonor: findDonor,
    columnsOf: columnsOf,
    build: build,
    markup: markup,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.VibeReviseStructures;
})(typeof self !== 'undefined' ? self : globalThis);
