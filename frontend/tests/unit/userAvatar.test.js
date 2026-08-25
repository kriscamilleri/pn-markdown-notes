import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { initialsFor } from "../../src/utils/identityColor.js";

const avatarSource = readFileSync(
  new URL("../../src/components/UserAvatar.vue", import.meta.url),
  "utf8",
);
const stackSource = readFileSync(
  new URL("../../src/components/AvatarStack.vue", import.meta.url),
  "utf8",
);

describe("UserAvatar initials (COLLAB-03 §6)", () => {
  it("derives initials from a two-word name, one-word name, email and empty user", () => {
    expect(initialsFor("Jane Doe", "")).toBe("JD");
    expect(initialsFor("Alice", "")).toBe("AL");
    expect(initialsFor("", "bob@example.com")).toBe("BO");
    expect(initialsFor("", "")).toBe("?");
  });

  it("carries the full name in aria-label", () => {
    expect(avatarSource).toContain(':aria-label="label"');
    expect(avatarSource).toMatch(/const name = \(props\.user\?\.name \|\| ''\)\.trim\(\)/);
    expect(avatarSource).toContain('return name');
    expect(avatarSource).toContain('Unknown collaborator');
  });

  it("exposes the user-avatar test id and data-user-id", () => {
    expect(avatarSource).toContain("'user-avatar'");
    expect(avatarSource).toContain(':data-user-id="userId"');
  });

  it("renders a gray-tone status dot, not an identity colour", () => {
    expect(avatarSource).toContain('STATUS_COLORS');
    expect(avatarSource).toContain('online');
    expect(avatarSource).toContain('idle');
    expect(avatarSource).toContain('offline');
  });
});

describe("AvatarStack overflow (COLLAB-03 §6)", () => {
  it("renders a +N pill past the cap", () => {
    expect(stackSource).toContain('avatar-stack-overflow');
    expect(stackSource).toMatch(/\+{{\s*overflow\s*}}/);
  });

  it("slices the roster to the configured max", () => {
    expect(stackSource).toMatch(/users\.slice\(0,\s*props\.max\)/);
  });
});
