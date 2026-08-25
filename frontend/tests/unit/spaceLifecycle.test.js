import { describe, expect, it } from "vitest";
import {
  isSpaceOwner,
  normalizeInvitationEmail,
  spaceErrorMessage,
} from "@/utils/spaceLifecycle";

describe("space lifecycle utilities", () => {
  it("normalizes invite email without changing internal characters", () => {
    expect(normalizeInvitationEmail("  Person+Tag@Example.COM ")).toBe("person+tag@example.com");
  });

  it("recognizes only the owner role", () => {
    expect(isSpaceOwner({ role: "owner" })).toBe(true);
    expect(isSpaceOwner({ role: "editor" })).toBe(false);
    expect(isSpaceOwner(null)).toBe(false);
  });

  it("maps stable server codes without exposing raw errors", () => {
    expect(spaceErrorMessage("SPACE_NOT_FOUND")).toContain("unavailable");
    expect(spaceErrorMessage("SQLITE_BUSY", "Safe fallback")).toBe("Safe fallback");
  });
});

