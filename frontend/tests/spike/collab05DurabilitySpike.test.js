import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

const workerPath = fileURLToPath(
  new URL("../../spikes/collab-05/durableRecoveryWorker.js", import.meta.url),
);
const processes = new Set();
const temporaryDirectories = [];

afterEach(async () => {
  for (const child of processes) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  processes.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function startServer(recoveryPath) {
  const child = spawn(process.execPath, [workerPath, recoveryPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  processes.add(child);
  const messages = [];
  const waiters = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  return {
    child,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    waitFor(predicate, timeoutMs = 5000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for recovery worker. stderr: ${stderr}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function onceExit(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

describe("COLLAB-05 §6.1a acknowledged durability crash spike", () => {
  it("restores the acknowledged Yjs state and replays only the unacknowledged update", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panino-collab05-spike-"));
    temporaryDirectories.push(directory);
    const recoveryPath = path.join(directory, "session-recovery.json");
    const clientDoc = new Y.Doc();
    const clientText = clientDoc.getText("content");
    const updates = [];
    clientDoc.on("update", (update) => updates.push(Buffer.from(update).toString("base64")));

    const first = startServer(recoveryPath);
    await first.waitFor((message) => message.type === "ready");
    clientText.insert(0, "acknowledged");
    first.send({ type: "update", sequence: 1, update: updates[0] });
    await expect(first.waitFor((message) => message.type === "ack" && message.durableSequence === 1))
      .resolves.toMatchObject({ duplicate: false });
    expect(JSON.parse(fs.readFileSync(recoveryPath, "utf8")).durableSequence).toBe(1);

    // This update reaches server memory, but the process is killed before the
    // recovery fsync/rename and therefore before any acknowledgement.
    clientText.insert(clientText.length, " + replayed");
    const exit = onceExit(first.child);
    first.send({
      type: "update",
      sequence: 2,
      update: updates[1],
      crashBeforePersist: true,
    });
    await expect(exit).resolves.toMatchObject({ signal: "SIGKILL" });

    const restarted = startServer(recoveryPath);
    await expect(restarted.waitFor((message) => message.type === "ready"))
      .resolves.toMatchObject({ durableSequence: 1, content: "acknowledged" });

    // The client retains sequence 2 until an ack, so it sends that exact Yjs
    // update after the state-vector/recovery exchange.
    restarted.send({ type: "update", sequence: 2, update: updates[1] });
    await expect(restarted.waitFor((message) => message.type === "ack" && message.durableSequence === 2))
      .resolves.toMatchObject({ duplicate: false });
    restarted.send({ type: "status" });
    await expect(restarted.waitFor((message) => message.type === "state"))
      .resolves.toMatchObject({ durableSequence: 2, content: "acknowledged + replayed" });

    restarted.send({ type: "update", sequence: 2, update: updates[1] });
    await expect(restarted.waitFor((message) => message.type === "ack" && message.duplicate === true))
      .resolves.toMatchObject({ durableSequence: 2 });
    expect(JSON.parse(fs.readFileSync(recoveryPath, "utf8")).durableSequence).toBe(2);
  });
});
