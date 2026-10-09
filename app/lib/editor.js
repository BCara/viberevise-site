/*
 * VibeRevise — edit mode.
 *
 * Turns the mapped text regions into editable islands, keeps what the user can
 * do inside them narrow enough that the markup cannot move, tracks history, and
 * writes the file out by splicing the original source.
 *
 * WHAT THE USER CAN DO
 * --------------------
 * Type, delete, cut, paste (as plain text) and press Enter. Nothing else:
 * formatting commands are refused, drops are refused, links do not navigate,
 * forms do not submit. Everything happens inside one island, which is one text
 * node, which is one range of the source file.
 *
 * ADDING MARKUP
 * -------------
 * Two things here do write markup the file did not have, both only ever where
 * the user asked for them:
 *
 *   - Enter inserts a <br>. It stays inside the block it was pressed in: a
 *     paragraph gets a new line, not a new paragraph.
 *   - Enter at the end of a list item, Ctrl/Cmd+Enter, or the "+" that appears
 *     on hover adds an empty sibling block — another <p> after a <p>, another
 *     <li> after an <li> — carrying the same tag and class and nothing else.
 *
 * An added block is a ZERO-LENGTH splice at a known offset, so it displaces
 * nothing: every byte that was in the file is still in the file. An added block
 * left empty is not written at all, on the grounds that it was almost certainly
 * a mis-click.
 */
