/*
 * VibeRevise — comments.
 *
 * A comment is stored as an ordinary HTML comment sitting just before the block
 * it is attached to:
 *
 *     <!-- comment: needs a figure for Q3 -->
 *     <p>Revenue grew by 12% over the quarter.</p>
 *
 * Nothing about that is VibeRevise's private format. A browser shows none of
 * it, a text editor shows all of it, and anyone — or anything — you send the
 * file to can read it without knowing this extension exists. That is the whole
 * reason for choosing comments over a store inside the browser: notes that
 * cannot travel with the document are not much use.
 *
 * Writing one is the same zero-length splice that adding a block uses, so it
 * displaces nothing.
 *
 * WHO WROTE IT
 * ------------
 * A comment can carry its author and the day it was written, in brackets
 * before the colon:
 *
 *     <!-- comment [Cara · 2026-10-01]: needs a figure for Q3 -->
 *
 * The name is whatever the writer typed into VibeRevise — self-declared, not
 * verified — so it says who claims to have written a note, which is what a
 * team that trusts each other needs, and no more. The plain form without
 * brackets is still read, so notes from before authorship existed keep working.
 *
 * SHOWING THEM
 * ------------
 * A comment that no browser displays is the right default — the document looks
 * exactly as it did before anyone annotated it — but it is the wrong default
 * for someone who wants to read their own notes without this extension. So a
 * comment has a second form, carrying the same three fields:
 *
 *     <div data-vr-comment="Cara · 2026-10-01" style="…">Cara · 2026-10-01: needs a figure for Q3</div>
 *     <p>Revenue grew by 12% over the quarter.</p>
 *
 * The attribute is the record and the text is the display, written from each
 * other so they cannot disagree. Every style is inline, so the note looks the
 * same in a file sent to someone who has no stylesheet, no network and no idea
 * what VibeRevise is.
 *
 * Both forms are read, always. Which one is WRITTEN is a single switch in the
 * editor, so turning it on rewrites every note in the file into the visible
 * form and turning it off puts them all back. Nothing is lost either way:
 * the text, the name and the date survive the round trip, which is the only
 * reason it is safe to offer as a toggle rather than a conversion.
 */
