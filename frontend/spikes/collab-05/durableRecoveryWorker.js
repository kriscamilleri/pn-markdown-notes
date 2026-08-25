/* global process, Buffer */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import * as Y from "yjs";

const recoveryPath = process.argv[2];
if (!recoveryPath) throw new Error("Recovery path is required");

const ydoc = new Y.Doc();
const ytext = ydoc.getText("content");
let durableSequence = 0;

if (fs.existsSync(recoveryPath)) {
  const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
  durableSequence = Number(recovery.durableSequence) || 0;
  Y.applyUpdate(ydoc, Buffer.from(recovery.update, "base64"), "recovery");
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function persist(sequence) {
  const payload = `${JSON.stringify({
    durableSequence: sequence,
    update: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64"),
  })}\n`;
  fs.mkdirSync(path.dirname(recoveryPath), { recursive: true });
  const temporaryPath = `${recoveryPath}.tmp-${process.pid}`;
  const fd = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporaryPath, recoveryPath);
  const directoryFd = fs.openSync(path.dirname(recoveryPath), "r");
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

async function handle(message) {
  if (message.type === "status") {
    send({
      type: "state",
      durableSequence,
      content: ytext.toString(),
      stateVector: Buffer.from(Y.encodeStateVector(ydoc)).toString("base64"),
    });
    return;
  }
  if (message.type !== "update") throw new Error("Unsupported message");
  const sequence = Number(message.sequence);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error("Invalid sequence");
  if (sequence <= durableSequence) {
    send({ type: "ack", durableSequence, duplicate: true });
    return;
  }
  if (sequence !== durableSequence + 1) throw new Error("Sequence gap");
  Y.applyUpdate(ydoc, Buffer.from(message.update, "base64"), "client");
  if (message.crashBeforePersist === true) {
    process.kill(process.pid, "SIGKILL");
    return;
  }
  persist(sequence);
  durableSequence = sequence;
  send({ type: "ack", durableSequence, duplicate: false });
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", async (line) => {
  try {
    await handle(JSON.parse(line));
  } catch (error) {
    send({ type: "error", message: error.message });
  }
});

send({ type: "ready", durableSequence, content: ytext.toString() });