(function (root) {
  'use strict';

  var Islands = root.VibeReviseIslands;
  var Splice = root.VibeReviseSplice;
  var Blocks = root.VibeReviseBlocks;
  var Comments = root.VibeReviseComments;
  var Structures = root.VibeReviseStructures;
  var AI = root.VibeReviseAI;     // absent in a host that offers no AI at all

  var UI_ATTR = 'data-viberevise-ui';
  var MODE_ATTR = 'data-vr-mode';
  var CHANGED_ATTR = 'data-vr-changed';
  var COALESCE_MS = 700;     // typing runs merge into one undo step
  var HISTORY_LIMIT = 500;

  /*
   * The input types allowed to reach the document — a whitelist, not a
   * blacklist. Everything here only ever changes characters inside one text
   * node; anything not on the list is refused, including input types that do
   * not exist yet and the empty string Chrome hands back for ones it does not
   * recognise. Refusing an edit is recoverable; letting an unknown command
   * rewrite the markup is not.
   *
   * insertParagraph, insertLineBreak, historyUndo and historyRedo are absent
   * because they are handled explicitly before this list is consulted.
   * insertFromPaste and insertFromDrop are absent deliberately: paste is
   * intercepted at the paste event and re-inserted as plain text, and drops are
   * refused outright, so anything arriving here by those routes got past the
   * handler that was supposed to sanitise it.
   */
  var ALLOWED_INPUT = [
    'insertText',
    'insertReplacementText',      // autocorrect, spellcheck suggestions
    'insertCompositionText',      // IME composition in progress
    'insertFromComposition',
    'insertTranspose',
    'deleteContentBackward',
    'deleteContentForward',
    'deleteByCut',
    'deleteWordBackward',
    'deleteWordForward',
    'deleteSoftLineBackward',
    'deleteSoftLineForward',
    'deleteEntireSoftLine',
    'deleteHardLineBackward',
    'deleteHardLineForward',
    'deleteCompositionText',
  ];

  // Anything that is not printable text: the C0 controls (which includes the
  // U+0001 that stands for a <br> in an island's value) and DEL. Newline is
  // deliberately absent — it is handled separately, as a line break.
  var CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

  /*
   * The document being edited.
   *
   * In the extension that is the page the content script was injected into, so
   * it is the global `document` and always has been. In the web app it is an
   * iframe holding the user's file, and the editor is running in the app's
   * document instead — a different window entirely. Everything below goes
   * through these two rather than the globals, because the editor does not
   * necessarily run inside the document it edits.
   *
   * The libraries never needed this: mapping.build() already takes a document,
   * and islands.js, blocks.js and structures.js work off ownerDocument.
   */
  function doc() { return state.doc || document; }
  function win() {
    return state.win || (state.doc && state.doc.defaultView) || window;
  }

  function makeState() { return {
    active: false,
    paused: false,        // edit mode on, but the page handed back for selecting and copying
    doc: null,            // the document being edited; null means this one
    win: null,
    settings: null,       // host storage: { get(key), set(key, value) }
    author: '',           // the name the user typed, self-declared
    assist: null,         // the layer holding the changes list and AI suggestions
    // AI, when the host offers it: { status(), complete(req), openSettings() }.
    // Null means there is no AI here at all, and none of its UI is drawn.
    ai: null,
    aiStatus: null,       // { configured, label, problem }, as the host last said
    aiJob: null,          // the request in flight, so it can be cancelled
    suggestions: [],      // AI suggestions waiting for accept or dismiss
    explanation: null,    // the last thing AI explained: { block, quote, text }
    nudgedName: false,    // suggested adding a name once already
    source: '',
    map: null,
    filename: 'page.html',
    regions: [],
    trees: [],            // inserted structures: one tree, many editable cells
    byIsland: null,
    byElement: null,      // blocks we added -> their region
    add: null,            // the hover controls
    hoverBlock: null,
    lastIsland: null,     // the island the caret was last in, for Insert
    addHideTimer: 0,      // grace period while the pointer crosses to the buttons
    comments: [],         // comment regions, existing and new
    // Whether a saved comment is written as a visible note or as an HTML
    // comment no browser shows. Remembered between sessions, because it is a
    // statement about how someone works rather than about one document.
    commentsVisible: false,
    rail: null,           // the margin the cards live in
    railRendering: false, // guards the blur fired by rebuilding the cards
    editingComment: null, // the region whose card has focus
    railStyle: null,      // the page's own inline <html> style, to put back
    history: [],
    historyAt: 0,
    lastTouch: 0,
    pendingBefore: null,
    ui: null,
    styleEl: null,
    listening: false,
    flashTimer: 0,
    // Carrying a session through a reload. See "the file changed underneath".
    session: null,        // host storage for this document: { load(), save(obj), clear() }
    prior: null,          // what was kept from last time, until the user says what to do with it
    resumePending: false, // asked "carry on?" and not yet answered: keep nothing until then
    restoring: false,     // putting edits back: quiet, and not history
    sessionTimer: 0,
    sessionWarned: false,
    sessionRead: false,   // the kept session has been read: only then may it be replaced
    written: null,        // the text last saved from this page, if any
    conflicts: [],        // edits that could not go back on, because the file changed there
    // The review point: the file as it was when the user last marked outside
    // changes as reviewed, in the same terms as `source`. What differs between
    // the two is what changed outside VibeRevise and has not been looked at.
    reviewBase: null,
    showOutside: true,    // highlight those changes on the page
    outsideCache: null,
    watch: null,          // host: { read(), bringIn(), bringInLabel }, to notice the file changing
    watchTimer: 0,
    diskText: null,       // the file as last seen on disk, when it differs from ours
    diskDismissed: null,  // a change the user said "later" to
    earlier: [],          // changes saved before the last reload, as rows to show
    removals: [],         // emptied blocks from the file, taken out with Delete
    unwraps: [],          // bold or italic from the file, taken off a whole phrase
  }; }
  var state = makeState();

  /*
   * Island styling.
   *
   * `all: unset !important` is the important part: the wrapper is an element
   * the page's own stylesheet knows nothing about, and a rule like
   * `span { color: red }` would otherwise repaint the user's document the
   * moment edit mode came on. Unsetting everything makes the wrapper visually
   * nonexistent — inherited properties still inherit, everything else goes back
   * to initial — and the affordances are then added back deliberately.
   */
  var ISLAND_CSS = [
    '[data-vr-island] { all: unset !important; display: inline !important; }',
    ':root[data-vr-mode] [data-vr-island] {',
    '  cursor: text !important;',
    '  border-radius: 2px !important;',
    '}',
    ':root[data-vr-mode] [data-vr-island]:hover {',
    '  background: rgba(91, 82, 240, .09) !important;',
    '  box-shadow: 0 0 0 1px rgba(91, 82, 240, .35) !important;',
    '}',
    ':root[data-vr-mode] [data-vr-island]:focus {',
    '  outline: none !important;',
    '  background: rgba(91, 82, 240, .12) !important;',
    '  box-shadow: 0 0 0 2px rgba(91, 82, 240, .75) !important;',
    '}',
    // Changed outside VibeRevise, since the user last reviewed: blue, so it is
    // never mistaken for their own (amber) edits.
    ':root[data-vr-mode] [data-vr-outside] {',
    '  background: rgba(95, 179, 217, .16) !important;',
    '  box-shadow: -4px 0 0 rgba(95, 179, 217, .9) !important;',
    '}',
    ':root[data-vr-mode] [data-vr-outside-gone] {',
    '  box-shadow: 0 -3px 0 rgba(255, 120, 120, .85) !important;',
    '}',
    ':root[data-vr-mode] [data-vr-island][data-vr-changed] {',
    '  background: rgba(217, 160, 30, .16) !important;',
    '}',
    // A commented section is shaded and barred, the way a word processor marks
    // one, so it is obvious which note belongs to which passage.
    ':root[data-vr-mode] [data-vr-commented] {',
    '  background: rgba(217, 160, 30, .10) !important;',
    '  box-shadow: -4px 0 0 rgba(217, 160, 30, .65) !important;',
    '}',
    ':root[data-vr-mode] [data-vr-commented][data-vr-comment-active] {',
    '  background: rgba(217, 160, 30, .2) !important;',
    '  box-shadow: -4px 0 0 rgba(217, 160, 30, 1) !important;',
    '}',
    // An island emptied of all its text would otherwise be impossible to click
    // back into.
    ':root[data-vr-mode] [data-vr-island]:empty {',
    '  display: inline-block !important;',
    '  min-width: .7em !important;',
    '  min-height: 1em !important;',
    '  box-shadow: 0 0 0 1px rgba(91, 82, 240, .5) !important;',
    '}',
  ].join('\n');

  var BAR_CSS = [
    ':host { all: initial; }',
    '.bar {',
    '  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
    '  display: flex; align-items: center; gap: 9px;',
    '  position: relative;',
    '  padding: 7px 8px 7px 13px;',
    '  border-radius: 999px;',
    '  background: rgba(22, 22, 27, .93);',
    '  color: #f1f2f5;',
    '  box-shadow: 0 2px 16px rgba(0, 0, 0, .3);',
    '  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);',
    '  -webkit-user-select: none; user-select: none;',
    '}',
    '.dot { width: 7px; height: 7px; border-radius: 50%; background: #7c74ff; flex: none; }',
    '.label { white-space: nowrap; }',
    '.count { color: #a5aab8; white-space: nowrap; }',
    '.msg { color: #ffd08a; max-width: 24em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.msg:empty { display: none; }',
    'button {',
    '  font: inherit; border: 0; border-radius: 999px; padding: 4px 11px;',
    '  cursor: pointer; background: rgba(255, 255, 255, .13); color: inherit;',
    '}',
    'button:hover:not(:disabled) { background: rgba(255, 255, 255, .22); }',
    'button.primary { background: #5b52f0; }',
    'button.primary:hover:not(:disabled) { background: #6d64ff; }',
    'button:disabled { opacity: .4; cursor: default; }',
    // Undo and redo are used far more often than Save, and always as a pair,
    // so they get the compact treatment and sit together behind a divider.
    'button.icon { padding: 4px 8px; font-size: 14px; line-height: 1; }',
    // Paused: only what still makes sense with editing off. Save stays, because
    // the edits are still there and still unsaved.
    '.bar.paused .dot { background: #d9a01e; }',
    '.bar.paused .insert, .bar.paused .menu, .bar.paused .undo, .bar.paused .redo, .bar.paused .fmt,',
    '.fmt { min-width: 26px; padding-left: 7px; padding-right: 7px; font-family: Georgia, serif; }',
    '.bar.paused .more-btn, .bar.paused .panel, .bar.paused .ai-btn, .bar.paused .sep,',
    '.bar.paused .outside-btn { display: none; }',
    '.outside-btn { color: #9fd6ef; }',
    '.outside-btn[aria-pressed="false"] { opacity: .55; text-decoration: line-through; }',
    '.sep { width: 1px; align-self: stretch; margin: 2px 1px; background: rgba(255, 255, 255, .16); flex: none; }',
    // The count reads as text but opens the list of changes.
    'button.count { background: transparent; padding: 4px 6px; color: #a5aab8; }',
    'button.count:hover:not(:disabled) { background: rgba(255, 255, 255, .1); color: #f1f2f5; }',
    '.panel[hidden] { display: none; }',
    '.panel {',
    '  position: absolute; bottom: calc(100% + 8px); right: 0;',
    '  width: 290px; max-width: calc(100vw - 32px); box-sizing: border-box;',
    '  padding: 12px; display: flex; flex-direction: column; gap: 7px;',
    '  border-radius: 12px; background: rgba(22, 22, 27, .97);',
    '  box-shadow: 0 4px 22px rgba(0, 0, 0, .42);',
    '}',
    '.p-label { font-weight: 600; }',
    '.p-head { display: flex; align-items: center; gap: 8px; }',
    '.p-title { font-weight: 600; flex: 1; }',
    // Detail is one press away rather than always on screen: the panel is for
    // doing something, and four lines of explanation above the controls makes
    // it something to read instead.
    '.p-info {',
    '  flex: none; width: 19px; height: 19px; padding: 0; border-radius: 50%;',
    '  font: 600 11px/1 ui-serif, Georgia, serif; font-style: italic;',
    '  background: rgba(255, 255, 255, .13); color: #c6cbd6;',
    '}',
    '.p-info:hover, .p-info[aria-expanded="true"] { background: #d9a01e; color: #231d10; }',
    '.p-row { display: flex; gap: 6px; }',
    '.p-input {',
    '  font: inherit; flex: 1 1 auto; min-width: 0; box-sizing: border-box;',
    '  padding: 6px 9px; border-radius: 7px; border: 1px solid rgba(255, 255, 255, .2);',
    '  background: rgba(255, 255, 255, .07); color: inherit;',
    '}',
    '.p-input:focus { outline: 2px solid #7c74ff; outline-offset: 0; }',
    '.p-hint { color: #9aa0ad; font-size: 11px; line-height: 1.45; }',
    '.p-sep { height: 1px; background: rgba(255, 255, 255, .12); margin: 2px 0; }',
    '.p-check {',
    '  display: flex; align-items: center; gap: 7px;',
    '  font-weight: 600; cursor: pointer;',
    '}',
    '.p-check input { flex: none; margin: 0; accent-color: #d9a01e; cursor: pointer; }',
    '.p-changes { text-align: left; border-radius: 7px; }',
    // The bar's comment button wears the same bubble as the one beside a
    // paragraph, so the two are recognisably the same thing in two places.
    'button.icon svg { width: 14px; height: 14px; fill: currentColor; display: block; }',
    // The insert menu opens upward: the bar is pinned to the bottom right, so
    // there is never room below it and always room above.
    '.menu[hidden] { display: none; }',
    '.menu {',
    '  position: absolute; bottom: calc(100% + 8px); right: 0;',
    '  min-width: 168px; padding: 5px;',
    '  display: flex; flex-direction: column; gap: 2px;',
    '  border-radius: 11px;',
    '  background: rgba(22, 22, 27, .97);',
    '  box-shadow: 0 4px 22px rgba(0, 0, 0, .42);',
    '}',
    '.menu button {',
    '  border-radius: 7px; padding: 7px 10px; text-align: left;',
    '  background: transparent; white-space: nowrap;',
    '}',
    '.menu button:hover:not(:disabled) { background: rgba(255, 255, 255, .16); }',
    '.menu .hint {',
    '  padding: 4px 10px 6px; color: #8f95a3; font-size: 11px; max-width: 20em;',
    '  white-space: normal;',
    '}',
    // AI. The count on the button is suggestions still waiting for an answer,
    // in the same amber as anything else that wants attention.
    'button.ai-btn { display: inline-flex; align-items: center; gap: 5px; }',
    'button.ai-btn[aria-expanded="true"] { background: rgba(255, 255, 255, .24); }',
    '.ai-n { background: #d9a01e; color: #231d10; border-radius: 999px; padding: 0 6px;',
    '  font-size: 10.5px; font-weight: 700; line-height: 16px; }',
    '.ai-n[hidden], .ai-panel [hidden] { display: none; }',
    '.ai-panel { width: 320px; }',
    '.ai-status { color: #c6cbd6; font-size: 11.5px; overflow-wrap: anywhere; }',
    '.ai-status.warn { color: #ffd08a; }',
    '.ai-head-btn { padding: 2px 9px; font-size: 11px; }',
    '.ai-section { display: flex; flex-direction: column; gap: 7px; }',
    '.ai-target { color: #c6cbd6; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.ai-chips { display: flex; flex-wrap: wrap; gap: 5px; }',
    '.ai-chips button { padding: 3px 9px; font-size: 11.5px; }',
    '.ai-busy { display: flex; align-items: center; gap: 8px; color: #c6cbd6; }',
    '.ai-busy-text { flex: 1; }',
    '.ai-spin { width: 12px; height: 12px; border-radius: 50%; flex: none;',
    '  border: 2px solid rgba(255, 255, 255, .25); border-top-color: #7c74ff;',
    '  animation: ai-spin .8s linear infinite; }',
    '@keyframes ai-spin { to { transform: rotate(360deg); } }',
    '@media (prefers-reduced-motion: reduce) { .ai-spin { animation: none; } }',
  ].join('\n');

  // --- small helpers ---------------------------------------------------------

  function islandOf(target) {
    if (!target) return null;
    var el = target.nodeType === 1 ? target : target.parentElement;
    if (!el || !el.closest) return null;
    return el.closest('[' + Islands.ATTR + ']');
  }

  function regionOf(island) {
    return island && state.byIsland ? state.byIsland.get(island) : null;
  }

  function changedCount() {
    var n = 0;
    for (var i = 0; i < state.regions.length; i++) {
      var r = state.regions[i];
      if (!r.removed && r.current !== r.original && r.island.isConnected) n++;
    }
    return n + commentChangedCount() + state.removals.filter(function (x) { return x.active; }).length +
      state.unwraps.filter(function (x) { return x.active; }).length;
  }

  function unsavedCount() {
    var n = 0;
    for (var i = 0; i < state.regions.length; i++) {
      var r = state.regions[i];
      if (!r.removed && r.current !== r.saved && r.island.isConnected) n++;
    }
    return n + commentUnsavedCount() +
      state.removals.filter(function (x) { return x.active !== x.saved; }).length +
      state.unwraps.filter(function (x) { return x.active !== x.saved; }).length;
  }

  // Added blocks the user never typed into. They are not written to the file,
  // so the status bar says so rather than letting them vanish silently.
  function emptyAddedCount() {
    var n = 0;
    for (var i = 0; i < state.regions.length; i++) {
      var r = state.regions[i];
      if (r.kind === 'insert' && !r.removed && !r.current) n++;
    }
    // A structure counts once, however many empty cells it has.
    for (var t = 0; t < state.trees.length; t++) {
      if (!state.trees[t].removed && !treeHasText(state.trees[t])) n++;
    }
    return n;
  }

  function sanitiseText(text) {
    return String(text).replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
  }

  // --- islands ---------------------------------------------------------------

  function buildRegions() {
    var records = state.map.records;
    state.regions = [];
    state.byIsland = new WeakMap();
    state.byElement = new WeakMap();

    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (!record.editable) continue;
      // The page's own scripts may have moved or removed nodes since the map
      // was built. A detached node has no place in the document any more.
      if (!record.node.parentNode) continue;

      var island = Islands.wrap(record.node);
      island.setAttribute('contenteditable', 'true');

      var region = {
        kind: 'text',
        record: record,
        island: island,
        original: record.node.data,
        current: record.node.data,
        saved: record.node.data,
      };
      state.regions.push(region);
      state.byIsland.set(island, region);
    }
  }

  /*
   * Leaving edit mode with no changes puts the DOM back exactly as it was.
   * With changes, the wrappers stay: they are holding the user's edits, and
   * `all: unset` keeps them invisible until edit mode comes back.
   */
  function teardownRegions() {
    var keep = changedCount() > 0;

    // An added block with nothing typed into it was a mis-click. It would not
    // have been written to the file either way, so take it out of the page too.
    for (var i = state.regions.length - 1; i >= 0; i--) {
      var region = state.regions[i];
      if (region.kind === 'insert' && !region.current && region.element.parentNode) {
        region.element.parentNode.removeChild(region.element);
        region.removed = true;
      }
    }

    for (var j = 0; j < state.regions.length; j++) {
      var island = state.regions[j].island;
      island.removeAttribute('contenteditable');
      if (!keep && state.regions[j].kind === 'text') Islands.unwrap(island);
    }

    if (!keep && commentChangedCount() === 0) {
      state.regions = [];
      state.byIsland = new WeakMap();
      state.byElement = new WeakMap();
      state.comments = [];
      state.history = [];
      state.historyAt = 0;
    }
  }

  function markChanged(region) {
    if (region.current !== region.original) region.island.setAttribute(CHANGED_ATTR, '');
    else region.island.removeAttribute(CHANGED_ATTR);
  }

  // The browser or a stray paste can leave elements inside an island. Flatten
  // them back to text and <br>, keeping the words and the caret.
  function flatten(island) {
    var caret = Islands.caretIndex(island);
    Islands.writeValue(island, Islands.readValue(island));
    if (caret != null) Islands.setCaret(island, caret);
  }


  // --- bold and italic --------------------------------------------------------

  /*
   * Ctrl/Cmd+B, Ctrl/Cmd+I, or the B and I on the bar.
   *
   * Adding: the selected words get <strong> or <em> around exactly them, as
   * marks in their run's value (see islands.js), so it is an ordinary edit:
   * one undo step, in the list of changes, kept through a reload.
   *
   * Taking off: formatting the user added comes off just the selected words.
   * Bold or italic that was in the file comes off its whole phrase: its two
   * tags are cut, and nothing between them is touched. Taking it off part of
   * a phrase would mean splitting the file's tags in two, so that is refused.
   *
   * A selection must stay inside one run of text. Across a link or existing
   * formatting, the new tags would cross the old ones and break the file.
   */
  var FMT_TAGS = { b: ['strong', 'b'], i: ['em', 'i'] };
  var FMT_NAME = { b: 'bold', i: 'italic' };

  function marksAt(value, at) {
    var stack = [];
    for (var i = 0; i < at; i++) {
      var ch = value.charAt(i);
      if (ch === '\u0002') stack.push('b');
      else if (ch === '\u0004') stack.push('i');
      else if (ch === '\u0003' || ch === '\u0005') stack.pop();
    }
    return stack;
  }

  // The index in `value` where `count` characters of words (marks not
  // counted) have gone by; inside any marks there if `inside`, else before.
  function indexOfText(value, count, inside) {
    var seen = 0;
    for (var i = 0; i <= value.length; i++) {
      var ch = value.charAt(i);
      var mark = /[\u0002-\u0005]/.test(ch);
      if (seen === count) {
        if (!inside || !mark) return i;
      }
      if (i < value.length && !mark) seen++;
    }
    return value.length;
  }

  function fileFormatAround(island, kind) {
    var block = Blocks.blockFor(island);
    for (var el = island.parentElement; el && el !== block; el = el.parentElement) {
      if (FMT_TAGS[kind].indexOf(el.localName) !== -1 && !el.hasAttribute(Islands.FMT_ATTR)) return el;
    }
    return null;
  }

  function toggleFormat(kind) {
    if (!state.active || state.paused) return false;
    var sel = doc().getSelection();
    var range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    var island = range && islandOf(range.startContainer);
    var name = FMT_NAME[kind];
    if (!island || !regionOf(island)) { flash('Select some words first, then ' + (kind === 'b' ? 'Bold' : 'Italic')); return false; }
    if (islandOf(range.endContainer) !== island) {
      flash('Select words within one stretch of text \u2014 ' + name + ' cannot cross a link or other formatting');
      return false;
    }

    // In the file already: take it off the whole phrase.
    var fromFile = fileFormatAround(island, kind);
    if (fromFile) return unwrapFormat(fromFile, kind);

    var value = normaliseFormat(Islands.readValue(island));
    var s = Islands.indexAt(island, range.startContainer, range.startOffset);
    var e = Islands.indexAt(island, range.endContainer, range.endOffset);
    if (s > e) { var t = s; s = e; e = t; }
    if (s === e) { flash('Select the words to make ' + name + ' first'); return false; }
    var atS = marksAt(value, s), atE = marksAt(value, e);
    if (atS.join() !== atE.join()) {
      flash('The selection starts and ends in different formatting \u2014 select inside it, or around all of it');
      return false;
    }

    var M = Islands.MARK;
    var open = M[kind][0], close = M[kind][1];
    var textS = Islands.plain(value.slice(0, s)).length;
    var textE = Islands.plain(value.slice(0, e)).length;
    var next;
    var at = atS.indexOf(kind);
    if (at !== -1) {
      // Off, for just these words: close it here, open it again after, with
      // anything nested inside it closed and reopened around that.
      var inner = atS.slice(at + 1);
      var closes = inner.slice().reverse().map(function (k) { return M[k][1]; }).join('');
      var opens = inner.map(function (k) { return M[k][0]; }).join('');
      next = value.slice(0, s) + closes + close + opens + value.slice(s, e) +
             closes + open + opens + value.slice(e);
    } else {
      // On: any of the same kind inside the selection is folded into it.
      var middle = value.slice(s, e).split(open).join('').split(close).join('');
      next = value.slice(0, s) + open + middle + close + value.slice(e);
    }
    next = normaliseFormat(next);
    if (next === value) return false;

    Islands.writeValue(island, next);
    state.lastTouch = 0;
    recordChange(island, value);
    island.focus();
    Islands.select(island, indexOfText(next, textS, at === -1), indexOfText(next, textE, false));
    flash(at === -1 ? 'Made ' + name : 'Took ' + name + ' off');
    return true;
  }

  function unwrapFormat(el, kind) {
    var range = state.map.elements.get(el);
    if (!range || !range.startTag || !range.endTag) {
      flash('VibeRevise cannot tell where this ' + FMT_NAME[kind] + ' ends in the file, so it stays');
      return false;
    }
    var item = makeUnwrap(el, kind);
    pushHistory({ kind: 'unwrap', item: item });
    setUnwrap(item, true);
    flash('Took ' + FMT_NAME[kind] + ' off \u201c' + item.text.slice(0, 40) + '\u201d \u2014 the whole phrase, as it was in the file');
    return true;
  }

  function makeUnwrap(el, kind) {
    var range = state.map.elements.get(el);
    var item = {
      element: el,
      kind: kind,
      open: { start: range.startTag.start, end: range.startTag.end },
      close: { start: range.endTag.start, end: range.endTag.end },
      text: el.textContent,
      children: [],
      active: false,
      saved: false,
      by: authorName(),
    };
    state.unwraps.push(item);
    return item;
  }

  // Off: the element's children take its place. On: it goes back around them.
  function setUnwrap(item, on) {
    if (on === item.active) return;
    var el = item.element;
    if (on) {
      item.children = Array.prototype.slice.call(el.childNodes);
      var parent = el.parentNode;
      item.children.forEach(function (c) { parent.insertBefore(c, el); });
      parent.removeChild(el);
    } else {
      var first = item.children[0];
      if (first && first.parentNode) {
        first.parentNode.insertBefore(el, first);
        item.children.forEach(function (c) { el.appendChild(c); });
      }
    }
    item.active = on;
    state.lastTouch = 0;
    refresh();
    positionCards();
  }

  // --- adding blocks ---------------------------------------------------------

  /*
   * Where a sibling of `block` would go in the file.
   *
   * A block we added ourselves is not in the file at all, so a sibling of it
   * anchors at the same offset. Several insertions can share one offset; save
   * emits them in document order, and a stable sort keeps them that way.
   */
  function anchorForBlock(block) {
    var owned = state.byElement.get(block);
    if (owned) return owned.anchor;
    return Blocks.anchorFor(state.map, state.source, block);
  }

  function canAddAfter(block) {
    return !!(block && anchorForBlock(block));
  }

  // opts.like: copy this block's tag and class instead of `block`'s.
  // opts.text: start with these words in it. opts.quiet: leave the caret be.
  function addAfterBlock(block, opts) {
    opts = opts || {};
    if (!block) { flash('There is nothing here to add another of'); return null; }

    var anchor = anchorForBlock(block);
    if (!anchor) {
      flash('VibeRevise cannot tell where this block ends in the file');
      return null;
    }

    var template = opts.template || Blocks.templateFor(opts.like || block);
    var element = doc().createElement(template.tag);
    if (template.className) element.setAttribute('class', template.className);

    var island = doc().createElement('span');
    island.setAttribute(Islands.ATTR, '');
    island.setAttribute('contenteditable', 'true');
    element.appendChild(island);
    block.parentNode.insertBefore(element, block.nextSibling);

    var region = {
      kind: 'insert',
      island: island,
      element: element,
      anchor: anchor,
      template: template,
      // Only used to carry the file's line-ending style into escaping.
      span: { raw: Blocks.newlineOf(state.source) },
      original: '',
      current: '',
      saved: '',
      removed: false,
    };
    state.regions.push(region);
    state.byIsland.set(island, region);
    state.byElement.set(element, region);

    if (opts.text) {
      Islands.writeValue(island, opts.text);
      region.current = opts.text;
      region.by = authorName();
    }

    pushHistory({ kind: 'add', region: region });

    if (!opts.quiet) {
      island.focus();
      Islands.setCaret(island, 0);
    }
    hideAdd();
    refresh();
    return region;
  }

  function addAfterIsland(island) {
    return addAfterBlock(Blocks.blockFor(island));
  }

  /*
   * The block a new structure should go after: whatever the user is in, then
   * whatever they are hovering, then the last block we can find an anchor for.
   * Never nothing — the toolbar should not fail for want of a destination.
   */
  function currentBlock() {
    /*
     * Where the caret is, or was.
     *
     * activeElement alone is not enough: pressing Insert moves focus to the
     * toolbar, so by the time this runs the caret is no longer in the text the
     * user was editing, and the answer would be whatever the document happened
     * to end with. The last island focused is the one they mean.
     */
    var island = islandOf(doc().activeElement);
    if (!island && state.lastIsland && state.lastIsland.isConnected) {
      island = state.lastIsland;
    }
    if (island) {
      var block = Blocks.blockFor(island);
      if (block && canAddAfter(block)) return block;
    }
    if (state.hoverBlock && canAddAfter(state.hoverBlock)) return state.hoverBlock;

    var islands = doc().querySelectorAll('[' + Islands.ATTR + ']');
    for (var i = islands.length - 1; i >= 0; i--) {
      var b = Blocks.blockFor(islands[i]);
      if (b && canAddAfter(b)) return b;
    }
    return null;
  }

  /*
   * Where a structure goes for `block`: { parent, before, anchor }.
   *
   * Normally straight after the block. A table cell is the exception: after a
   * <td> is still inside the row, where a browser draws anything as one more
   * cell and the saved file would have a list sitting between two cells. So a
   * list, heading or paragraph goes INSIDE the cell, under its text, and a
   * table (no tables in tables) goes after the whole table.
   */
  function placementFor(block, id) {
    var tag = block.localName;
    if (tag === 'td' || tag === 'th') {
      var inside = id !== 'table' && anchorInside(block);
      if (inside) return { parent: block, before: null, anchor: inside };
      var table = block.closest('table');
      var after = table && anchorForBlock(table);
      if (after) return { parent: table.parentNode, before: table.nextSibling, anchor: after };
      return null;
    }
    var anchor = anchorForBlock(block);
    return anchor ? { parent: block.parentNode, before: block.nextSibling, anchor: anchor } : null;
  }

  // Just inside the closing tag of a cell from the file, so what goes there
  // sits under the cell's own text, one level further in.
  function anchorInside(block) {
    var range = state.map.elements.get(block);
    if (!range || !range.endTag || !range.startTag) return null;
    var newline = Blocks.newlineOf(state.source);
    var indent = Blocks.indentOf(state.source, range.startTag.start);
    return { offset: range.endTag.start, before: newline + indent + '  ', after: newline + indent };
  }

  /*
   * Is the caret part-way through a paragraph? If so, where to cut it:
   * { island, region, block, head, tail }, or { refuse } with the reason.
   *
   * The cut has to leave every tag where it was. The words after the caret
   * move into a new paragraph, so they must be plain words: the caret has to
   * be in the paragraph's last run of text, and not inside bold or a link.
   */
  function splitPoint() {
    var island = islandOf(doc().activeElement);
    if (!island) return null;
    var region = regionOf(island);
    if (!region || (region.kind !== 'text' && region.kind !== 'insert')) return null;
    var block = Blocks.blockFor(island);
    if (!block || block.localName === 'td' || block.localName === 'th') return null;
    var at = Islands.caretIndex(island);
    if (at == null) return null;

    var EDGE = /^[\s\u0001]+|[\s\u0001]+$/g;
    var value = region.current;
    var head = value.slice(0, at), tail = value.slice(at);
    var runs = runsOf(block);
    var me = runs.indexOf(region);
    var laterText = runs.slice(me + 1).some(function (r) { return r.current.replace(EDGE, ''); });
    var earlierText = runs.slice(0, me).some(function (r) { return r.current.replace(EDGE, ''); });

    // At either end there is nothing to split: it goes after, as it always has.
    if (!tail.replace(EDGE, '') && !laterText) return null;
    if (!head.replace(EDGE, '') && !earlierText) return null;
    if (laterText || island.parentNode !== block) {
      return { block: block, refuse: 'VibeRevise cannot split a paragraph inside or before its bold, italic or links — move the cursor past them' };
    }
    return {
      island: island, region: region, block: block,
      head: head.replace(/[\s\u0001]+$/, ''),
      tail: tail.replace(/^[\s\u0001]+/, ''),
    };
  }

  /*
   * Add a structure — a table, a list, a heading — after the current block.
   *
   * Unlike addAfterBlock, which owns one element holding one run of text, this
   * owns a small tree holding several. The bookkeeping is arranged so the rest
   * of the editor does not have to know the difference:
   *
   *   - each editable cell gets an ordinary region (kind 'cell'), so typing,
   *     changed-marking, undo and the unsaved count work unaltered
   *   - one tree region owns the anchor and the markup, and is shaped enough
   *     like an added block that setAdded() moves it in and out for undo
   *
   * collectEdits emits the tree once, at its first cell, rather than per cell.
   */
  function insertStructure(id, where) {
    var block = where || currentBlock();
    if (!block) { flash('VibeRevise cannot tell where to put that in the file'); return null; }

    // Part-way through a paragraph, the paragraph is split around it: from
    // Insert, or from the + beside the very paragraph the caret is in. The +
    // beside any other block means "after this block".
    var split = splitPoint();
    if (split && where && where !== split.block) split = null;
    if (split && split.refuse) { flash(split.refuse); return null; }

    var place = placementFor(block, id);
    if (!place) { flash('VibeRevise cannot tell where this block ends in the file'); return null; }
    var anchor = place.anchor;

    var built = Structures.build(document, id, block);
    if (!built) { flash('VibeRevise does not know how to add that'); return null; }

    // Everything a split does is one undo step, so note where history was.
    var mark = 0;
    if (split) {
      if (state.historyAt < state.history.length) state.history.length = state.historyAt;
      mark = state.history.length;
      state.lastTouch = 0;            // the cut must not merge into earlier typing
      var cutFrom = split.region.current;
      Islands.writeValue(split.island, split.head);
      recordChange(split.island, cutFrom);
    }

    place.parent.insertBefore(built.element, place.before);

    var tree = {
      kind: 'tree',
      id: id,
      inside: place.parent === block,   // in a table cell, under its text
      element: built.element,
      island: built.islands[0],     // the one setAdded() puts the caret back in
      islands: built.islands,
      anchor: anchor,
      // The indent of the line the structure starts on, so its inner lines can
      // be laid out relative to it.
      indent: anchor.before.replace(/^[\r\n]+/, ''),
      cells: [],
      removed: false,
    };

    for (var i = 0; i < built.islands.length; i++) {
      var isl = built.islands[i];
      var cell = {
        kind: 'cell',
        island: isl,
        tree: tree,
        // Carries the file's line-ending style into escaping, as for any region.
        span: { raw: Blocks.newlineOf(state.source) },
        original: '',
        current: '',
        saved: '',
        removed: false,
      };
      tree.cells.push(cell);
      state.regions.push(cell);
      state.byIsland.set(isl, cell);
    }

    state.trees.push(tree);
    // So adding a sibling to the structure itself anchors in the same place.
    state.byElement.set(built.element, tree);

    pushHistory({ kind: 'add', region: tree });

    if (split) {
      // The rest of the paragraph goes after the new structure, as a paragraph
      // like the one it came from.
      addAfterBlock(built.element, { like: split.block, text: split.tail, quiet: true });
      var steps = state.history.splice(mark);
      pushHistory({ kind: 'group', entries: steps });
    }

    tree.island.focus();
    Islands.setCaret(tree.island, 0);
    hideAdd();
    refresh();

    var what = Structures.kindById(id);
    flash(built.donor
      ? 'Added a ' + what.label.toLowerCase() + ' like the one above'
      : 'Added a plain ' + what.label.toLowerCase() + ' — this document had none to copy');
    return tree;
  }

  // Has anything been typed into this structure at all?
  function treeHasText(tree) {
    for (var i = 0; i < tree.cells.length; i++) {
      if (tree.cells[i].current) return true;
    }
    return false;
  }

  // A bullet or a numbered item — the one block Enter carries on from.
  function isListItem(block) {
    return !!block && block.localName === 'li';
  }

  // True when the caret sits at the very end of the last run of text in its
  // block — the point at which Enter in a list item starts the next one rather
  // than breaking the line.
  function atEndOfBlock(island) {
    var value = Islands.readValue(island);
    if (Islands.caretIndex(island) !== value.length) return false;

    var block = Blocks.blockFor(island);
    if (!block) return false;

    var inBlock = block.querySelectorAll('[' + Islands.ATTR + ']');
    return inBlock.length > 0 && inBlock[inBlock.length - 1] === island;
  }

  // --- history ---------------------------------------------------------------

  // Push an entry, dropping any redo branch first.
  function pushHistory(entry) {
    if (state.historyAt < state.history.length) state.history.length = state.historyAt;
    state.history.push(entry);
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
    state.historyAt = state.history.length;
    state.lastTouch = 0;
  }

  /*
   * Tidy the formatting marks: an emptied bold run goes, and two bold runs
   * that now touch become one. Deleting across formatting leaves both behind,
   * and neither should reach the file as <strong></strong>.
   */
  function normaliseFormat(value) {
    var prev;
    do {
      prev = value;
      value = value.replace(/\u0002\u0003|\u0004\u0005|\u0003\u0002|\u0005\u0004/g, '');
    } while (value !== prev);
    return value;
  }

  function recordChange(island, explicitBefore, explicitCaret) {
    var region = regionOf(island);
    if (!region) return;

    var after = normaliseFormat(Islands.readValue(island));
    if (after === region.current) return;

    var before = explicitBefore !== undefined ? explicitBefore : region.current;
    var caretBefore = explicitCaret !== undefined ? explicitCaret
      : (state.pendingBefore ? state.pendingBefore.caret : null);
    var now = Date.now();

    // A fresh edit abandons anything that was waiting to be redone.
    if (state.historyAt < state.history.length) state.history.length = state.historyAt;

    var last = state.history[state.history.length - 1];
    if (last && last.kind === 'text' && last.region === region &&
        (now - state.lastTouch) < COALESCE_MS) {
      // A run of typing in one region is one undo step, not one per keystroke.
      last.after = after;
      last.caretAfter = Islands.caretIndex(island);
    } else {
      state.history.push({
        kind: 'text',
        region: region,
        before: before,
        after: after,
        caretBefore: caretBefore,
        caretAfter: Islands.caretIndex(island),
      });
      if (state.history.length > HISTORY_LIMIT) state.history.shift();
      state.historyAt = state.history.length;
    }

    state.lastTouch = now;
    region.current = after;
    region.by = authorName();
    if (region.ai) region.humanToo = true;
    markChanged(region);
    refresh();
  }

  function applyHistory(region, value, caret) {
    Islands.writeValue(region.island, value);
    region.current = value;
    markChanged(region);
    state.lastTouch = 0;          // never coalesce across an undo or redo
    region.island.focus();
    if (caret != null) Islands.setCaret(region.island, caret);
    refresh();
  }

  /*
   * Several regions changed as one step — an accepted AI suggestion, which is
   * one change to one paragraph however many runs of text it touched. Undo
   * puts every run back, and who did it and whether AI suggested it go back
   * with them.
   */
  function multiChange(r, after) {
    return {
      region: r, before: r.current, after: after,
      aiBefore: !!r.ai, byBefore: r.by, modelBefore: r.aiModel || null,
      humanBefore: !!r.humanToo,
      humanAfter: !!r.humanToo || (!r.ai && r.current !== r.original),
    };
  }

  function applyMulti(entry, forward) {
    for (var i = 0; i < entry.changes.length; i++) {
      var c = entry.changes[i];
      var value = forward ? c.after : c.before;
      Islands.writeValue(c.region.island, value);
      c.region.current = value;
      // An accepted suggestion is AI's; putting a run back as the file had it
      // (undoing one change from the list) is nobody's.
      c.region.ai = forward ? (entry.revert ? false : true) : c.aiBefore;
      c.region.by = forward ? (entry.revert ? null : entry.by) : c.byBefore;
      c.region.aiModel = forward ? (entry.revert ? null : entry.model) : c.modelBefore;
      // Words a person typed before the suggestion are still in what it
      // wrote, so the run stays theirs as well as AI's.
      c.region.humanToo = forward ? (!entry.revert && c.humanAfter) : c.humanBefore;
      markChanged(c.region);
    }
    state.lastTouch = 0;
    refresh();
    positionCards();
  }

  // Take an added block back out of the page, or put it back.
  function setAdded(region, present) {
    if (present === !region.removed) return;
    if (present) {
      region.parent.insertBefore(region.element, region.nextSibling);
      region.removed = false;
      region.island.focus();
    } else {
      // Remember exactly where it sat, so redo can put it back there.
      region.parent = region.element.parentNode;
      region.nextSibling = region.element.nextSibling;
      if (region.parent) region.parent.removeChild(region.element);
      region.removed = true;
    }
    state.lastTouch = 0;
    refresh();
  }

  function setCommentText(region, text) {
    region.text = text;
    region.editingFrom = undefined;
    renderRail();
    refresh();
  }

  function undo() {
    flushCommentEdit();
    if (state.historyAt === 0) { flash('Nothing to undo'); return; }
    undoEntry(state.history[--state.historyAt]);
  }

  function redo() {
    flushCommentEdit();
    if (state.historyAt >= state.history.length) { flash('Nothing to redo'); return; }
    redoEntry(state.history[state.historyAt++]);
  }

  // A 'group' is several entries taken as one step: undone last-first.
  function undoEntry(entry) {
    if (entry.kind === 'group') { for (var i = entry.entries.length - 1; i >= 0; i--) undoEntry(entry.entries[i]); }
    else if (entry.kind === 'add') setAdded(entry.region, false);
    else if (entry.kind === 'remove-added') setAdded(entry.region, true);
    else if (entry.kind === 'remove-block') setRemoval(entry.item, false);
    else if (entry.kind === 'restore-block') setRemoval(entry.item, true);
    else if (entry.kind === 'unwrap') setUnwrap(entry.item, false);
    else if (entry.kind === 'rewrap') setUnwrap(entry.item, true);
    else if (entry.kind === 'multi') applyMulti(entry, false);
    else if (entry.kind === 'comment-add') setCommentRemoved(entry.region, true);
    else if (entry.kind === 'comment-remove') setCommentRemoved(entry.region, false);
    else if (entry.kind === 'comment-text') setCommentText(entry.region, entry.before);
    else applyHistory(entry.region, entry.before, entry.caretBefore);
  }

  function redoEntry(entry) {
    if (entry.kind === 'group') entry.entries.forEach(redoEntry);
    else if (entry.kind === 'add') setAdded(entry.region, true);
    else if (entry.kind === 'remove-added') setAdded(entry.region, false);
    else if (entry.kind === 'remove-block') setRemoval(entry.item, true);
    else if (entry.kind === 'restore-block') setRemoval(entry.item, false);
    else if (entry.kind === 'unwrap') setUnwrap(entry.item, true);
    else if (entry.kind === 'rewrap') setUnwrap(entry.item, false);
    else if (entry.kind === 'multi') applyMulti(entry, true);
    else if (entry.kind === 'comment-add') setCommentRemoved(entry.region, false);
    else if (entry.kind === 'comment-remove') setCommentRemoved(entry.region, true);
    else if (entry.kind === 'comment-text') setCommentText(entry.region, entry.after);
    else applyHistory(entry.region, entry.after, entry.caretAfter);
  }

  // --- input handling --------------------------------------------------------

  function onBeforeInput(e) {
    // Forged input is the serious one: it would put the page's words into the
    // document and record them as something the user typed.
    if (!fromUser(e)) return;
    var island = islandOf(e.target);
    if (!island || !state.active) return;
    var type = e.inputType || '';

    if (type === 'historyUndo') { e.preventDefault(); undo(); return; }
    if (type === 'historyRedo') { e.preventDefault(); redo(); return; }

    if (type === 'insertParagraph' || type === 'insertLineBreak') {
      e.preventDefault();
      // Enter breaks the line, the way a paragraph of prose wants it. The one
      // exception is a list item, where the next thing after finishing a bullet
      // is the next bullet. Every other kind of block gets a sibling from
      // Ctrl/Cmd+Enter or the "+" instead, which is explicit enough not to
      // surprise anyone mid-sentence.
      var block = Blocks.blockFor(island);
      if (type === 'insertParagraph' && isListItem(block) &&
          atEndOfBlock(island) && canAddAfter(block)) {
        addAfterIsland(island);
      } else {
        insertPlain(island, '\n');
      }
      return;
    }

    if (ALLOWED_INPUT.indexOf(type) === -1) {
      e.preventDefault();
      if (type === 'formatBold' || type === 'formatItalic') {
        toggleFormat(type === 'formatBold' ? 'b' : 'i');
      } else if (type.lastIndexOf('format', 0) === 0) {
        // Colours, underline, indentation, alignment: new markup or new
        // attributes VibeRevise does not write. Bold and italic it does, above.
        flash('VibeRevise does bold and italic, but not that kind of formatting');
      } else if (type === 'insertFromDrop') {
        flash('Drag and drop is not supported — copy and paste instead');
      } else {
        flash('That kind of edit is not supported in VibeRevise');
      }
      return;
    }

    // Ordinary typing and deleting. Remember where we were so the change can be
    // turned into an undo step once it has happened.
    state.pendingBefore = {
      region: regionOf(island),
      value: Islands.readValue(island),
      caret: Islands.caretIndex(island),
    };
  }

  function onInput(e) {
    if (!fromUser(e)) return;
    var island = islandOf(e.target);
    if (!island || !state.active) return;
    if (!Islands.isClean(island)) flatten(island);

    var pending = state.pendingBefore;
    var matches = pending && pending.region === regionOf(island);
    state.pendingBefore = null;
    recordChange(island,
                 matches ? pending.value : undefined,
                 matches ? pending.caret : undefined);
    positionCards();     // the text just reflowed; the cards follow it
  }

  function insertPlain(island, text) {
    var doc = island.ownerDocument;
    var sel = doc.getSelection();
    if (!sel || !sel.rangeCount) return;

    var range = sel.getRangeAt(0);
    if (!island.contains(range.commonAncestorContainer)) return;

    var before = Islands.readValue(island);
    var caretBefore = Islands.caretIndex(island);

    range.deleteContents();

    var pieces = sanitiseText(text).split('\n');
    var frag = doc.createDocumentFragment();
    for (var i = 0; i < pieces.length; i++) {
      if (i) frag.appendChild(doc.createElement('br'));
      if (pieces[i]) frag.appendChild(doc.createTextNode(pieces[i]));
    }
    var last = frag.lastChild;
    range.insertNode(frag);

    if (last) {
      range.setStartAfter(last);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    recordChange(island, before, caretBefore);
  }

  function onPaste(e) {
    if (!state.active || !fromUser(e)) return;
    var island = islandOf(e.target);
    if (!island) return;
    // Always intercept: the clipboard usually carries text/html as well, and
    // letting the browser have it would paste tags straight into the document.
    e.preventDefault();
    var text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    insertPlain(island, text);
  }

  function onDrop(e) {
    if (!state.active || !fromUser(e)) return;
    e.preventDefault();
    flash('Drag and drop is not supported — copy and paste instead');
  }

  function onDragOver(e) {
    if (state.active) e.preventDefault();
  }

  /*
   * Something just inserted that has had nothing typed into it yet.
   *
   * Inserting is a guess about what the user wanted, and the guess is wrong
   * often enough that backing out of it has to be as cheap as making it. So
   * while a new thing is still empty, Esc and the delete keys mean "not that"
   * rather than "edit nothing". Once a single character is in it the keys go
   * back to their ordinary jobs, because by then it is the user's content.
   *
   * Only the newest insertion qualifies, and only while it is still the last
   * thing that happened: anything else and this would delete a table the user
   * had merely clicked into.
   */
  function pendingInsert() {
    var entry = state.history[state.historyAt - 1];
    if (!entry || entry.kind !== 'add' || entry.region.removed) return null;

    var region = entry.region;
    var empty = region.kind === 'tree' ? !treeHasText(region) : !region.current;
    if (!empty) return null;

    var island = islandOf(doc().activeElement);
    var here = island && state.byIsland.get(island);
    if (!here) return null;
    return (here === region || here.tree === region) ? region : null;
  }

  /*
   * The added item the caret is in, if nothing has been typed into it — the
   * whole of it, for a table: one empty cell in a table with words elsewhere
   * is not an empty table. A line break on its own is not text.
   *
   * Unlike pendingInsert(), any added item qualifies, however long ago it was
   * added: the user can click into an empty paragraph they added earlier and
   * press Delete to be rid of it. What never qualifies is anything that came
   * from the file — those regions are kind 'text', not 'insert' or 'cell' —
   * so no key press here can remove a single byte of the original document.
   */
  function blank(value) {
    return !value || !Islands.plain(value).split(Islands.BR).join('').trim();
  }

  function emptyAddedHere() {
    var island = islandOf(doc().activeElement);
    var here = island && state.byIsland.get(island);
    if (!here) return null;
    var item = here.kind === 'insert' ? here : here.kind === 'cell' ? here.tree : null;
    if (!item || item.removed) return null;
    var empty = item.kind === 'tree'
      ? item.cells.every(function (c) { return blank(c.current); })
      : blank(item.current);
    return empty ? item : null;
  }


  /*
   * A block from the file that has been emptied, and Delete pressed in it.
   *
   * Emptying a paragraph leaves its tags in the file: <p></p>, or a heading
   * with nothing in it, which still takes up space on the page. Once every
   * word is gone there is nothing left to lose, so Delete takes the element
   * out as well, as one undo step, and the list of changes says so.
   *
   * Only plain blocks of words: a paragraph, a heading, a list item, a quote.
   * Not a table cell (the table would lose its shape), not a section or a
   * div (they hold other things), and not a block with anything in it besides
   * words and their formatting: an image is content, even with no text.
   */
  var REMOVABLE = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'dt', 'dd', 'figcaption', 'pre'];
  var INLINE = ['b', 'strong', 'i', 'em', 'u', 's', 'span', 'a', 'mark', 'small', 'sub', 'sup',
                'code', 'abbr', 'cite', 'q', 'font', 'del', 'ins', 'br', 'kbd', 'var', 'time'];

  function removableHere() {
    var island = islandOf(doc().activeElement);
    var r = island && regionOf(island);
    if (!r || r.kind !== 'text') return null;
    var block = Blocks.blockFor(island);
    if (!block || REMOVABLE.indexOf(block.localName) === -1) return null;
    var runs = runsOf(block);
    if (!runs.length || runs.some(function (x) { return !blank(x.current); })) return null;

    var what = describeTag(block.localName);
    var all = block.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].hasAttribute(Islands.ATTR)) continue;
      if (INLINE.indexOf(all[i].localName) === -1) {
        return { refuse: 'This ' + what + ' has more in it than words, so VibeRevise leaves it in place' };
      }
    }
    if (liveComments().some(function (c) { return c.block === block; })) {
      return { refuse: 'This ' + what + ' has a comment on it — delete the comment first' };
    }

    // The only item in a list goes with its list, rather than leaving an
    // empty <ul> behind.
    var target = block;
    var list = block.parentElement;
    if (block.localName === 'li' && list && /^(ul|ol)$/.test(list.localName) &&
        list.children.length === 1 && state.map.elements.get(list)) target = list;

    var range = state.map.elements.get(target);
    if (!range || !range.startTag || !range.endTag) {
      return { refuse: 'VibeRevise cannot tell where this ' + what + ' ends in the file, so it stays' };
    }
    return { block: block, target: target };
  }

  function makeRemoval(target, block) {
    var range = state.map.elements.get(target);
    var runs = state.regions.filter(function (x) { return x.kind === 'text' && target.contains(x.island); });
    var item = {
      kind: 'removal',
      element: target,
      parent: target.parentNode,
      next: target.nextSibling,
      tags: { start: range.startTag.start, end: range.endTag.end },
      cut: Comments.deleteRange(state.source, { start: range.startTag.start, end: range.endTag.end }),
      what: target === block ? describeTag(block.localName) : 'list',
      before: runs.map(function (x) { return x.original; }).join(''),
      runs: runs,
      active: false,
      saved: false,
      by: authorName(),
    };
    state.removals.push(item);
    return item;
  }

  function removeFileBlock(target, block) {
    var item = makeRemoval(target, block || target);
    var land = islandBeside(target);
    pushHistory({ kind: 'remove-block', item: item });
    setRemoval(item, true);
    if (land) {
      land.focus();
      Islands.setCaret(land, Islands.readValue(land).length);
    }
    flash('Removed the empty ' + item.what + ' — Ctrl/Cmd+Z brings it back');
    return item;
  }

  function setRemoval(item, on) {
    if (on === item.active) return;
    if (on) {
      item.parent = item.element.parentNode;
      item.next = item.element.nextSibling;
      if (item.parent) item.parent.removeChild(item.element);
    } else if (item.parent) {
      item.parent.insertBefore(item.element, item.next && item.next.parentNode === item.parent ? item.next : null);
    }
    item.active = on;
    state.lastTouch = 0;
    refresh();
    positionCards();
  }

  /*
   * Something added after a removed block was anchored just past its closing
   * tag, which is now inside the cut. It goes where the block was instead.
   */
  function liveAnchor(anchor) {
    for (var i = 0; i < state.removals.length; i++) {
      var x = state.removals[i];
      if (!x.active || anchor.offset < x.cut.start || anchor.offset > x.cut.end) continue;
      var wholeLine = x.cut.start === 0 || state.source.charAt(x.cut.start - 1) === '\n';
      return wholeLine
        ? { offset: x.cut.start, before: anchor.before.replace(/^[\r\n]+/, ''),
            after: Blocks.newlineOf(state.source) }
        : { offset: x.cut.start, before: '', after: '' };
    }
    return anchor;
  }

  // The editable island just before `el` in the document, for the caret to
  // land in once `el` is gone; failing that, the first one after it.
  function islandBeside(el) {
    var islands = doc().querySelectorAll('[' + Islands.ATTR + ']');
    var before = null, after = null;
    for (var i = 0; i < islands.length; i++) {
      var isl = islands[i];
      if (el.contains(isl) || !isl.isConnected) continue;
      if (el.compareDocumentPosition(isl) & Node.DOCUMENT_POSITION_PRECEDING) before = isl;
      else if (!after) after = isl;
    }
    return before || after;
  }

  /*
   * Take an empty added item out, as its own undoable step. The newest one
   * goes through undo(), so history does not keep an add and its removal
   * side by side for nothing; an older one is removed with an entry of its
   * own, so Ctrl/Cmd+Z brings it back exactly where it was.
   */
  function removeAdded(item) {
    var land = islandBeside(item.element);
    if (pendingInsert() === item) {
      undo();
    } else {
      setAdded(item, false);
      pushHistory({ kind: 'remove-added', region: item });
      refresh();
    }
    if (land) {
      land.focus();
      Islands.setCaret(land, Islands.readValue(land).length);
    }
    flash('Removed the ' + insertName(item) + ' \u2014 Ctrl/Cmd+Z brings it back');
  }

  function insertName(region) {
    if (region.kind !== 'tree') return region.template ? describeTag(region.template.tag) : 'new block';
    var what = Structures.kindById(region.id);
    return what ? what.label.toLowerCase() : 'new block';
  }

  /*
   * Did a person do this, or did the page?
   *
   * Every listener below is on the document, which page script can reach and
   * dispatch to whatever world the editor itself runs in. isTrusted is false
   * for anything dispatchEvent produced, and that is the only thing telling
   * the two apart.
   *
   * It did not matter while VibeRevise only opened documents the user wrote.
   * It matters now that it opens pages they did not: without this, a page can
   * forge Ctrl+S and raise a Save dialog nobody asked for, forge Ctrl+Z to
   * undo work, or forge beforeinput to put its own words into the document and
   * have them recorded as the user's edit — which the user would then save.
   *
   * state.trustSynthetic exists because the test suite can only produce
   * synthetic events. It is never set by the extension or the web app, and the
   * suite tests the guard itself with it off, so the hatch does not quietly
   * become the only path anyone exercises.
   */
  function fromUser(e) {
    return !!(e && (e.isTrusted || state.trustSynthetic));
  }

  function isSaveKey(e) {
    return (e.metaKey || e.ctrlKey) && !e.altKey && (e.key || '').toLowerCase() === 's';
  }

  /*
   * Ctrl/Cmd+S is Save wherever the edits are: typing in the document, in a
   * comment or a box on the bar, paused, or after Done with edits unsaved.
   * The browser's "Save page as" would save the page as rendered, wrappers
   * and all, which is never what is wanted here.
   */
  function onAnyKey(e) {
    if (!isSaveKey(e) || !fromUser(e) || !state.regions.length) return;
    if (state.active && !state.paused) return;          // onKeyDown has it
    if (!state.active && !unsavedCount()) return;      // nothing of ours to save
    e.preventDefault();
    if (e.shiftKey) saveAs(); else save();
  }

  function onKeyDown(e) {
    if (!state.active || !fromUser(e)) return;

    // Esc closes the insert menu, and is checked before the modifier gate
    // below because it carries no modifier.
    if (e.key === 'Escape' &&
        (isMenuOpen() || isAddMenuOpen() || isMoreOpen() || isChangesOpen() ||
         isAIOpen() || isReviewOpen())) {
      e.preventDefault();
      setMenuOpen(false);
      setMoreOpen(false);
      setAIOpen(false);
      closeReview();
      if (isAddMenuOpen()) { setAddMenuOpen(false); hideAdd(); }
      closeChanges();
      return;
    }

    // Delete and Backspace remove any empty added item the caret is in, and
    // a paragraph or heading from the file once every word of it is gone.
    if (e.key === 'Backspace' || e.key === 'Delete') {
      var empty = emptyAddedHere();
      if (empty) {
        e.preventDefault();
        removeAdded(empty);
        return;
      }
      var gone = removableHere();
      if (gone) {
        e.preventDefault();
        if (gone.refuse) flash(gone.refuse);
        else removeFileBlock(gone.target, gone.block);
        return;
      }
    }

    // Esc means "not that", so it only ever cancels the thing just inserted —
    // never an older one the user has come back to. Through undo(), so a
    // mistaken press is itself undoable.
    if (e.key === 'Escape') {
      var fresh = pendingInsert();
      if (fresh) {
        e.preventDefault();
        undo();
        flash('Removed the ' + insertName(fresh));
        return;
      }
    }

    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    var key = (e.key || '').toLowerCase();

    if (key === 's') { e.preventDefault(); if (e.shiftKey) saveAs(); else save(); return; }
    if ((key === 'b' || key === 'i') && !e.shiftKey) { e.preventDefault(); toggleFormat(key); return; }
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); return; }

    // Ctrl/Cmd+Enter adds a block from anywhere in it, not just the end.
    if (key === 'enter') {
      var island = islandOf(doc().activeElement);
      if (island) { e.preventDefault(); addAfterIsland(island); }
      return;
    }
  }

  // Following a link would throw away every unsaved edit, and the page is a
  // document being edited, not a site being browsed.
  function onClick(e) {
    if (!state.active) return;
    var el = e.target && e.target.nodeType === 1 ? e.target : null;
    var link = el && el.closest ? el.closest('a[href]') : null;
    if (link && (link.getAttribute('href') || '').charAt(0) !== '#') {
      e.preventDefault();
      flash('Links do not navigate while edit mode is on');
    }
  }

  function onSubmit(e) {
    if (!state.active) return;
    e.preventDefault();
    flash('Forms do not submit while edit mode is on');
  }

  function onBeforeUnload(e) {
    saveSessionNow();
    if (!unsavedCount()) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  }

  // --- the "+" that appears on hover -----------------------------------------

  var ADD_BTN = 24;   // button size
  var ADD_GAP = 8;    // breathing room between the buttons and the text

  var ADD_CSS = [
    ':host { all: initial; }',
    '.row { display: flex; gap: 5px; }',
    // In the margin the pair stacks, so it needs one button's width, not two.
    '.row.stack { flex-direction: column; }',
    // Sitting over the text is the fallback, so there it carries its own backing.
    '.row.over {',
    '  background: #fff; border-radius: 11px; padding: 3px;',
    '  box-shadow: 0 1px 6px rgba(0, 0, 0, .3);',
    '}',
    'button {',
    '  font: 600 15px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
    '  width: 24px; height: 24px; padding: 0;',
    '  display: flex; align-items: center; justify-content: center;',
    '  border: 0; border-radius: 8px; cursor: pointer;',
    '  color: #fff;',
    // A white ring, so they read against a dark page as well as a light one.
    '  box-shadow: 0 0 0 2px #fff, 0 1px 3px rgba(0, 0, 0, .28);',
    '  transition: transform .09s ease, filter .09s ease;',
    '}',
    '.row.over button { box-shadow: none; }',
    'button:hover { filter: brightness(1.12); transform: translateY(-1px); }',
    'button:active { transform: none; }',
    'button:focus-visible { outline: 2px solid #5b52f0; outline-offset: 2px; }',
    // The + opens the list of everything that can go here, because "what do I
    // want" is the question someone actually has when they reach for it. The
    // one-click repeat of what is already there is still worth its own button,
    // but it is a specific answer, so it gets a specific icon rather than the
    // most general symbol on the row.
    'button.more { background: #5b52f0; }',
    'button.block { background: #6b7280; }',
    'button.note { background: #d9a01e; }',
    // Pressed, the + holds the menu open and should look it.
    'button.more[aria-expanded="true"] { background: #4038d6; transform: none; }',
    '.menu[hidden] { display: none; }',
    '.menu {',
    '  position: absolute; left: 100%; top: 0; margin-left: 7px;',
    '  min-width: 166px; padding: 5px; z-index: 1;',
    '  display: flex; flex-direction: column; gap: 2px;',
    '  border-radius: 10px;',
    '  background: rgba(22, 22, 27, .97);',
    '  box-shadow: 0 4px 22px rgba(0, 0, 0, .42);',
    '  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
    '}',
    '.menu button {',
    '  width: auto; height: auto; border-radius: 7px; padding: 7px 10px;',
    '  justify-content: flex-start; text-align: left; white-space: nowrap;',
    '  background: transparent; box-shadow: none; font-weight: 400;',
    '  font-size: 12px;',
    '}',
    '.menu button:hover { background: rgba(255, 255, 255, .16); filter: none; }',
    '.menu .sep { height: 1px; margin: 3px 4px; background: rgba(255,255,255,.14); }',
    '.menu .same { font-weight: 600; }',
    'svg { width: 13px; height: 13px; fill: currentColor; display: block; }',
    '.menu button svg { display: none; }',
  ].join('\n');

  function ensureAddButton() {
    if (state.add && state.add.host.isConnected) return state.add;

    var host = doc().createElement('div');
    host.setAttribute(UI_ATTR, '');
    [['position', 'absolute'], ['z-index', '2147483646'], ['margin', '0'],
     ['padding', '0'], ['width', 'auto'], ['height', 'auto'],
     ['transform', 'none'], ['pointer-events', 'auto'], ['display', 'none'],
    ].forEach(function (p) { host.style.setProperty(p[0], p[1], 'important'); });

    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>' + ADD_CSS + '</style>' +
      '<div class="row">' +
        // The + now means "put something here", which is the question people
        // actually arrive with, and it opens the whole list.
        '<button class="more" title="Insert something here" aria-expanded="false">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true">' +
          '<path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z"/>' +
          '</svg>' +
        '</button>' +
        // Two stacked sheets: one more of the thing already there. A specific
        // action deserves a specific picture, not the most general symbol on
        // the row.
        '<button class="block" title="Add another one of these">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true">' +
          '<path d="M5 2h8a1 1 0 0 1 1 1v8h-2V4H5z"/>' +
          '<path d="M3 5h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>' +
          '</svg>' +
        '</button>' +
        '<button class="note" title="Comment on this section">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true">' +
          '<path d="M3 2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7l-3.6 2.8V12H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/>' +
          '</svg>' +
        '</button>' +
        '<div class="menu" hidden>' +
          '<button class="same" data-same="1"></button>' +
          '<div class="sep"></div>' +
          Structures.KINDS.map(function (k) {
            return '<button data-kind="' + k.id + '">' + k.label + '</button>';
          }).join('') +
        '</div>' +
      '</div>';

    shadow.querySelector('.block').addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (state.hoverBlock) addAfterBlock(state.hoverBlock);
    });

    /*
     * The + opens the list — a paragraph, a table, a heading — all inserted in
     * the same place, which is the point of offering it from here rather than
     * only from the toolbar: the controls are already beside the block, so
     * there is no question of where the new thing goes.
     *
     * The first item in that list is still "another one of these", so the
     * common case is two clicks from here and one click from the button
     * beside it.
     */
    var menu = shadow.querySelector('.menu');
    shadow.querySelector('.more').addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      setAddMenuOpen(menu.hidden);
    });

    menu.addEventListener('mousedown', function (e) {
      var btn = e.target.closest && e.target.closest('button');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      var block = state.hoverBlock;
      setAddMenuOpen(false);
      hideAdd();
      if (!block) return;
      if (btn.hasAttribute('data-same')) addAfterBlock(block);
      else insertStructure(btn.getAttribute('data-kind'), block);
    });
    shadow.querySelector('.note').addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (state.hoverBlock) addCommentTo(state.hoverBlock);
    });

    // The buttons stand off the block now, so the pointer has to cross a sliver
    // of page to reach them; don't take them away while it is in flight.
    host.addEventListener('mouseenter', clearAddHide);
    host.addEventListener('mouseleave', requestHideAdd);

    doc().documentElement.appendChild(host);
    state.add = {
      host: host,
      row: shadow.querySelector('.row'),
      menu: menu,
      plus: shadow.querySelector('.more'),
      same: shadow.querySelector('.same'),
    };
    return state.add;
  }

  /*
   * The insert menu hanging off the hover controls.
   *
   * While it is open the controls must not be taken away, however far the
   * pointer wanders — the user is reading a menu, not leaving.
   */
  function setAddMenuOpen(open) {
    if (!state.add) return;
    state.add.menu.hidden = !open;
    state.add.plus.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      clearAddHide();
      // Name the block being hovered, so the first item says what it will add.
      var tag = state.hoverBlock ? state.hoverBlock.localName : 'block';
      state.add.same.textContent = 'Another ' + tag;
    }
  }

  function isAddMenuOpen() {
    return !!(state.add && !state.add.menu.hidden);
  }

  function clearAddHide() {
    if (state.addHideTimer) {
      clearTimeout(state.addHideTimer);
      state.addHideTimer = 0;
    }
  }

  function hideAdd() {
    setAddMenuOpen(false);
    clearAddHide();
    if (state.add) state.add.host.style.setProperty('display', 'none', 'important');
    state.hoverBlock = null;
  }

  /*
   * Leaving the block is only a hint: the pointer may be on its way to a button.
   *
   * The buttons sit ADD_BTN + ADD_GAP to the left of the text, so reaching them
   * means crossing a strip of ordinary page that belongs to neither. Every
   * mouseover in that strip lands on the document and reads as "gone". Two
   * things keep the buttons where the user is aiming:
   *
   *   - a grace period long enough to cross 30px and land on a 22px target,
   *     which 220ms was not; people who track a small control are slower than
   *     people who already know where it is
   *   - inApproachCorridor(), which does not start the countdown at all while
   *     the pointer is in the strip beside the block it belongs to
   *
   * Together these mean the buttons go away when you leave, and stay when you
   * are on your way to them.
   */
  function requestHideAdd() {
    if (isAddMenuOpen()) return;
    if (!state.add || !state.hoverBlock || state.addHideTimer) return;
    state.addHideTimer = setTimeout(function () {
      state.addHideTimer = 0;
      hideAdd();
    }, 650);
  }

  /*
   * Is the pointer in the dead strip between the hovered block and its buttons?
   *
   * The corridor is the block's own vertical band, widened a little for a
   * diagonal approach, running from just past the buttons to the block's right
   * edge. Inside it, nothing is hiding.
   */
  function inApproachCorridor(e) {
    if (!state.hoverBlock) return false;
    var r = state.hoverBlock.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    var reach = ADD_BTN + ADD_GAP + 10;
    return e.clientY >= r.top - 10 && e.clientY <= r.bottom + 10 &&
           e.clientX >= r.left - reach && e.clientX <= r.right;
  }

  /*
   * Park the buttons in the page's left margin, level with the block's first
   * line, so they never sit on the words. A block hard against the left edge
   * has no margin to use, and there falls back to a pill straddling the top
   * edge — opaque, so it reads over whatever is underneath. Positioned in
   * document coordinates so it stays put while the page scrolls.
   */
  function showAddFor(block) {
    var ui = ensureAddButton();
    var rect = block.getBoundingClientRect();
    if (!rect.width && !rect.height) { hideAdd(); return; }

    clearAddHide();
    state.hoverBlock = block;

    var left = rect.left + win().scrollX;
    var top = rect.top + win().scrollY;
    if (left >= ADD_BTN + ADD_GAP + 4) {
      ui.row.className = 'row stack';
      left -= ADD_BTN + ADD_GAP;
    } else {
      ui.row.className = 'row over';
      if (top >= ADD_BTN + 6) top -= ADD_BTN + 6;
    }

    ui.host.style.setProperty('left', left + 'px', 'important');
    ui.host.style.setProperty('top', top + 'px', 'important');
    ui.host.style.setProperty('display', 'block', 'important');
  }

  // Remember where the caret has been, so Insert still knows after the toolbar
  // has taken focus away. Focus moving into the toolbar is not an island, so it
  // leaves the last one standing, which is exactly what is wanted.
  function onFocusIn(e) {
    var island = islandOf(e.target);
    if (island) state.lastIsland = island;
  }

  function onMouseDownAnywhere() {
    // The bar's and the hover controls' own handlers stopPropagation, so
    // reaching here means the click was somewhere else.
    if (isMenuOpen()) setMenuOpen(false);
    if (isMoreOpen()) setMoreOpen(false);
    if (isAIOpen()) setAIOpen(false);
    if (isAddMenuOpen()) { setAddMenuOpen(false); hideAdd(); }
  }

  function onMouseOver(e) {
    if (!state.active) return;
    if (state.add && e.target === state.add.host) {   // over the buttons themselves
      clearAddHide();
      return;
    }

    var island = islandOf(e.target);
    if (!island) {
      if (inApproachCorridor(e)) { clearAddHide(); return; }
      requestHideAdd();
      return;
    }

    var block = Blocks.blockFor(island);
    if (!block || !canAddAfter(block)) {
      if (inApproachCorridor(e)) { clearAddHide(); return; }
      requestHideAdd();
      return;
    }
    clearAddHide();
    if (block !== state.hoverBlock) showAddFor(block);
  }

  var LISTENERS = [
    ['beforeinput', onBeforeInput, true],
    ['input', onInput, true],
    ['paste', onPaste, true],
    ['drop', onDrop, true],
    ['dragover', onDragOver, true],
    ['keydown', onKeyDown, true],
    ['focusin', onFocusIn, true],
    ['mouseover', onMouseOver, true],
    ['mousedown', onMouseDownAnywhere, false],
    ['click', onClick, true],
    ['submit', onSubmit, true],
  ];

  function addListeners() {
    if (state.listening) return;
    LISTENERS.forEach(function (l) { doc().addEventListener(l[0], l[1], l[2]); });
    win().addEventListener('resize', onResize);
    state.listening = true;
  }

  function removeListeners() {
    if (!state.listening) return;
    LISTENERS.forEach(function (l) { doc().removeEventListener(l[0], l[1], l[2]); });
    win().removeEventListener('resize', onResize);
    state.listening = false;
  }

  // --- comments --------------------------------------------------------------

  var COMMENTED_ATTR = 'data-vr-commented';
  var ACTIVE_ATTR = 'data-vr-comment-active';
  var RAIL_WIDTH = 296;

  var RAIL_CSS = [
    ':host { all: initial; }',
    '.card {',
    '  position: absolute; right: 0; width: 260px;',
    '  font: 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
    '  background: #fffdf7; color: #22242a;',
    '  border: 1px solid #e6ddc4; border-left: 3px solid #d9a01e;',
    '  border-radius: 6px; padding: 8px 9px 7px;',
    '  box-shadow: 0 1px 6px rgba(0, 0, 0, .12);',
    '  transition: top .12s ease;',
    '  box-sizing: border-box;',
    '}',
    '.card.unsaved { border-left-color: #5b52f0; }',
    '.head { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }',
    '.who { font-weight: 600; color: #6b6250; flex: 1; }',
    '.del {',
    '  font: 14px/1 system-ui, sans-serif; border: 0; background: transparent;',
    '  color: #9a917d; cursor: pointer; padding: 0 2px; border-radius: 3px;',
    '}',
    '.del:hover { background: rgba(0, 0, 0, .07); color: #b91c1c; }',
    // A reply is the same card, stepped in and tied to the one above it, so a
    // thread reads as one object in the margin without needing a container.
    '.card.reply {',
    '  width: 244px; border-left-color: #c9bda0;',
    '  border-top-left-radius: 3px;',
    '}',
    '.card.reply .who::before { content: "\\21b3\\00a0"; color: #a9a08c; font-weight: 400; }',
    '.foot { margin-top: 6px; }',
    '.reply-btn {',
    '  font: 600 11px/1 system-ui, sans-serif; border: 0; background: transparent;',
    '  color: #8a7f66; cursor: pointer; padding: 3px 5px; border-radius: 4px;',
    '}',
    '.reply-btn:hover { background: rgba(0, 0, 0, .07); color: #4a4133; }',
    'textarea {',
    '  font: inherit; width: 100%; border: 0; padding: 0; margin: 0;',
    '  background: transparent; color: inherit; resize: none; overflow: hidden;',
    '  outline: none; display: block;',
    '}',
    'textarea::placeholder { color: #a9a08c; }',
    '@media (prefers-color-scheme: dark) {',
    '  .card { background: #2a2620; color: #ece9e2; border-color: #4a4133; }',
    '  .card.reply { border-left-color: #6b6250; }',
    '  .who { color: #b8ad93; }',
    '  .reply-btn { color: #b8ad93; }',
    '  .reply-btn:hover { background: rgba(255, 255, 255, .12); color: #ece9e2; }',
    '  textarea::placeholder { color: #7d7462; }',
    '}',
  ].join('\n');

  /*
   * The notes to show, in the order they should be read.
   *
   * Document order of the section each one is attached to, and within a
   * section the order they were written. That is what makes a reply a reply:
   * nothing in the file marks one, and nothing needs to — a thread is simply
   * the notes that share a block, oldest first. Writing it this way means a
   * reply survives being read by anything that knows only what an HTML
   * comment is.
   */
  function liveComments() {
    var live = state.comments.filter(function (r) { return !r.removed; });
    var order = new Map();
    for (var i = 0; i < live.length; i++) order.set(live[i], i);

    return live.sort(function (a, b) {
      if (a.block !== b.block && a.block && b.block && a.block.compareDocumentPosition) {
        var rel = a.block.compareDocumentPosition(b.block);
        if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      }
      return order.get(a) - order.get(b);
    });
  }

  // How many live notes sit on this block, and where this one comes in that
  // thread. Index 0 opens it; anything after is a reply.
  function threadIndex(region) {
    var n = 0;
    var live = liveComments();
    for (var i = 0; i < live.length; i++) {
      if (live[i] === region) return n;
      if (live[i].block === region.block) n++;
    }
    return n;
  }

  /*
   * What the file would hold for this note if it were saved right now: its
   * text, or null when the file would not contain it at all. A note that was
   * deleted and a note that was emptied both come to the same thing.
   */
  function commentWanted(r) {
    if (r.removed) return null;
    return r.text.trim() || null;
  }

  // What the file holds for it now: null when it is not in there.
  function commentInFile(r) {
    return r.saved == null ? null : r.saved;
  }

  // Is this note exactly what the file holds, in the form it will be written?
  function commentSettled(r) {
    if (commentWanted(r) !== commentInFile(r)) return false;
    if (commentInFile(r) === null) return true;
    return !!r.savedVisible === !!state.commentsVisible;
  }

  function commentChangedCount() {
    var n = 0;
    for (var i = 0; i < state.comments.length; i++) {
      var r = state.comments[i];
      if (r.removed) { if (r.token) n++; continue; }   // a deleted existing comment is a change
      if (r.text.trim() !== r.original) { n++; continue; }
      // Same words, written the other way round: showing a note in the
      // document, or hiding it again, changes the file.
      if (r.token && !!r.element !== !!state.commentsVisible) n++;
    }
    return n;
  }

  /*
   * Notes that differ from the file as it was last written.
   *
   * Compared against what the file HOLDS rather than against the text the note
   * was last saved with. Those are not the same thing for a note that was
   * deleted: it used to count as unsaved for ever, because its text had been
   * recorded as saved while the fact of its removal never was, so the status
   * bar claimed unsaved work after a save that had plainly succeeded — and
   * the unload warning went on firing on a file with nothing left to lose.
   */
  function commentUnsavedCount() {
    var n = 0;
    for (var i = 0; i < state.comments.length; i++) {
      var r = state.comments[i];
      if (commentWanted(r) !== commentInFile(r)) { n++; continue; }
      if (commentInFile(r) === null) continue;
      if (!!r.savedVisible !== !!state.commentsVisible) n++;
    }
    return n;
  }

  function emptyCommentCount() {
    var n = 0;
    var live = liveComments();
    for (var i = 0; i < live.length; i++) if (!live[i].text.trim()) n++;
    return n;
  }

  /*
   * Comments already in the file. Anything that is not one of ours — the
   * boilerplate a generator left behind, a conditional comment — is left
   * exactly where it is and never shown.
   */
  function buildComments() {
    state.comments = [];
    var found = [];
    var paired = state.map.comments.paired;

    for (var i = 0; i < paired.length; i++) {
      var parsed = Comments.parse(paired[i].node.data);
      if (parsed === null) continue;
      var node = paired[i].node;
      found.push({
        token: paired[i].token,
        node: node,
        element: null,
        block: node.nextElementSibling || node.parentElement,
        parsed: parsed,
      });
    }

    /*
     * The visible form. Its range in the file is the whole element, start tag
     * to end tag, which mapping already works out for every element it could
     * pair with the source. One without both tags is left alone: a note we
     * cannot find the edges of is one we cannot safely rewrite or remove.
     */
    var rendered = doc().querySelectorAll('[' + Comments.RENDERED_ATTR + ']');
    for (var j = 0; j < rendered.length; j++) {
      var el = rendered[j];
      var tags = state.map.elements.get(el);
      if (!tags || !tags.startTag || !tags.endTag) continue;
      var fromEl = Comments.parseElement(el);
      if (fromEl === null) continue;
      found.push({
        token: { start: tags.startTag.start, end: tags.endTag.end },
        node: null,
        element: el,
        block: el.nextElementSibling || el.parentElement,
        parsed: fromEl,
      });
    }

    // Source order, so a thread reads in the order it was written whichever
    // form each note happens to be in.
    found.sort(function (a, b) { return a.token.start - b.token.start; });

    for (var k = 0; k < found.length; k++) {
      var f = found[k];
      state.comments.push({
        kind: 'comment',
        token: f.token,
        node: f.node,
        element: f.element,
        block: f.block,
        author: f.parsed.author,
        date: f.parsed.date,
        text: f.parsed.text,
        original: f.parsed.text,
        saved: f.parsed.text,
        savedVisible: !!f.element,
        removed: false,
        anchor: null,
        card: null,
      });
    }
  }

  // opts.text and opts.author fill the note in, for a reply AI drafted; such a
  // note is not focused, because nobody is about to type into it.
  function addCommentTo(block, opts) {
    opts = opts || {};
    if (!block) return null;
    flushCommentEdit();
    var anchor = Comments.anchorFor(state.map, state.source, block);
    if (!anchor) {
      flash('VibeRevise cannot tell where this section starts in the file');
      return null;
    }
    if (!authorName() && !state.nudgedName && !opts.text) {
      state.nudgedName = true;
      flash('Tip: add your name from ⋯ so people can see who wrote this');
    }
    var region = {
      kind: 'comment',
      token: null,
      node: null,
      element: null,
      block: block,
      author: opts.author != null ? opts.author : authorName(),
      date: Comments.today(),
      text: opts.text || '',
      original: '',
      saved: null,            // not in the file at all until it is written
      savedVisible: false,
      removed: false,
      anchor: anchor,
      card: null,
    };
    state.comments.push(region);
    pushHistory({ kind: 'comment-add', region: region });
    hideAdd();
    renderRail(opts.text ? null : region);
    refresh();
    return region;
  }

  /*
   * Move the switch. Nothing is written here — the next save is what rewrites
   * the file — but every note that is in it immediately counts as unsaved, so
   * the status bar and the margin say straight away that a save is pending
   * rather than letting a toggle look like it did nothing.
   */
  function setCommentsVisible(next) {
    next = !!next;
    if (next === state.commentsVisible) return;
    state.commentsVisible = next;
    if (state.ui && state.ui.showComments) state.ui.showComments.checked = next;
    if (state.settings) {
      Promise.resolve(state.settings.set('commentsVisible', next)).catch(function () {});
    }
    renderRail();
    refresh();

    var n = state.comments.filter(function (r) {
      return commentInFile(r) !== null;
    }).length;
    flash(next
      ? (n ? 'Comments will be visible in the file — save to rewrite ' + n + ' of them'
           : 'Comments will be saved as visible notes')
      : (n ? 'Comments will be hidden again — save to rewrite ' + n + ' of them'
           : 'Comments will be saved as HTML comments, which no browser shows'));
  }

  function setCommentRemoved(region, removed) {
    region.removed = removed;
    renderRail();
    refresh();
  }

  function removeComment(region) {
    flushCommentEdit();
    pushHistory({ kind: 'comment-remove', region: region });
    setCommentRemoved(region, true);
  }

  // Text changes are one history step per visit to a card, not per keystroke.
  function commitCommentText(region) {
    if (region.editingFrom === undefined || region.editingFrom === region.text) {
      region.editingFrom = undefined;
      return;
    }
    pushHistory({
      kind: 'comment-text',
      region: region,
      before: region.editingFrom,
      after: region.text,
    });
    region.editingFrom = undefined;
  }

  /*
   * Settle any half-finished typing in a card before something structural
   * happens.
   *
   * Without this, adding or deleting a comment rebuilds the margin, which
   * destroys the focused textarea, which fires blur, which files the typing as
   * a history step AFTER the structural one. Undo would then take back the
   * typing instead of the deletion — the wrong thing, and confusingly so.
   */
  function flushCommentEdit() {
    if (!state.editingComment) return;
    commitCommentText(state.editingComment);
    state.editingComment = null;
  }

  // --- the comment margin ----------------------------------------------------

  /*
   * The cards live in a margin down the right-hand side, like a word processor.
   * Making room for it means widening the page's right padding while edit mode
   * is on — a visible change to the layout, but a temporary one, and the file
   * never hears about it. The page's own inline style is put back on the way
   * out.
   */
  function ensureRail() {
    if (state.rail && state.rail.host.isConnected) return state.rail;

    var html = doc().documentElement;
    state.railStyle = {
      paddingRight: html.style.getPropertyValue('padding-right'),
      paddingPriority: html.style.getPropertyPriority('padding-right'),
      position: html.style.getPropertyValue('position'),
      positionPriority: html.style.getPropertyPriority('position'),
    };
    html.style.setProperty('padding-right', RAIL_WIDTH + 'px', 'important');
    // So the rail positions against the padding box rather than the viewport.
    html.style.setProperty('position', 'relative', 'important');

    var host = doc().createElement('div');
    host.setAttribute(UI_ATTR, '');
    [['position', 'absolute'], ['top', '0'], ['right', '10px'],
     ['width', '260px'], ['height', '0'], ['margin', '0'], ['padding', '0'],
     ['z-index', '2147483645'], ['pointer-events', 'auto'],
    ].forEach(function (p) { host.style.setProperty(p[0], p[1], 'important'); });

    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>' + RAIL_CSS + '</style><div class="list"></div>';
    html.appendChild(host);

    state.rail = { host: host, shadow: shadow, list: shadow.querySelector('.list') };
    return state.rail;
  }

  function closeRail() {
    if (state.rail && state.rail.host.parentNode) {
      state.rail.host.parentNode.removeChild(state.rail.host);
    }
    state.rail = null;

    if (state.railStyle) {
      var html = doc().documentElement;
      var saved = state.railStyle;
      html.style.removeProperty('padding-right');
      html.style.removeProperty('position');
      if (saved.paddingRight) {
        html.style.setProperty('padding-right', saved.paddingRight, saved.paddingPriority);
      }
      if (saved.position) {
        html.style.setProperty('position', saved.position, saved.positionPriority);
      }
      state.railStyle = null;
    }
  }

  function clearHighlights() {
    var marked = doc().querySelectorAll('[' + COMMENTED_ATTR + ']');
    for (var i = 0; i < marked.length; i++) {
      marked[i].removeAttribute(COMMENTED_ATTR);
      marked[i].removeAttribute(ACTIVE_ATTR);
    }
  }

  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }

  function renderRail(focusRegion) {
    var regions = liveComments();

    if (!regions.length) {
      state.railRendering = true;
      clearHighlights();
      closeRail();
      state.railRendering = false;
      return;
    }

    var rail = ensureRail();
    state.railRendering = true;
    rail.list.textContent = '';
    clearHighlights();

    regions.forEach(function (region) {
      var isReply = threadIndex(region) > 0;
      var card = doc().createElement('div');
      card.className = 'card' + (commentSettled(region) ? '' : ' unsaved') +
        (isReply ? ' reply' : '');
      card.innerHTML =
        '<div class="head"><span class="who"></span>' +
        '<button class="del" title="Delete this comment">&times;</button></div>' +
        '<textarea rows="1" placeholder="' +
          (isReply ? 'Write a reply…' : 'Write a comment…') + '"></textarea>' +
        '<div class="foot">' +
          '<button class="reply-btn" title="Add a reply to this thread">Reply</button>' +
          (state.ai ? '<button class="reply-btn ask-ai" title="Have AI draft a reply, and ' +
            'suggest a change to the passage if the thread asks for one">Ask AI</button>' : '') +
        '</div>';

      // Whoever the note says wrote it; a new one is the current user's until
      // it is saved.
      var who = region.token ? region.author : (region.author || authorName());
      card.querySelector('.who').textContent = who
        ? who + (region.date ? ' · ' + region.date : '')
        : 'Comment';
      var textarea = card.querySelector('textarea');
      textarea.value = region.text;

      textarea.addEventListener('input', function () {
        region.text = textarea.value;
        autoGrow(textarea);
        card.className = 'card' + (commentSettled(region) ? '' : ' unsaved');
        positionCards();
        refresh();
      });
      textarea.addEventListener('focus', function () {
        region.editingFrom = region.text;
        state.editingComment = region;
        if (region.block && region.block.setAttribute) region.block.setAttribute(ACTIVE_ATTR, '');
      });
      textarea.addEventListener('blur', function () {
        // A blur caused by rebuilding the margin is not the user finishing an
        // edit; flushCommentEdit has already dealt with any real one.
        if (state.railRendering) return;
        if (state.editingComment === region) state.editingComment = null;
        commitCommentText(region);
        if (region.block && region.block.removeAttribute) region.block.removeAttribute(ACTIVE_ATTR);
      });
      card.querySelector('.del').addEventListener('click', function () { removeComment(region); });
      // A reply is another note on the same section. Nothing in the file says
      // so; it is a reply because it sits in the same thread, which is what
      // keeps the format something a text editor can still make sense of.
      card.querySelector('.reply-btn').addEventListener('click', function () {
        addCommentTo(region.block);
      });
      var askAI = card.querySelector('.ask-ai');
      if (askAI) askAI.addEventListener('click', function () { aiReplyTo(region); });

      rail.list.appendChild(card);
      region.card = card;
      autoGrow(textarea);

      if (region.block && region.block.setAttribute) {
        region.block.setAttribute(COMMENTED_ATTR, '');
      }
    });

    state.railRendering = false;
    positionCards();
    if (focusRegion && focusRegion.card) focusRegion.card.querySelector('textarea').focus();
  }

  /*
   * Line each card up with the section it belongs to, and push it down if the
   * one above would overlap it. Same idea as a word processor's margin: the
   * cards want to sit beside their text and settle for as close as they can get.
   */
  function positionCards() {
    if (!state.rail) return;
    var regions = liveComments();
    var bottom = 0;

    for (var i = 0; i < regions.length; i++) {
      var region = regions[i];
      if (!region.card) continue;

      var wanted = bottom;
      if (region.block && region.block.getBoundingClientRect) {
        var rect = region.block.getBoundingClientRect();
        wanted = rect.top + win().scrollY;
      }
      var top = Math.max(wanted, bottom);
      region.card.style.top = top + 'px';
      bottom = top + region.card.offsetHeight + 8;
    }
  }

  function onResize() {
    positionCards();
  }

  // --- status bar ------------------------------------------------------------

  function ensureStyles() {
    if (state.styleEl && state.styleEl.isConnected) return;
    var el = doc().createElement('style');
    el.setAttribute(UI_ATTR, '');
    el.textContent = ISLAND_CSS;
    (doc().head || doc().documentElement).appendChild(el);
    state.styleEl = el;
  }

  /*
   * The status bar lives in a closed shadow root so the page's stylesheet
   * cannot reach into it and our styles cannot leak out. The host element's own
   * positioning is set inline with !important, since that is the one part a
   * page rule could still fight over.
   */
  // The same speech bubble the hover controls use, so the button in the bar
  // reads as "comments" rather than as "a menu of other things".
  var BUBBLE =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M3 2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7l-3.6 2.8V12H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/>' +
    '</svg>';

  function ensureStatusBar() {
    if (state.ui && state.ui.host.isConnected) return;

    var host = doc().createElement('div');
    host.setAttribute(UI_ATTR, '');
    [['position', 'fixed'], ['right', '16px'], ['bottom', '16px'],
     ['z-index', '2147483647'], ['margin', '0'], ['padding', '0'],
     ['width', 'auto'], ['height', 'auto'], ['max-width', 'none'],
     ['transform', 'none'], ['opacity', '1'], ['visibility', 'visible'],
     ['display', 'block'], ['pointer-events', 'auto'], ['float', 'none'],
    ].forEach(function (p) { host.style.setProperty(p[0], p[1], 'important'); });

    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML =
      '<style>' + BAR_CSS + '</style>' +
      '<div class="bar">' +
        '<span class="dot"></span>' +
        '<span class="label">Edit mode</span>' +
        '<button class="count" title="Show what has changed"></button>' +
        '<span class="msg"></span>' +
        '<span class="sep"></span>' +
        '<button class="fmt fmt-b" title="Bold (Ctrl/Cmd+B)" aria-label="Bold"><b>B</b></button>' +
        '<button class="fmt fmt-i" title="Italic (Ctrl/Cmd+I)" aria-label="Italic"><i>I</i></button>' +
        '<button class="insert" title="Add a table, a list, a heading">Insert \u25be</button>' +
        '<div class="menu" hidden>' +
          Structures.KINDS.map(function (k) {
            return '<button data-kind="' + k.id + '">' + k.label + '</button>';
          }).join('') +
          '<div class="hint">Copied from the nearest one already in the document, ' +
          'so it matches.</div>' +
        '</div>' +
        '<span class="sep"></span>' +
        '<button class="undo icon" title="Undo (Ctrl/Cmd+Z)" aria-label="Undo" disabled>\u21b6</button>' +
        '<button class="redo icon" title="Redo (Ctrl/Cmd+Shift+Z)" aria-label="Redo" disabled>\u21b7</button>' +
        '<span class="sep"></span>' +
        '<button class="more-btn icon" title="Comments and review" ' +
                'aria-label="Comments and review">' + BUBBLE + '</button>' +
        '<div class="panel" hidden>' +
          '<div class="p-head">' +
            '<span class="p-title">Comments &amp; review</span>' +
            '<button class="p-info" aria-expanded="false" ' +
                    'title="What these do" aria-label="What these do">i</button>' +
          '</div>' +
          '<div class="p-row">' +
            '<input id="vr-author" class="p-input" maxlength="60" autocomplete="name" ' +
                   'aria-label="Your name" placeholder="Your name">' +
            '<button class="p-save">Save</button>' +
          '</div>' +
          '<div class="p-hint" data-info hidden>Signs your comments and the list of ' +
            'changes. Not a sign-in — anyone can type any name.</div>' +
          '<label class="p-check">' +
            '<input type="checkbox" class="p-show-comments">' +
            'Show comments in the document' +
          '</label>' +
          '<div class="p-hint" data-info hidden>Off, a comment is hidden in the file: ' +
            'it travels with the document but no browser shows it. On, it is saved as ' +
            'a visible note anyone can read without VibeRevise. The switch goes both ' +
            'ways, and rewrites every comment next time you save.</div>' +
          '<div class="p-sep"></div>' +
          '<button class="p-changes">Show changes</button>' +
          '<button class="p-changes p-saveas" title="Ctrl/Cmd+Shift+S">Save as\u2026</button>' +
        '</div>' +
        (state.ai ? AI_MARKUP : '') +
        '<button class="outside-btn" hidden aria-pressed="true" ' +
          'title="Show or hide what changed outside VibeRevise"></button>' +
        '<button class="save primary" disabled>Save</button>' +
        '<button class="pause" title="Stop editing for now, so you can select and copy text">Pause</button>' +
        '<button class="done">Done</button>' +
      '</div>';

    doc().documentElement.appendChild(host);

    var ui = {
      host: host,
      count: shadow.querySelector('.count'),
      msg: shadow.querySelector('.msg'),
      insert: shadow.querySelector('.insert'),
      fmtB: shadow.querySelector('.fmt-b'),
      fmtI: shadow.querySelector('.fmt-i'),
      menu: shadow.querySelector('.menu'),
      undo: shadow.querySelector('.undo'),
      redo: shadow.querySelector('.redo'),
      save: shadow.querySelector('.save'),
      done: shadow.querySelector('.done'),
      pause: shadow.querySelector('.pause'),
      bar: shadow.querySelector('.bar'),
      label: shadow.querySelector('.label'),
      moreBtn: shadow.querySelector('.more-btn'),
      panel: shadow.querySelector('.panel'),
      authorInput: shadow.querySelector('.p-input'),
      authorSave: shadow.querySelector('.p-save'),
      changesBtn: shadow.querySelector('.p-changes'),
      saveAsBtn: shadow.querySelector('.p-saveas'),
      outsideBtn: shadow.querySelector('.outside-btn'),
      info: shadow.querySelector('.p-info'),
      infoRows: shadow.querySelectorAll('[data-info]'),
      showComments: shadow.querySelector('.p-show-comments'),
    };
    ui.info.addEventListener('click', function () {
      var open = ui.info.getAttribute('aria-expanded') !== 'true';
      ui.info.setAttribute('aria-expanded', open ? 'true' : 'false');
      for (var i = 0; i < ui.infoRows.length; i++) ui.infoRows[i].hidden = !open;
    });
    ui.showComments.checked = !!state.commentsVisible;
    ui.showComments.addEventListener('change', function () {
      setCommentsVisible(ui.showComments.checked);
    });
    // mousedown, not click: by click time the caret has already left the text
    // the user was editing, and undo would restore it somewhere they cannot see.
    // mousedown with the default prevented, so opening the menu does not pull
    // the caret out of the text. currentBlock() can recover from that, but not
    // losing it in the first place is better: the page does not jump and the
    // user's selection survives.
    // mousedown with the default prevented: the selection being formatted
    // must still be there when the button acts on it.
    ui.fmtB.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); toggleFormat('b'); });
    ui.fmtI.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); toggleFormat('i'); });
    ui.insert.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(ui.menu.hidden);
    });
    ui.insert.addEventListener('click', function (e) { e.stopPropagation(); });
    // mousedown, not click: the menu closes on the document's click, and by
    // then this button no longer exists to have been clicked.
    ui.menu.addEventListener('mousedown', function (e) {
      var btn = e.target.closest && e.target.closest('button[data-kind]');
      if (!btn) return;
      e.preventDefault();
      setMenuOpen(false);
      insertStructure(btn.getAttribute('data-kind'));
    });

    ui.undo.addEventListener('mousedown', function (e) { e.preventDefault(); undo(); });
    ui.redo.addEventListener('mousedown', function (e) { e.preventDefault(); redo(); });
    ui.save.addEventListener('click', function () { save(); });
    ui.saveAsBtn.addEventListener('click', function () { setMoreOpen(false); saveAs(); });
    ui.outsideBtn.addEventListener('mousedown', function (e) {
      e.preventDefault();
      setShowOutside(!state.showOutside);
    });
    ui.done.addEventListener('click', function () { setActive(false); });
    ui.pause.addEventListener('click', function () { setPaused(!state.paused); });

    ui.count.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleChanges();
    });
    // The bubble opens the panel, and the panel opens the list of changes;
    // pressed again, the bubble closes whichever of them is open.
    ui.moreBtn.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (isChangesOpen()) { closeChanges(); setMoreOpen(false); return; }
      setMoreOpen(ui.panel.hidden);
    });
    // The panel holds a text field, so it must take focus and keep it: stop
    // the page's mousedown handler from treating a click in here as "away".
    ui.panel.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    ui.authorSave.addEventListener('click', function () {
      setAuthor(ui.authorInput.value);
      flash(state.author ? 'Hello, ' + state.author : 'Name cleared');
      setMoreOpen(false);
    });
    ui.authorInput.addEventListener('keydown', function (e) {
      if (isSaveKey(e)) { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) saveAs(); else save(); return; }
      if (e.key === 'Enter') { e.preventDefault(); ui.authorSave.click(); }
      e.stopPropagation();       // typing a name is not an editing shortcut
    });
    ui.changesBtn.addEventListener('click', function () {
      setMoreOpen(false);
      openChanges();
    });
    state.ui = ui;
    if (state.ai) wireAIPanel(shadow);
  }

  /*
   * The insert menu. Closed by anything that is not it: a click elsewhere, Esc,
   * leaving edit mode, or choosing something from it.
   */
  function setMenuOpen(open) {
    if (!state.ui) return;
    if (open) setAIOpen(false);
    state.ui.menu.hidden = !open;
    state.ui.insert.textContent = 'Insert ' + (open ? '\u25b4' : '\u25be');
  }

  function isMenuOpen() {
    return !!(state.ui && !state.ui.menu.hidden);
  }

  function removeStatusBar() {
    setMenuOpen(false);
    clearAddHide();
    if (state.ui && state.ui.host.parentNode) state.ui.host.parentNode.removeChild(state.ui.host);
    state.ui = null;
    if (state.add && state.add.host.parentNode) {
      state.add.host.parentNode.removeChild(state.add.host);
    }
    state.add = null;
    state.hoverBlock = null;
  }

  function refresh() {
    if (!state.ui) return;
    var changed = changedCount();
    var unsaved = unsavedCount();
    var empty = emptyAddedCount() + emptyCommentCount();

    // Counted the way the list of changes counts them — per paragraph, not per
    // run of text — so the number on the bar and the number in the list agree.
    var shown = collectChanges().length || changed;
    var text = changed === 0
      ? 'no changes'
      : shown + (shown === 1 ? ' change' : ' changes') + (unsaved ? ' · unsaved' : ' · saved');
    if (empty) text += ' · ' + empty + ' empty' + (empty === 1 ? '' : 's') + ' not saved';

    if (state.conflicts.length) {
      text += ' · ' + state.conflicts.length + (state.conflicts.length === 1 ? ' clash' : ' clashes');
    }
    var outsideN = outsideRows().length;
    state.ui.outsideBtn.hidden = !outsideN;
    state.ui.outsideBtn.textContent = '\u25d1 ' + outsideN + ' outside';
    state.ui.outsideBtn.setAttribute('aria-pressed', state.showOutside ? 'true' : 'false');
    state.ui.count.textContent = text;
    state.ui.save.disabled = unsaved === 0;
    scheduleSession();
    state.ui.undo.disabled = state.historyAt === 0;
    state.ui.redo.disabled = state.historyAt >= state.history.length;
    // Saving in place and saving a copy are different enough acts that the
    // button should not use one word for both.
    if (state.served && state.served.canPut) {
      state.ui.save.textContent = 'Save to server';
      state.ui.save.title = 'Write this file back to ' + state.served.url;
    } else {
      state.ui.save.textContent = 'Save';
      state.ui.save.title = '';
    }
    renderChanges();       // only does anything while the list is open
  }

  function flash(message) {
    if (!state.ui || state.restoring) return;
    state.ui.msg.textContent = message;
    clearTimeout(state.flashTimer);
    state.flashTimer = setTimeout(function () {
      if (state.ui) state.ui.msg.textContent = '';
    }, 3000);
  }

  // --- who you are, what changed, and AI rewrites ---------------------------

  /*
   * The user's name, as they typed it. Self-declared: it records who says they
   * wrote something, which is what a team that trusts each other needs, and it
   * is presented as exactly that everywhere it appears.
   */
  function authorName() { return state.author || ''; }
  function displayName(name) { return name || 'You'; }

  function setAuthor(name) {
    state.author = Comments.cleanName(name);
    if (state.settings) {
      Promise.resolve(state.settings.set('author', state.author)).catch(function () {});
    }
    renderMore();
    renderRail();
    renderChanges();
    return state.author;
  }

  function setMoreOpen(open) {
    if (!state.ui) return;
    state.ui.panel.hidden = !open;
    if (open) {
      setMenuOpen(false);
      setAIOpen(false);
      renderMore();
      state.ui.authorInput.value = authorName();
    }
  }

  function isMoreOpen() { return !!(state.ui && !state.ui.panel.hidden); }

  function renderMore() {
    if (!state.ui) return;
    var n = collectChanges().length;
    state.ui.changesBtn.textContent = n
      ? 'Show changes (' + n + ')' : 'Show changes (none yet)';
  }

  // --- the list of changes ----------------------------------------------------

  var TAG_NAMES = {
    p: 'paragraph', li: 'list item', blockquote: 'quote', td: 'cell', th: 'heading cell',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  };

  function describeTag(tag) { return TAG_NAMES[tag] || tag; }

  /*
   * Everything that differs from the file as it was opened, in document order,
   * with who did it and whether AI suggested it. Session-level: this is what
   * Save would write, described, not a history kept in the file.
   */
  function collectChanges() {
    var list = [];
    var i, r;

    // Edits are grouped by block. A paragraph with bold in it is several runs
    // of text, and one rewrite of it is one change to one paragraph — not one
    // row per fragment, which reads as several unrelated edits.
    var byBlock = new Map();
    for (i = 0; i < state.regions.length; i++) {
      r = state.regions[i];
      if (r.kind === 'text' && r.current !== r.original && r.island.isConnected) {
        var block = Blocks.blockFor(r.island) || r.island;
        var group = byBlock.get(block);
        if (!group) {
          group = { kind: 'edit', block: block, by: r.by, target: block, regions: [] };
          byBlock.set(block, group);
          list.push(group);
        }
        group.regions.push(r);
        if (r.by) group.by = r.by;
        if (r.ai) { group.ai = true; group.model = group.model || r.aiModel; }
        if (!r.ai || r.humanToo) group.human = true;
      } else if (r.kind === 'insert' && !r.removed && r.current) {
        list.push({ kind: 'added', what: describeTag(r.template.tag), after: r.current,
                    by: r.by, ai: !!r.ai, target: r.element, region: r });
      }
    }
    // Each group's before and after is the whole block's text, unchanged runs
    // included, so the diff shows the edit in the sentence it belongs to.
    state.unwraps.forEach(function (x) {
      if (x.active) list.push({ kind: 'unformat', what: FMT_NAME[x.kind], before: x.text, after: x.text,
                                by: x.by, target: Blocks.blockFor(x.children[0] && x.children[0].nodeType === 1
                                  ? x.children[0] : (x.children[0] && x.children[0].parentElement)) || null, item: x });
    });
    byBlock.forEach(function (group, block) {
      var runs = [];
      var islands = block.querySelectorAll ? block.querySelectorAll('[' + Islands.ATTR + ']') : [];
      for (var k = 0; k < islands.length; k++) {
        var reg = regionOf(islands[k]);
        if (reg && reg.kind === 'text') runs.push(reg);
      }
      if (!runs.length) runs = state.regions.filter(function (x) { return x.island === block; });
      group.before = runs.map(function (x) { return x.original; }).join('');
      group.after = runs.map(function (x) { return x.current; }).join('');
      group.formatOnly = Islands.plain(group.before) === Islands.plain(group.after);
    });

    for (i = 0; i < state.trees.length; i++) {
      var t = state.trees[i];
      if (t.removed || !treeHasText(t)) continue;
      var typed = t.cells.filter(function (c) { return c.current; });
      list.push({ kind: 'added', what: Structures.kindById(t.id).label.toLowerCase(),
                  after: typed.map(function (c) { return c.current; }).join(' · '),
                  by: typed[0] && typed[0].by,
                  target: t.element, region: t });
    }
    state.removals.forEach(function (x) {
      if (x.active) list.push({ kind: 'removed', what: x.what, before: x.before, by: x.by,
                                target: x.next && x.next.isConnected && x.next.nodeType === 1 ? x.next : null, item: x });
    });
    for (i = 0; i < state.comments.length; i++) {
      var c = state.comments[i];
      var text = c.text.trim();
      var target = c.block;
      if (c.removed) {
        if (c.token) list.push({ kind: 'comment-del', before: c.original, by: c.author, target: target, region: c });
      } else if (!c.token && text) {
        list.push({ kind: 'comment-add', after: text, by: c.author || authorName(), target: target, region: c });
      } else if (c.token && text !== c.original) {
        list.push({ kind: 'comment-edit', before: c.original, after: text, by: c.author, target: target, region: c });
      }
    }

    list.sort(function (a, b) {
      if (!a.target || !b.target || a.target === b.target) return 0;
      return a.target.compareDocumentPosition(b.target) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    return list;
  }

  function changeHeading(ch) {
    var who = displayName(ch.by);
    var ai = ch.ai ? ' (AI suggested)' : '';
    if (ch.kind === 'edit') {
      // AI is named as an author in its own right, the way a person is, with
      // whoever accepted it alongside.
      var bot = ch.model ? 'AI (' + ch.model + ')' : 'AI';
      if (ch.ai && ch.human) return who + ' and ' + bot + ' · edited';
      if (ch.ai) return bot + ' · edited · accepted by ' + who;
      return who + (ch.formatOnly ? ' · bold or italic' : ' · edited');
    }
    if (ch.kind === 'added') return who + ' · added a ' + ch.what + ai;
    if (ch.kind === 'removed') return who + ' · removed an empty ' + ch.what;
    if (ch.kind === 'unformat') return who + ' · took ' + ch.what + ' off';
    if (ch.kind === 'comment-add') return who + ' · added a comment';
    if (ch.kind === 'comment-edit') return 'Comment edited' + (ch.by ? ' (' + ch.by + '’s)' : '');
    return 'Comment deleted' + (ch.by ? ' (' + ch.by + '’s)' : '');
  }

  // For display only: a <br> in an island's value reads as a return arrow.
  function visible(value) { return Islands.plain(value).split(Islands.BR).join(' ↵ '); }

  /*
   * Which words changed, as [{ op: 'same'|'del'|'add', text }].
   *
   * Longest common subsequence over words, the ordinary way. This lived in the
   * AI module until that was removed, which was always the wrong home for it:
   * there is nothing AI about asking which words differ, and the list of
   * changes needs the answer whether anything else is installed or not.
   *
   * Splitting on (\s+) keeps the whitespace as its own token, so the pieces
   * rejoin into exactly the text that went in.
   *
   * The table is n*m, so a pathological pair of long runs would allocate more
   * than the answer is worth. Past that bound it says "all of this became all
   * of that" rather than spending a second on a prettier answer nobody is
   * waiting for.
   */
  function diffWords(a, b) {
    var x = String(a).split(/(\s+)/).filter(function (t) { return t !== ''; });
    var y = String(b).split(/(\s+)/).filter(function (t) { return t !== ''; });
    if (x.length * y.length > 4000000) {
      return [{ op: 'del', text: String(a) }, { op: 'add', text: String(b) }];
    }

    var n = x.length, m = y.length;
    var table = [];
    for (var i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }

    var out = [];
    function push(op, text) {
      var last = out[out.length - 1];
      if (last && last.op === op) last.text += text;
      else out.push({ op: op, text: text });
    }

    i = 0; j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { push('same', x[i]); i++; j++; }
      else if (table[i + 1][j] >= table[i][j + 1]) { push('del', x[i]); i++; }
      else { push('add', y[j]); j++; }
    }
    while (i < n) push('del', x[i++]);
    while (j < m) push('add', y[j++]);
    return out;
  }

  // Before/after as marked-up words, built from DOM nodes so the document's
  // own text cannot inject anything.
  function diffInto(box, before, after) {
    diffWords(visible(before), visible(after)).forEach(function (part) {
      var node = doc().createElement(part.op === 'same' ? 'span' : part.op === 'del' ? 'del' : 'ins');
      node.textContent = part.text;
      box.appendChild(node);
    });
  }

  /*
   * Undo one change from the list, leaving every other change alone.
   *
   * Ctrl/Cmd+Z can only walk back through history in order, so taking back
   * the third edit of ten meant taking back the seven after it too. This puts
   * that one thing back as the file had it, and does so as a new history step
   * of its own: Ctrl/Cmd+Z straight afterwards brings the change back.
   *
   * `ch` is a row from collectChanges(), taken fresh, so it describes the page
   * as it is now.
   */
  function revertChange(ch) {
    if (!state.active || !ch) return false;
    flushCommentEdit();

    if (ch.kind === 'edit') {
      var changes = [];
      ch.regions.forEach(function (r) {
        if (r.current === r.original) return;
        changes.push(multiChange(r, r.original));
      });
      if (!changes.length) return false;
      var entry = { kind: 'multi', changes: changes, revert: true };
      pushHistory(entry);
      applyMulti(entry, true);
      renderReview();         // a suggestion for that paragraph is stale now
    } else if (ch.kind === 'unformat') {
      pushHistory({ kind: 'rewrap', item: ch.item });
      setUnwrap(ch.item, false);
    } else if (ch.kind === 'removed') {
      // Back in the page, and with the words it had in the file.
      var steps = [{ kind: 'restore-block', item: ch.item }];
      var words = ch.item.runs.filter(function (r) { return r.current !== r.original; })
        .map(function (r) { return multiChange(r, r.original); });
      if (words.length) steps.push({ kind: 'multi', changes: words, revert: true });
      var back = { kind: 'group', entries: steps };
      pushHistory(back);
      redoEntry(back);
    } else if (ch.kind === 'added') {
      if (!ch.region || ch.region.removed) return false;
      setAdded(ch.region, false);
      pushHistory({ kind: 'remove-added', region: ch.region });
    } else if (ch.kind === 'comment-add') {
      removeComment(ch.region);
    } else if (ch.kind === 'comment-del' || ch.kind === 'comment-edit') {
      // Back as the file has it: shown, and in its original words, as one step.
      // A 'comment-add' entry is exactly "shown": redo shows it, undo removes it.
      var steps = [];
      if (ch.region.removed) steps.push({ kind: 'comment-add', region: ch.region });
      if (ch.region.text !== ch.region.original) {
        steps.push({ kind: 'comment-text', region: ch.region, before: ch.region.text, after: ch.region.original });
      }
      if (!steps.length) return false;
      var group = { kind: 'group', entries: steps };
      pushHistory(group);
      redoEntry(group);
    } else {
      return false;
    }
    refresh();
    flash('Undone — Ctrl/Cmd+Z brings it back');
    return true;
  }

  // A value with its bold and italic shown as bold and italic.
  function formattedInto(box, value) {
    var stack = [box];
    String(value || '').split(/([\u0001-\u0005])/).forEach(function (piece) {
      var top = stack[stack.length - 1];
      if (piece === '\u0001') top.appendChild(doc().createTextNode(' \u21b5 '));
      else if (piece === '\u0002' || piece === '\u0004') {
        var el = doc().createElement(piece === '\u0002' ? 'strong' : 'em');
        el.className = 'c-fmt';
        top.appendChild(el);
        stack.push(el);
      } else if (piece === '\u0003' || piece === '\u0005') { if (stack.length > 1) stack.pop(); }
      else if (piece) top.appendChild(doc().createTextNode(piece));
    });
  }

  function openChanges() {
    closeReview();
    ensureAssist().changes.hidden = false;
    renderChanges();
  }
  function closeChanges() { if (state.assist) state.assist.changes.hidden = true; }
  function toggleChanges() {
    if (state.assist && !state.assist.changes.hidden) closeChanges();
    else openChanges();
  }
  function isChangesOpen() { return !!(state.assist && !state.assist.changes.hidden); }

  function renderChanges() {
    if (!state.assist || state.assist.changes.hidden) return;
    var box = state.assist.changes;
    var list = collectChanges();
    box.textContent = '';

    var head = doc().createElement('div');
    head.className = 'c-head';
    var title = doc().createElement('strong');
    title.textContent = list.length ? 'Changes (' + list.length + ')'
      : (state.conflicts.length || outsideRows().length || state.earlier.length) ? 'Changes' : 'No changes yet';
    var close = doc().createElement('button');
    close.className = 'x';
    close.title = 'Close';
    close.textContent = '×';
    close.addEventListener('click', closeChanges);
    head.appendChild(title);
    head.appendChild(close);
    box.appendChild(head);

    var note = doc().createElement('div');
    note.className = 'c-note';
    note.textContent = 'What Save would write.';
    box.appendChild(note);

    var ol = doc().createElement('ol');
    ol.className = 'c-list';
    list.forEach(function (ch) {
      var li = doc().createElement('li');
      var btn = doc().createElement('button');
      btn.className = 'c-row';
      var who = doc().createElement('span');
      who.className = 'c-who';
      who.textContent = changeHeading(ch);
      var what = doc().createElement('span');
      what.className = 'c-diff';
      if (ch.kind === 'edit' && ch.formatOnly) formattedInto(what, ch.after);
      else if (ch.kind === 'edit' || ch.kind === 'comment-edit') diffInto(what, ch.before, ch.after);
      else if (ch.kind === 'comment-del' || ch.kind === 'removed') {
        var d = doc().createElement('del');
        d.textContent = visible(ch.before) || '(it was empty)';
        what.appendChild(d);
      }
      else what.textContent = visible(ch.after);
      btn.appendChild(who);
      btn.appendChild(what);
      btn.addEventListener('click', function () {
        if (!ch.target || !ch.target.isConnected) return;
        ch.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        ch.target.setAttribute(ACTIVE_ATTR, '');
        setTimeout(function () { ch.target.removeAttribute(ACTIVE_ATTR); }, 1400);
      });
      li.appendChild(btn);
      var undoBtn = doc().createElement('button');
      undoBtn.className = 'c-undo';
      undoBtn.textContent = 'Undo';
      undoBtn.title = ch.kind === 'comment-del' || ch.kind === 'removed' ? 'Bring it back, with its words'
        : ch.kind === 'added' || ch.kind === 'comment-add' ? 'Take this back out'
        : 'Put this back as it is in the file';
      undoBtn.setAttribute('aria-label', 'Undo this change: ' + changeHeading(ch));
      undoBtn.addEventListener('click', function () { revertChange(ch); });
      li.appendChild(undoBtn);
      ol.appendChild(li);
    });
    box.appendChild(ol);

    if (state.conflicts.length) {
      box.appendChild(sectionHead('Clashes (' + state.conflicts.length + ')',
        'You changed these, and so did something outside VibeRevise. Keep one or the other.'));
      state.conflicts.forEach(function (x) { box.appendChild(conflictRow(x)); });
    }
    var outside = outsideRows();
    if (outside.length) {
      box.appendChild(sectionHead('Changed outside VibeRevise (' + outside.length + ')',
        'Since you last marked them reviewed. Already in the file; highlighted in blue on the page.'));
      var otools = doc().createElement('div');
      otools.className = 'r-tools';
      var showBtn = doc().createElement('button');
      showBtn.className = 'pill';
      showBtn.textContent = state.showOutside ? 'Hide highlights' : 'Show highlights';
      showBtn.addEventListener('click', function () { setShowOutside(!state.showOutside); });
      var allBtn = doc().createElement('button');
      allBtn.className = 'pill';
      allBtn.textContent = 'Mark all reviewed';
      allBtn.addEventListener('click', function () { markReviewed(null); });
      otools.appendChild(showBtn);
      otools.appendChild(allBtn);
      box.appendChild(otools);
      var ol2 = doc().createElement('ol');
      ol2.className = 'c-list';
      outside.forEach(function (o) {
        var li = infoRow(o.after ? (o.before ? 'Changed outside VibeRevise' : 'Added outside VibeRevise')
          : 'Removed outside VibeRevise', o.before, o.after, o.target);
        var done = doc().createElement('button');
        done.className = 'c-undo';
        done.textContent = 'Reviewed';
        done.title = 'Stop highlighting this one';
        done.addEventListener('click', function () { markReviewed(o); });
        li.appendChild(done);
        ol2.appendChild(li);
      });
      box.appendChild(ol2);
    }
    if (state.earlier.length) {
      box.appendChild(sectionHead('Saved before the reload (' + state.earlier.length + ')', ''));
      var ol3 = doc().createElement('ol');
      ol3.className = 'c-list';
      state.earlier.forEach(function (e) {
        ol3.appendChild(infoRow(e.heading + ' · ' + shortTime(e.at), e.before, e.after, null));
      });
      box.appendChild(ol3);
    }
  }

  function shortTime(at) {
    return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  function sectionHead(title, note) {
    var wrap = doc().createElement('div');
    wrap.className = 'c-section';
    var t = doc().createElement('strong');
    t.textContent = title;
    wrap.appendChild(t);
    if (note) {
      var n = doc().createElement('div');
      n.className = 'c-note';
      n.textContent = note;
      wrap.appendChild(n);
    }
    return wrap;
  }

  function infoRow(heading, before, after, target) {
    var li = doc().createElement('li');
    var row = doc().createElement('button');
    row.className = 'c-row c-info';
    var who = doc().createElement('span');
    who.className = 'c-who';
    who.textContent = heading;
    var what = doc().createElement('span');
    what.className = 'c-diff';
    diffInto(what, before, after);
    row.appendChild(who);
    row.appendChild(what);
    row.addEventListener('click', function () {
      if (!target || !target.isConnected) return;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.setAttribute(ACTIVE_ATTR, '');
      setTimeout(function () { target.removeAttribute(ACTIVE_ATTR); }, 1400);
    });
    li.appendChild(row);
    return li;
  }

  function conflictRow(x) {
    var item = doc().createElement('div');
    item.className = 's-item stale';
    var head = doc().createElement('div');
    head.className = 's-what';
    var who = x.ai ? 'AI' + (x.model ? ' (' + x.model + ')' : '') : displayName(x.by);
    head.textContent = x.kind === 'removed' ? 'You removed an empty block here, and the other tool has changed it since \u2014 it stays'
      : x.kind === 'added' ? who + ' added this, where the file has since changed'
      : x.kind === 'comment' ? (x.by ? x.by + '’s' : 'A') + ' comment, where the file has since changed'
      : x.theirs != null ? who + ' and the other tool both changed this' : who + ' changed this, and the other tool rewrote or removed it';
    item.appendChild(head);

    function line(label, text, base) {
      var row = doc().createElement('div');
      row.className = 'c-diff';
      var b = doc().createElement('b');
      b.textContent = label + ' ';
      row.appendChild(b);
      if (base != null) diffInto(row, base, text);
      else row.appendChild(doc().createTextNode(visible(text)));
      item.appendChild(row);
    }
    if (x.theirs != null) line('Theirs:', x.theirs, x.base || null);
    line('Yours:', x.mine, x.base || null);

    var tools = doc().createElement('div');
    tools.className = 'r-tools';
    if (x.region) {
      var mine = doc().createElement('button');
      mine.className = 'pill primary';
      mine.textContent = 'Keep mine';
      mine.title = 'Put your words in place of theirs';
      mine.addEventListener('click', function () { settleConflict(x, true); });
      tools.appendChild(mine);
    }
    var theirs = doc().createElement('button');
    theirs.className = 'pill';
    theirs.textContent = x.region ? 'Keep theirs' : 'Dismiss';
    theirs.addEventListener('click', function () { settleConflict(x, false); });
    var copy = doc().createElement('button');
    copy.className = 'pill';
    copy.textContent = 'Copy mine';
    copy.addEventListener('click', function () { copyText(visible(x.mine).replace(/ \u21b5 /g, '\n'), 'Copied your version'); });
    tools.appendChild(theirs);
    tools.appendChild(copy);
    item.appendChild(tools);
    return item;
  }

  // --- the layer the changes list floats in ----------------------------------

  var ASSIST_CSS = [
    ':host { all: initial; }',
    '.layer { position: fixed; inset: 0; pointer-events: none;',
    '  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #f1f2f5; }',
    '[hidden] { display: none !important; }',
    'button { font: inherit; color: inherit; cursor: pointer; border: 0; }',
    '.changes {',
    '  position: absolute; pointer-events: auto; box-sizing: border-box;',
    '  border-radius: 12px; background: rgba(22, 22, 27, .97);',
    '  box-shadow: 0 6px 28px rgba(0, 0, 0, .45);',
    '  right: 16px; bottom: 70px; width: 380px; max-width: calc(100vw - 32px);',
    '  max-height: 62vh; overflow: auto; padding: 12px;',
    '  display: flex; flex-direction: column; gap: 8px;',
    '}',
    '.c-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
    '.a-title { font-weight: 600; }',
    '.x { background: transparent; font-size: 17px; line-height: 1; padding: 2px 6px;',
    '  border-radius: 6px; color: #9aa0ad; }',
    '.x:hover { background: rgba(255, 255, 255, .12); color: #fff; }',
    '.c-note { color: #9aa0ad; font-size: 11.5px; }',
    '.c-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }',
    '.c-row { width: 100%; text-align: left; display: flex; flex-direction: column; gap: 3px;',
    '  padding: 8px 10px; border-radius: 8px; background: rgba(255, 255, 255, .06);',
    '  border-left: 3px solid rgba(255, 255, 255, .25); }',
    '.c-row:hover { background: rgba(255, 255, 255, .12); }',
    '.c-list li { position: relative; }',
    '.c-section { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; }',
    '.c-fmt { color: #9fe0b5; }',
    // Notices sit at the top, clear of the list of changes they lead to.
    '.changes.resume { top: 16px; bottom: auto; max-width: min(380px, calc(100vw - 32px)); }',
    '.c-info { border-left-color: #5fb3d9; }',
    '.changes .s-item b { font-weight: 600; color: #c6cbd6; }',
    '.c-who { font-weight: 600; font-size: 12px; padding-right: 52px; }',
    '.c-undo { position: absolute; top: 6px; right: 6px; padding: 2px 9px; border-radius: 999px;',
    '  font-size: 11.5px; background: rgba(255, 255, 255, .13); }',
    '.c-undo:hover { background: rgba(255, 255, 255, .24); }',
    '.c-diff { color: #d6d9e0; font-size: 12px; overflow-wrap: anywhere; }',
    'del { color: #ff9f9f; text-decoration: line-through; text-decoration-color: rgba(255,159,159,.7); }',
    'del + ins, ins + del { margin-left: .3em; }',
    'ins { color: #9fe0b5; text-decoration: none; background: rgba(159, 224, 181, .12); border-radius: 3px; }',
    '.review {',
    '  position: absolute; pointer-events: auto; box-sizing: border-box;',
    '  border-radius: 12px; background: rgba(22, 22, 27, .97);',
    '  box-shadow: 0 6px 28px rgba(0, 0, 0, .45);',
    '  right: 16px; bottom: 70px; width: 420px; max-width: calc(100vw - 32px);',
    '  max-height: 62vh; overflow: auto; padding: 12px;',
    '  display: flex; flex-direction: column; gap: 8px;',
    '}',
    '.r-tools { display: flex; gap: 6px; align-items: center; }',
    '.pill { padding: 4px 11px; border-radius: 999px; background: rgba(255, 255, 255, .13); font-size: 12px; }',
    '.pill:hover { background: rgba(255, 255, 255, .22); }',
    '.pill.primary { background: #5b52f0; }',
    '.pill.primary:hover { background: #6d64ff; }',
    '.pill:disabled { opacity: .4; cursor: default; }',
    '.s-item { padding: 9px 10px; border-radius: 8px; background: rgba(255, 255, 255, .06);',
    '  border-left: 3px solid #7c74ff; display: flex; flex-direction: column; gap: 6px; }',
    '.s-item.stale { border-left-color: #ff9f9f; }',
    '.s-head { display: flex; gap: 8px; align-items: baseline; }',
    '.s-what { font-weight: 600; font-size: 12px; flex: 1; }',
    '.s-show { background: transparent; color: #9aa0ad; font-size: 11.5px; padding: 0 4px; border-radius: 4px; }',
    '.s-show:hover { color: #fff; background: rgba(255, 255, 255, .1); }',
    '.s-why { color: #9aa0ad; font-size: 11.5px; }',
    '.s-stale { color: #ffb3b3; font-size: 11.5px; }',
    '.s-item.explain { border-left-color: #5fb3d9; }',
    '.s-explain { color: #e4e7ee; font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere; }',
  ].join('\n');

  function ensureAssist() {
    if (state.assist && state.assist.host.isConnected) return state.assist;

    var host = doc().createElement('div');
    host.setAttribute(UI_ATTR, '');
    [['position', 'fixed'], ['left', '0'], ['top', '0'], ['width', '100%'], ['height', '100%'],
     ['z-index', '2147483646'], ['margin', '0'], ['padding', '0'], ['border', '0'],
     ['pointer-events', 'none'], ['display', 'block'], ['transform', 'none'],
     ['opacity', '1'], ['visibility', 'visible'],
    ].forEach(function (p) { host.style.setProperty(p[0], p[1], 'important'); });

    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>' + ASSIST_CSS + '</style>' +
      '<div class="layer">' +
        '<div class="changes" hidden role="dialog" aria-label="Changes"></div>' +
        '<div class="changes resume" hidden role="dialog" aria-label="Carry on"></div>' +
        '<div class="review" hidden role="dialog" aria-label="AI suggestions"></div>' +
      '</div>';
    doc().documentElement.appendChild(host);

    // A click inside the list is not a click "away" from it.
    shadow.querySelectorAll('.changes').forEach(function (el) {
      el.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    });
    shadow.querySelector('.review').addEventListener('mousedown', function (e) { e.stopPropagation(); });

    state.assist = {
      host: host,
      changes: shadow.querySelector('.changes:not(.resume)'),
      resume: shadow.querySelector('.resume'),
      review: shadow.querySelector('.review'),
    };
    return state.assist;
  }

  function removeAssist() {
    if (state.assist && state.assist.host.parentNode) {
      state.assist.host.parentNode.removeChild(state.assist.host);
    }
    state.assist = null;
  }


  // --- AI suggestions --------------------------------------------------------

  /*
   * Off unless the host offers it and the user has added a key.
   *
   * Every route here ends the same way: a SUGGESTION, shown as a before/after
   * of the paragraph, which changes nothing until it is accepted. Accepting is
   * one undo step, and the list of changes says the edit was AI-suggested. The
   * answer can only ever land in the runs of text a person could have typed
   * into, so the markup is exactly as safe as it is from the keyboard.
   *
   * What leaves the browser is the words of the paragraphs involved — split at
   * their formatting, so the answer can go back without moving a tag — and,
   * for a rewrite, a little of the text either side for context. Never the
   * file, never the markup.
   */
  var AI_CHIPS = [
    ['Tighten', 'Make it tighter and more direct without losing any meaning.'],
    ['Fix grammar', 'Fix spelling, grammar and punctuation only.'],
    ['Plainer', 'Rewrite it in plainer language a general reader would follow.'],
    ['More formal', 'Make the tone more formal and professional.'],
  ];

  var AI_MARKUP =
    '<button class="ai-btn" title="AI suggestions" aria-label="AI suggestions" ' +
            'aria-expanded="false">✦ AI<span class="ai-n" hidden></span></button>' +
    '<div class="panel ai-panel" hidden>' +
      '<div class="p-head">' +
        '<span class="p-title">AI suggestions</span>' +
        '<button class="ai-head-btn ai-settings" title="Provider, model and key">Settings</button>' +
      '</div>' +
      '<div class="ai-status"></div>' +
      '<div class="ai-section ai-setup" hidden>' +
        '<div class="p-hint">Use your own API key — Claude, OpenAI, Gemini, OpenRouter, or a ' +
          'model running on your own computer. Nothing is sent until you ask for a ' +
          'suggestion, and nothing changes until you accept one.</div>' +
        '<button class="primary ai-setup-btn">Set up AI</button>' +
      '</div>' +
      '<div class="ai-section ai-ready" hidden>' +
        '<div class="ai-target"></div>' +
        '<button class="p-changes ai-explain" title="Explain the selection, or this paragraph. Changes nothing.">' +
          'Explain</button>' +
        '<div class="ai-chips">' +
          AI_CHIPS.map(function (c, i) {
            return '<button data-chip="' + i + '" title="' + c[1] + '">' + c[0] + '</button>';
          }).join('') +
        '</div>' +
        '<div class="p-row">' +
          '<input class="p-input ai-instruction" maxlength="300" ' +
                 'aria-label="What to change" placeholder="Or say what to change…">' +
          '<button class="ai-go">Suggest</button>' +
        '</div>' +
        '<div class="p-sep"></div>' +
        '<button class="p-changes ai-proofread">Proofread the whole document</button>' +
        '<button class="p-changes ai-review-btn" hidden></button>' +
        '<div class="p-hint ai-disclose"></div>' +
      '</div>' +
      '<div class="ai-busy" hidden>' +
        '<span class="ai-spin" aria-hidden="true"></span>' +
        '<span class="ai-busy-text" role="status"></span>' +
        '<button class="ai-cancel">Cancel</button>' +
      '</div>' +
    '</div>';

  function wireAIPanel(shadow) {
    var ui = state.ui;
    ui.aiBtn = shadow.querySelector('.ai-btn');
    ui.aiCount = shadow.querySelector('.ai-n');
    ui.aiPanel = shadow.querySelector('.ai-panel');
    ui.aiStatus = shadow.querySelector('.ai-status');
    ui.aiSetup = shadow.querySelector('.ai-setup');
    ui.aiReady = shadow.querySelector('.ai-ready');
    ui.aiTarget = shadow.querySelector('.ai-target');
    ui.aiInstruction = shadow.querySelector('.ai-instruction');
    ui.aiReviewBtn = shadow.querySelector('.ai-review-btn');
    ui.aiDisclose = shadow.querySelector('.ai-disclose');
    ui.aiBusy = shadow.querySelector('.ai-busy');
    ui.aiBusyText = shadow.querySelector('.ai-busy-text');

    // mousedown with the default prevented, like Insert: opening the panel
    // must not take the caret out of the paragraph it is about to work on.
    ui.aiBtn.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      setAIOpen(ui.aiPanel.hidden);
    });
    ui.aiPanel.addEventListener('mousedown', function (e) { e.stopPropagation(); });

    function settings() { setAIOpen(false); state.ai.openSettings(); }
    shadow.querySelector('.ai-settings').addEventListener('click', settings);
    shadow.querySelector('.ai-setup-btn').addEventListener('click', settings);

    shadow.querySelector('.ai-chips').addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('button[data-chip]');
      if (btn) aiRewrite(null, AI_CHIPS[+btn.getAttribute('data-chip')][1]);
    });
    function go() {
      var text = ui.aiInstruction.value.trim();
      if (!text) { ui.aiInstruction.focus(); return; }
      aiRewrite(null, text);
    }
    shadow.querySelector('.ai-go').addEventListener('click', go);
    ui.aiInstruction.addEventListener('keydown', function (e) {
      if (isSaveKey(e)) { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) saveAs(); else save(); return; }
      if (e.key === 'Enter') { e.preventDefault(); go(); }
      e.stopPropagation();        // typing an instruction is not an editing shortcut
    });
    shadow.querySelector('.ai-proofread').addEventListener('click', function () { aiProofread(); });
    // mousedown with the default prevented, so a selection in the document
    // survives the press and Explain can see what was selected.
    shadow.querySelector('.ai-explain').addEventListener('mousedown', function (e) {
      e.preventDefault();
      aiExplain();
    });
    ui.aiReviewBtn.addEventListener('click', function () { setAIOpen(false); openReview(); });
    shadow.querySelector('.ai-cancel').addEventListener('click', cancelAI);
    renderAI();
  }

  function setAIOpen(open) {
    if (!state.ui || !state.ui.aiPanel) return;
    state.ui.aiPanel.hidden = !open;
    state.ui.aiBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      setMenuOpen(false);
      setMoreOpen(false);
      renderAI();
      // The key may have been added in another tab since this page asked.
      refreshAIStatus();
    }
  }

  function isAIOpen() { return !!(state.ui && state.ui.aiPanel && !state.ui.aiPanel.hidden); }

  function refreshAIStatus() {
    if (!state.ai) return Promise.resolve(null);
    return Promise.resolve(state.ai.status()).then(function (st) {
      state.aiStatus = st || { configured: false };
      renderAI();
      renderReview();         // Read or read-and-write decides its buttons
      return state.aiStatus;
    }).catch(function (err) {
      state.aiStatus = { configured: false, problem: String(err && err.message || err) };
      renderAI();
      return state.aiStatus;
    });
  }

  // Just the model, for naming AI in the list of changes.
  function aiModelName() {
    var label = state.aiStatus && state.aiStatus.label;
    if (!label) return null;
    var parts = String(label).split(' · ');
    return parts[parts.length - 1] || null;
  }

  // Read and write: suggestions can be accepted. Read (the default): AI only
  // advises, and every change in the document is one the user typed.
  function aiCanWrite() { return !!(state.aiStatus && state.aiStatus.access === 'write'); }

  function aiReady() { return !!(state.ai && state.aiStatus && state.aiStatus.configured); }

  function renderAI() {
    var ui = state.ui;
    if (!ui || !ui.aiPanel) return;
    var st = state.aiStatus;
    var n = pendingSuggestions().length;

    ui.aiCount.hidden = n === 0;
    ui.aiCount.textContent = String(n);

    var busy = !!state.aiJob;
    ui.aiBusy.hidden = !busy;
    if (busy) ui.aiBusyText.textContent = state.aiJob.label;

    if (!st) {
      ui.aiStatus.textContent = 'Checking AI settings…';
      ui.aiStatus.className = 'ai-status';
      ui.aiSetup.hidden = true;
      ui.aiReady.hidden = true;
      return;
    }
    ui.aiStatus.textContent = st.configured
      ? st.label + (aiCanWrite() ? ' \u00b7 read and write' : ' \u00b7 read only')
      : (st.problem || 'Not set up yet.');
    ui.aiStatus.className = 'ai-status' + (st.configured ? '' : ' warn');
    ui.aiSetup.hidden = st.configured;
    ui.aiReady.hidden = !st.configured || busy;

    var target = aiTarget();
    ui.aiTarget.textContent = target
      ? 'Rewrite this ' + describeTag(target.block.localName || 'block') + ': “' +
        visible(target.regions.map(function (r) { return r.current; }).join('')).trim().slice(0, 60) + '”'
      : 'Click into a paragraph, then choose how to rewrite it.';

    ui.aiReviewBtn.hidden = n === 0;
    ui.aiReviewBtn.textContent = 'Review suggestions (' + n + ')';
    ui.aiDisclose.textContent = 'Sends only the words of the paragraphs involved to ' +
      (st.host || 'your AI provider') + (aiCanWrite()
        ? '. Nothing changes until you accept.'
        : '. Read only: AI suggests, and you make every change yourself.');
  }

  /*
   * The runs of text that make up one block, in order: the islands whose own
   * block is this one. A nested block — a list inside a section — is its own
   * paragraph, not part of its container's.
   */
  function runsOf(block) {
    var out = [];
    if (!block || !block.querySelectorAll) return out;
    var islands = block.querySelectorAll('[' + Islands.ATTR + ']');
    for (var i = 0; i < islands.length; i++) {
      var r = regionOf(islands[i]);
      if (!r || r.removed || (r.tree && r.tree.removed)) continue;
      if ((Blocks.blockFor(islands[i]) || islands[i]) !== block) continue;
      out.push(r);
    }
    return out;
  }

  // Every paragraph in the document, in order, as { block, regions }.
  function allBlocks() {
    var seen = new Map();
    var list = [];
    var islands = doc().querySelectorAll('[' + Islands.ATTR + ']');
    for (var i = 0; i < islands.length; i++) {
      var r = regionOf(islands[i]);
      if (!r || r.removed || (r.tree && r.tree.removed)) continue;
      var block = Blocks.blockFor(islands[i]) || islands[i];
      var entry = seen.get(block);
      if (!entry) {
        entry = { block: block, regions: [] };
        seen.set(block, entry);
        list.push(entry);
      }
      entry.regions.push(r);
    }
    return list;
  }

  function textOfRegions(regions) {
    return regions.map(function (r) { return r.current; }).join('');
  }

  // The paragraph the caret is in, or was in before the toolbar took focus.
  function aiTarget() {
    var island = islandOf(doc().activeElement);
    if (!island && state.lastIsland && state.lastIsland.isConnected) island = state.lastIsland;
    if (!island || !regionOf(island)) return null;
    var block = Blocks.blockFor(island) || island;
    var regions = runsOf(block);
    if (!regions.length) regions = [regionOf(island)];
    return { block: block, regions: regions };
  }

  /*
   * Run one request as the job in flight. One at a time: a second request
   * while the first is out would leave two sets of answers racing each other
   * for the same paragraphs.
   */
  function runAI(label, fn) {
    if (!state.ai) return Promise.resolve(null);
    if (state.aiJob) { flash('AI is still working on the last request'); return Promise.resolve(null); }
    var job = { label: label, cancelled: false };
    state.aiJob = job;
    renderAI();
    flash(label);

    return refreshAIStatus().then(function (st) {
      if (!st || !st.configured) {
        flash('Set up AI first — ' + ((st && st.problem) || 'add your API key'));
        setAIOpen(true);
        return null;
      }
      return fn(job);
    }).catch(function (err) {
      flash('AI failed: ' + (err && err.message || err));
      return null;
    }).then(function (result) {
      if (state.aiJob === job) state.aiJob = null;
      renderAI();
      return result;
    });
  }

  function cancelAI() {
    if (!state.aiJob) return;
    state.aiJob.cancelled = true;
    state.aiJob = null;
    flash('Cancelled — anything already on its way back will be ignored');
    renderAI();
  }

  // Ask, and read the JSON out of the answer. { ok, data } or { ok:false, message }.
  function askAI(req, job) {
    return Promise.resolve(state.ai.complete(req)).then(function (res) {
      if (job.cancelled) return { ok: false, cancelled: true };
      if (!res || !res.ok) return { ok: false, message: (res && res.message) || 'No answer.' };
      var data = AI.parseJson(res.text);
      if (!data) {
        return { ok: false, message: res.truncated
          ? 'The answer was cut off before it finished. Try a shorter passage.'
          : 'The answer was not in a form VibeRevise can use.' };
      }
      return { ok: true, data: data };
    });
  }

  /*
   * A suggestion: the regions it covers, what they held when it was asked
   * for, and what it proposes. If any of them has changed since, it is stale
   * and will not be applied — mapping an answer onto words the model never saw
   * would be guessing.
   */
  function addSuggestion(kind, what, why, block, regions, after) {
    var s = {
      kind: kind,
      what: what,
      why: why || '',
      block: block,
      regions: regions,
      basis: regions.map(function (r) { return r.current; }),
      after: after,
    };
    // A newer suggestion for the same paragraph replaces an older one.
    state.suggestions = state.suggestions.filter(function (o) { return o.block !== block; });
    state.suggestions.push(s);
    return s;
  }

  function isStale(s) {
    for (var i = 0; i < s.regions.length; i++) {
      var r = s.regions[i];
      if (r.removed || (r.tree && r.tree.removed) || r.current !== s.basis[i]) return true;
    }
    return false;
  }

  function pendingSuggestions() { return state.suggestions; }

  function neighbourText(block, step) {
    var blocks = allBlocks();
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].block !== block) continue;
      var other = blocks[i + step];
      if (!other) return '';
      var t = AI.toModel(textOfRegions(other.regions));
      return step < 0 ? t.slice(-400) : t.slice(0, 400);
    }
    return '';
  }

  function aiRewrite(target, instruction) {
    target = target || aiTarget();
    if (!target) { flash('Click into the paragraph you want rewritten first'); return Promise.resolve(null); }
    var regions = target.regions;
    var original = regions.map(function (r) { return r.current; });
    if (!AI.toModel(original.join('')).trim()) {
      flash('That paragraph is empty — type something first');
      return Promise.resolve(null);
    }
    var what = describeTag(target.block.localName || 'block');

    return runAI('Asking for a rewrite of this ' + what + '…', function (job) {
      var req = AI.rewriteRequest({
        runs: original,
        instruction: instruction,
        kind: what,
        before: neighbourText(target.block, -1),
        after: neighbourText(target.block, 1),
      });
      return askAI(req, job).then(function (res) {
        if (res.cancelled) return null;
        if (!res.ok) { flash('AI: ' + res.message); return null; }
        var aligned = AI.alignRuns(original, res.data.runs);
        if (!aligned.ok) { flash(aligned.problem); return null; }
        if (!aligned.changed) { flash('AI suggests leaving this ' + what + ' as it is'); return null; }
        var s = addSuggestion('rewrite', 'Rewrite this ' + what,
          typeof res.data.note === 'string' ? res.data.note : '', target.block, regions, aligned.runs);
        setAIOpen(false);
        openReview();
        flash('Suggestion ready \u2014 accept or dismiss it');
        return s;
      });
    });
  }

  /*
   * Every paragraph, a batch at a time. A batch that fails stops the run but
   * keeps what earlier batches found: those suggestions are as good as they
   * were a moment ago.
   */
  function aiProofread() {
    var blocks = allBlocks().filter(function (b) {
      return AI.toModel(textOfRegions(b.regions)).replace(/\s/g, '').length >= 3;
    });
    if (!blocks.length) { flash('There is no text here to proofread'); return Promise.resolve(null); }

    var items = blocks.map(function (b, i) {
      return {
        id: 'p' + (i + 1),
        runs: b.regions.map(function (r) { return r.current; }),
        block: b.block,
        regions: b.regions,
      };
    });
    var byId = new Map(items.map(function (it) { return [it.id, it]; }));
    var chunks = AI.chunkBlocks(items);

    return runAI('Proofreading…', function (job) {
      var found = 0;
      var i = 0;
      function next() {
        if (job.cancelled) return null;
        if (i >= chunks.length) {
          flash(found ? 'Proofreading found ' + found + ' thing' + (found === 1 ? '' : 's') + ' to fix'
                      : 'Proofreading found nothing to fix');
          if (found) { setAIOpen(false); openReview(); }
          return found;
        }
        job.label = chunks.length > 1
          ? 'Proofreading… part ' + (i + 1) + ' of ' + chunks.length
          : 'Proofreading…';
        renderAI();
        var chunk = chunks[i++];
        return askAI(AI.proofreadRequest(chunk), job).then(function (res) {
          if (res.cancelled) return null;
          if (!res.ok) {
            flash('AI: ' + res.message + (found ? ' (' + found + ' found before that)' : ''));
            if (found) openReview();
            return found;
          }
          var fixes = Array.isArray(res.data.fixes) ? res.data.fixes : [];
          fixes.forEach(function (fix) {
            var it = fix && byId.get(fix.id);
            // Only paragraphs that were in THIS batch, and only once each.
            if (!it || chunk.indexOf(it) === -1) return;
            var aligned = AI.alignRuns(it.runs, fix.runs);
            if (!aligned.ok || !aligned.changed) return;
            addSuggestion('proofread', 'Proofreading · ' + describeTag(it.block.localName || 'block'),
              typeof fix.why === 'string' ? fix.why : '', it.block, it.regions, aligned.runs);
            found++;
          });
          renderReview();
          return next();
        });
      }
      return next();
    });
  }

  // How an AI-drafted note is signed. Honest about where the words came from,
  // and still the user's: they asked for it and can edit it before saving.
  function aiAuthor() {
    return authorName() ? authorName() + ' (AI draft)' : 'AI draft';
  }

  function aiReplyTo(region) {
    flushCommentEdit();
    var block = region.block;
    var thread = liveComments().filter(function (c) {
      return c.block === block && c.text.trim();
    });
    if (!thread.length) { flash('Write the comment first, then ask AI'); return Promise.resolve(null); }
    var regions = runsOf(block);
    var original = regions.map(function (r) { return r.current; });

    return runAI('Asking AI about this comment thread…', function (job) {
      var req = AI.commentRequest({
        runs: original,
        thread: thread.map(function (c) {
          return { author: c.token ? c.author : (c.author || authorName()), text: c.text.trim() };
        }),
      });
      return askAI(req, job).then(function (res) {
        if (res.cancelled) return null;
        if (!res.ok) { flash('AI: ' + res.message); return null; }
        var reply = typeof res.data.reply === 'string' ? res.data.reply.trim() : '';
        var out = { reply: null, suggestion: null };
        if (reply) out.reply = addCommentTo(block, { text: reply, author: aiAuthor() });

        var runs = res.data.runs;
        if (regions.length && Array.isArray(runs) && runs.length) {
          var aligned = AI.alignRuns(original, runs);
          if (aligned.ok && aligned.changed) {
            out.suggestion = addSuggestion('comment', 'Change asked for in the comments',
              reply.slice(0, 160), block, regions, aligned.runs);
            openReview();
          }
        }
        flash(out.suggestion ? 'AI drafted a reply and suggested a change — review it before saving'
          : out.reply ? 'AI drafted a reply — edit it or delete it before saving'
          : 'AI had nothing to add');
        return out;
      });
    });
  }

  function acceptSuggestion(s) {
    if (state.suggestions.indexOf(s) === -1) return false;
    if (!aiCanWrite()) {
      flash('AI is set to read only \u2014 copy the suggestion and make the change yourself');
      return false;
    }
    if (isStale(s)) {
      flash('That paragraph has changed since — dismiss this and ask again');
      renderReview();
      return false;
    }
    var changes = [];
    for (var i = 0; i < s.regions.length; i++) {
      var r = s.regions[i];
      if (s.after[i] === r.current) continue;
      changes.push(multiChange(r, s.after[i]));
    }
    state.suggestions.splice(state.suggestions.indexOf(s), 1);
    if (changes.length) {
      var entry = { kind: 'multi', changes: changes, by: authorName(), model: aiModelName() };
      pushHistory(entry);
      applyMulti(entry, true);
    }
    renderReview();
    renderAI();
    return true;
  }

  function dismissSuggestion(s) {
    var at = state.suggestions.indexOf(s);
    if (at === -1) return false;
    state.suggestions.splice(at, 1);
    renderReview();
    renderAI();
    return true;
  }

  function acceptAll() {
    if (!aiCanWrite()) return 0;
    var n = 0;
    state.suggestions.slice().forEach(function (s) {
      if (!isStale(s) && acceptSuggestion(s)) n++;
    });
    flash(n ? 'Applied ' + n + ' suggestion' + (n === 1 ? '' : 's') + ' — Ctrl/Cmd+Z undoes them one at a time'
            : 'Nothing could be applied — the paragraphs have changed since');
    return n;
  }

  function openReview() {
    var assist = ensureAssist();
    assist.changes.hidden = true;
    assist.review.hidden = false;
    renderReview();
  }
  function closeReview() { if (state.assist) state.assist.review.hidden = true; }
  function isReviewOpen() { return !!(state.assist && !state.assist.review.hidden); }

  function renderReview() {
    if (!state.assist || state.assist.review.hidden) return;
    var box = state.assist.review;
    var list = state.suggestions;
    var write = aiCanWrite();
    box.textContent = '';

    var head = doc().createElement('div');
    head.className = 'c-head';
    var title = doc().createElement('strong');
    title.textContent = list.length ? 'AI suggestions (' + list.length + ')'
      : state.explanation ? 'AI' : 'No suggestions waiting';
    var tools = doc().createElement('span');
    tools.className = 'r-tools';
    if (write && list.length > 1) {
      var all = doc().createElement('button');
      all.className = 'pill primary';
      all.textContent = 'Accept all';
      all.addEventListener('click', acceptAll);
      tools.appendChild(all);
    }
    var close = doc().createElement('button');
    close.className = 'x';
    close.title = 'Close — suggestions keep until you accept or dismiss them';
    close.textContent = '×';
    close.addEventListener('click', closeReview);
    tools.appendChild(close);
    head.appendChild(title);
    head.appendChild(tools);
    box.appendChild(head);

    var note = doc().createElement('div');
    note.className = 'c-note';
    note.textContent = !list.length
      ? (state.explanation ? 'An explanation changes nothing in the document.'
                           : 'Ask for a rewrite or a proofread from the \u2726 AI button.')
      : write
        ? 'Nothing changes until you accept. Accepting is one undo step, and the list of changes names AI as the author.'
        : 'AI is set to read only, so these are advice. Copy a suggestion and make the change yourself if you agree.';
    box.appendChild(note);

    if (state.explanation) box.appendChild(explanationItem(state.explanation));

    list.forEach(function (s) {
      var stale = isStale(s);
      var item = doc().createElement('div');
      item.className = 's-item' + (stale ? ' stale' : '');

      var top = doc().createElement('div');
      top.className = 's-head';
      var what = doc().createElement('span');
      what.className = 's-what';
      what.textContent = s.what;
      var show = doc().createElement('button');
      show.className = 's-show';
      show.textContent = 'Show';
      show.addEventListener('click', function () {
        if (!s.block || !s.block.isConnected) return;
        s.block.scrollIntoView({ block: 'center', behavior: 'smooth' });
        s.block.setAttribute(ACTIVE_ATTR, '');
        setTimeout(function () { s.block.removeAttribute(ACTIVE_ATTR); }, 1400);
      });
      top.appendChild(what);
      top.appendChild(show);
      item.appendChild(top);

      if (s.why) {
        var why = doc().createElement('div');
        why.className = 's-why';
        why.textContent = s.why;
        item.appendChild(why);
      }

      var diff = doc().createElement('div');
      diff.className = 'c-diff';
      diffInto(diff, s.basis.join(''), s.after.join(''));
      item.appendChild(diff);

      if (stale) {
        var warn = doc().createElement('div');
        warn.className = 's-stale';
        warn.textContent = 'This paragraph has changed since the suggestion was made, so it cannot be applied.';
        item.appendChild(warn);
      }

      var actions = doc().createElement('div');
      actions.className = 'r-tools';
      var accept = doc().createElement('button');
      if (write) {
        accept.className = 'pill primary';
        accept.textContent = 'Accept';
        accept.disabled = stale;
        accept.addEventListener('click', function () {
          if (acceptSuggestion(s)) flash('Applied — Ctrl/Cmd+Z undoes it');
        });
      } else {
        accept.className = 'pill';
        accept.textContent = 'Copy';
        accept.title = 'Copy the suggested wording, to make the change yourself';
        accept.addEventListener('click', function () {
          copyText(visible(s.after.join('')).replace(/ \u21b5 /g, '\n'), 'Copied the suggestion');
        });
      }
      var dismiss = doc().createElement('button');
      dismiss.className = 'pill';
      dismiss.textContent = 'Dismiss';
      dismiss.addEventListener('click', function () { dismissSuggestion(s); });
      actions.appendChild(accept);
      actions.appendChild(dismiss);
      item.appendChild(actions);

      box.appendChild(item);
    });
  }

  function explanationItem(ex) {
    var item = doc().createElement('div');
    item.className = 's-item explain';

    var top = doc().createElement('div');
    top.className = 's-head';
    var what = doc().createElement('span');
    what.className = 's-what';
    what.textContent = 'Explained: \u201c' + ex.quote.slice(0, 60) + (ex.quote.length > 60 ? '\u2026' : '') + '\u201d';
    top.appendChild(what);
    item.appendChild(top);

    var body = doc().createElement('div');
    body.className = 's-explain';
    body.textContent = ex.text;
    item.appendChild(body);

    var actions = doc().createElement('div');
    actions.className = 'r-tools';
    var keep = doc().createElement('button');
    keep.className = 'pill';
    keep.textContent = 'Save as comment';
    keep.title = 'Keep this as a comment on the paragraph, signed as an AI draft';
    keep.addEventListener('click', function () { saveExplanation(); });
    var copy = doc().createElement('button');
    copy.className = 'pill';
    copy.textContent = 'Copy';
    copy.addEventListener('click', function () { copyText(ex.text, 'Copied the explanation'); });
    var dismiss = doc().createElement('button');
    dismiss.className = 'pill';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', function () {
      state.explanation = null;
      renderReview();
    });
    actions.appendChild(keep);
    actions.appendChild(copy);
    actions.appendChild(dismiss);
    item.appendChild(actions);
    return item;
  }

  function copyText(text, done) {
    var clip = window.navigator && navigator.clipboard;
    if (!clip || !clip.writeText) { flash('This browser will not let VibeRevise copy'); return; }
    clip.writeText(text).then(function () { flash(done); },
      function () { flash('The browser refused to copy \u2014 select the text and copy it instead'); });
  }

  // The words selected inside `block`, if any.
  function selectionIn(block) {
    var sel = doc().getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
    var range = sel.getRangeAt(0);
    if (!block.contains(range.startContainer) || !block.contains(range.endContainer)) return '';
    return sel.toString().trim();
  }

  /*
   * Explain the selection, or the paragraph the caret is in. Advice only: it
   * changes nothing, in either mode, and it is kept until dismissed or saved
   * as a comment.
   */
  function aiExplain(target) {
    target = target || aiTarget();
    if (!target) { flash('Click into a paragraph, or select some words, first'); return Promise.resolve(null); }
    var text = AI.toModel(textOfRegions(target.regions)).trim();
    if (!text) { flash('That paragraph is empty'); return Promise.resolve(null); }
    var selection = selectionIn(target.block);
    var what = describeTag(target.block.localName || 'block');

    return runAI(selection ? 'Asking AI to explain the selection\u2026' : 'Asking AI to explain this ' + what + '\u2026',
      function (job) {
        var req = AI.explainRequest({
          text: text,
          selection: selection,
          before: neighbourText(target.block, -1),
          after: neighbourText(target.block, 1),
        });
        return askAI(req, job).then(function (res) {
          if (res.cancelled) return null;
          if (!res.ok) { flash('AI: ' + res.message); return null; }
          var answer = typeof res.data.explanation === 'string' ? res.data.explanation.trim() : '';
          if (!answer) { flash('AI had nothing to say about it'); return null; }
          state.explanation = { block: target.block, quote: selection || text, text: answer };
          setAIOpen(false);
          openReview();
          return state.explanation;
        });
      });
  }

  function saveExplanation() {
    var ex = state.explanation;
    if (!ex) return null;
    if (!ex.block.isConnected) { flash('That paragraph is no longer on the page'); return null; }
    var region = addCommentTo(ex.block, { text: ex.text, author: aiAuthor() });
    if (!region) return null;
    state.explanation = null;
    renderReview();
    flash('Saved as a comment \u2014 edit it or delete it before saving the file');
    return region;
  }

  // The host says its AI settings changed: a key added in another tab, say.
  function aiSettingsChanged() {
    return refreshAIStatus();
  }


  // --- saving ----------------------------------------------------------------

  /*
   * An island's value becomes source text: each run escaped for its context,
   * each <br> written as a literal <br>. `replacementFor` also restores the
   * file's line-ending style, which the DOM does not preserve.
   */
  // Bold and italic the user added are marks in the value, written as tags.
  var MARK_TAGS = { '\u0001': '<br>', '\u0002': '<strong>', '\u0003': '</strong>',
                    '\u0004': '<em>', '\u0005': '</em>' };

  function serialise(value, span) {
    return normaliseFormat(value).split(/([\u0001-\u0005])/).map(function (piece) {
      if (MARK_TAGS[piece]) return MARK_TAGS[piece];
      return piece ? Splice.replacementFor(span, piece) : '';
    }).join('');
  }

  /*
   * Walked in DOCUMENT order rather than region order, because several added
   * blocks can share one anchor offset — a block added after a block that was
   * itself added has nowhere else to go. applyEdits sorts by offset with a
   * stable sort, so feeding them in document order is what keeps them in the
   * order they appear on screen.
   */
  function collectEdits() {
    var edits = [];
    var trees = new Set();
    var islands = doc().querySelectorAll('[' + Islands.ATTR + ']');

    for (var i = 0; i < islands.length; i++) {
      var region = state.byIsland.get(islands[i]);
      if (!region || region.removed) continue;

      // A cell does not emit on its own: its tree emits all of them together,
      // at its first cell, so a half-filled table still writes every cell it
      // needs, in document order with any block added beside it.
      if (region.kind === 'cell') {
        if (!trees.has(region.tree)) {
          trees.add(region.tree);
          var te = treeEdit(region.tree);
          if (te) edits.push(te);
        }
        continue;
      }

      if (region.kind === 'insert') {
        // An added block nobody typed into is not written at all.
        if (!region.current) continue;
        var anchor = liveAnchor(region.anchor);
        edits.push({
          start: anchor.offset,
          end: anchor.offset,
          replacement: anchor.before +
            Blocks.markup(region.template, serialise(region.current, region.span)) +
            anchor.after,
        });
        continue;
      }

      if (region.current === region.original) continue;   // untouched: never spliced
      edits.push({
        start: region.record.span.start,
        end: region.record.span.end,
        replacement: serialise(region.current, region.record.span),
      });
    }

    state.removals.forEach(function (x) {
      if (x.active) edits.push({ start: x.cut.start, end: x.cut.end, replacement: '' });
    });
    state.unwraps.forEach(function (x) {
      if (!x.active || !x.element.ownerDocument) return;
      edits.push({ start: x.open.start, end: x.open.end, replacement: '' });
      edits.push({ start: x.close.start, end: x.close.end, replacement: '' });
    });
    collectCommentEdits(edits);
    return edits;
  }

  /*
   * An inserted structure is a single zero-length splice: its whole tree,
   * rendered from the cells the user typed into. One nobody typed anything into
   * is not written at all, on the same grounds as an added block left empty.
   */
  function treeEdit(tree) {
    if (tree.removed || !treeHasText(tree)) return null;
    var anchor = liveAnchor(tree.anchor);
    return {
      start: anchor.offset,
      end: anchor.offset,
      replacement: anchor.before + Structures.markup(tree.element, {
        newline: Blocks.newlineOf(state.source),
        indent: tree.indent,
        text: function (island) {
          var cell = state.byIsland.get(island);
          return cell ? serialise(cell.current, cell.span) : '';
        },
      }) + anchor.after,
    };
  }

  /*
   * Comments are ranges too: a new one is a zero-length splice before its
   * section, an edited one replaces the comment that is already there, and a
   * deleted one cuts it — taking the whole line with it if the comment had the
   * line to itself.
   *
   * A comment left empty is treated as no comment: a new one is never written,
   * and an existing one emptied out is removed.
   */
  // Whichever form the switch currently says, for every note being written.
  function commentMarkup(text, indent, newline, meta) {
    return state.commentsVisible
      ? Comments.renderedMarkup(text, indent, newline, meta)
      : Comments.markup(text, indent, newline, meta);
  }

  function collectCommentEdits(edits) {
    var newline = Blocks.newlineOf(state.source);

    for (var i = 0; i < state.comments.length; i++) {
      var region = state.comments[i];
      var text = region.text.trim();

      if (region.removed || (!text && region.token)) {
        if (!region.token) continue;                 // a new one, discarded
        var cut = Comments.deleteRange(state.source, region.token);
        edits.push({ start: cut.start, end: cut.end, replacement: '' });
        continue;
      }
      if (!text) continue;                           // a new one, never written in

      if (region.token) {
        // Untouched text is still a rewrite when the switch has moved: that is
        // exactly what turning notes on and off means, and it is the one case
        // where a save changes a line nobody typed in.
        var wasVisible = !!region.element;
        if (text === region.original && wasVisible === !!state.commentsVisible) continue;
        // An edited note keeps the attribution it came with: it is still that
        // person's comment, and re-signing it would claim otherwise.
        edits.push({
          start: region.token.start,
          end: region.token.end,
          replacement: commentMarkup(
            text, Blocks.indentOf(state.source, region.token.start), newline,
            { author: region.author, date: region.date }),
        });
        continue;
      }

      edits.push({
        start: region.anchor.offset,
        end: region.anchor.offset,
        // Attributed only once the user has given a name. Someone who never
        // touches the feature gets exactly the plain comment they always did,
        // rather than a date stamped on every note they write.
        replacement: commentMarkup(text, region.anchor.indent, newline,
          (region.author || authorName())
            ? { author: region.author || authorName(), date: region.date || Comments.today() }
            : null) +
          region.anchor.after,
      });
    }
  }

  function send(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (res) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, message: chrome.runtime.lastError.message });
          } else {
            resolve(res || { ok: false, message: 'No response from the extension.' });
          }
        });
      } catch (err) {
        resolve({ ok: false, message: String(err && err.message || err) });
      }
    });
  }

  function toDataUrl(text) {
    var bytes = new TextEncoder().encode(text);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return 'data:text/html;charset=utf-8;base64,' + btoa(binary);
  }

  /*
   * Hand the file to the downloads API, which is the only way to get the OS
   * Save dialog — and therefore the only way the user can choose to replace the
   * original. Two fallbacks, because a service worker cannot create object URLs
   * of its own and support for reaching a page's blob: URL has moved around
   * between Chrome versions:
   *   1. a blob: URL created here
   *   2. a data: URL, which needs no cross-context resolution
   *   3. an ordinary download link in the page — no dialog, so the file lands in
   *      the Downloads folder and the status bar says so
   */
  function requestDownload(text) {
    var blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/html;charset=utf-8' }));

    return send({ type: 'vibeRevise:download', url: blobUrl, filename: state.filename })
      .then(function (res) {
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 60000);
        if (res && res.ok) { console.log('[VibeRevise] saved via blob URL'); return res; }
        console.warn('[VibeRevise] blob URL download failed, trying a data URL:', res && res.message);
        return send({ type: 'vibeRevise:download', url: toDataUrl(text), filename: state.filename });
      })
      .then(function (res) {
        if (res && res.ok) { console.log('[VibeRevise] saved via data URL'); return res; }
        console.warn('[VibeRevise] downloads API unavailable, falling back to a download link:',
                     res && res.message);
        var a = doc().createElement('a');
        a.setAttribute(UI_ATTR, '');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/html;charset=utf-8' }));
        a.download = state.filename;
        a.style.setProperty('display', 'none', 'important');
        doc().documentElement.appendChild(a);
        a.click();
        setTimeout(function () {
          URL.revokeObjectURL(a.href);
          if (a.parentNode) a.parentNode.removeChild(a);
        }, 60000);
        return { ok: true, viaAnchor: true };
      });
  }

  /*
   * Write the document back to the server it came from.
   *
   * Only ever reached for an http(s) document whose server answered OPTIONS
   * with PUT in its Allow header, so this is not a probe — it is the save.
   *
   * The write is CONDITIONAL. If the server gave us an ETag or a Last-Modified
   * when we read the document, it comes back as If-Match / If-Unmodified-Since,
   * and a server that honours it returns 412 rather than letting this save
   * overwrite a change made by someone else in the meantime. That is the one
   * thing a save-in-place can get catastrophically wrong, and it costs a header
   * to prevent.
   *
   * Anything other than success falls back to the download path rather than
   * losing the user's edits: a 405 means the route was removed since the probe,
   * a 5xx or a dropped connection means the server is unwell, and in every case
   * the user still gets their file.
   */
  function saveToServer(text) {
    var headers = { 'Content-Type': 'text/html; charset=utf-8' };
    if (state.served.etag) headers['If-Match'] = state.served.etag;
    else if (state.served.lastModified) headers['If-Unmodified-Since'] = state.served.lastModified;

    return fetch(state.served.url, {
      method: 'PUT',
      headers: headers,
      body: text,
      credentials: 'same-origin',
    }).then(function (r) {
      if (r.status === 412) {
        return {
          ok: false,
          conflict: true,
          message: 'the file changed on the server since you opened it. ' +
                   'Reload the page and make your edits again.',
        };
      }
      // The route is not there. Either the Allow header was optimistic or it has
      // been removed since the probe; either way this server does not do
      // save-in-place, so stop offering it for the rest of the session rather
      // than failing the same way on every save.
      if (r.status === 404 || r.status === 405 || r.status === 501) {
        state.served.canPut = false;
        return { ok: false, unsupported: true, message: 'HTTP ' + r.status };
      }
      if (!r.ok) return { ok: false, message: 'HTTP ' + r.status + ' ' + r.statusText };

      // Take the new validator so a second save in the same session is still
      // conditional, and still refuses to clobber.
      var etag = r.headers.get('ETag');
      if (etag) state.served.etag = etag;
      var lm = r.headers.get('Last-Modified');
      if (lm) state.served.lastModified = lm;
      return { ok: true, toServer: true };
    }).catch(function (err) {
      return { ok: false, message: String(err && err.message || err) };
    });
  }

  /*
   * The exact bytes that would be saved right now: the original source with
   * only the changed regions spliced. With no changes this returns the source
   * itself, unchanged, which is the guarantee the whole extension rests on.
   */
  function preview() {
    return Splice.applyEdits(state.source, collectEdits());
  }

  /*
   * Saving through the host — the web app's file handle, or the extension's.
   *
   * A host that turns out not to be able to write says so with fallback:true,
   * and the download catches the edits. Cancelling a dialog is deliberately
   * not that: downloading a file somebody just declined to save would be the
   * opposite of what they asked for.
   */
  function hostSave(text, opts) {
    return Promise.resolve(state.saveFile(text, opts)).then(function (res) {
      if (!res || res.ok || !res.fallback) return res;
      return requestDownload(text).then(function (dl) {
        if (!dl || !dl.ok) return dl;
        return { ok: true, where: 'Could not write to the file — downloaded ' + state.filename + ' instead' };
      });
    });
  }

  // Save as: choose somewhere new to write, and keep saving there after.
  // Where the host cannot choose (a document saved back to its server, or a
  // download), it is a download, whose dialog always asks where.
  function saveAs() { return save({ as: true }); }

  /*
   * Saving over a file another tool has changed since would throw its work
   * away without anyone seeing it. When Save writes in place and the host can
   * look, it looks first, and offers to bring the changes in instead.
   */
  function save(opts) {
    opts = opts || {};
    var inPlace = state.saveFile || (state.served && state.served.canPut);
    if (opts.force || opts.as || !state.watch || !inPlace || !state.regions.length) return saveNow(opts);
    return Promise.resolve(state.watch.read()).catch(function () { return null; }).then(function (text) {
      if (text != null && text !== expectedOnDisk()) {
        state.diskText = text;
        showDiskNotice(true);
        return;
      }
      return saveNow(opts);
    });
  }

  function saveNow(opts) {
    opts = opts || {};
    if (!state.regions.length) { flash('Nothing to save'); return Promise.resolve(); }

    flushCommentEdit();

    var text;
    try {
      text = preview();
    } catch (err) {
      flash('Could not save: ' + (err && err.message || err));
      return Promise.resolve();
    }

    // Captured now, applied on success: the user can keep typing while the
    // save dialog is open.
    var snapshot = state.regions.map(function (r) { return { region: r, value: r.current }; })
      .concat(state.comments.map(function (r) {
        // null where the file will not hold this note at all, so a deletion is
        // recorded as having been saved rather than only its text.
        return { region: r, value: commentWanted(r), visible: !!state.commentsVisible };
      }));
    var skipped = emptyAddedCount() + emptyCommentCount();
    var removedAtSave = state.removals.concat(state.unwraps).map(function (x) { return { item: x, active: x.active }; });

    var toServer = !!(state.served && state.served.canPut) && !opts.as;
    flash(state.saveFile ? 'Saving…' : (toServer ? 'Saving to the server…' : 'Saving…'));

    var attempt = state.saveFile ? hostSave(text, opts) : toServer
      ? saveToServer(text).then(function (res) {
          if (res.ok || res.conflict) return res;
          // The server said no. Do not lose the edits over it — fall back to
          // the download. A missing route is an ordinary fact about the server,
          // not a failure worth alarming anyone about; anything else is worth
          // repeating back.
          return requestDownload(text).then(function (dl) {
            if (dl && dl.ok) {
              if (res.unsupported) dl.noRoute = true;
              else dl.fellBack = res.message;
            }
            return dl;
          });
        })
      : requestDownload(text);

    return attempt.then(function (res) {
      if (!res || !res.ok) {
        flash(res && res.conflict
          ? 'Not saved — ' + res.message
          : 'Save failed: ' + ((res && res.message) || 'unknown error'));
        return;
      }
      // What the file on disk now holds, when the save wrote over it. A
      // download leaves the file as it was.
      if (res.inPlace || res.toServer) state.written = text;
      state.earlierThisLoad = collectChanges().map(rowRecord);
      removedAtSave.forEach(function (x) { x.item.saved = x.active; });
      for (var i = 0; i < snapshot.length; i++) {
        snapshot[i].region.saved = snapshot[i].value;
        if (snapshot[i].region.kind === 'comment') {
          snapshot[i].region.savedVisible = snapshot[i].visible;
        }
      }
      renderRail();
      refresh();
      saveSessionNow();

      var where;
      if (res.where) {
        where = res.where;
      } else if (res.toServer) {
        where = 'Saved ' + state.filename + ' to the server';
      } else if (res.noRoute) {
        where = 'This server does not accept saves — downloaded ' + state.filename + ' instead';
      } else if (res.fellBack) {
        where = 'Server refused the save (' + res.fellBack + ') — downloaded instead';
      } else if (res.viaAnchor) {
        where = 'Saved to your Downloads folder as ' + state.filename;
      } else {
        where = 'Saved ' + state.filename + ' — the original file is unchanged';
      }
      flash(skipped
        ? where + ' (' + skipped + ' empty left out)'
        : where);
    });
  }


  // --- the file changed underneath: carrying a session through a reload -------

  /*
   * Another tool rewrites the file, the page is reloaded, and everything held
   * only in the page is gone: unsaved edits, who made which change, what is
   * still waiting to be resolved. So the session is kept, in the host's own
   * storage (never the page's, never sent anywhere), and offered back.
   *
   * What is kept is the file as this page opened it, the text last saved from
   * it, and each unsaved edit as what the file held there and what the user
   * made it. Coming back to a file that has changed since, each edit goes
   * back on only where the file still holds what it held before. Anywhere the
   * other tool changed, the edit is a CLASH: shown, with the other tool's
   * words beside it, and settled by the user. Nothing is written over words
   * VibeRevise has not seen.
   *
   * Undo history is not kept: it is a list of steps through DOM that is gone.
   * Each restored change can still be undone from its row.
   */
  var SESSION_DAYS = 14;

  function scheduleSession() {
    if (!state.session || state.resumePending || state.restoring) return;
    clearTimeout(state.sessionTimer);
    state.sessionTimer = setTimeout(saveSessionNow, 700);
  }

  // Kept from the moment a document is opened, edits or not: without the
  // file as it was, a change another tool makes cannot be shown afterwards.
  function saveSessionNow(extra) {
    if (!state.session || !state.sessionRead || state.resumePending || state.restoring || !state.regions.length) return;
    clearTimeout(state.sessionTimer);
    var snap = Object.assign(sessionSnapshot(), extra || {});
    var done = state.session.save(snap);
    Promise.resolve(done).catch(function (err) {
      if (state.sessionWarned) return;
      state.sessionWarned = true;
      console.warn('[VibeRevise] could not keep the session:', err);
      flash('This document is too big to keep through a reload — save before reloading');
    });
  }

  // A changes-list row, reduced to what can be shown again after a reload.
  function rowRecord(ch) {
    return { heading: changeHeading(ch), before: ch.before || '', after: ch.after || '', at: Date.now() };
  }

  function sessionSnapshot() {
    var edits = [];
    var islands = doc().querySelectorAll('[' + Islands.ATTR + ']');
    var trees = new Set();
    var meta = function (r) {
      return { by: r.by || null, ai: !!r.ai, model: r.aiModel || null, human: !!r.humanToo };
    };
    for (var i = 0; i < islands.length; i++) {
      var r = state.byIsland.get(islands[i]);
      if (!r || r.removed) continue;
      if (r.kind === 'text') {
        if (r.current === r.saved) continue;
        edits.push(Object.assign({ k: 'text', start: r.record.span.start, end: r.record.span.end,
          expected: r.saved, mine: r.current }, meta(r)));
      } else if (r.kind === 'insert') {
        if (!r.current || r.current === r.saved) continue;
        if (r.saved) {                 // already in the file as its own block
          edits.push(Object.assign({ k: 'found', expected: r.saved, mine: r.current }, meta(r)));
        } else {
          edits.push(Object.assign({ k: 'insert', anchor: r.anchor.offset,
            template: r.template, mine: r.current }, meta(r)));
        }
      } else if (r.kind === 'cell' && !trees.has(r.tree)) {
        var t = r.tree;
        trees.add(t);
        if (t.removed || !treeHasText(t)) continue;
        var saved = t.cells.some(function (c) { return c.saved; });
        if (saved) {
          t.cells.forEach(function (c) {
            if (c.current !== c.saved) edits.push(Object.assign({ k: 'found', expected: c.saved, mine: c.current }, meta(c)));
          });
        } else {
          edits.push({ k: 'tree', id: t.id, anchor: t.anchor.offset, inside: !!t.inside,
            cells: t.cells.map(function (c) { return c.current; }),
            by: (t.cells.find(function (c) { return c.by; }) || {}).by || null });
        }
      }
    }
    state.removals.forEach(function (x) {
      if (x.active && !x.saved) edits.push({ k: 'remove', start: x.tags.start, end: x.tags.end, what: x.what, before: x.before });
    });
    state.unwraps.forEach(function (x) {
      if (x.active && !x.saved) edits.push({ k: 'unwrap', start: x.open.start, end: x.close.end, fmt: x.kind, text: x.text, by: x.by });
    });
    for (var j = 0; j < state.comments.length; j++) {
      var c = state.comments[j];
      var want = commentWanted(c);
      if (want === c.saved) continue;
      if (c.saved === null) {
        if (c.removed || !c.text.trim()) continue;
        edits.push({ k: 'comment-new', anchor: c.anchor.offset, text: c.text, author: c.author, date: c.date });
      } else {
        edits.push({ k: 'comment-change', expected: c.saved, text: c.text, removed: !!c.removed || want === null });
      }
    }
    return {
      v: 1,
      at: Date.now(),
      filename: state.filename,
      baseline: state.source,
      written: state.written,
      edits: edits,
      conflicts: state.conflicts.map(function (x) {
        return { kind: x.kind, base: x.base, theirs: x.theirs, mine: x.mine, by: x.by, ai: x.ai, model: x.model };
      }),
      reviewBase: state.reviewBase,
      showOutside: state.showOutside,
      earlier: state.earlier.concat(state.earlierThisLoad || []),
    };
  }

  /*
   * Ask before putting anything back. Only when there is something to ask
   * about: unsaved edits, or a file that changed since. A kept history with
   * nothing pending comes back without a question.
   */
  function offerResume() {
    var prior = state.prior;
    if (!prior || !state.active || state.resumePending) return;
    var reference = prior.written != null ? prior.written : prior.baseline;
    var changed = reference !== state.source;
    var pending = prior.edits.length + (prior.conflicts || []).length;
    // Nothing of the user's at stake, or a reload VibeRevise asked for: carry
    // on without a question. What changed is still shown.
    if (!pending || prior.autoResume) { resume(true); return; }

    state.resumePending = true;
    var box = ensureAssist().resume;
    box.textContent = '';
    var title = doc().createElement('strong');
    title.textContent = 'Carry on where you left off?';
    box.appendChild(title);
    var when = new Date(prior.at);
    var p = doc().createElement('div');
    p.className = 'c-note';
    p.textContent = 'You were editing this ' + when.toLocaleString(undefined,
        { weekday: 'short', hour: 'numeric', minute: '2-digit' }) +
      (prior.edits.length ? ', with ' + prior.edits.length + ' unsaved change' + (prior.edits.length === 1 ? '' : 's') : '') +
      '.' + (changed ? ' The file has been changed since, outside VibeRevise. Your changes go back ' +
        'where the file is as it was; anywhere it was changed shows as a clash for you to settle.' : '');
    box.appendChild(p);
    var tools = doc().createElement('div');
    tools.className = 'r-tools';
    var go = doc().createElement('button');
    go.className = 'pill primary';
    go.textContent = 'Carry on';
    go.addEventListener('click', function () { resume(true); });
    var fresh = doc().createElement('button');
    fresh.className = 'pill';
    fresh.textContent = 'Start fresh';
    fresh.title = 'Forget the earlier session and its unsaved changes';
    fresh.addEventListener('click', function () { resume(false); });
    tools.appendChild(go);
    tools.appendChild(fresh);
    box.appendChild(tools);
    box.hidden = false;
  }

  function resume(carryOn) {
    var prior = state.prior;
    state.prior = null;
    state.resumePending = false;
    if (state.assist) state.assist.resume.hidden = true;
    if (!prior) return null;
    if (!carryOn) {
      Promise.resolve(state.session && state.session.clear()).catch(function () {});
      flash('Started fresh');
      return null;
    }
    var result = restoreSession(prior);
    refresh();
    saveSessionNow();
    var bits = [];
    if (result.restored) bits.push(result.restored + ' change' + (result.restored === 1 ? '' : 's') + ' put back');
    if (state.conflicts.length) bits.push(state.conflicts.length + ' clash' + (state.conflicts.length === 1 ? '' : 'es') + ' to settle');
    if (result.outside) bits.push(result.outside + ' change' + (result.outside === 1 ? '' : 's') + ' made outside VibeRevise, in blue');
    if (bits.length) {
      flash(bits.join(' · '));
      if (state.conflicts.length || result.outside) openChanges();
    }
    return result;
  }

  // Elements by where their tags are in the current source.
  function elementsBy(field) {
    // The element map is weak, so walk the page and ask it about each one.
    var out = new Map();
    var all = doc().getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      var range = state.map.elements.get(all[i]);
      var at = range && field(range);
      if (at != null && !out.has(at)) out.set(at, all[i]);
    }
    return out;
  }

  function restoreSession(prior) {
    var Rebase = root.VibeReviseRebase;
    var d = Rebase.diff(prior.baseline, state.source);

    var texts = state.regions.filter(function (r) { return r.kind === 'text'; });
    var byStart = new Map(texts.map(function (r) { return [r.record.span.start, r]; }));
    var endingAt = elementsBy(function (r) { return r.endTag ? r.endTag.end : null; });
    var closingAt = elementsBy(function (r) { return r.endTag ? r.endTag.start : null; });
    var openingAt = elementsBy(function (r) { return r.startTag ? r.startTag.start : null; });
    var chain = new Map();          // anchor offset -> the last thing put there
    var used = new Set();
    var restored = 0;
    var conflicts = (prior.conflicts || []).slice();

    function apply(r, e) {
      Islands.writeValue(r.island, e.mine);
      r.current = e.mine;
      r.by = e.by;
      r.ai = !!e.ai;
      r.aiModel = e.model;
      r.humanToo = !!e.human;
      markChanged(r);
      used.add(r);
      restored++;
    }
    // Where an edit's words went, if the file moved them but did not change
    // them: one run, and only one, still holding exactly what it held.
    function findUnchanged(expected, among) {
      if (String(expected).length < 3) return null;
      var hits = among.filter(function (r) {
        return !used.has(r) && r.current === expected && r.current === r.original;
      });
      return hits.length === 1 ? hits[0] : null;
    }
    function inHunk(h) {
      return h ? texts.filter(function (r) {
        return r.record.span.start >= h.bStart && r.record.span.end <= h.bEnd;
      }) : [];
    }
    function clash(kind, e, near) {
      var best = null, score = 0.3;
      near.forEach(function (r) {
        if (used.has(r)) return;
        var sc = Rebase.similarity(e.expected, r.current);
        if (sc > score) { score = sc; best = r; }
      });
      conflicts.push({ kind: kind, base: e.expected || '', theirs: best ? best.current : null,
        mine: e.mine, region: best, by: e.by, ai: e.ai, model: e.model });
    }

    state.restoring = true;
    try {
      prior.edits.forEach(function (e) {
        if (e.k === 'text') {
          var m = Rebase.mapRange(d, e.start, e.end);
          var r = m && byStart.get(m.start);
          if (r && r.record.span.end === m.end && r.current === e.expected && !used.has(r)) { apply(r, e); return; }
          var h = Rebase.hunkAt(d, e.start);
          var near = inHunk(h);
          var found = findUnchanged(e.expected, near);
          if (found) { apply(found, e); return; }
          clash('text', e, near.length ? near : texts);
        } else if (e.k === 'found') {
          var f = e.expected.length >= 12 ? findUnchanged(e.expected, texts.concat(
            state.regions.filter(function (x) { return x.kind === 'cell'; }))) : null;
          if (f) apply(f, e); else clash('text', e, texts);
        } else if (e.k === 'insert' || e.k === 'tree') {
          var at = Rebase.mapPoint(d, e.anchor);
          var host = at == null ? null
            : chain.get(at) || (e.inside ? closingAt.get(at) : endingAt.get(at));
          if (!host) {
            conflicts.push({ kind: 'added', base: '', theirs: null,
              mine: e.k === 'tree' ? e.cells.filter(Boolean).join(' · ') : e.mine, by: e.by });
            return;
          }
          if (e.k === 'insert') {
            var added = addAfterBlock(host, { template: e.template, text: e.mine, quiet: true });
            if (!added) return;
            added.by = e.by; added.ai = !!e.ai; added.aiModel = e.model;
            markChanged(added);
            chain.set(at, added.element);
          } else {
            var tree = insertStructure(e.id, host);
            if (!tree) return;
            tree.cells.forEach(function (c, i) {
              if (!e.cells[i]) return;
              Islands.writeValue(c.island, e.cells[i]);
              c.current = e.cells[i];
              c.by = e.by;
              markChanged(c);
            });
            if (!e.inside) chain.set(at, tree.element);
          }
          restored++;
        } else if (e.k === 'comment-new') {
          var pt = Rebase.mapPoint(d, e.anchor);
          var block = pt == null ? null : openingAt.get(pt);
          var c = block && addCommentTo(block, { text: e.text, author: e.author });
          if (c) { c.date = e.date; restored++; }
          else conflicts.push({ kind: 'comment', base: '', theirs: null, mine: e.text, by: e.author });
        } else if (e.k === 'remove') {
          var mr = Rebase.mapRange(d, e.start, e.end);
          var el = mr && openingAt.get(mr.start);
          var er = el && state.map.elements.get(el);
          if (er && er.endTag && er.endTag.end === mr.end) {
            var gone = makeRemoval(el, el.localName === 'ul' || el.localName === 'ol' ? el.firstElementChild || el : el);
            gone.by = e.by || gone.by;
            setRemoval(gone, true);
            restored++;
          } else {
            conflicts.push({ kind: 'removed', base: '', theirs: null, mine: e.before || '' });
          }
        } else if (e.k === 'unwrap') {
          var mu = Rebase.mapRange(d, e.start, e.end);
          var fe = mu && openingAt.get(mu.start);
          var fr = fe && state.map.elements.get(fe);
          if (fr && fr.endTag && fr.endTag.end === mu.end) {
            var un = makeUnwrap(fe, e.fmt);
            un.by = e.by || un.by;
            setUnwrap(un, true);
            restored++;
          } else {
            conflicts.push({ kind: 'removed', base: '', theirs: null, mine: e.text || '' });
          }
        } else if (e.k === 'comment-change') {
          var cm = state.comments.find(function (x) { return x.original === e.expected && !used.has(x); });
          if (cm) {
            used.add(cm);
            cm.text = e.removed ? cm.text : e.text;
            cm.removed = !!e.removed;
            restored++;
          } else if (!e.removed) {
            conflicts.push({ kind: 'comment', base: e.expected, theirs: null, mine: e.text });
          }
        }
      });
    } finally {
      state.restoring = false;
    }

    // The review point, carried forward. What VibeRevise itself saved into
    // the file is moved onto it, so only the other tool's changes show.
    var review = prior.reviewBase != null ? prior.reviewBase : prior.baseline;
    if (prior.written != null) review = Rebase.transplant(review, prior.baseline, prior.written);
    state.reviewBase = review;
    state.outsideCache = null;
    var fresh = outsideRows().length;
    // Something new from outside is shown; otherwise as the user left it.
    var reference = prior.written != null ? prior.written : prior.baseline;
    state.showOutside = reference !== state.source || prior.showOutside !== false;

    state.history = [];
    state.historyAt = 0;
    state.conflicts = conflicts;
    state.earlier = prior.earlier || [];
    renderRail();
    positionCards();
    renderOutsideMarks();
    return { restored: restored, conflicts: conflicts.length, outside: fresh };
  }

  /*
   * Settle a clash. Mine: the user's words go onto the run the other tool's
   * version is in, as an ordinary edit (one undo step). Theirs: the edit is
   * dropped, and the file keeps what the other tool wrote.
   */
  function settleConflict(x, keepMine) {
    var at = state.conflicts.indexOf(x);
    if (at === -1) return false;
    if (keepMine) {
      var r = x.region;
      if (!r || !r.island.isConnected) { flash('There is nowhere left to put that — copy it instead'); return false; }
      var before = r.current;
      Islands.writeValue(r.island, x.mine);
      state.lastTouch = 0;
      recordChange(r.island, before);
    }
    state.conflicts.splice(at, 1);
    refresh();
    renderChanges();
    return true;
  }


  // --- what changed outside VibeRevise ----------------------------------------

  /*
   * One row per changed stretch of the file since the review point, however
   * many times another tool went over it: a paragraph changed three times
   * before anyone looked is one row, from what was reviewed to what is there
   * now. That is what keeps several rounds of changes from piling up.
   */
  function outsideRows() {
    if (!state.reviewBase || state.reviewBase === state.source || !state.map) return [];
    var c = state.outsideCache;
    if (c && c.base === state.reviewBase && c.source === state.source) return c.rows;
    var Rebase = root.VibeReviseRebase;
    var d = Rebase.diff(state.reviewBase, state.source);
    var texts = state.regions.filter(function (r) { return r.kind === 'text'; });
    var rows = [];
    d.hunks.forEach(function (h) {
      var before = Rebase.textOf(state.reviewBase.slice(h.aStart, h.aEnd));
      var after = Rebase.textOf(state.source.slice(h.bStart, h.bEnd));
      if (before === after) return;
      var blocks = [];
      texts.forEach(function (r) {
        if (r.record.span.start >= h.bStart && r.record.span.end <= h.bEnd) {
          var b = Blocks.blockFor(r.island) || r.island;
          if (blocks.indexOf(b) === -1) blocks.push(b);
        }
      });
      var next = null;
      if (!blocks.length) {
        var t = texts.find(function (r) { return r.record.span.start >= h.bEnd; });
        next = t ? (Blocks.blockFor(t.island) || t.island) : null;
      }
      rows.push({ hunk: h, before: before, after: after, blocks: blocks, gone: next,
                  target: blocks[0] || next });
    });
    state.outsideCache = { base: state.reviewBase, source: state.source, rows: rows };
    return rows;
  }

  function clearOutsideMarks() {
    var marked = doc().querySelectorAll('[data-vr-outside],[data-vr-outside-gone]');
    for (var i = 0; i < marked.length; i++) {
      marked[i].removeAttribute('data-vr-outside');
      marked[i].removeAttribute('data-vr-outside-gone');
    }
  }

  function renderOutsideMarks() {
    clearOutsideMarks();
    if (!state.active || state.paused || !state.showOutside) return;
    outsideRows().forEach(function (o) {
      o.blocks.forEach(function (b) { if (b.isConnected) b.setAttribute('data-vr-outside', ''); });
      if (o.gone && o.gone.isConnected) o.gone.setAttribute('data-vr-outside-gone', '');
    });
  }

  function setShowOutside(on) {
    state.showOutside = !!on;
    renderOutsideMarks();
    refresh();
    renderChanges();
    flash(on ? 'Showing what changed outside VibeRevise, in blue' : 'Highlights hidden — the changes are still listed');
  }

  /*
   * Reviewed: one row, or all of them. The review point takes that stretch
   * as it is now, so it stops being highlighted and drops off the list; the
   * next change another tool makes there shows up afresh.
   */
  function markReviewed(row) {
    var rows = outsideRows();
    if (!rows.length) return 0;
    if (!row) {
      state.reviewBase = state.source;
    } else {
      var h = row.hunk;
      state.reviewBase = state.reviewBase.slice(0, h.aStart) + state.source.slice(h.bStart, h.bEnd) +
        state.reviewBase.slice(h.aEnd);
    }
    state.outsideCache = null;
    renderOutsideMarks();
    refresh();
    renderChanges();
    return row ? 1 : rows.length;
  }

  // --- noticing the file change while it is open ------------------------------

  /*
   * Every few seconds while editing, ask the host what the file now holds,
   * and compare it with what VibeRevise thinks is there: the text this page
   * opened, or the text it last saved over it. Only while the page is in view.
   */
  var WATCH_MS = 4000;

  function expectedOnDisk() { return state.written != null ? state.written : state.source; }

  function startWatching() {
    stopWatching();
    if (!state.watch) return;
    state.watchTimer = setInterval(function () {
      if (!state.active || doc().hidden || state.resumePending) return;
      checkDisk();
    }, WATCH_MS);
  }
  function stopWatching() { clearInterval(state.watchTimer); state.watchTimer = 0; }

  function checkDisk() {
    if (!state.watch) return Promise.resolve(false);
    return Promise.resolve(state.watch.read()).then(function (text) {
      if (text == null || text === expectedOnDisk()) { state.diskText = null; return false; }
      state.diskText = text;
      if (text !== state.diskDismissed) showDiskNotice(false);
      return true;
    }).catch(function () { return false; });
  }

  function diskPlaces() {
    if (state.diskText == null) return 0;
    var Rebase = root.VibeReviseRebase;
    return Rebase.diff(expectedOnDisk(), state.diskText).hunks.length;
  }

  // The bar that says so. Also what Save shows when it would overwrite it.
  function showDiskNotice(saving) {
    var box = ensureAssist().resume;
    box.textContent = '';
    var title = doc().createElement('strong');
    title.textContent = saving ? 'The file was changed outside VibeRevise' : 'This file was changed outside VibeRevise';
    box.appendChild(title);
    var n = diskPlaces();
    var p = doc().createElement('div');
    p.className = 'c-note';
    p.textContent = (n ? 'In ' + n + ' place' + (n === 1 ? '' : 's') + '. ' : '') + (saving
      ? 'Saving now would write over those changes. Bring them in first and your edits carry over; anything you both changed shows as a clash.'
      : 'Bring the changes in to see them, highlighted in blue. Your unsaved edits carry over.');
    box.appendChild(p);
    var tools = doc().createElement('div');
    tools.className = 'r-tools';
    var go = doc().createElement('button');
    go.className = 'pill primary';
    go.textContent = (state.watch && state.watch.bringInLabel) || 'Bring the changes in';
    go.addEventListener('click', bringIn);
    tools.appendChild(go);
    if (saving) {
      var anyway = doc().createElement('button');
      anyway.className = 'pill';
      anyway.textContent = 'Save anyway';
      anyway.title = 'Write over the other changes';
      anyway.addEventListener('click', function () { box.hidden = true; save({ force: true }); });
      tools.appendChild(anyway);
    }
    var later = doc().createElement('button');
    later.className = 'pill';
    later.textContent = saving ? 'Cancel' : 'Later';
    later.addEventListener('click', function () { box.hidden = true; state.diskDismissed = state.diskText; });
    tools.appendChild(later);
    box.appendChild(tools);
    box.hidden = false;
  }

  /*
   * Bring the file's new contents in: the session is kept as it stands, marked
   * to carry straight on, and the host shows the file again (the web app in
   * place; the extension by reloading the page). The usual comparison does
   * the rest: edits go back where the file is unchanged, clashes are listed,
   * and the other tool's changes are highlighted.
   */
  function bringIn() {
    if (!state.watch) return false;
    if (state.assist) state.assist.resume.hidden = true;
    flushCommentEdit();
    saveSessionNow({ autoResume: true });
    Promise.resolve(state.watch.bringIn()).catch(function (err) {
      flash('Could not bring the changes in: ' + (err && err.message || err));
    });
    return true;
  }

  // --- lifecycle -------------------------------------------------------------

  function setActive(next) {
    if (next === state.active) return state.active;

    if (next) {
      state.active = true;
      ensureStyles();
      if (!state.regions.length) {
        buildRegions();
        buildComments();
        if (state.prior) setTimeout(offerResume, 0);   // once the bar exists
      } else {
        state.regions.forEach(function (r) { r.island.setAttribute('contenteditable', 'true'); });
      }
      doc().documentElement.setAttribute(MODE_ATTR, 'on');
      addListeners();
      ensureStatusBar();
      renderRail();
      if (state.reviewBase == null) state.reviewBase = state.source;
      refresh();
      renderOutsideMarks();
      startWatching();
      saveSessionNow();
      if (!state.regions.length) flash('No editable text found in this file');
    } else {
      setPaused(false);
      state.active = false;
      stopWatching();
      clearOutsideMarks();
      // Suggestions belong to the paragraphs on screen in this session of
      // editing; anything still on its way back is no longer wanted.
      if (state.aiJob) state.aiJob.cancelled = true;
      state.aiJob = null;
      state.suggestions = [];
      state.explanation = null;
      doc().documentElement.removeAttribute(MODE_ATTR);
      removeListeners();
      teardownRegions();
      clearHighlights();
      closeRail();
      removeAssist();
      removeStatusBar();
      // The stylesheet stays: any wrappers left holding unsaved edits still need
      // `all: unset` to remain invisible.
    }

    send({ type: 'vibeRevise:state', active: state.active, unsaved: unsavedCount() });
    return state.active;
  }

  /*
   * Pause: edit mode stays on, but the page goes back to being a page.
   *
   * Inside an editable run the browser keeps a drag-selection within that one
   * run, so copying a sentence that crosses a link, or a whole table, is not
   * possible while editing. Pausing takes `contenteditable` off every run and
   * stops the editing listeners, so selection and copy behave as they would
   * without VibeRevise.
   *
   * Nothing is torn down. The wrappers, the edits, undo history and comments
   * all stay exactly where they are, so Resume is instant and loses nothing.
   * Links and forms are still held back, because the edits are still unsaved.
   */
  var PAUSED_LISTENERS = [
    ['click', onClick, true],
    ['submit', onSubmit, true],
  ];

  function setPaused(next) {
    next = !!next && state.active;
    if (next === state.paused) return state.paused;
    state.paused = next;

    state.regions.forEach(function (r) {
      if (r.removed) return;
      if (next) r.island.removeAttribute('contenteditable');
      else r.island.setAttribute('contenteditable', 'true');
    });

    if (next) {
      setMenuOpen(false);
      setMoreOpen(false);
      setAIOpen(false);
      hideAdd();
      closeRail();
      removeAssist();
      removeListeners();
      clearOutsideMarks();
      PAUSED_LISTENERS.forEach(function (l) { doc().addEventListener(l[0], l[1], l[2]); });
      doc().documentElement.removeAttribute(MODE_ATTR);
      var active = doc().activeElement;
      if (active && active.blur && state.byIsland.get(active)) active.blur();
    } else {
      PAUSED_LISTENERS.forEach(function (l) { doc().removeEventListener(l[0], l[1], l[2]); });
      if (state.active) {
        doc().documentElement.setAttribute(MODE_ATTR, 'on');
        addListeners();
        renderRail();
        renderOutsideMarks();
      }
    }

    if (state.ui) {
      state.ui.bar.classList.toggle('paused', next);
      state.ui.label.textContent = next ? 'Paused' : 'Edit mode';
      state.ui.pause.textContent = next ? 'Resume editing' : 'Pause';
      state.ui.pause.classList.toggle('primary', next);
      state.ui.pause.title = next ? 'Go back to editing'
                                  : 'Stop editing for now, so you can select and copy text';
      flash(next ? 'Select and copy as normal. Your edits are kept.' : '');
    }
    refresh();
    return state.paused;
  }

  function init(options) {
    // A different document, or the same one read again: start from nothing,
    // rather than carrying regions that belong to a page that is gone.
    if (options.fresh) {
      if (state.active) setActive(false);
      clearTimeout(state.sessionTimer);
      state = makeState();
    }
    state.doc = options.doc || null;
    state.watch = options.watch || null;
    // Where this document's session is kept between reloads, if the host keeps one.
    state.session = options.session || null;
    state.prior = null;
    if (state.session) {
      var asked = state;
      Promise.resolve(state.session.load()).then(function (prior) {
        if (state !== asked) return;      // a fresh start since
        if (prior && prior.v === 1 && Date.now() - prior.at < SESSION_DAYS * 864e5) {
          state.prior = prior;
          if (state.active) offerResume();
        } else if (prior) {
          Promise.resolve(state.session.clear()).catch(function () {});
        }
        state.sessionRead = true;
        // Nothing kept: keep the file as it is now, so a change another tool
        // makes before the next reload can be shown.
        if (!state.prior && state.active) saveSessionNow();
      }).catch(function () { state.sessionRead = true; /* nothing kept is fine */ });
    }
    state.settings = options.settings || null;
    state.author = options.author || '';
    if (state.settings) {
      Promise.resolve(state.settings.get('author')).then(function (name) {
        state.author = Comments.cleanName(name || '');
        renderMore();
        renderRail();
      }).catch(function () { /* no stored name is fine */ });
      Promise.resolve(state.settings.get('commentsVisible')).then(function (on) {
        state.commentsVisible = !!on;
        if (state.ui && state.ui.showComments) state.ui.showComments.checked = !!on;
        refresh();
      }).catch(function () { /* the default is off */ });
    }
    // A host that owns saving supplies this: text -> Promise<{ok, where}>. The
    // web app writes through a file handle, shares, or downloads, and knows
    // which of those it did; the extension supplies nothing and keeps the
    // server/download path below.
    state.saveFile = options.saveFile || null;
    // AI, offered by the host or not at all. The editor builds the prompts and
    // shows the answers; the host holds the key and makes the request, so the
    // key never has to be anywhere the document can see.
    state.ai = (options.ai && AI) ? options.ai : null;
    state.aiStatus = null;
    if (state.ai) refreshAIStatus();
    // Only the test suite passes this. See fromUser().
    state.trustSynthetic = options.trustSynthetic === true;
    state.win = state.doc ? state.doc.defaultView : null;
    state.source = options.source;
    state.map = options.map;
    state.filename = options.filename || 'page.html';
    // null for a file:// document; for a served one, where to PUT it back and
    // the validators that make the write conditional. See saveToServer().
    state.served = options.served || null;
    // Registered once and left in place: unsaved edits still exist after edit
    // mode is switched off, and losing them to a stray navigation would be the
    // worst thing this extension could do.
    win().addEventListener('beforeunload', onBeforeUnload);
    // Removed first, so starting again never adds it twice; added every time,
    // because document.open() (how the web app shows a file) drops listeners.
    doc().removeEventListener('keydown', onAnyKey, true);
    doc().addEventListener('keydown', onAnyKey, true);
  }

  function status() {
    var added = 0;
    for (var i = 0; i < state.regions.length; i++) {
      if (state.regions[i].kind === 'insert' && !state.regions[i].removed) added++;
    }
    return {
      active: state.active,
      paused: state.paused,
      regions: state.regions.length,
      changed: changedCount(),
      unsaved: unsavedCount(),
      added: added,
      emptyAdded: emptyAddedCount(),
      comments: liveComments().length,
      emptyComments: emptyCommentCount(),
      canUndo: state.historyAt > 0,
      canRedo: state.historyAt < state.history.length,
      writeBack: state.served && state.served.canPut ? 'server' : 'download',
      author: authorName(),
      changeCount: collectChanges().length,
    };
  }

  root.VibeReviseEditor = {
    init: init,
    // Exposed for the test suite: `preview` is the file that would be written,
    // and `serialise` decides what text lands in it. Both are worth testing
    // directly rather than through a download.
    preview: preview,
    serialise: serialise,
    addAfterIsland: addAfterIsland,
    insertStructure: insertStructure,
    // Authorship and the list of changes.
    setAuthor: setAuthor,
    changes: collectChanges,
    openChanges: openChanges,
    revertChange: revertChange,
    sessionSnapshot: sessionSnapshot,
    removeFileBlock: removeFileBlock,
    toggleFormat: toggleFormat,
    resume: resume,
    conflicts: function () { return state.conflicts.slice(); },
    outsideChanges: function () { return outsideRows().slice(); },
    markReviewed: markReviewed,
    setShowOutside: setShowOutside,
    checkDisk: checkDisk,
    bringIn: bringIn,
    settleConflict: settleConflict,
    changeHeading: changeHeading,
    atEndOfBlock: atEndOfBlock,
    addCommentTo: addCommentTo,
    removeComment: removeComment,
    commentRegions: liveComments,
    setActive: setActive,
    setPaused: setPaused,
    // Exposed for the suite: the list of changes is built from this.
    diffWords: diffWords,
    setCommentsVisible: setCommentsVisible,
    // AI. Exposed so the hosts can say settings changed, and so the suite can
    // drive suggestions without clicking through a closed shadow root.
    aiRewrite: function (instruction, block) {
      var target = null;
      if (block) {
        target = { block: block, regions: runsOf(block) };
        if (!target.regions.length) target = null;
      }
      return aiRewrite(target, instruction);
    },
    aiProofread: aiProofread,
    aiReplyTo: aiReplyTo,
    aiExplain: function (block) {
      return aiExplain(block ? { block: block, regions: runsOf(block) } : null);
    },
    explanation: function () { return state.explanation; },
    saveExplanation: saveExplanation,
    aiSettingsChanged: aiSettingsChanged,
    suggestions: function () { return state.suggestions.slice(); },
    acceptSuggestion: acceptSuggestion,
    dismissSuggestion: dismissSuggestion,
    acceptAllSuggestions: acceptAll,
    isSuggestionStale: isStale,
    commentsVisible: function () { return state.commentsVisible; },
    isActive: function () { return state.active; },
    status: status,
    save: save,
    saveAs: saveAs,
    undo: undo,
    redo: redo,
  };
})(typeof self !== 'undefined' ? self : globalThis);
