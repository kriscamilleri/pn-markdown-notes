import { describe, expect, it } from "vitest";
import {
  resolveSyncMerge,
  evaluateWritebackGuard,
  WRITEBACK_WINDOW_MS,
} from "../../src/utils/syncMerge.js";

describe("resolveSyncMerge (COLLAB-02 §5.3)", () => {
  it("adopts a first remote row when no local row or merge base existed", () => {
    const result = resolveSyncMerge({
      hasBase: false,
      hasMine: false,
      base: undefined,
      mine: "",
      theirs: "# First pull",
      capabilityEnabled: true,
    });

    expect(result).toEqual({ action: "record-base", content: "# First pull", conflicts: [] });
  });

  it("records the value as base when there is no base and both sides agree", () => {
    const result = resolveSyncMerge({
      hasBase: false,
      base: undefined,
      mine: "hello",
      theirs: "hello",
      capabilityEnabled: true,
    });
    expect(result.action).toBe("record-base");
    expect(result.content).toBe("hello");
  });

  it("records a conflict when there is no base and the local value differs", () => {
    const result = resolveSyncMerge({
      hasBase: false,
      base: undefined,
      mine: "mine",
      theirs: "theirs",
      capabilityEnabled: true,
    });
    expect(result.action).toBe("record-conflict");
    expect(result.content).toBe("theirs");
    expect(result.reason).toBe("no-base");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].mineLines).toEqual(["mine"]);
  });

  it("adopts theirs when mine still equals base", () => {
    const result = resolveSyncMerge({
      hasBase: true,
      base: "base",
      mine: "base",
      theirs: "theirs",
      capabilityEnabled: true,
    });
    expect(result.action).toBe("adopt-theirs");
    expect(result.content).toBe("theirs");
  });

  it("restores mine when theirs equals base (remote changed nothing)", () => {
    const result = resolveSyncMerge({
      hasBase: true,
      base: "base",
      mine: "mine",
      theirs: "base",
      capabilityEnabled: true,
    });
    expect(result.action).toBe("restore-mine");
    expect(result.content).toBe("mine");
  });

  it("writes a clean merge when capability is enabled", () => {
    const result = resolveSyncMerge({
      hasBase: true,
      base: "p1\n\np2",
      mine: "p1 MINE\n\np2",
      theirs: "p1\n\np2 THEIRS",
      capabilityEnabled: true,
    });
    expect(result.action).toBe("write-merge");
    expect(result.content).toBe("p1 MINE\n\np2 THEIRS");
    expect(result.conflicts).toEqual([]);
  });

  it("records a conflict instead of writing when a merge has conflicts", () => {
    const result = resolveSyncMerge({
      hasBase: true,
      base: "p1\np2",
      mine: "p1 MINE\np2",
      theirs: "p1 THEIRS\np2",
      capabilityEnabled: true,
    });
    expect(result.action).toBe("record-conflict");
    expect(result.content).toBe("p1 THEIRS\np2");
    expect(result.conflicts).toHaveLength(1);
  });

  it("holds both sides when capability is disabled even for a clean merge", () => {
    const result = resolveSyncMerge({
      hasBase: true,
      base: "p1\n\np2",
      mine: "p1 MINE\n\np2",
      theirs: "p1\n\np2 THEIRS",
      capabilityEnabled: false,
    });
    expect(result.action).toBe("record-conflict");
    expect(result.content).toBe("p1\n\np2 THEIRS");
    expect(result.reason).toBe("writeback-disabled");
    expect(result.pendingMerged).toBe("p1 MINE\n\np2 THEIRS");
  });

  it("treats an over-budget merge as a recoverable conflict", () => {
    const large = "a".repeat(1024 * 1024 + 1);
    const result = resolveSyncMerge({
      hasBase: true,
      base: "p1",
      mine: large,
      theirs: "p2",
      capabilityEnabled: true,
    });
    expect(result.action).toBe("record-conflict");
    expect(result.reason).toBe("budget");
    expect(result.content).toBe("p2");
  });
});

describe("evaluateWritebackGuard (COLLAB-02 §6.3)", () => {
  const start = Date.parse("2026-08-16T00:00:00.000Z");

  it("allows the first write-back and starts the window", () => {
    const result = evaluateWritebackGuard({ writebackCount: 0, windowStartedAt: null, now: start });
    expect(result.allowed).toBe(true);
    expect(result.writebackCount).toBe(1);
    expect(result.windowStartedAt).toBe(new Date(start).toISOString());
  });

  it("allows write-backs two and three within the window", () => {
    const first = evaluateWritebackGuard({ writebackCount: 0, windowStartedAt: null, now: start });
    const second = evaluateWritebackGuard({
      writebackCount: first.writebackCount,
      windowStartedAt: first.windowStartedAt,
      now: start + 1000,
    });
    expect(second.allowed).toBe(true);
    expect(second.writebackCount).toBe(2);

    const third = evaluateWritebackGuard({
      writebackCount: second.writebackCount,
      windowStartedAt: second.windowStartedAt,
      now: start + 2000,
    });
    expect(third.allowed).toBe(true);
    expect(third.writebackCount).toBe(3);
  });

  it("suppresses the fourth write-back within the window", () => {
    const result = evaluateWritebackGuard({
      writebackCount: 3,
      windowStartedAt: new Date(start).toISOString(),
      now: start + 3000,
    });
    expect(result.allowed).toBe(false);
    expect(result.writebackCount).toBe(3);
  });

  it("resets the window after 60 seconds", () => {
    const result = evaluateWritebackGuard({
      writebackCount: 3,
      windowStartedAt: new Date(start).toISOString(),
      now: start + WRITEBACK_WINDOW_MS + 1,
    });
    expect(result.allowed).toBe(true);
    expect(result.writebackCount).toBe(1);
    expect(result.windowStartedAt).toBe(new Date(start + WRITEBACK_WINDOW_MS + 1).toISOString());
  });
});
