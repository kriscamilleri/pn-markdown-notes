// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { YTextareaBinding } from "../../spikes/collab-05/yTextareaBinding.js";

let OverType;
const mounted = [];

beforeEach(async () => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.CSS = { supports: () => false };
  globalThis.matchMedia = vi.fn(() => ({ matches: false, addListener() {}, removeListener() {} }));
  ({ default: OverType } = await import("overtype"));
});

afterEach(() => {
  for (const item of mounted.splice(0)) {
    item.binding?.destroy();
    item.editor?.destroy?.();
    item.container?.remove();
  }
});

function createEditor(ytext, origin) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [editor] = OverType.init(container, {
    value: ytext.toString(),
    toolbar: false,
    showStats: false,
    autoResize: false,
  });
  const textarea = container.querySelector("textarea");
  const binding = new YTextareaBinding({
    textarea,
    ytext,
    origin,
    applyValue: (value) => editor.setValue(value),
  });
  const result = { container, editor, textarea, binding };
  mounted.push(result);
  return result;
}

function nativeInput(textarea, value, selection = value.length, inputType = "insertText", data = null) {
  textarea.value = value;
  textarea.setSelectionRange(selection, selection);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
}

describe("COLLAB-05 §6.1a OverType/Y.Text binding spike", () => {
  it("handles insert, replace, paste, composition, and remote selection transformation without whole-body writes", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "hello world");
    const originA = { participant: "A" };
    const originB = { participant: "B" };
    const editorA = createEditor(ytext, originA);
    const editorB = createEditor(ytext, originB);
    const localDeltas = [];
    ytext.observe((event, transaction) => {
      if (transaction.origin === originA || transaction.origin === originB) {
        localDeltas.push({ origin: transaction.origin, delta: event.delta });
      }
    });

    nativeInput(editorA.textarea, "hello brave world", 11);
    expect(ytext.toString()).toBe("hello brave world");
    expect(editorB.textarea.value).toBe("hello brave world");

    nativeInput(editorA.textarea, "hello bold world", 10, "insertReplacementText", "bold");
    expect(editorB.textarea.value).toBe("hello bold world");

    const pasted = "\n" + "large pasted block ".repeat(256);
    const beforePasteTransactions = localDeltas.length;
    nativeInput(
      editorB.textarea,
      `${editorB.textarea.value}${pasted}`,
      editorB.textarea.value.length + pasted.length,
      "insertFromPaste",
      pasted,
    );
    expect(ytext.toString()).toBe(`hello bold world${pasted}`);
    expect(localDeltas).toHaveLength(beforePasteTransactions + 1);
    expect(localDeltas.at(-1).delta.filter((operation) => operation.insert)).toEqual([
      { insert: pasted },
    ]);

    const beforeComposition = ytext.toString();
    editorA.textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    editorA.textarea.value = `${beforeComposition}世界`;
    editorA.textarea.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertCompositionText",
      data: "世界",
      isComposing: true,
    }));
    expect(ytext.toString()).toBe(beforeComposition);
    editorA.textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "世界" }));
    expect(ytext.toString()).toBe(`${beforeComposition}世界`);
    expect(editorB.textarea.value).toBe(`${beforeComposition}世界`);

    editorB.textarea.setSelectionRange(6, 10);
    nativeInput(editorA.textarea, `start ${editorA.textarea.value}`, 6);
    expect(editorB.textarea.selectionStart).toBe(12);
    expect(editorB.textarea.selectionEnd).toBe(16);

    // Every local transaction is the one contiguous edit found by the
    // prefix/suffix scan; none deletes and reinserts the whole body.
    expect(localDeltas.length).toBeGreaterThan(4);
    for (const { delta } of localDeltas) {
      const deleted = delta.reduce((total, operation) => total + (operation.delete || 0), 0);
      const inserted = delta.reduce(
        (total, operation) => total + (typeof operation.insert === "string" ? operation.insert.length : 0),
        0,
      );
      expect(deleted > 100 && inserted > 100).toBe(false);
    }
  });

  it("uses origin-scoped Y.UndoManager so one participant never undoes the other's edit", () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "root");
    const editorA = createEditor(ytext, { participant: "A" });
    const editorB = createEditor(ytext, { participant: "B" });

    nativeInput(editorA.textarea, "root-A");
    nativeInput(editorB.textarea, "root-A-B");
    editorA.binding.undo();

    expect(ytext.toString()).toBe("root-B");
    expect(editorA.textarea.value).toBe("root-B");
    expect(editorB.textarea.value).toBe("root-B");
    editorB.binding.undo();
    expect(ytext.toString()).toBe("root");
  });
});
