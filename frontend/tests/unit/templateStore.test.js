import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../src/store/templateStore.js", import.meta.url),
  "utf8",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the body of a named `async function` or `function` from the source.
 * Returns everything between the opening `{` and the matching closing `}`.
 */
function functionBody(fnName) {
  const re = new RegExp(
    `(?:async\\s+)?function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{`,
    "g",
  );
  const match = re.exec(source);
  if (!match) return "";

  let pos = match.index + match[0].length;
  let depth = 1;
  let inString = false;
  let stringChar = "";
  let inComment = false;
  let inLineComment = false;

  while (depth > 0 && pos < source.length) {
    const ch = source[pos];
    const prev = pos > 0 ? source[pos - 1] : "";

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
    } else if (inComment) {
      if (ch === "/" && prev === "*") inComment = false;
    } else if (inString) {
      if (ch === stringChar && prev !== "\\") inString = false;
    } else {
      if ((ch === '"' || ch === "'" || ch === "`") && prev !== "\\") {
        inString = true;
        stringChar = ch;
      } else if (ch === "/" && prev === "/") {
        inLineComment = true;
      } else if (ch === "*" && prev === "/") {
        inComment = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
      }
    }
    pos++;
  }

  return source.slice(match.index, pos);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("templateStore – export and structure", () => {
  it("exports useTemplateStore via defineStore", () => {
    expect(source).toMatch(
      /export\s+const\s+useTemplateStore\s*=\s*defineStore/,
    );
  });

  it('registers the store with the name "templateStore"', () => {
    expect(source).toMatch(/defineStore\s*\(\s*['"]templateStore['"]/);
  });

  it("declares reactive state: templates (ref), isLoading (ref), error (ref)", () => {
    expect(source).toMatch(/const\s+templates\s*=\s*ref\(/);
    expect(source).toMatch(/const\s+isLoading\s*=\s*ref\(/);
    expect(source).toMatch(/const\s+error\s*=\s*ref\(/);
  });

  it("initialises templates as an empty array", () => {
    expect(source).toMatch(/templates\s*=\s*ref\(\s*\[\s*\]\s*\)/);
  });

  it("initialises isLoading as false and error as an empty string", () => {
    expect(source).toMatch(/isLoading\s*=\s*ref\(\s*false\s*\)/);
    expect(source).toMatch(/error\s*=\s*ref\(\s*['"]["']\s*\)/);
  });

  it("returns all expected keys from the store factory", () => {
    const returnBlock = source.slice(source.lastIndexOf("return {"));

    expect(returnBlock).toMatch(/\btemplates\b/);
    expect(returnBlock).toMatch(/\bisLoading\b/);
    expect(returnBlock).toMatch(/\berror\b/);
    expect(returnBlock).toMatch(/\bloadTemplates\b/);
    expect(returnBlock).toMatch(/\bcreateTemplate\b/);
    expect(returnBlock).toMatch(/\bupdateTemplate\b/);
    expect(returnBlock).toMatch(/\bduplicateTemplate\b/);
    expect(returnBlock).toMatch(/\bdeleteTemplate\b/);
  });
});

describe("templateStore – method signatures", () => {
  it("declares loadTemplates as an async function", () => {
    expect(source).toMatch(/async\s+function\s+loadTemplates\s*\(/);
  });

  it("declares createTemplate as an async function with (name, content, titlePattern, defaultFolderId) params", () => {
    expect(source).toMatch(
      /async\s+function\s+createTemplate\s*\([^)]*name[^)]*content[^)]*titlePattern[^)]*defaultFolderId[^)]*\)/,
    );
  });

  it("declares updateTemplate as an async function with (id, name, content, titlePattern, defaultFolderId) params", () => {
    expect(source).toMatch(
      /async\s+function\s+updateTemplate\s*\([^)]*id[^)]*name[^)]*content[^)]*titlePattern[^)]*defaultFolderId[^)]*\)/,
    );
  });

  it("declares duplicateTemplate with an explicit database scope", () => {
    expect(source).toMatch(/async\s+function\s+duplicateTemplate\s*\(dbKey,\s*id\)/);
  });

  it("declares deleteTemplate with an explicit database scope", () => {
    expect(source).toMatch(/async\s+function\s+deleteTemplate\s*\(dbKey,\s*id\)/);
  });
});

