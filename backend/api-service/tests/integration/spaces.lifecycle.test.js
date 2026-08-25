import crypto from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../mailer.js", () => ({
  buildSpaceInviteUrl: (token) => `http://localhost:5173/#/spaces/invitations/${token}`,
  sendPasswordResetEmail: vi.fn(),
  sendSpaceInviteEmail: vi.fn().mockResolvedValue(true),
}));

import { sendSpaceInviteEmail } from "../../mailer.js";
import { deleteTestDb, getSpacesDb } from "../../db.js";
import { addEditorMember, createSpace } from "../../spaces.js";
import {
  cleanupTestUser,
  createTestApp,
  getTestToken,
  setupTestUser,
} from "../testHelpers.js";

const FLAG = "SHARED_SPACES_ENABLED";
const ORIGINAL_FLAG = process.env[FLAG];

describe("shared-space lifecycle routes", () => {
  let app;
  let server;
  let owner;
  let editor;
  let outsider;
  let spaceIds;

  beforeAll(() => {
    ({ app, server } = createTestApp());
  });

  beforeEach(async () => {
    process.env[FLAG] = "true";
    const stamp = `${Date.now()}-${Math.random()}`;
    owner = await setupTestUser(`owner-${stamp}@example.test`, "password123");
    editor = await setupTestUser(`editor-${stamp}@example.test`, "password123");
    outsider = await setupTestUser(`outsider-${stamp}@example.test`, "password123");
    spaceIds = [];
    vi.clearAllMocks();
    sendSpaceInviteEmail.mockResolvedValue(true);
  });

  afterEach(() => {
    const db = getSpacesDb();
    for (const spaceId of spaceIds) {
      db.prepare("DELETE FROM space_invites WHERE space_id = ?").run(spaceId);
      db.prepare("DELETE FROM space_members WHERE space_id = ?").run(spaceId);
      db.prepare("DELETE FROM spaces WHERE id = ?").run(spaceId);
      deleteTestDb(`space:${spaceId}`);
    }
    for (const user of [owner, editor, outsider]) {
      if (!user) continue;
      db.prepare("DELETE FROM space_user_versions WHERE user_id = ?").run(user.userId);
      cleanupTestUser(user.userId);
    }
  });

  afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env[FLAG];
    else process.env[FLAG] = ORIGINAL_FLAG;
    return new Promise((resolve) => server.close(resolve));
  });

  const auth = (user) => ({ Authorization: `Bearer ${getTestToken(user.userId)}` });

  async function createViaApi(name = "Writers") {
    const response = await request(app)
      .post("/spaces")
      .set(auth(owner))
      .send({ name })
      .expect(201);
    spaceIds.push(response.body.space.id);
    return response.body.space;
  }

  it("creates, reads, and renames as owner without disclosing a space to outsiders", async () => {
    const space = await createViaApi();
    await request(app)
      .patch(`/spaces/${space.id}`)
      .set(auth(owner))
      .send({ name: "Editorial" })
      .expect(200, { space: { id: space.id, name: "Editorial" } });

    const detail = await request(app)
      .get(`/spaces/${space.id}`)
      .set(auth(owner))
      .expect(200);
    expect(detail.body.space).toMatchObject({ name: "Editorial", role: "owner" });
    expect(detail.body.members).toEqual([
      expect.objectContaining({ id: owner.userId, role: "owner" }),
    ]);

    await request(app)
      .get(`/spaces/${space.id}`)
      .set(auth(outsider))
      .expect(404, { error: "Not found", code: "SPACE_NOT_FOUND" });
    await request(app)
      .get("/spaces/99999999-9999-4999-8999-999999999999")
      .set(auth(outsider))
      .expect(404, { error: "Not found", code: "SPACE_NOT_FOUND" });
  });

  it("creates a hashed email-bound invite that expires and can be accepted only once", async () => {
    const space = await createViaApi();
    const invited = await request(app)
      .post(`/spaces/${space.id}/invitations`)
      .set(auth(owner))
      .send({ email: `  ${editor.email.toUpperCase()}  `, role: "editor" })
      .expect(201);
    expect(invited.body.invitation.email).toBe(editor.email.toLowerCase());
    expect(invited.body).not.toHaveProperty("token");
    expect(invited.body.invitationUrl).toMatch(
      new RegExp(`/spaces/invitations/[a-f0-9]{64}$`),
    );
    const rawToken = sendSpaceInviteEmail.mock.calls[0][1];
    expect(invited.body.invitationUrl).toContain(rawToken);
    const stored = getSpacesDb().prepare(
      "SELECT token_hash AS tokenHash FROM space_invites WHERE invite_id = ?",
    ).get(invited.body.invitation.id);
    expect(stored.tokenHash).toBe(crypto.createHash("sha256").update(rawToken).digest("hex"));
    expect(stored.tokenHash).not.toBe(rawToken);

    await request(app)
      .post("/space-invitations/accept")
      .set(auth(outsider))
      .send({ token: rawToken })
      .expect(400, { error: "Invitation is invalid or expired", code: "SPACE_INVITE_INVALID" });
    await request(app)
      .post("/space-invitations/accept")
      .set(auth(editor))
      .send({ token: rawToken })
      .expect(200);
    await request(app)
      .post("/space-invitations/accept")
      .set(auth(editor))
      .send({ token: rawToken })
      .expect(400, { error: "Invitation is invalid or expired", code: "SPACE_INVITE_INVALID" });
  });

  it("lists and accepts invitations for the signed-in account on Manage Spaces", async () => {
    const space = await createViaApi("Editorial");
    const invited = await request(app)
      .post(`/spaces/${space.id}/invitations`)
      .set(auth(owner))
      .send({ email: editor.email })
      .expect(201);

    await request(app)
      .get("/space-invitations")
      .set(auth(outsider))
      .expect(200, { invitations: [] });
    const pending = await request(app)
      .get("/space-invitations")
      .set(auth(editor))
      .expect(200);
    expect(pending.body.invitations).toEqual([
      expect.objectContaining({
        id: invited.body.invitation.id,
        spaceName: "Editorial",
        role: "editor",
      }),
    ]);
    expect(JSON.stringify(pending.body)).not.toContain(sendSpaceInviteEmail.mock.calls[0][1]);

    await request(app)
      .post(`/space-invitations/${invited.body.invitation.id}/accept`)
      .set(auth(outsider))
      .expect(400, { error: "Invitation is invalid or expired", code: "SPACE_INVITE_INVALID" });
    const accepted = await request(app)
      .post(`/space-invitations/${invited.body.invitation.id}/accept`)
      .set(auth(editor))
      .expect(200);
    expect(accepted.body).toMatchObject({ accepted: true, spaceId: space.id });
    await request(app)
      .get("/space-invitations")
      .set(auth(editor))
      .expect(200, { invitations: [] });
    await request(app).get(`/spaces/${space.id}`).set(auth(editor)).expect(200);
  });

  it("revokes and resends invitations while invalidating every previous link", async () => {
    const space = await createViaApi();
    const first = await request(app)
      .post(`/spaces/${space.id}/invitations`)
      .set(auth(owner))
      .send({ email: editor.email })
      .expect(201);
    const firstToken = sendSpaceInviteEmail.mock.calls.at(-1)[1];
    const resent = await request(app)
      .post(`/spaces/${space.id}/invitations/${first.body.invitation.id}/resend`)
      .set(auth(owner))
      .expect(200);
    const secondToken = sendSpaceInviteEmail.mock.calls.at(-1)[1];
    expect(secondToken).not.toBe(firstToken);
    expect(resent.body.invitation.id).not.toBe(first.body.invitation.id);
    expect(resent.body.invitationUrl).toContain(secondToken);

    await request(app)
      .post("/space-invitations/accept")
      .set(auth(editor))
      .send({ token: firstToken })
      .expect(400);
    await request(app)
      .delete(`/spaces/${space.id}/invitations/${resent.body.invitation.id}`)
      .set(auth(owner))
      .expect(204);
    await request(app)
      .post("/space-invitations/accept")
      .set(auth(editor))
      .send({ token: secondToken })
      .expect(400);
  });

  it("enforces owner actions, transfers exactly one owner, and lets the former owner leave", async () => {
    const created = createSpace({ actorUserId: owner.userId, name: "Writers" });
    spaceIds.push(created.spaceId);
    addEditorMember({
      actorUserId: owner.userId,
      spaceId: created.spaceId,
      userId: editor.userId,
    });
    await request(app)
      .patch(`/spaces/${created.spaceId}`)
      .set(auth(editor))
      .send({ name: "No" })
      .expect(403);
    await request(app)
      .post(`/spaces/${created.spaceId}/leave`)
      .set(auth(owner))
      .expect(409);
    await request(app)
      .post(`/spaces/${created.spaceId}/ownership`)
      .set(auth(owner))
      .send({ userId: editor.userId })
      .expect(200, { ownerUserId: editor.userId });
    expect(getSpacesDb().prepare(
      "SELECT COUNT(*) AS count FROM space_members WHERE space_id = ? AND role = 'owner'",
    ).get(created.spaceId).count).toBe(1);
    await request(app)
      .post(`/spaces/${created.spaceId}/leave`)
      .set(auth(owner))
      .expect(204);
  });

  it("requests retained deletion while revoking all access immediately", async () => {
    const created = createSpace({ actorUserId: owner.userId, name: "Writers" });
    spaceIds.push(created.spaceId);
    addEditorMember({
      actorUserId: owner.userId,
      spaceId: created.spaceId,
      userId: editor.userId,
    });
    const response = await request(app)
      .post(`/spaces/${created.spaceId}/deletion-request`)
      .set(auth(owner))
      .expect(202);
    expect(Date.parse(response.body.deleteAfter) - Date.now())
      .toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    await request(app).get(`/spaces/${created.spaceId}`).set(auth(owner)).expect(404);
    await request(app).get(`/spaces/${created.spaceId}`).set(auth(editor)).expect(404);
    expect(getSpacesDb().prepare("SELECT status FROM spaces WHERE id = ?").get(created.spaceId))
      .toEqual({ status: "pending_delete" });
  });
});
