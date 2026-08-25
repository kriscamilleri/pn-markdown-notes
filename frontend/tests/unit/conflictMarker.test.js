import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const treeItemSource = readFileSync(
  new URL("../../src/components/TreeItem.vue", import.meta.url),
  "utf8",
);
const recentRowSource = readFileSync(
  new URL("../../src/components/RecentDocumentRow.vue", import.meta.url),
  "utf8",
);

describe("unresolved-conflict markers (COLLAB-02 §6.2)", () => {
  it("renders a marker on tree document rows", () => {
    expect(treeItemSource).toContain('tree-item-conflict-');
    expect(treeItemSource).toContain("hasConflict");
    expect(treeItemSource).toContain("conflictStore.hasConflict(props.item.id, props.item.dbKey)");
  });

  it("renders a marker on recent document rows", () => {
    expect(recentRowSource).toContain('document-row-conflict-');
    expect(recentRowSource).toContain("hasConflict");
    expect(recentRowSource).toContain("conflictStore.hasConflict(props.document.id, props.document.dbKey)");
  });
});
