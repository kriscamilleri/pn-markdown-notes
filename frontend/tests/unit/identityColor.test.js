import { describe, expect, it } from "vitest";
import {
  IDENTITY_PALETTE,
  identityColorFor,
  initialsFor,
} from "../../src/utils/identityColor.js";
import {
  verifyIdentityPalette,
  contrastRatio,
  deltaE2000,
  hueInBlueRange,
  LIGHT_SURFACE,
  DARK_SURFACE,
  INITIALS_COLOR,
  PN_PRIMARY,
  PN_ACCENT,
} from "../../src/utils/identityPaletteVerify.js";

describe("identityColorFor (COLLAB-03 §4)", () => {
  it("is stable for a given user id across calls", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(identityColorFor(id)).toBe(identityColorFor(id));
  });

  it("distributes a sample of user ids across the palette (no single-bucket collapse)", () => {
    const ids = Array.from({ length: 64 }, () => crypto.randomUUID());
    const colours = new Set(ids.map(identityColorFor));
    expect(colours.size).toBeGreaterThan(1);
    expect([...colours].every((c) => IDENTITY_PALETTE.includes(c))).toBe(true);
  });
});

describe("identity palette thresholds (COLLAB-03 §3)", () => {
  it("reports zero violations", () => {
    expect(verifyIdentityPalette().violations).toEqual([]);
  });

  it("clears 3:1 against both surfaces", () => {
    for (const colour of IDENTITY_PALETTE) {
      expect(contrastRatio(colour, LIGHT_SURFACE)).toBeGreaterThanOrEqual(3.0);
      expect(contrastRatio(colour, DARK_SURFACE)).toBeGreaterThanOrEqual(3.0);
    }
  });

  it("clears 4.5:1 against white initials", () => {
    for (const colour of IDENTITY_PALETTE) {
      expect(contrastRatio(colour, INITIALS_COLOR)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps at least Delta E 12 from --pn-primary and --pn-accent", () => {
    for (const colour of IDENTITY_PALETTE) {
      expect(deltaE2000(colour, PN_PRIMARY)).toBeGreaterThanOrEqual(12);
      expect(deltaE2000(colour, PN_ACCENT)).toBeGreaterThanOrEqual(12);
    }
  });

  it("keeps every swatch out of the reserved blue hue range", () => {
    for (const colour of IDENTITY_PALETTE) {
      expect(hueInBlueRange(colour)).toBe(false);
    }
  });
});

describe("initialsFor (COLLAB-03 §6)", () => {
  it("derives two initials from a two-word name", () => {
    expect(initialsFor("Jane Doe", "")).toBe("JD");
  });

  it("derives initials from a one-word name", () => {
    expect(initialsFor("Alice", "")).toBe("AL");
  });

  it("falls back to the email local part", () => {
    expect(initialsFor("", "carol@example.com")).toBe("CA");
  });

  it("falls back to a question mark for an empty user", () => {
    expect(initialsFor("", "")).toBe("?");
    expect(initialsFor(null, null)).toBe("?");
  });

  it("keeps identity in initials, not hue, across distinct names", () => {
    const byName = [
      initialsFor("Jane Doe", ""),
      initialsFor("John Smith", ""),
      initialsFor("Alice", ""),
      initialsFor("Bob Carter", ""),
    ];
    expect(new Set(byName).size).toBe(byName.length);
  });
});
