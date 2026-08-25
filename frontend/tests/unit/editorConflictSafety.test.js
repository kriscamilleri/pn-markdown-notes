import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import {
  classifyEditorConflict,
  hasDocumentContentChanged,
} from "../../src/utils/documentPersistence.js";
import { useDraftStore } from "../../src/store/draftStore.js";

const editorSource = readFileSync(
  new URL("../../src/components/Editor.vue", import.meta.url),
  "utf8",
);

describe("classifyEditorConflict (COLLAB-01 §4.2)", () => {
  it("adopts a remote change when the editor is clean", () => {
    expect(
      classifyEditorConflict({ mine: "# base", base: "# base", theirs: "# remote" }),
    ).toBe("adopt");
  });

  it("ignores a remote change that equals the base (nothing changed remotely)", () => {
    expect(
      classifyEditorConflict({ mine: "# edited", base: "# base", theirs: "# base" }),
    ).toBe("ignore");
  });

  it("reports a conflict when both sides diverged from the base", () => {
    expect(
      classifyEditorConflict({ mine: "# edited", base: "# base", theirs: "# remote" }),
    ).toBe("conflict");
  });

  it("ignores a local save (mine === theirs === new base)", () => {
    expect(
      classifyEditorConflict({ mine: "# saved", base: "# saved", theirs: "# saved" }),
    ).toBe("ignore");
  });

  it("treats legacy null content as an empty string", () => {
    expect(
      classifyEditorConflict({ mine: null, base: null, theirs: "" }),
    ).toBe("ignore");
    expect(
      classifyEditorConflict({ mine: null, base: null, theirs: "changed" }),
    ).toBe("adopt");
  });

  it("treats undefined content as an empty string", () => {
    expect(
      classifyEditorConflict({ mine: undefined, base: undefined, theirs: "changed" }),
    ).toBe("adopt");
  });
});

describe("draftStore base tracking (COLLAB-01 §4.1)", () => {
  it("stores and retrieves a per-document base", () => {
    setActivePinia(createPinia());
    const store = useDraftStore();

    store.setBase("note-1", "# base");
    expect(store.getBase("note-1")).toBe("# base");
    expect(store.getBase("missing")).toBeUndefined();
  });

  it("clears a single base and all bases", () => {
    setActivePinia(createPinia());
    const store = useDraftStore();

    store.setBase("note-1", "# one");
    store.setBase("note-2", "# two");
    store.clearBase("note-1");
    expect(store.getBase("note-1")).toBeUndefined();
    expect(store.getBase("note-2")).toBe("# two");

    store.clearAll();
    expect(store.getBase("note-2")).toBeUndefined();
  });

  it("keeps bases independent from drafts", () => {
    setActivePinia(createPinia());
    const store = useDraftStore();

    store.setDraft("note-1", "# draft");
    store.setBase("note-1", "# base");
    expect(store.getDraft("note-1")).toBe("# draft");
    expect(store.getBase("note-1")).toBe("# base");

    store.clearDraft("note-1");
    expect(store.getDraft("note-1")).toBeUndefined();
    expect(store.getBase("note-1")).toBe("# base");
  });
});

describe("Editor.vue conflict wiring (COLLAB-01)", () => {
  it("renders the conflict banner with the required test ids", () => {
    expect(editorSource).toContain('data-testid="editor-conflict-banner"');
    expect(editorSource).toContain('data-testid="editor-conflict-keep-mine"');
    expect(editorSource).toContain('data-testid="editor-conflict-use-theirs"');
    expect(editorSource).toContain('data-testid="editor-conflict-compare"');
  });

  it("renders a save-status surface", () => {
    expect(editorSource).toContain('data-testid="editor-save-status"');
  });

  it("suppresses the debounced DB write while a conflict is active", () => {
    expect(editorSource).toMatch(
      /if\s*\(conflict\.value\s*\|\|\s*persistedConflict\.value\)\s*\{\s*debouncedSyncToDB\.cancel\(\);\s*return;\s*\}/s,
    );
  });

  it("watches both document id and content, not id alone", () => {
    expect(editorSource).toMatch(
      /\(\)\s*=>\s*\[file\.value\?\.id,\s*file\.value\?\.content\]/,
    );
  });

  it("preserves the cursor on programmatic adoption", () => {
    expect(editorSource).toMatch(/setSelectionRange\(start,\s*end\)/);
    expect(editorSource).toMatch(/Math\.min\(selStart,\s*length\)/);
  });

  it("uses the shared conflict classifier", () => {
    expect(editorSource).toMatch(
      /classifyEditorConflict\(\{\s*mine,\s*base,\s*theirs\s*\}\)/,
    );
  });

  it("wires persisted conflict resolution through the shared banner", () => {
    expect(editorSource).toContain('data-testid="editor-conflict-resolve"');
    expect(editorSource).toContain('<ConflictResolutionModal');
    expect(editorSource).toContain('@apply="applyPersistedResolution"');
    expect(editorSource).toContain('conflictStore.resolveConflict(activeConflict, content)');
  });

  it("adopts a persisted resolution only after the transaction succeeds", () => {
    const applyStart = editorSource.indexOf('async function applyPersistedResolution');
    const applyEnd = editorSource.indexOf('/* ───── paste-images', applyStart);
    const applySource = editorSource.slice(applyStart, applyEnd);
    expect(applySource.indexOf('await conflictStore.resolveConflict')).toBeLessThan(
      applySource.indexOf('setEditorValue(content'),
    );
    expect(applySource).toContain('draftStore.setBase(id, content)');
  });
});

describe("hasDocumentContentChanged remains a comparison primitive", () => {
  it("still normalizes null to empty string", () => {
    expect(hasDocumentContentChanged(null, "")).toBe(false);
    expect(hasDocumentContentChanged("# a", "# a")).toBe(false);
    expect(hasDocumentContentChanged("# a", "# b")).toBe(true);
  });
});
