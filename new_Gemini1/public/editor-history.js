'use strict';

// Keep editable documents in history; Three.js objects and camera state stay live.
(function(root) {
  function create({capture, restore, selection = () => null, onChange = () => {}, limit = 100}) {
    let entries = [], index = -1, mergeKey = null, depth = 0, restoring = false;
    const snapshot = () => ({data: JSON.stringify(capture()), selected: selection()});
    const history = {
      get canUndo() { return !depth && index > 0; },
      get canRedo() { return !depth && index >= 0 && index < entries.length - 1; },
      reset() {
        entries = [snapshot()]; index = 0; mergeKey = null; depth = 0;
        onChange(history);
      },
      record(key = null) {
        if (restoring || depth) return;
        const next = snapshot();
        if (index < 0) { history.reset(); return; }
        if (next.data === entries[index].data) return;
        entries.splice(index + 1);
        if (key && key === mergeKey && index > 0) entries[index] = next;
        else { entries.push(next); index++; }
        if (entries.length > limit + 1) { entries.shift(); index--; }
        mergeKey = key;
        onChange(history);
      },
      select() {
        // A render can change selection before an edit has been recorded.
        if (!restoring && !depth && index >= 0 && JSON.stringify(capture()) === entries[index].data)
          entries[index].selected = selection();
      },
      breakMerge() { mergeKey = null; },
      begin() { mergeKey = null; depth++; onChange(history); },
      end() {
        if (!depth) return;
        depth--;
        if (!depth) history.record();
        onChange(history);
      },
      undo() { return move(-1); },
      redo() { return move(1); },
    };
    function move(direction) {
      if (restoring || (direction < 0 ? !history.canUndo : !history.canRedo)) return false;
      mergeKey = null;
      index += direction;
      restoring = true;
      try { restore(JSON.parse(entries[index].data), entries[index].selected); }
      finally { restoring = false; onChange(history); }
      return true;
    }
    return history;
  }

  function isInput(target) {
    return !!(target?.isContentEditable || target?.matches?.('input,select,textarea'));
  }
  function inputKey() { return isInput(document.activeElement) ? document.activeElement : null; }
  function updateButtons(history, undoId, redoId) {
    const undo = document.getElementById(undoId), redo = document.getElementById(redoId);
    if (undo) undo.disabled = !history.canUndo;
    if (redo) redo.disabled = !history.canRedo;
  }
  function shortcut(event, undo, redo) {
    if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) || isInput(event.target)) return false;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return false;
    event.preventDefault();
    if (key === 'y' || event.shiftKey) redo(); else undo();
    return true;
  }
  function clipboardShortcut(event, copy, paste, duplicate) {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || isInput(event.target)) return false;
    const action = {c: copy, v: paste, d: duplicate}[event.key.toLowerCase()];
    if (!action) return false;
    event.preventDefault(); action(); return true;
  }
  function bindInputs(container, history) {
    container?.addEventListener('focusout', () => history.breakMerge());
    container?.addEventListener('change', () => history.breakMerge());
  }
  const api = {create, isInput, inputKey, updateButtons, shortcut, clipboardShortcut, bindInputs};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EditorHistory = api;
})(globalThis);
