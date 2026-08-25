// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YTextareaBinding, contiguousTextEdit } from "@/utils/yTextareaBinding";

const bindings = [];
afterEach(() => {
  while (bindings.length) bindings.pop().destroy();
  document.body.replaceChildren();
});

function bind(ytext, origin) {
  const textarea = document.createElement("textarea");
  textarea.value = ytext.toString();
  document.body.appendChild(textarea);
  const binding = new YTextareaBinding({ textarea, ytext, origin, applyValue: (value) => { textarea.value = value; } });
  bindings.push(binding);
  return { textarea, binding };
}

function input(textarea, value) {
  textarea.value = value;
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
}

describe("production Y.Text textarea binding", () => {
  it("expresses insert, delete, replace, and paste as one contiguous edit", () => {
    const edit = contiguousTextEdit("alpha beta", "alpha brave beta");
    expect(
      `alpha beta`.slice(0, edit.index)
      + edit.insertText
      + `alpha beta`.slice(edit.index + edit.deleteCount),
    ).toBe("alpha brave beta");
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "alpha beta");
    const a = bind(text, { id: "a" });
    const b = bind(text, { id: "b" });
    input(a.textarea, "alpha brave beta");
    expect(b.textarea.value).toBe("alpha brave beta");
    input(a.textarea, "alpha bold beta\na pasted block");
    expect(text.toString()).toBe("alpha bold beta\na pasted block");
  });

  it("preserves a selection under remote edits and defers IME composition", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "hello world");
    const a = bind(text, { id: "a" });
    const b = bind(text, { id: "b" });
    b.textarea.setSelectionRange(6, 11);
    input(a.textarea, "start hello world");
    expect([b.textarea.selectionStart, b.textarea.selectionEnd]).toEqual([12, 17]);
    a.textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    a.textarea.value += "世界";
    a.textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    expect(text.toString()).not.toContain("世界");
    a.textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(text.toString()).toContain("世界");
  });

  it("undoes only transactions from the local origin", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "root");
    const a = bind(text, { id: "a" });
    const b = bind(text, { id: "b" });
    input(a.textarea, "root-A");
    input(b.textarea, "root-A-B");
    a.binding.undo();
    expect(text.toString()).toBe("root-B");
  });
});
