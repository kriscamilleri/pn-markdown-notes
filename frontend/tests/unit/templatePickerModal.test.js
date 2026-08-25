import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Covers docs/specs/.../document-templates-extensions.md §11.3 —
// the note-creation flow driven by title_pattern and default_folder_id.
const source = readFileSync(
  new URL("../../src/components/TemplatePickerModal.vue", import.meta.url),
  "utf8",
);

/**
 * Extract the body of a named function from the `<script setup>` block.
 */
function functionBody(fnName) {
  const re = new RegExp(
    `(?:async\\s+)?function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{`,
  );
  const match = re.exec(source);
  if (!match) return "";

  let pos = match.index + match[0].length;
  let depth = 1;
  while (depth > 0 && pos < source.length) {
    const ch = source[pos];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    pos++;
  }
  return source.slice(match.index, pos);
}

describe("TemplatePickerModal – title pattern resolution", () => {
  it("uses Document in product-facing creation copy", () => {
    expect(source).toContain("New Document from Template");
    expect(source).toContain("Create Document");
    expect(source).toContain("Save a document as a template");
  });

  it("falls back to the template name when title_pattern is empty", () => {
    const body = functionBody("createNoteFromTemplate");
    expect(body).toMatch(/let\s+noteTitle\s*=\s*tpl\.name/);
    expect(body).toMatch(/if\s*\(titlePattern\)/);
  });

  it("resolves the title pattern through resolveTemplateVariables", () => {
    const body = functionBody("createNoteFromTemplate");
    expect(body).toMatch(
      /resolveTemplateVariables\(\s*titlePattern\s*,\s*inputValues\s*\)/,
    );
  });

  it("falls back to the template name when the pattern resolves to empty", () => {
    const body = functionBody("createNoteFromTemplate");
    expect(body).toMatch(/if\s*\(resolved\)\s*noteTitle\s*=\s*resolved/);
  });

  it("passes the database scope and resolved title to createFile, then writes content transactionally", () => {
    const body = functionBody("createNoteFromTemplate");
    expect(body).toMatch(/createFile\(\s*props\.databaseKey\s*,\s*noteTitle\s*,\s*folderId\s*\)/);
    expect(body).toMatch(
      /resolveTemplateVariables\(\s*tpl\.content\s*,\s*inputValues\s*\)/,
    );
    expect(body).toMatch(/repository\(props\.databaseKey\)\.transaction/);
    expect(body).toMatch(/UPDATE notes SET content = \?, updated_at = \? WHERE id = \?/);
  });

  it("scans both content and title pattern for input labels", () => {
    const body = functionBody("handleUseTemplate");
    expect(body).toMatch(
      /extractInputLabels\(\s*tpl\.content\s*,\s*tpl\.titlePattern\s*\|\|\s*''\s*\)/,
    );
  });

  it("shows the variable form when either source contributes input labels", () => {
    const body = functionBody("handleUseTemplate");
    expect(body).toMatch(/if\s*\(inputLabels\.length\s*===\s*0\)/);
    expect(body).toMatch(/showVariables\.value\s*=\s*true/);
  });

  it("deduplicates title and content labels via the shared variableLabels computed", () => {
    expect(source).toMatch(
      /extractInputLabels\(\s*activeTemplate\.value\.content\s*,\s*activeTemplate\.value\.titlePattern\s*\|\|\s*''\s*\)/,
    );
  });
});

describe("TemplatePickerModal – default folder resolution", () => {
  it("prefers the template default folder over the current folder", () => {
    const body = functionBody("resolveTargetFolder");
    expect(body).toMatch(/if\s*\(tpl\.defaultFolderId\)/);
    expect(body).toMatch(/return\s+tpl\.defaultFolderId/);
  });

  it("falls back to currentFolderId when no default folder is set", () => {
    const body = functionBody("resolveTargetFolder");
    expect(body).toMatch(/return\s+props\.currentFolderId/);
  });

  it("falls back to currentFolderId when the default folder no longer exists", () => {
    const body = functionBody("resolveTargetFolder");
    expect(body).toMatch(/await\s+folderExists\(\s*tpl\.defaultFolderId\s*\)/);
    expect(body).toMatch(/if\s*\(exists\)\s*return\s+tpl\.defaultFolderId/);
  });

  it("checks folder existence with a parameterized COUNT query", () => {
    const body = functionBody("folderExists");
    expect(body).toMatch(
      /SELECT\s+COUNT\(\*\)\s+AS\s+count\s+FROM\s+folders\s+WHERE\s+id\s*=\s*\?/,
    );
    expect(body).toMatch(/\[\s*targetId\s*,?\s*\]/);
  });

  it("awaits folder resolution on both creation paths", () => {
    expect(functionBody("handleUseTemplate")).toMatch(
      /await\s+resolveTargetFolder\(tpl\)/,
    );
    expect(functionBody("handleCreateWithVariables")).toMatch(
      /await\s+resolveTargetFolder\(tpl\)/,
    );
  });

  it("does not walk the structure tree synchronously for folder existence", () => {
    // getChildren is async; a synchronous walk iterates a Promise and throws.
    expect(functionBody("folderExists")).not.toMatch(/getChildren/);
  });
});
