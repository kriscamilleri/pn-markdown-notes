import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  LOCAL_ONLY_TABLES,
  isLocalOnlyTable,
} from "../../src/store/importExportStore.js";

const source = readFileSync(
  new URL("../../src/store/importExportStore.js", import.meta.url),
  "utf8",
);

describe("import/export local-only table exclusion (COLLAB-02 §4)", () => {
  it("lists note_sync_base and note_conflicts as local-only", () => {
    expect(LOCAL_ONLY_TABLES).toContain("note_sync_base");
    expect(LOCAL_ONLY_TABLES).toContain("note_conflicts");
    expect(isLocalOnlyTable("note_sync_base")).toBe(true);
    expect(isLocalOnlyTable("note_conflicts")).toBe(true);
    expect(isLocalOnlyTable("notes")).toBe(false);
  });

  it("queryAllData selects only user-facing tables", () => {
    const queryBlock = source.match(/async function queryAllData\(\)[\s\S]*?\n {4}\}/);
    expect(queryBlock).toBeTruthy();
    expect(queryBlock[0]).toContain("FROM folders");
    expect(queryBlock[0]).toContain("FROM notes");
    expect(queryBlock[0]).not.toContain("FROM note_sync_base");
    expect(queryBlock[0]).not.toContain("FROM note_conflicts");
  });

  it("does not reference local-only tables in any export query", () => {
    // The three export functions (JSON, ZIP, StackEdit) must never read the
    // client-local recovery tables.
    const exportRegion = source.slice(
      source.indexOf("async function exportDataAsJsonString"),
      source.indexOf("async function importData"),
    );
    expect(exportRegion).not.toContain("note_sync_base");
    expect(exportRegion).not.toContain("note_conflicts");
  });
});