(function (root) {
  'use strict';

  var Blocks = root.VibeReviseBlocks;

  // Continuation lines are indented to sit under the text of the first line.
  var CONTINUATION = '     ';

  /*
   * The note inside a comment, or null if this is not one of ours.
   * Continuation lines are trimmed, since their indentation is only there to
   * make the file readable.
   */
  var COMMENT_RE = /^\s*comment(?:\s*\[([^\]\n]*)\])?\s*:\s*([\s\S]*)$/i;

  /*
   * One of ours, pulled apart: { text, author, date }, or null if this comment
   * is somebody else's. author and date are null when the note has none.
   */
  function parse(data) {
    var match = COMMENT_RE.exec(data);
    if (!match) return null;
    var author = null, date = null;
    if (match[1] !== undefined) {
      var bits = match[1].split('\u00b7').map(function (b) { return b.trim(); });
      if (bits.length > 1 && /^\d{4}-\d{2}-\d{2}$/.test(bits[bits.length - 1])) {
        date = bits.pop();
      }
      author = bits.join(' \u00b7 ') || null;
    }
    var text = match[2]
      .split('\n')
      .map(function (line) { return line.trim(); })
      .join('\n')
      .replace(/\s+$/, '');
    return { text: text, author: author, date: date };
  }

  function textOf(data) {
    var parsed = parse(data);
    return parsed ? parsed.text : null;
  }

  /*
   * A name that can sit inside the brackets: one line, no closing bracket, no
   * run of hyphens that could end the comment early, and not endless.
   */
  function cleanName(name) {
    return String(name || '')
      .replace(/[\r\n\]\[]/g, ' ')
      .replace(/-{2,}/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
  }

  /*
   * Make a note safe to put inside an HTML comment.
   *
   * A comment ends at the first "-->", and a run of hyphens next to the closing
   * bracket can end it early, so runs of two or more hyphens are broken up with
   * spaces and a trailing hyphen gets one after it. Nothing else needs escaping:
   * "<", ">" and "&" are all ordinary characters inside a comment.
   */
  function sanitise(text) {
    return String(text)
      .replace(/\r\n?/g, '\n')
      .replace(/-{2,}/g, function (run) { return run.split('').join(' '); })
      .replace(/-$/, '- ');
  }

  // "[Cara · 2026-10-01]", or "" when there is nothing to attribute.
  function attribution(meta) {
    var author = cleanName(meta && meta.author);
    var date = meta && meta.date && /^\d{4}-\d{2}-\d{2}$/.test(meta.date) ? meta.date : '';
    if (!author && !date) return '';
    return ' [' + [author, date].filter(Boolean).join(' \u00b7 ') + ']';
  }

  function markup(text, indent, newline, meta) {
    var lines = sanitise(text).split('\n');
    var body = lines.map(function (line, i) {
      return i === 0 ? line : indent + CONTINUATION + line;
    }).join(newline);
    return '<!-- comment' + attribution(meta) + ': ' + body + ' -->';
  }

  // --- the visible form -------------------------------------------------------

  var RENDERED_ATTR = 'data-vr-comment';

  /*
   * Inline, because this has to survive being emailed to someone who will open
   * it with no stylesheet and no network. The amber matches the comment button
   * and the margin card, so a note looks like the same object in all three
   * places. normal font-style on the name stops the whole thing reading as one
   * run of italics.
   */
  var RENDERED_STYLE = [
    'margin:.7em 0',
    'padding:.5em .8em',
    'border-left:3px solid #d9a01e',
    'background:#fdf6e6',
    'color:#4a4133',
    // Single quotes: this whole string goes inside a double-quoted style
    // attribute, and "Segoe UI" would end the attribute at the S.
    "font:italic 14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
    'white-space:pre-wrap',
  ].join(';');

  // What the reader sees: "Cara · 2026-10-01: the note", or just the note when
  // there is nobody to attribute it to.
  function renderedText(text, meta) {
    var who = attribution(meta).replace(/^ \[|\]$/g, '');
    return who ? who + ': ' + text : text;
  }

  /*
   * The same note as an element a browser will actually show.
   *
   * The body is escaped for text content and the attribution for an attribute
   * value; neither can carry markup out of a comment and into the document,
   * which matters because the text came from a person typing into a box.
   */
  function renderedMarkup(text, indent, newline, meta) {
    var body = String(text).replace(/\r\n?/g, '\n');
    var who = attribution(meta).replace(/^ \[|\]$/g, '');
    return '<div ' + RENDERED_ATTR + '="' + escapeAttr(who) + '"' +
           ' style="' + RENDERED_STYLE + '">' +
           escapeText(renderedText(body, meta)) +
           '</div>';
  }

  function escapeText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    return escapeText(s).replace(/"/g, '&quot;');
  }

  function isRendered(el) {
    return !!(el && el.nodeType === 1 && el.hasAttribute && el.hasAttribute(RENDERED_ATTR));
  }

  /*
   * A visible note pulled back apart: { text, author, date }, in the same shape
   * parse() returns for the hidden form.
   *
   * The attribute is believed over the text, because the text is a rendering of
   * it. The rendered prefix is stripped when it is there and left alone when it
   * is not, so a note somebody retyped by hand still reads as its own body
   * rather than losing its first few words.
   */
  function parseElement(el) {
    if (!isRendered(el)) return null;
    var who = (el.getAttribute(RENDERED_ATTR) || '').trim();
    var text = (el.textContent || '').replace(/\r\n?/g, '\n');

    if (who && text.slice(0, who.length + 2) === who + ': ') {
      text = text.slice(who.length + 2);
    }

    var author = null, date = null;
    if (who) {
      var bits = who.split('\u00b7').map(function (b) { return b.trim(); });
      if (bits.length > 1 && /^\d{4}-\d{2}-\d{2}$/.test(bits[bits.length - 1])) {
        date = bits.pop();
      }
      author = bits.join(' \u00b7 ') || null;
    }
    return { text: text.replace(/\s+$/, ''), author: author, date: date };
  }

  // Today, as the brackets record it: local date, not UTC, since the person
  // writing the note means their own today.
  function today(now) {
    var d = now || new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /*
   * Where a new comment for `block` goes: immediately before its start tag,
   * with a newline and the block's own indent trailing so the block still
   * begins its own line.
   */
  function anchorFor(map, source, block) {
    var range = map.elements.get(block);
    if (!range || !range.startTag) return null;
    var indent = Blocks.indentOf(source, range.startTag.start);
    return {
      offset: range.startTag.start,
      before: '',
      after: Blocks.newlineOf(source) + indent,
      indent: indent,
    };
  }

  /*
   * The range to cut when a comment is deleted.
   *
   * If the comment has a line to itself, the whole line goes, blank line and
   * all. Otherwise only the comment itself is removed, leaving whatever shares
   * its line alone.
   */
  function deleteRange(source, token) {
    var lineStart = source.lastIndexOf('\n', token.start - 1) + 1;
    var lineEnd = source.indexOf('\n', token.end);
    var restOfLine = source.slice(token.end, lineEnd === -1 ? source.length : lineEnd);

    if (/^[ \t]*$/.test(source.slice(lineStart, token.start)) &&
        /^[ \t\r]*$/.test(restOfLine)) {
      return { start: lineStart, end: lineEnd === -1 ? source.length : lineEnd + 1 };
    }
    return { start: token.start, end: token.end };
  }

  root.VibeReviseComments = {
    parse: parse,
    RENDERED_ATTR: RENDERED_ATTR,
    renderedMarkup: renderedMarkup,
    parseElement: parseElement,
    isRendered: isRendered,
    cleanName: cleanName,
    today: today,
    textOf: textOf,
    sanitise: sanitise,
    markup: markup,
    anchorFor: anchorFor,
    deleteRange: deleteRange,
  };
})(typeof self !== 'undefined' ? self : globalThis);