describe("templateStore – SQL patterns", () => {
  it("loadTemplates SELECTs all template columns including title_pattern and default_folder_id", () => {
    const body = functionBody("loadTemplates");
    expect(body).toMatch(/title_pattern/);
    expect(body).toMatch(/default_folder_id/);
  });

  it("loadTemplates maps title_pattern and default_folder_id to camelCase", () => {
    const body = functionBody("loadTemplates");
    expect(body).toMatch(/titlePattern:\s*r\.title_pattern/);
    expect(body).toMatch(/defaultFolderId:\s*r\.default_folder_id/);
  });

  it("createTemplate INSERTs with title_pattern and default_folder_id columns", () => {
    const body = functionBody("createTemplate");
    expect(body).toMatch(/title_pattern/);
    expect(body).toMatch(/default_folder_id/);
  });

  it("createTemplate generates a UUID and ISO timestamp for the new row", () => {
    const body = functionBody("createTemplate");
    expect(body).toMatch(/uuidv4\(\)/);
    expect(body).toMatch(/new\s+Date\(\)\.toISOString\(\)/);
  });

  it("createTemplate reloads templates and shows a success toast", () => {
    const body = functionBody("createTemplate");
    expect(body).toMatch(/await\s+loadTemplates\(dbKey\)/);
    expect(body).toMatch(/uiStore\.addToast\(.*Template created/);
  });

  it("updateTemplate UPDATEs title_pattern and default_folder_id columns", () => {
    const body = functionBody("updateTemplate");
    expect(body).toMatch(/title_pattern/);
    expect(body).toMatch(/default_folder_id/);
  });

  it("duplicateTemplate SELECTs title_pattern and default_folder_id from source", () => {
    const body = functionBody("duplicateTemplate");
    expect(body).toMatch(/title_pattern/);
    expect(body).toMatch(/default_folder_id/);
  });

  it("duplicateTemplate copies title_pattern and default_folder_id from source", () => {
    const body = functionBody("duplicateTemplate");
    expect(body).toMatch(/orig\.title_pattern/);
    expect(body).toMatch(/orig\.default_folder_id/);
  });

  it('duplicateTemplate appends " - Copy" to the original name', () => {
    const body = functionBody("duplicateTemplate");
    expect(body).toMatch(/\$\{orig\.name\}\s*-\s*Copy/);
  });

  it("duplicateTemplate throws when the source template is not found", () => {
    const body = functionBody("duplicateTemplate");
    expect(body).toMatch(/throw\s+new\s+Error\(.*Template not found/);
  });

  it("deleteTemplate issues DELETE FROM templates WHERE id", () => {
    const body = functionBody("deleteTemplate");
    expect(body).toMatch(/DELETE\s+FROM\s+templates\s+WHERE\s+id\s*=\s*\?/);
  });
});

describe("templateStore – error handling", () => {
  it("loadTemplates sets error.value to err.message in the catch block", () => {
    const body = functionBody("loadTemplates");
    expect(body).toMatch(/error\.value\s*=\s*err\.message/);
  });

  it("loadTemplates clears isLoading in the finally block", () => {
    const body = functionBody("loadTemplates");
    expect(body).toMatch(/finally\s*\{[^}]*isLoading\.value\s*=\s*false/);
  });

  it("createTemplate catches errors and shows an error toast before re-throwing", () => {
    const body = functionBody("createTemplate");
    expect(body).toMatch(/uiStore\.addToast\(.*Failed to create template/);
    expect(body).toMatch(/throw\s+err/);
  });

  it("updateTemplate catches errors and shows an error toast before re-throwing", () => {
    const body = functionBody("updateTemplate");
    expect(body).toMatch(/uiStore\.addToast\(.*Failed to update template/);
    expect(body).toMatch(/throw\s+err/);
  });

  it("duplicateTemplate catches errors and shows an error toast before re-throwing", () => {
    const body = functionBody("duplicateTemplate");
    expect(body).toMatch(/uiStore\.addToast\(.*Failed to duplicate template/);
    expect(body).toMatch(/throw\s+err/);
  });

  it("deleteTemplate catches errors and shows an error toast before re-throwing", () => {
    const body = functionBody("deleteTemplate");
    expect(body).toMatch(/uiStore\.addToast\(.*Failed to delete template/);
    expect(body).toMatch(/throw\s+err/);
  });
});

describe("templateStore – scoped repository usage", () => {
  it("references syncStore from useSyncStore for all DB operations", () => {
    expect(source).toMatch(/const\s+syncStore\s*=\s*useSyncStore\(\)/);
  });

  it("requires a scoped repository for loadTemplates", () => {
    const body = functionBody("loadTemplates");
    expect(body).toMatch(/syncStore\.repository\(dbKey\)\.execute\(/);
  });

  it("uses a scoped transaction for createTemplate", () => {
    const body = functionBody("createTemplate");
    expect(body).toMatch(/syncStore\.repository\(dbKey\)\.transaction\(/);
  });

  it("uses a scoped transaction for updateTemplate", () => {
    const body = functionBody("updateTemplate");
    expect(body).toMatch(/syncStore\.repository\(dbKey\)\.transaction\(/);
  });

  it("uses the same scoped repository for duplicateTemplate read and write", () => {
    const body = functionBody("duplicateTemplate");
    expect(body).toMatch(/syncStore\.repository\(dbKey\)\.execute\(/);
    expect(body).toMatch(/syncStore\.repository\(dbKey\)\.transaction\(/);
  });

  it("uses a scoped transaction for deleteTemplate", () => {
    const body = functionBody("deleteTemplate");
    expect(body).toMatch(/syncStore\.repository\(dbKey\)\.transaction\(/);
  });
});
