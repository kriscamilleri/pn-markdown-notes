import * as Y from "yjs";

/** One contiguous edit, expressed in UTF-16 offsets as Y.Text expects. */
export function contiguousTextEdit(previousValue, nextValue) {
  const before = String(previousValue ?? "");
  const after = String(nextValue ?? "");
  let prefix = 0;
  const sharedLength = Math.min(before.length, after.length);
  while (prefix < sharedLength && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;

  return {
    index: prefix,
    deleteCount: before.length - prefix - suffix,
    insertText: after.slice(prefix, after.length - suffix),
  };
}

/** Transform a textarea offset through one Y.Text delta. */
export function transformOffset(offset, delta) {
  const target = Math.max(0, Number(offset) || 0);
  let oldOffset = 0;
  let newOffset = 0;
  for (const operation of delta || []) {
    if (operation.insert !== undefined) {
      newOffset += typeof operation.insert === "string" ? operation.insert.length : 1;
      continue;
    }
    if (operation.delete !== undefined) {
      const end = oldOffset + operation.delete;
      if (target <= end) return newOffset;
      oldOffset = end;
      continue;
    }
    if (operation.retain !== undefined) {
      const end = oldOffset + operation.retain;
      if (target <= end) return newOffset + (target - oldOffset);
      oldOffset = end;
      newOffset += operation.retain;
    }
  }
  return newOffset + (target - oldOffset);
}

/**
 * Disposable COLLAB-05 spike binding. It deliberately lives outside `src/`:
 * passing the spike is evidence for a production binding, not that binding.
 */
export class YTextareaBinding {
  constructor({ textarea, ytext, origin = {}, applyValue = null }) {
    if (!(textarea instanceof HTMLTextAreaElement)) throw new TypeError("A textarea is required");
    if (!(ytext instanceof Y.Text)) throw new TypeError("A Y.Text is required");
    this.textarea = textarea;
    this.ytext = ytext;
    this.origin = origin;
    this.applyValue = applyValue;
    this.composing = false;
    this.applyingRemote = false;
    this.previousValue = ytext.toString();
    this.undoManager = new Y.UndoManager(ytext, {
      trackedOrigins: new Set([origin]),
      captureTimeout: 0,
    });

    this.onInput = () => {
      if (!this.composing && !this.applyingRemote) this.applyLocalInput();
    };
    this.onCompositionStart = () => {
      this.composing = true;
    };
    this.onCompositionEnd = () => {
      this.composing = false;
      this.applyLocalInput();
    };
    this.onYText = (event, transaction) => {
      const value = this.ytext.toString();
      if (transaction.origin === this.origin) {
        this.previousValue = value;
        return;
      }
      const selectionStart = this.textarea.selectionStart;
      const selectionEnd = this.textarea.selectionEnd;
      const nextStart = transformOffset(selectionStart, event.delta);
      const nextEnd = transformOffset(selectionEnd, event.delta);
      this.applyingRemote = true;
      try {
        if (this.applyValue) this.applyValue(value);
        if (this.textarea.value !== value) this.textarea.value = value;
        this.textarea.setSelectionRange(nextStart, nextEnd, this.textarea.selectionDirection || "none");
        this.previousValue = value;
      } finally {
        this.applyingRemote = false;
      }
    };

    textarea.addEventListener("input", this.onInput);
    textarea.addEventListener("compositionstart", this.onCompositionStart);
    textarea.addEventListener("compositionend", this.onCompositionEnd);
    ytext.observe(this.onYText);
    if (textarea.value !== this.previousValue) {
      if (this.applyValue) this.applyValue(this.previousValue);
      if (textarea.value !== this.previousValue) textarea.value = this.previousValue;
    }
  }

  applyLocalInput() {
    const nextValue = this.textarea.value;
    const edit = contiguousTextEdit(this.previousValue, nextValue);
    if (edit.deleteCount === 0 && !edit.insertText) return;
    this.ytext.doc.transact(() => {
      if (edit.deleteCount > 0) this.ytext.delete(edit.index, edit.deleteCount);
      if (edit.insertText) this.ytext.insert(edit.index, edit.insertText);
    }, this.origin);
    this.previousValue = this.ytext.toString();
  }

  undo() {
    this.undoManager.undo();
  }

  redo() {
    this.undoManager.redo();
  }

  destroy() {
    this.textarea.removeEventListener("input", this.onInput);
    this.textarea.removeEventListener("compositionstart", this.onCompositionStart);
    this.textarea.removeEventListener("compositionend", this.onCompositionEnd);
    this.ytext.unobserve(this.onYText);
    this.undoManager.destroy();
  }
}
