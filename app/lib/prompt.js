/*
 * VibeRevise — in-page prompt.
 *
 * A small card in the corner of the document, used when VibeRevise needs
 * something from the user before it can do anything: at the moment, that means
 * asking them to choose the file when Chrome will not let the extension read it
 * on its own.
 *
 * It has to live in the page rather than the popup, because opening a file
 * dialog from a popup closes the popup and cancels the whole interaction.
 *
 * Like the status bar, it renders inside a closed shadow root so the page's
 * stylesheet cannot reach it and its own styles cannot leak out, and it is
 * tagged data-viberevise-ui so the offset map never treats it as content.
 */
(function (root) {
  'use strict';

  var UI_ATTR = 'data-viberevise-ui';

  var CSS = [
    ':host { all: initial; }',
    '.card {',
    '  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
    // A filename can be any length, and this card sits 16px from the edge of
    // the window, so the width is a maximum rather than a fixed size.
    '  width: 300px;',
    '  max-width: calc(100vw - 32px);',
    '  box-sizing: border-box;',
    '  padding: 14px 15px;',
    '  border-radius: 10px;',
    '  background: rgba(22, 22, 27, .95);',
    '  color: #f1f2f5;',
    '  box-shadow: 0 4px 24px rgba(0, 0, 0, .35);',
    '  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);',
    '}',
    '.title { font-weight: 600; margin-bottom: 5px; }',
    '.body { color: #b8bdc9; }',
    // The filename lives here rather than on the button, where it has a whole
    // line to itself and can wrap. A button cannot wrap, so a long name there
    // ellipsised away the verb and left the thing reading "Choo…".
    '.file {',
    '  margin-top: 9px; font-weight: 600;',
    '  overflow-wrap: anywhere; word-break: break-word;',
    '}',
    '.file:empty { display: none; }',
    '.error { color: #ff9f9f; margin-top: 8px; }',
    '.error:empty { display: none; }',
    '.row { display: flex; gap: 8px; margin-top: 12px; align-items: stretch; }',

    'button {',
    '  font: inherit; border: 0; border-radius: 7px; padding: 6px 13px;',
    '  cursor: pointer; background: rgba(255, 255, 255, .13); color: inherit;',
    '}',
    // The label WRAPS rather than clipping. Clipping it was a mistake twice
    // over: a squeezed button turned "Choose DIGISTAYBOOK_…" into "Choo", and
    // then "Choose this file" into "Ch". Two letters and an ellipsis is not a
    // label, and the failure is silent — nothing says the button is lying
    // about what it does. A wrapped label is uglier on a narrow card and
    // always readable, which is the right way round.
    '.row { flex-wrap: wrap; }',
    '.go { flex: 1 1 130px; white-space: normal; text-align: center; }',
    '.cancel { flex: 0 1 auto; }',
    'button:hover { background: rgba(255, 255, 255, .22); }',
    'button.primary { background: #5b52f0; }',
    'button.primary:hover { background: #6d64ff; }',
    'input[type=file] { display: none; }',
  ].join('\n');

  var current = null;

  function dismiss() {
    if (current && current.host.parentNode) current.host.parentNode.removeChild(current.host);
    current = null;
  }

  function build(options) {
    dismiss();

    var host = document.createElement('div');
    host.setAttribute(UI_ATTR, '');
    [['position', 'fixed'], ['right', '16px'], ['bottom', '16px'],
     ['z-index', '2147483647'], ['margin', '0'], ['padding', '0'],
     ['width', 'auto'], ['height', 'auto'], ['max-width', 'none'],
     ['transform', 'none'], ['opacity', '1'], ['visibility', 'visible'],
     ['display', 'block'], ['pointer-events', 'auto'], ['float', 'none'],
    ].forEach(function (p) { host.style.setProperty(p[0], p[1], 'important'); });

    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML =
      '<style>' + CSS + '</style>' +
      '<div class="card">' +
        '<div class="title"></div>' +
        '<div class="body"></div>' +
        '<div class="file"></div>' +
        '<div class="error"></div>' +
        '<div class="row">' +
          '<button class="go primary"></button>' +
          '<button class="cancel">Cancel</button>' +
        '</div>' +
        '<input type="file" accept=".html,.htm,.xhtml,text/html">' +
      '</div>';

    shadow.querySelector('.title').textContent = options.title;
    shadow.querySelector('.body').textContent = options.body;
    shadow.querySelector('.file').textContent = options.file || '';
    var go = shadow.querySelector('.go');
    go.textContent = options.action;
    // The full name on hover as well, for a name long enough to wrap to three
    // lines and for anyone reading it with a screen reader.
    go.title = options.file ? options.action + ': ' + options.file : options.action;

    document.documentElement.appendChild(host);
    current = { host: host, shadow: shadow };
    return current;
  }

  // showOpenFilePicker is the better of the two ways to ask, because what it
  // hands back is a handle rather than a snapshot — see chooseFile(). It needs
  // a secure context, which a file:// page is, and it does not exist in
  // Firefox or Safari, where the input is the only way.
  var CAN_HANDLE = typeof window.showOpenFilePicker === 'function';

  var PICKER_TYPES = [{
    description: 'HTML document',
    accept: { 'text/html': ['.html', '.htm', '.xhtml'] },
  }];

  /*
   * Both pickers are given the same id, which is what makes them open where
   * the last one did.
   *
   * The browser remembers a directory per id, across sessions, and without one
   * every picker opens in Downloads — which is almost never where the document
   * is. Sharing the id between opening and saving is deliberate: they are two
   * halves of working on one file, and a save that starts somewhere other than
   * where the file was opened is the thing that makes people save a second
   * copy of their document by accident.
   */
  var PICKER_ID = 'viberevise-doc';

  // Start the picker beside a file we already have a handle for, when there is
  // one. A file handle names its own directory, so this is "open where that
  // file lives" without ever having to know a path.
  function startingPoint(near) {
    return near || undefined;
  }

  /*
   * Ask the user to choose a file, and keep asking until they pick one that
   * `validate` accepts or they cancel.
   *
   * Resolves with { file, handle }. The handle is the point of this: a file
   * chosen through showOpenFilePicker can be WRITTEN BACK TO, so the one click
   * the user spends proving they meant to open this file also buys saving over
   * the top of it for the rest of the session. The old file input gives only a
   * read-only snapshot, which is why saving used to mean a download every time.
   * It is still the fallback, and handle is null there.
   *
   * Either picker is opened from inside the button's own click handler, which
   * is what keeps the browser's user-activation requirement satisfied.
   */
  function chooseFile(options) {
    return new Promise(function (resolve, reject) {
      var ui = build(options);
      var input = ui.shadow.querySelector('input[type=file]');
      var errorEl = ui.shadow.querySelector('.error');

      // Shared by both routes: validate, and only then take the card down.
      function offer(file, handle) {
        return Promise.resolve(options.validate ? options.validate(file) : null)
          .then(function (problem) {
            if (problem) { errorEl.textContent = problem; return; }
            dismiss();
            resolve({ file: file, handle: handle || null });
          })
          .catch(function (err) { errorEl.textContent = String(err && err.message || err); });
      }

      function viaInput() {
        input.value = '';        // so re-picking the same file still fires change
        input.click();
      }

      ui.shadow.querySelector('.go').addEventListener('click', function () {
        errorEl.textContent = '';
        if (!CAN_HANDLE) { viaInput(); return; }

        window.showOpenFilePicker({
          types: PICKER_TYPES,
          multiple: false,
          id: PICKER_ID,
          startIn: startingPoint(options.near),
        })
          .then(function (handles) {
            var handle = handles[0];
            return handle.getFile().then(function (file) { return offer(file, handle); });
          })
          .catch(function (err) {
            // AbortError is the user closing the picker, which is not an error
            // and must not look like one. Anything else means this browser
            // would not do it, so fall back rather than strand them.
            if (err && err.name === 'AbortError') return;
            console.log('[VibeRevise] the file picker would not give a handle:', err);
            viaInput();
          });
      });

      ui.shadow.querySelector('.cancel').addEventListener('click', function () {
        dismiss();
        reject(new Error('cancelled'));
      });

      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (file) offer(file, null);
      });
    });
  }

  /*
   * Can this handle actually be written to?
   *
   * Asking is the only way to find out: the API exists on a file:// page, but
   * whether Chrome will grant write permission to a local file chosen there is
   * its decision, not ours, and it may change between versions. queryPermission
   * first so an already-granted handle does not re-prompt.
   */
  function canWrite(handle) {
    if (!handle || typeof handle.createWritable !== 'function') return Promise.resolve(false);
    if (typeof handle.queryPermission !== 'function') return Promise.resolve(true);
    return handle.queryPermission({ mode: 'readwrite' })
      .then(function (statePermission) {
        if (statePermission === 'granted') return true;
        if (statePermission === 'denied') return false;
        return handle.requestPermission({ mode: 'readwrite' })
          .then(function (asked) { return asked === 'granted'; });
      })
      .catch(function () { return false; });
  }

  /*
   * Ask for somewhere to write, defaulting to the file being edited.
   *
   * Picking the same file is the point — that is what "save over the top"
   * means — so the name is pre-filled, the picker opens where the last one
   * did, and `near` starts it in that file's own directory when we have a
   * handle for it. The user should only have to confirm.
   *
   * Resolves with null if they cancel, which is an answer, not a failure.
   */
  function saveAs(suggestedName, near) {
    if (typeof window.showSaveFilePicker !== 'function') return Promise.resolve(null);
    return window.showSaveFilePicker({
      suggestedName: suggestedName,
      types: PICKER_TYPES,
      id: PICKER_ID,
      startIn: startingPoint(near),
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return null;
      console.log('[VibeRevise] the save picker would not give a handle:', err);
      return null;
    });
  }

  function writeThrough(handle, text) {
    return handle.createWritable().then(function (writable) {
      return writable.write(new Blob([text], { type: 'text/html;charset=utf-8' }))
        .then(function () { return writable.close(); });
    });
  }

  root.VibeRevisePrompt = {
    chooseFile: chooseFile,
    saveAs: saveAs,
    canWrite: canWrite,
    writeThrough: writeThrough,
    canHandle: CAN_HANDLE,
    dismiss: dismiss,
  };
})(typeof self !== 'undefined' ? self : globalThis);
