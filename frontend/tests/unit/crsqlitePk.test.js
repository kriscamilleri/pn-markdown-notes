import { describe, expect, it } from "vitest";
import { parsePkId } from "../../src/utils/crsqlitePk.js";

const UUID = "12345678-1234-4123-8123-123456789abc";

function packedTextHex(text) {
  const data = Buffer.from(text, "utf8");
  // crsql_pack_columns framing: [1 column][type=text][varint length][bytes].
  const header = Buffer.from([1, 3, data.length]);
  return Buffer.concat([header, data]).toString("hex");
}

describe("parsePkId (COLLAB-02 §5.3)", () => {
  it("extracts a note id from a packed hex pk", () => {
    expect(parsePkId(packedTextHex(UUID))).toBe(UUID);
  });

  it("extracts a note id from a bare hex uuid", () => {
    expect(parsePkId(Buffer.from(UUID, "utf8").toString("hex"))).toBe(UUID);
  });

  it("extracts the first element of an array pk", () => {
    expect(parsePkId([UUID])).toBe(UUID);
  });

  it("extracts from a JSON array string", () => {
    expect(parsePkId(JSON.stringify([UUID]))).toBe(UUID);
  });

  it("extracts from a plain token when no uuid is present", () => {
    expect(parsePkId(packedTextHex("some-note-id"))).toBe("some-note-id");
  });

  it("returns null for unparseable input", () => {
    expect(parsePkId(null)).toBeNull();
    expect(parsePkId(undefined)).toBeNull();
    expect(parsePkId("")).toBeNull();
    expect(parsePkId("zz")).toBeNull(); // not valid hex
  });
});
