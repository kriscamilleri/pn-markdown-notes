import * as Y from "yjs";

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

export function transformOffset(offset, delta) {
  const target = Math.max(0, Number(offset) || 0);
  let oldOffset = 0;
  let newOffset = 0;
  for (const operation of delta || []) {
    if (operation.insert !== undefined) {
      newOffset += typeof operation.insert === "string" ? operation.insert.length : 1;
    } else if (operation.delete !== undefined) {
      const end = oldOffset + operation.delete;
      if (target <= end) return newOffset;
      oldOffset = end;
    } else if (operation.retain !== undefined) {
      const end = oldOffset + operation.retain;
      if (target <= end) return newOffset + target - oldOffset;
      oldOffset = end;
      newOffset += operation.retain;
    }
  }
  return newOffset + target - oldOffset;
}

export class YTextareaBinding {
  constructor({ textarea, ytext, origin, applyValue }) {
    if (!(textarea instanceof HTMLTextAreaElement)) throw new TypeError("A textarea is required");
    if (!(ytext instanceof Y.Text)) throw new TypeError("A Y.Text is required");
    this.textarea = textarea;
    this.ytext = ytext;
    this.origin = origin;
    this.applyValue = applyValue;
    this.previousValue = ytext.toString();
    this.composing = false;
    this.applyingRemote = false;
    this.undoManager = new Y.UndoManager(ytext, {
      trackedOrigins: new Set([origin]),
      captureTimeout: 500,
    });
    this.onInput = () => {
      if (!this.composing && !this.applyingRemote) this.applyLocalInput();
    };
    this.onCompositionStart = () => { this.composing = true; };
    this.onCompositionEnd = () => {
      this.composing = false;
      this.applyLocalInput();
    };
    this.onYText = (event, transaction) => {
      const value = ytext.toString();
      if (transaction.origin === origin) {
        this.previousValue = value;
        return;
      }
      const start = transformOffset(textarea.selectionStart, event.delta);
      const end = transformOffset(textarea.selectionEnd, event.delta);
      this.applyingRemote = true;
      try {
        applyValue?.(value);
        if (textarea.value !== value) textarea.value = value;
        textarea.setSelectionRange(start, end, textarea.selectionDirection || "none");
        this.previousValue = value;
      } finally {
        this.applyingRemote = false;
      }
    };
    textarea.addEventListener("input", this.onInput);
    textarea.addEventListener("compositionstart", this.onCompositionStart);
    textarea.addEventListener("compositionend", this.onCompositionEnd);
    ytext.observe(this.onYText);
    if (textarea.value !== this.previousValue) applyValue?.(this.previousValue);
  }

  applyLocalInput() {
    const edit = contiguousTextEdit(this.previousValue, this.textarea.value);
    if (!edit.deleteCount && !edit.insertText) return;
    this.ytext.doc.transact(() => {
      if (edit.deleteCount) this.ytext.delete(edit.index, edit.deleteCount);
      if (edit.insertText) this.ytext.insert(edit.index, edit.insertText);
    }, this.origin);
    this.previousValue = this.ytext.toString();
  }

  undo() { this.undoManager.undo(); }
  redo() { this.undoManager.redo(); }

  destroy() {
    this.textarea.removeEventListener("input", this.onInput);
    this.textarea.removeEventListener("compositionstart", this.onCompositionStart);
    this.textarea.removeEventListener("compositionend", this.onCompositionEnd);
    this.ytext.unobserve(this.onYText);
    this.undoManager.destroy();
  }
}
