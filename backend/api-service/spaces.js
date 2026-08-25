import { v4 as uuidv4, validate as validateUuid } from "uuid";
import express from "express";
import crypto from "node:crypto";
import {
  MINIMUM_CLIENT_SCHEMA_VERSION,
  deleteDb,
  getAuthDb,
  getDb,
  getSpacesDb,
} from "./db.js";
import { buildSpaceInviteUrl, sendSpaceInviteEmail } from "./mailer.js";
import { deleteSpaceUploads } from "./spaceStorage.js";

const ALLOWED_ROLES = new Set(["owner", "editor"]);
const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const DELETE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SPACE_DELETE_SWEEP_MS = 60 * 60 * 1000;

function positiveLimit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function normalizeInviteEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function requireInviteEmail(value) {
  const email = normalizeInviteEmail(value);
  if (!email || email.length > 320 || !email.includes("@")) {
    throw new SpaceRepositoryError(
      "INVALID_INVITE_EMAIL",
      "Enter a valid email address",
    );
  }
  return email;
}

function hashInviteToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export class SpaceRepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SpaceRepositoryError";
    this.code = code;
  }
}

export function isSharedSpacesEnabled() {
  return process.env.SHARED_SPACES_ENABLED === "true";
}

function requireEnabled() {
  if (!isSharedSpacesEnabled()) {
    throw new SpaceRepositoryError(
      "SHARED_SPACES_DISABLED",
      "Shared spaces are disabled",
    );
  }
}

function requireUuid(value, field) {
  if (typeof value !== "string" || !validateUuid(value)) {
    throw new SpaceRepositoryError("INVALID_UUID", `${field} must be a UUID`);
  }
  return value;
}

function requireRole(role) {
  if (!ALLOWED_ROLES.has(role)) {
    throw new SpaceRepositoryError(
      "INVALID_SPACE_ROLE",
      "Space role must be owner or editor",
    );
  }
  return role;
}

function requireEditorRole(role) {
  requireRole(role);
  if (role !== "editor") {
    throw new SpaceRepositoryError(
      "INVALID_SPACE_ROLE",
      "Members can only be added as editors",
    );
  }
}

function requireUser(userId) {
  requireUuid(userId, "userId");
  const user = getAuthDb()
    .prepare("SELECT id FROM users WHERE id = ?")
    .get(userId);
  if (!user) {
    throw new SpaceRepositoryError("USER_NOT_FOUND", "User not found");
  }
  return user;
}

function requireOwner(db, spaceId, actorUserId) {
  const membership = db
    .prepare(
      `SELECT s.id, m.role
         FROM spaces s
         JOIN space_members m ON m.space_id = s.id
        WHERE s.id = ?
          AND m.user_id = ?
          AND s.status = 'active'`,
    )
    .get(spaceId, actorUserId);

  if (!membership) {
    throw new SpaceRepositoryError("SPACE_NOT_FOUND", "Space not found");
  }
  if (membership.role !== "owner") {
    throw new SpaceRepositoryError(
      "SPACE_OWNER_REQUIRED",
      "Only the current space owner may manage members",
    );
  }

  const owner = db.prepare(
    `SELECT 1 FROM spaces s
      JOIN space_members m
        ON m.space_id = s.id
       AND m.user_id = s.owner_user_id
       AND m.role = 'owner'
     WHERE s.id = ? AND s.owner_user_id = ?`,
  ).get(spaceId, actorUserId);
  if (!owner) {
    throw new SpaceRepositoryError(
      "SPACE_INVARIANT_VIOLATION",
      "Shared-space metadata failed an integrity check",
    );
  }
}

function bumpUserVersion(db, userId) {
  db.prepare(
    `INSERT INTO space_user_versions (user_id, version)
     VALUES (?, 1)
     ON CONFLICT(user_id) DO UPDATE SET version = version + 1`,
  ).run(userId);
}

function membershipVersion(db, userId) {
  return (
    db
      .prepare("SELECT version FROM space_user_versions WHERE user_id = ?")
      .get(userId)?.version ?? 0
  );
}

function memberUserIds(db, spaceId) {
  return db.prepare(
    "SELECT user_id AS userId FROM space_members WHERE space_id = ? ORDER BY user_id",
  ).all(spaceId).map((row) => row.userId);
}

function bumpUsers(db, userIds) {
  for (const userId of new Set(userIds)) bumpUserVersion(db, userId);
}

function versionsForUsers(db, userIds) {
  return new Map(
    [...new Set(userIds)].map((userId) => [userId, membershipVersion(db, userId)]),
  );
}

function ensureSpaceProfile(spaceId, userId) {
  const profile = getAuthDb().prepare(
    "SELECT id, name, created_at AS createdAt FROM users WHERE id = ?",
  ).get(userId);
  if (!profile) return;
  const db = getDb(`space:${spaceId}`);
  db.prepare(
    `INSERT INTO users (id, name, email, created_at)
     VALUES (?, ?, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = NULL`,
  ).run(profile.id, profile.name, profile.createdAt || new Date().toISOString());
}

function membershipQuery(db, spaceId, userId) {
  return db
    .prepare(
      `SELECT s.id AS spaceId,
              s.name,
              s.status,
              s.owner_user_id AS ownerUserId,
              s.created_at AS createdAt,
              s.updated_at AS updatedAt,
              m.user_id AS userId,
              m.role,
              m.invited_by AS invitedBy,
              m.created_at AS memberSince
         FROM spaces s
         JOIN space_members m ON m.space_id = s.id
        WHERE s.id = ? AND m.user_id = ? AND s.status = 'active'`,
    )
    .get(spaceId, userId);
}

function tableExists(db, name) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

/**
 * Read-only invariant sweep over `_spaces.db` (phase-0 design artifacts §2).
 * Returns { ok, violations } and, when `throwOnViolation` (the default),
 * throws SpaceRepositoryError("SPACE_INVARIANT_VIOLATION", ...) on any
 * failure so the caller's transaction rolls back rather than guessing a
 * repair. Restore tooling may inject its staged auth DB; normal application
 * callers default to the live auth connection. The thrown message is
 * intentionally generic; violation detail is only logged server-side.
 */
export function assertSpacesInvariants(
  db,
  { throwOnViolation = true, authDb = null } = {},
) {
  const violations = [];

  // 1 & 6: every space has exactly one owner membership agreeing with
  // spaces.owner_user_id; more than one is a duplicate-owner violation.
  const spaces = db
    .prepare("SELECT id, owner_user_id AS ownerUserId FROM spaces")
    .all();
  for (const space of spaces) {
    const owners = db
      .prepare(
        "SELECT user_id AS userId FROM space_members WHERE space_id = ? AND role = 'owner'",
      )
      .all(space.id);
    if (owners.length === 0) {
      violations.push({ code: "SPACE_OWNER_MISSING", spaceId: space.id });
    } else if (owners.length > 1) {
      violations.push({ code: "SPACE_DUPLICATE_OWNER", spaceId: space.id });
    } else if (owners[0].userId !== space.ownerUserId) {
      violations.push({ code: "SPACE_OWNER_MISMATCH", spaceId: space.id });
    }
  }

  // 2: no orphaned space_members / space_invites rows.
  const orphanMembers = db
    .prepare(
      "SELECT DISTINCT space_id AS spaceId FROM space_members WHERE space_id NOT IN (SELECT id FROM spaces)",
    )
    .all();
  for (const row of orphanMembers) {
    violations.push({ code: "SPACE_ORPHAN_MEMBER", spaceId: row.spaceId });
  }

  if (tableExists(db, "space_invites")) {
    const orphanInvites = db
      .prepare(
        "SELECT DISTINCT space_id AS spaceId FROM space_invites WHERE space_id NOT IN (SELECT id FROM spaces)",
      )
      .all();
    for (const row of orphanInvites) {
      violations.push({ code: "SPACE_ORPHAN_INVITE", spaceId: row.spaceId });
    }
  }

  // 3 & 5: every referenced user id (member or owner) must exist in the auth
  // DB, and must have a space_user_versions row (no gaps).
  const referencedUserIds = new Set([
    ...db
      .prepare("SELECT DISTINCT user_id AS userId FROM space_members")
      .all()
      .map((r) => r.userId),
    ...db
      .prepare("SELECT DISTINCT owner_user_id AS userId FROM spaces")
      .all()
      .map((r) => r.userId),
  ]);

  if (referencedUserIds.size > 0) {
    const authDatabase = authDb || getAuthDb();
    const authExists = authDatabase.prepare("SELECT 1 FROM users WHERE id = ?");
    for (const userId of referencedUserIds) {
      if (!authExists.get(userId)) {
        violations.push({ code: "SPACE_MEMBER_USER_MISSING", userId });
      }
    }

    const versionExists = db.prepare(
      "SELECT 1 FROM space_user_versions WHERE user_id = ?",
    );
    for (const userId of referencedUserIds) {
      if (!versionExists.get(userId)) {
        violations.push({ code: "SPACE_VERSION_MISSING", userId });
      }
    }
  }

  // 4: status/delete_after pairing.
  const pairingViolations = db
    .prepare(
      `SELECT id AS spaceId FROM spaces
        WHERE (status = 'pending_delete' AND delete_after IS NULL)
           OR (status = 'active' AND delete_after IS NOT NULL)`,
    )
    .all();
  for (const row of pairingViolations) {
    violations.push({
      code: "SPACE_STATUS_DELETE_AFTER_MISMATCH",
      spaceId: row.spaceId,
    });
  }

  const ok = violations.length === 0;
  if (!ok) {
    console.error(
      "[spaces]",
      JSON.stringify({
        event: "space_invariant_violation",
        count: violations.length,
        codes: [...new Set(violations.map((v) => v.code))],
      }),
    );
    if (throwOnViolation) {
      throw new SpaceRepositoryError(
        "SPACE_INVARIANT_VIOLATION",
        "Shared-space metadata failed an integrity check",
      );
    }
  }

  return { ok, violations };
}

function createArgs(actorOrOptions, name) {
  if (actorOrOptions && typeof actorOrOptions === "object") {
    return {
      actorUserId: actorOrOptions.actorUserId,
      name: actorOrOptions.name,
    };
  }
  return { actorUserId: actorOrOptions, name };
}

function memberArgs(actorOrOptions, spaceId, userId, role) {
  if (actorOrOptions && typeof actorOrOptions === "object") {
    return {
      actorUserId: actorOrOptions.actorUserId,
      spaceId: actorOrOptions.spaceId,
      userId: actorOrOptions.userId,
      role: actorOrOptions.role ?? "editor",
    };
  }
  return {
    actorUserId: actorOrOptions,
    spaceId,
    userId,
    role: role ?? "editor",
  };
}

/**
 * Create a space and its sole owner membership as one _spaces.db transaction.
 * actorUserId must come from trusted authentication context at the future call site.
 */
export function createSpace(actorOrOptions, suppliedName) {
  requireEnabled();
  const { actorUserId, name } = createArgs(actorOrOptions, suppliedName);
  requireUser(actorUserId);

  const normalizedName = typeof name === "string" ? name.trim() : "";
  if (!normalizedName || normalizedName.length > 100) {
    throw new SpaceRepositoryError("INVALID_SPACE_NAME", "Space name is required");
  }

  const db = getSpacesDb();
  const ownedCount = db.prepare(
    "SELECT COUNT(*) AS count FROM spaces WHERE owner_user_id = ?",
  ).get(actorUserId)?.count ?? 0;
  if (ownedCount >= positiveLimit("SPACE_OWNER_LIMIT", 20)) {
    throw new SpaceRepositoryError(
      "SPACE_OWNER_LIMIT",
      "You have reached the owned-space limit",
    );
  }
  const spaceId = uuidv4();
  const now = new Date().toISOString();

  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO spaces
         (id, name, owner_user_id, status, delete_after, created_at, updated_at)
       VALUES (?, ?, ?, 'active', NULL, ?, ?)`,
    ).run(spaceId, normalizedName, actorUserId, now, now);
    db.prepare(
      `INSERT INTO space_members
         (space_id, user_id, role, invited_by, created_at)
       VALUES (?, ?, 'owner', NULL, ?)`,
    ).run(spaceId, actorUserId, now);
    bumpUserVersion(db, actorUserId);
    ensureSpaceProfile(spaceId, actorUserId);
    assertSpacesInvariants(db);
  });

  try {
    create();
  } catch (error) {
    try {
      deleteDb(`space:${spaceId}`);
    } catch (cleanupError) {
      console.error("[spaces] failed to remove an unadmitted space database", {
        code: cleanupError?.code || "CLEANUP_FAILED",
      });
    }
    throw error;
  }
  return {
    ...membershipQuery(db, spaceId, actorUserId),
    membershipVersion: membershipVersion(db, actorUserId),
  };
}

export function getSpaceMembership(spaceOrOptions, suppliedUserId) {
  requireEnabled();
  const spaceId =
    spaceOrOptions && typeof spaceOrOptions === "object"
      ? spaceOrOptions.spaceId
      : spaceOrOptions;
  const userId =
    spaceOrOptions && typeof spaceOrOptions === "object"
      ? spaceOrOptions.userId
      : suppliedUserId;

  requireUuid(spaceId, "spaceId");
  requireUser(userId);
  return membershipQuery(getSpacesDb(), spaceId, userId) ?? null;
}

export function listSpacesForUser(userOrOptions) {
  requireEnabled();
  const userId =
    userOrOptions && typeof userOrOptions === "object"
      ? userOrOptions.userId
      : userOrOptions;
  requireUser(userId);

  const db = getSpacesDb();
  const spaces = db
    .prepare(
      `SELECT s.id AS spaceId,
              s.name,
              s.status,
              s.owner_user_id AS ownerUserId,
              s.created_at AS createdAt,
              s.updated_at AS updatedAt,
              m.role,
              m.created_at AS memberSince
         FROM spaces s
         JOIN space_members m ON m.space_id = s.id
        WHERE m.user_id = ? AND s.status = 'active'
        ORDER BY s.created_at ASC, s.id ASC`,
    )
    .all(userId);

  return { spaces, membershipVersion: membershipVersion(db, userId) };
}

function encodeSpaceCursor(space) {
  return Buffer.from(JSON.stringify([space.createdAt, space.spaceId]), "utf8").toString("base64url");
}

function decodeSpaceCursor(value) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      typeof decoded[1] !== "string" ||
      !validateUuid(decoded[1])
    ) {
      return null;
    }
    return { createdAt: decoded[0], spaceId: decoded[1] };
  } catch {
    return null;
  }
}

/**
 * Paginated, read-only discovery payload for a member's local registry.
 * Member profiles intentionally expose only `{id, name}`.
 */
export function listSpaceMembershipPage({ userId, cursor = null, limit = 25 }) {
  requireEnabled();
  requireUser(userId);
  const boundedLimit = Math.min(50, Math.max(1, Number(limit) || 25));
  const decodedCursor = cursor ? decodeSpaceCursor(cursor) : null;
  if (cursor && !decodedCursor) {
    throw new SpaceRepositoryError("INVALID_SPACE_CURSOR", "Invalid space-list cursor");
  }

  const db = getSpacesDb();
  const cursorSql = decodedCursor
    ? "AND (s.created_at > ? OR (s.created_at = ? AND s.id > ?))"
    : "";
  const params = decodedCursor
    ? [userId, decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.spaceId, boundedLimit + 1]
    : [userId, boundedLimit + 1];
  const rows = db.prepare(
    `SELECT s.id AS spaceId,
            s.name,
            s.owner_user_id AS ownerUserId,
            s.created_at AS createdAt,
            s.updated_at AS updatedAt,
            m.role,
            m.created_at AS memberSince
       FROM spaces s
       JOIN space_members m ON m.space_id = s.id
      WHERE m.user_id = ? AND s.status = 'active'
      ${cursorSql}
      ORDER BY s.created_at ASC, s.id ASC
      LIMIT ?`,
  ).all(...params);

  const hasNextPage = rows.length > boundedLimit;
  const spaces = rows.slice(0, boundedLimit);
  const authDb = getAuthDb();
  const memberRows = db.prepare(
    `SELECT user_id AS id
       FROM space_members
      WHERE space_id = ?
      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC, user_id ASC`,
  );
  const userName = authDb.prepare("SELECT name FROM users WHERE id = ?");
  for (const space of spaces) {
    space.members = memberRows.all(space.spaceId).map(({ id }) => ({
      id,
      name: userName.get(id)?.name || "Unknown collaborator",
    }));
  }

  return {
    spaces,
    membershipVersion: membershipVersion(db, userId),
    minimum_client_schema: MINIMUM_CLIENT_SCHEMA_VERSION,
    nextCursor: hasNextPage ? encodeSpaceCursor(spaces.at(-1)) : null,
  };
}

export const spaceRoutes = express.Router();

spaceRoutes.get("/spaces", (req, res) => {
  try {
    const page = listSpaceMembershipPage({
      userId: req.user.user_id,
      cursor: req.query.cursor || null,
      limit: req.query.limit,
    });
    res.json(page);
  } catch (error) {
    if (error?.code === "SHARED_SPACES_DISABLED") {
      return res.status(404).json({ error: "Not found", code: "SPACE_NOT_FOUND" });
    }
    if (error?.code === "INVALID_SPACE_CURSOR") {
      return res.status(400).json({ error: "Invalid cursor", code: error.code });
    }
    console.error("[spaces] discovery failed", { code: error?.code || "UNKNOWN" });
    return res.status(500).json({ error: "Unable to list spaces" });
  }
});

export function addEditorMember(
  actorOrOptions,
  suppliedSpaceId,
  suppliedUserId,
  suppliedRole = "editor",
) {
  requireEnabled();
  const { actorUserId, spaceId, userId, role } = memberArgs(
    actorOrOptions,
    suppliedSpaceId,
    suppliedUserId,
    suppliedRole,
  );
  requireUuid(actorUserId, "actorUserId");
  requireUuid(spaceId, "spaceId");
  requireUuid(userId, "userId");
  requireEditorRole(role);
  requireUser(actorUserId);

  const db = getSpacesDb();
  const now = new Date().toISOString();
  const add = db.transaction(() => {
    requireOwner(db, spaceId, actorUserId);
    requireUser(userId);
    const memberCount = db.prepare(
      "SELECT COUNT(*) AS count FROM space_members WHERE space_id = ?",
    ).get(spaceId)?.count ?? 0;
    if (memberCount >= positiveLimit("SPACE_MEMBER_LIMIT", 100)) {
      throw new SpaceRepositoryError(
        "SPACE_MEMBER_LIMIT",
        "This space has reached its member limit",
      );
    }
    const joinedCount = db.prepare(
      "SELECT COUNT(*) AS count FROM space_members WHERE user_id = ?",
    ).get(userId)?.count ?? 0;
    if (joinedCount >= positiveLimit("SPACE_JOINED_LIMIT", 100)) {
      throw new SpaceRepositoryError(
        "SPACE_JOINED_LIMIT",
        "This account has reached its joined-space limit",
      );
    }
    ensureSpaceProfile(spaceId, userId);
    db.prepare(
      `INSERT INTO space_members
         (space_id, user_id, role, invited_by, created_at)
       VALUES (?, ?, 'editor', ?, ?)`,
    ).run(spaceId, userId, actorUserId, now);
    bumpUsers(db, memberUserIds(db, spaceId));
    assertSpacesInvariants(db);
  });

  try {
    add();
  } catch (error) {
    if (error?.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      throw new SpaceRepositoryError(
        "SPACE_MEMBER_EXISTS",
        "User is already a member of this space",
      );
    }
    throw error;
  }

  return {
    ...membershipQuery(db, spaceId, userId),
    membershipVersion: membershipVersion(db, userId),
  };
}

export function removeEditorMember(
  actorOrOptions,
  suppliedSpaceId,
  suppliedUserId,
) {
  requireEnabled();
  const { actorUserId, spaceId, userId } = memberArgs(
    actorOrOptions,
    suppliedSpaceId,
    suppliedUserId,
    "editor",
  );
  requireUuid(actorUserId, "actorUserId");
  requireUuid(spaceId, "spaceId");
  requireUuid(userId, "userId");
  requireUser(actorUserId);

  const db = getSpacesDb();
  const remove = db.transaction(() => {
    requireOwner(db, spaceId, actorUserId);
    requireUser(userId);
    const membership = db
      .prepare(
        "SELECT role FROM space_members WHERE space_id = ? AND user_id = ?",
      )
      .get(spaceId, userId);

    if (!membership) {
      throw new SpaceRepositoryError(
        "SPACE_MEMBER_NOT_FOUND",
        "Space member not found",
      );
    }
    if (membership.role === "owner") {
      throw new SpaceRepositoryError(
        "SPACE_OWNER_REMOVAL_DENIED",
        "The owner cannot be removed or demoted",
      );
    }

    const result = db
      .prepare(
        `DELETE FROM space_members
          WHERE space_id = ? AND user_id = ? AND role = 'editor'`,
      )
      .run(spaceId, userId);
    if (result.changes !== 1) {
      throw new SpaceRepositoryError(
        "SPACE_MEMBER_NOT_FOUND",
        "Editor membership not found",
      );
    }
    bumpUsers(db, [...memberUserIds(db, spaceId), userId]);
    assertSpacesInvariants(db);
  });

  remove();
  const userIds = [...memberUserIds(db, spaceId), userId];
  return {
    spaceId,
    userId,
    revokedUserIds: [userId],
    userIds,
    versions: versionsForUsers(db, userIds),
    membershipVersion: membershipVersion(db, userId),
  };
}

export function getSpaceDetails({ actorUserId, spaceId }) {
  requireEnabled();
  requireUuid(spaceId, "spaceId");
  requireUuid(actorUserId, "actorUserId");
  requireUser(actorUserId);
  const db = getSpacesDb();
  const membership = membershipQuery(db, spaceId, actorUserId);
  if (!membership) {
    throw new SpaceRepositoryError("SPACE_NOT_FOUND", "Space not found");
  }

  const authDb = getAuthDb();
  const nameFor = authDb.prepare("SELECT name FROM users WHERE id = ?");
  const members = db.prepare(
    `SELECT user_id AS id, role, created_at AS memberSince
       FROM space_members
      WHERE space_id = ?
      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at, user_id`,
  ).all(spaceId).map((member) => ({
    ...member,
    name: nameFor.get(member.id)?.name || "Unknown collaborator",
  }));
  const invitations = membership.role === "owner"
    ? db.prepare(
      `SELECT invite_id AS id, email, role, expires_at AS expiresAt,
              created_at AS createdAt
         FROM space_invites
        WHERE space_id = ? AND used_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC`,
    ).all(spaceId)
    : [];

  return {
    space: {
      id: membership.spaceId,
      name: membership.name,
      role: membership.role,
      ownerUserId: membership.ownerUserId,
      createdAt: membership.createdAt,
      updatedAt: membership.updatedAt,
    },
    members,
    invitations,
    membershipVersion: membershipVersion(db, actorUserId),
  };
}

export function renameSpace({ actorUserId, spaceId, name }) {
  requireEnabled();
  requireUuid(spaceId, "spaceId");
  requireUuid(actorUserId, "actorUserId");
  requireUser(actorUserId);
  const normalizedName = typeof name === "string" ? name.trim() : "";
  if (!normalizedName || normalizedName.length > 100) {
    throw new SpaceRepositoryError("INVALID_SPACE_NAME", "Space name is required");
  }
  const db = getSpacesDb();
  const changed = db.transaction(() => {
    requireOwner(db, spaceId, actorUserId);
    const userIds = memberUserIds(db, spaceId);
    db.prepare(
      "UPDATE spaces SET name = ?, updated_at = ? WHERE id = ? AND status = 'active'",
    ).run(normalizedName, new Date().toISOString(), spaceId);
    bumpUsers(db, userIds);
    assertSpacesInvariants(db);
    return { userIds, versions: versionsForUsers(db, userIds) };
  })();
  return { spaceId, name: normalizedName, ...changed };
}

export function createSpaceInvite({
  actorUserId,
  spaceId,
  email,
  role = "editor",
  now = new Date(),
  tokenFactory = () => crypto.randomBytes(32).toString("hex"),
}) {
  requireEnabled();
  requireUuid(spaceId, "spaceId");
  requireUuid(actorUserId, "actorUserId");
  requireEditorRole(role);
  requireUser(actorUserId);
  const normalizedEmail = requireInviteEmail(email);
  const token = tokenFactory();
  if (typeof token !== "string" || token.length < 32 || token.length > 256) {
    throw new SpaceRepositoryError("INVITE_TOKEN_FAILURE", "Unable to create invitation");
  }
  const tokenHash = hashInviteToken(token);
  const inviteId = uuidv4();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + INVITE_LIFETIME_MS).toISOString();
  const db = getSpacesDb();

  const result = db.transaction(() => {
    requireOwner(db, spaceId, actorUserId);
    const knownUser = getAuthDb().prepare(
      "SELECT id FROM users WHERE lower(trim(email)) = ?",
    ).get(normalizedEmail);
    if (knownUser && db.prepare(
      "SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?",
    ).get(spaceId, knownUser.id)) {
      throw new SpaceRepositoryError(
        "SPACE_MEMBER_EXISTS",
        "That account is already a member",
      );
    }

    db.prepare(
      `UPDATE space_invites SET revoked_at = ?
        WHERE space_id = ? AND email = ? AND used_at IS NULL AND revoked_at IS NULL`,
    ).run(createdAt, spaceId, normalizedEmail);
    db.prepare(
      `INSERT INTO space_invites
         (token_hash, space_id, email, role, expires_at, used_at, created_at,
          invite_id, revoked_at)
       VALUES (?, ?, ?, 'editor', ?, NULL, ?, ?, NULL)`,
    ).run(tokenHash, spaceId, normalizedEmail, expiresAt, createdAt, inviteId);
    const userIds = memberUserIds(db, spaceId);
    bumpUsers(db, userIds);
    assertSpacesInvariants(db);
    const spaceName = db.prepare("SELECT name FROM spaces WHERE id = ?").get(spaceId).name;
    return { userIds, versions: versionsForUsers(db, userIds), spaceName };
  })();

  return {
    invite: { id: inviteId, email: normalizedEmail, role: "editor", expiresAt, createdAt },
    token,
    ...result,
  };
}

export function revokeSpaceInvite({ actorUserId, spaceId, inviteId, now = new Date() }) {
  requireEnabled();
  requireUuid(spaceId, "spaceId");
  requireUuid(actorUserId, "actorUserId");
  requireUuid(inviteId, "inviteId");
  requireUser(actorUserId);
  const db = getSpacesDb();
  return db.transaction(() => {
    requireOwner(db, spaceId, actorUserId);
    const revoked = db.prepare(
      `UPDATE space_invites SET revoked_at = ?
        WHERE invite_id = ? AND space_id = ?
          AND used_at IS NULL AND revoked_at IS NULL`,
    ).run(now.toISOString(), inviteId, spaceId);
    if (revoked.changes !== 1) {
      throw new SpaceRepositoryError("SPACE_INVITE_NOT_FOUND", "Invitation not found");
    }
    const userIds = memberUserIds(db, spaceId);
    bumpUsers(db, userIds);
    assertSpacesInvariants(db);
    return { spaceId, inviteId, userIds, versions: versionsForUsers(db, userIds) };
  })();
}

export function resendSpaceInvite({ actorUserId, spaceId, inviteId, now = new Date(), tokenFactory }) {
  requireEnabled();
  requireUuid(spaceId, "spaceId");
  requireUuid(actorUserId, "actorUserId");
  requireUuid(inviteId, "inviteId");
  requireUser(actorUserId);
  const db = getSpacesDb();
  requireOwner(db, spaceId, actorUserId);
  const invite = db.prepare(
    `SELECT email FROM space_invites
      WHERE invite_id = ? AND space_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
  ).get(inviteId, spaceId);
  if (!invite) {
    throw new SpaceRepositoryError("SPACE_INVITE_NOT_FOUND", "Invitation not found");
  }
  return createSpaceInvite({
    actorUserId,
    spaceId,
    email: invite.email,
    now,
    ...(tokenFactory ? { tokenFactory } : {}),
  });
}

/**
 * Lists active, unexpired invitations addressed to the authenticated account.
 * Raw invitation tokens are never returned by this discovery endpoint.
 */
export function listPendingSpaceInvitations({ actorUserId, now = new Date() }) {
  requireEnabled();
  requireUuid(actorUserId, "actorUserId");
  const actor = requireUser(actorUserId);
  const actorEmail = normalizeInviteEmail(
    getAuthDb().prepare("SELECT email FROM users WHERE id = ?").get(actor.id)?.email,
  );
  if (!actorEmail) return [];

  return getSpacesDb().prepare(
    `SELECT i.invite_id AS id,
            s.name AS spaceName,
            i.role,
            i.expires_at AS expiresAt,
            i.created_at AS createdAt
       FROM space_invites i
       JOIN spaces s ON s.id = i.space_id
      WHERE i.email = ?
        AND i.used_at IS NULL
        AND i.revoked_at IS NULL
        AND i.expires_at > ?
        AND s.status = 'active'
        AND NOT EXISTS (
          SELECT 1
            FROM space_members m
           WHERE m.space_id = i.space_id AND m.user_id = ?
        )
      ORDER BY i.created_at DESC, i.invite_id`,
  ).all(actorEmail, now.toISOString(), actorUserId);
}

function acceptSpaceInviteSelection({
  actorUserId,
  tokenHash = null,
  inviteId = null,
  now = new Date(),
}) {
  requireEnabled();
  requireUuid(actorUserId, "actorUserId");
  const actor = requireUser(actorUserId);
  const db = getSpacesDb();
  const acceptedAt = now.toISOString();

  const candidate = db.prepare(
    `SELECT i.space_id AS spaceId, i.email, i.expires_at AS expiresAt, s.status
       FROM space_invites i JOIN spaces s ON s.id = i.space_id
      WHERE ((? IS NOT NULL AND i.token_hash = ?) OR (? IS NOT NULL AND i.invite_id = ?))
        AND i.used_at IS NULL AND i.revoked_at IS NULL`,
  ).get(tokenHash, tokenHash, inviteId, inviteId);
  const actorEmail = getAuthDb().prepare("SELECT email FROM users WHERE id = ?").get(actor.id)?.email;
  if (
    !candidate ||
    candidate.status !== "active" ||
    Date.parse(candidate.expiresAt) <= now.getTime() ||
    normalizeInviteEmail(actorEmail) !== candidate.email
  ) {
    throw new SpaceRepositoryError("SPACE_INVITE_INVALID", "Invitation is invalid or expired");
  }
  try {
    ensureSpaceProfile(candidate.spaceId, actorUserId);
  } catch (error) {
    console.error("[spaces] profile replication failed", { code: error?.code || "UNKNOWN" });
    throw new SpaceRepositoryError("SPACE_INVITE_RETRY", "Invitation could not be accepted yet");
  }

  const result = db.transaction(() => {
    const invite = db.prepare(
      `SELECT i.invite_id AS inviteId, i.space_id AS spaceId, i.email, i.expires_at AS expiresAt,
              s.status
         FROM space_invites i
         JOIN spaces s ON s.id = i.space_id
        WHERE ((? IS NOT NULL AND i.token_hash = ?) OR (? IS NOT NULL AND i.invite_id = ?))
          AND i.used_at IS NULL AND i.revoked_at IS NULL`,
    ).get(tokenHash, tokenHash, inviteId, inviteId);
    const authEmail = getAuthDb().prepare("SELECT email FROM users WHERE id = ?").get(actor.id)?.email;
    if (
      !invite ||
      invite.status !== "active" ||
      Date.parse(invite.expiresAt) <= now.getTime() ||
      normalizeInviteEmail(authEmail) !== invite.email
    ) {
      throw new SpaceRepositoryError(
        "SPACE_INVITE_INVALID",
        "Invitation is invalid or expired",
      );
    }
    if (db.prepare(
      "SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?",
    ).get(invite.spaceId, actorUserId)) {
      throw new SpaceRepositoryError("SPACE_INVITE_INVALID", "Invitation is invalid or expired");
    }
    const memberCount = db.prepare(
      "SELECT COUNT(*) AS count FROM space_members WHERE space_id = ?",
    ).get(invite.spaceId)?.count ?? 0;
    if (memberCount >= positiveLimit("SPACE_MEMBER_LIMIT", 100)) {
      throw new SpaceRepositoryError("SPACE_MEMBER_LIMIT", "This space has reached its member limit");
    }
    const joinedCount = db.prepare(
      "SELECT COUNT(*) AS count FROM space_members WHERE user_id = ?",
    ).get(actorUserId)?.count ?? 0;
    if (joinedCount >= positiveLimit("SPACE_JOINED_LIMIT", 100)) {
      throw new SpaceRepositoryError("SPACE_JOINED_LIMIT", "This account has reached its joined-space limit");
    }

    db.prepare(
      `INSERT INTO space_members (space_id, user_id, role, invited_by, created_at)
       SELECT space_id, ?, 'editor', s.owner_user_id, ?
         FROM space_invites i JOIN spaces s ON s.id = i.space_id
        WHERE i.invite_id = ?`,
    ).run(actorUserId, acceptedAt, invite.inviteId);
    db.prepare("UPDATE space_invites SET used_at = ? WHERE invite_id = ?")
      .run(acceptedAt, invite.inviteId);
    const userIds = memberUserIds(db, invite.spaceId);
    bumpUsers(db, userIds);
    assertSpacesInvariants(db);
    return {
      spaceId: invite.spaceId,
      userIds,
      versions: versionsForUsers(db, userIds),
    };
  })();
  return result;
}

export function acceptSpaceInvite({ actorUserId, token, now = new Date() }) {
  requireEnabled();
  requireUuid(actorUserId, "actorUserId");
  requireUser(actorUserId);
  if (typeof token !== "string" || token.length < 32 || token.length > 256) {
    throw new SpaceRepositoryError("SPACE_INVITE_INVALID", "Invitation is invalid or expired");
  }
  return acceptSpaceInviteSelection({
    actorUserId,
    tokenHash: hashInviteToken(token),
    now,
  });
}

/**
 * Accepts a discovered invitation by its public id after re-checking that the
 * authenticated account still owns the invited email address.
 */
export function acceptPendingSpaceInvitation({ actorUserId, inviteId, now = new Date() }) {
  requireEnabled();
  requireUuid(actorUserId, "actorUserId");
  requireUser(actorUserId);
  requireUuid(inviteId, "inviteId");
  return acceptSpaceInviteSelection({ actorUserId, inviteId, now });
}

export function transferSpaceOwnership({ actorUserId, spaceId, targetUserId }) {
  requireEnabled();
  requireUuid(spaceId, "spaceId");
  requireUuid(actorUserId, "actorUserId");
  requireUuid(targetUserId, "targetUserId");
  requireUser(actorUserId);
  requireUser(targetUserId);
  const db = getSpacesDb();
  return db.transaction(() => {
    requireOwner(db, spaceId, actorUserId);
    if (actorUserId === targetUserId) {
      throw new SpaceRepositoryError("SPACE_OWNER_UNCHANGED", "Select another editor");
    }
    const target = db.prepare(
      "SELECT role FROM space_members WHERE space_id = ? AND user_id = ?",
    ).get(spaceId, targetUserId);
    if (!target || target.role !== "editor") {
      throw new SpaceRepositoryError("SPACE_MEMBER_NOT_FOUND", "Editor not found");
    }
    db.prepare(
      "UPDATE space_members SET role = 'editor' WHERE space_id = ? AND user_id = ? AND role = 'owner'",
    ).run(spaceId, actorUserId);
    db.prepare(
      "UPDATE space_members SET role = 'owner' WHERE space_id = ? AND user_id = ? AND role = 'editor'",
    ).run(spaceId, targetUserId);
    db.prepare(
      "UPDATE spaces SET owner_user_id = ?, updated_at = ? WHERE id = ?",
    ).run(targetUserId, new Date().toISOString(), spaceId);
    const userIds = memberUserIds(db, spaceId);
    bumpUsers(db, userIds);
    assertSpacesInvariants(db);
    return { spaceId, ownerUserId: targetUserId, userIds, versions: versionsForUsers(db, userIds) };
  })();
}

export function leaveSpace({ actorUserId, spaceId }) {
  requireEnabled();
  requireUuid(spaceId, "spaceId");
  requireUuid(actorUserId, "actorUserId");
  requireUser(actorUserId);
  const db = getSpacesDb();
  return db.transaction(() => {
    const membership = membershipQuery(db, spaceId, actorUserId);
    if (!membership) throw new SpaceRepositoryError("SPACE_NOT_FOUND", "Space not found");
    if (membership.role === "owner") {
      throw new SpaceRepositoryError(
        "SPACE_OWNER_LEAVE_DENIED",
        "Transfer ownership before leaving this space",
      );
    }
    db.prepare("DELETE FROM space_members WHERE space_id = ? AND user_id = ?")
      .run(spaceId, actorUserId);
    const remaining = memberUserIds(db, spaceId);
    const userIds = [...remaining, actorUserId];
    bumpUsers(db, userIds);
    assertSpacesInvariants(db);
    return { spaceId, revokedUserIds: [actorUserId], userIds, versions: versionsForUsers(db, userIds) };
  })();
}

export function requestSpaceDeletion({ actorUserId, spaceId, now = new Date() }) {
  requireEnabled();
  requireUuid(spaceId, "spaceId");
  requireUuid(actorUserId, "actorUserId");
  requireUser(actorUserId);
  const db = getSpacesDb();
  return db.transaction(() => {
    requireOwner(db, spaceId, actorUserId);
    const userIds = memberUserIds(db, spaceId);
    const deleteAfter = new Date(now.getTime() + DELETE_RETENTION_MS).toISOString();
    db.prepare(
      `UPDATE spaces
          SET status = 'pending_delete', delete_after = ?, updated_at = ?
        WHERE id = ? AND status = 'active'`,
    ).run(deleteAfter, now.toISOString(), spaceId);
    db.prepare(
      `UPDATE space_invites SET revoked_at = ?
        WHERE space_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
    ).run(now.toISOString(), spaceId);
    bumpUsers(db, userIds);
    assertSpacesInvariants(db);
    return {
      spaceId,
      deleteAfter,
      revokedUserIds: userIds,
      userIds,
      versions: versionsForUsers(db, userIds),
    };
  })();
}

export function purgeExpiredSpaces({
  now = new Date(),
  removeContent = (spaceId) => deleteDb(`space:${spaceId}`),
  removeUploads = deleteSpaceUploads,
} = {}) {
  const db = getSpacesDb();
  const due = db.prepare(
    `SELECT id FROM spaces
      WHERE status = 'pending_delete' AND delete_after <= ?
      ORDER BY delete_after, id`,
  ).all(now.toISOString());
  const purged = [];
  const failed = [];

  for (const { id: spaceId } of due) {
    try {
      removeContent(spaceId);
      removeUploads(spaceId);
      db.transaction(() => {
        const stillDue = db.prepare(
          `SELECT 1 FROM spaces
            WHERE id = ? AND status = 'pending_delete' AND delete_after <= ?`,
        ).get(spaceId, now.toISOString());
        if (!stillDue) return;
        db.prepare("DELETE FROM space_invites WHERE space_id = ?").run(spaceId);
        db.prepare("DELETE FROM space_members WHERE space_id = ?").run(spaceId);
        db.prepare("DELETE FROM spaces WHERE id = ?").run(spaceId);
        assertSpacesInvariants(db);
        purged.push(spaceId);
      })();
    } catch (error) {
      failed.push({ spaceId, code: error?.code || "PURGE_FAILED" });
      console.error("[spaces] retained space purge failed", {
        code: error?.code || "PURGE_FAILED",
      });
    }
  }
  return { purged, failed };
}

export function startSpaceDeletionJob({ intervalMs = SPACE_DELETE_SWEEP_MS } = {}) {
  const timer = setInterval(() => {
    try {
      purgeExpiredSpaces();
    } catch (error) {
      console.error("[spaces] deletion sweep failed", { code: error?.code || "SWEEP_FAILED" });
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

export function assertAccountDeletionAllowed(userId) {
  requireUuid(userId, "userId");
  const owned = getSpacesDb().prepare(
    "SELECT 1 FROM spaces WHERE owner_user_id = ? LIMIT 1",
  ).get(userId);
  if (owned) {
    throw new SpaceRepositoryError(
      "OWNED_SPACES_REMAIN",
      "Transfer ownership or finish deleting every owned space first",
    );
  }
  return true;
}

/**
 * The one shared-space authorization resolver for `/sync` and the WebSocket
 * subscribe/poke paths (COLLAB-04 §4.2, §4.3). It never trusts a
 * client-supplied user id: `actorUserId` must come from `req.user.user_id`
 * (the authenticated JWT subject) at every call site. It never throws for an
 * ordinary "no access" outcome — disabled flag, invalid input, unknown
 * space, non-member, and pending-deletion space are all indistinguishable
 * `null` so a caller cannot use it to probe space existence. It returns the
 * active membership plus the caller's current space_user_versions version.
 *
 * A genuine metadata operational failure (e.g. `_spaces.db` unreadable) is
 * NOT swallowed into that same `null` — it propagates as a thrown error, so
 * callers can tell "not a member" apart from "we couldn't check" and
 * respond accordingly (never as a disclosing detail, but never as a silent
 * false negative either).
 */
export function resolveSpaceAccess(spaceOrOptions, suppliedActorUserId) {
  const spaceId =
    spaceOrOptions && typeof spaceOrOptions === "object"
      ? spaceOrOptions.spaceId
      : spaceOrOptions;
  const actorUserId =
    spaceOrOptions && typeof spaceOrOptions === "object"
      ? spaceOrOptions.actorUserId
      : suppliedActorUserId;

  if (!isSharedSpacesEnabled()) return null;
  if (typeof spaceId !== "string" || !validateUuid(spaceId)) return null;
  if (typeof actorUserId !== "string" || !validateUuid(actorUserId)) return null;

  const db = getSpacesDb();
  const membership = membershipQuery(db, spaceId, actorUserId);
  if (!membership) return null;
  return {
    spaceId: membership.spaceId,
    role: membership.role,
    membershipVersion: membershipVersion(db, actorUserId),
  };
}

/**
 * The caller's current space_user_versions version, or 0 when shared spaces
 * are disabled, the user id is invalid, or the user has no space activity
 * yet. Never returns 0 for a genuine metadata operational failure — see
 * `resolveSpaceAccess` above for the same rationale; that case propagates as
 * a thrown error instead so it can be surfaced as a real server failure.
 */
export function getSpaceMembershipVersion(userId) {
  if (!isSharedSpacesEnabled()) return 0;
  if (typeof userId !== "string" || !validateUuid(userId)) return 0;
  return membershipVersion(getSpacesDb(), userId);
}

async function publishLifecycleChange(req, result) {
  if (!req.clients || !result) return;
  const { closeCollabSpaceSessions, notifySpaceMembershipChanged, revokeSpaceSubscribers } = await import("./websocket.js");
  if (result.versions?.size) {
    notifySpaceMembershipChanged(req.clients, result.versions);
  }
  if (result.revokedUserIds?.length && result.spaceId) {
    if (result.deleteAfter) closeCollabSpaceSessions(req.clients, `space:${result.spaceId}`);
    revokeSpaceSubscribers(
      req.clients,
      `space:${result.spaceId}`,
      result.revokedUserIds,
    );
  }
}

function lifecycleErrorResponse(res, error) {
  const code = error?.code || "SPACE_OPERATION_FAILED";
  if (code === "SHARED_SPACES_DISABLED" || code === "SPACE_NOT_FOUND") {
    return res.status(404).json({ error: "Not found", code: "SPACE_NOT_FOUND" });
  }
  if (code === "SPACE_OWNER_REQUIRED") {
    return res.status(403).json({ error: "This action requires the space owner", code });
  }
  if (code === "SPACE_INVITE_INVALID") {
    return res.status(400).json({ error: "Invitation is invalid or expired", code });
  }
  if (code === "SPACE_INVITE_RETRY") {
    return res.status(503).json({ error: "Invitation could not be accepted yet", code });
  }
  if (
    code.startsWith("INVALID_") ||
    code === "INVITE_TOKEN_FAILURE"
  ) {
    return res.status(400).json({ error: error.message, code });
  }
  if (code === "SPACE_MEMBER_NOT_FOUND" || code === "SPACE_INVITE_NOT_FOUND") {
    return res.status(404).json({ error: "Not found", code });
  }
  if (
    code === "SPACE_MEMBER_EXISTS" ||
    code === "SPACE_OWNER_REMOVAL_DENIED" ||
    code === "SPACE_OWNER_LEAVE_DENIED" ||
    code === "SPACE_OWNER_UNCHANGED" ||
    code === "SPACE_OWNER_LIMIT" ||
    code === "SPACE_MEMBER_LIMIT" ||
    code === "SPACE_JOINED_LIMIT" ||
    code === "OWNED_SPACES_REMAIN"
  ) {
    return res.status(409).json({ error: error.message, code });
  }
  console.error("[spaces] lifecycle operation failed", { code });
  return res.status(500).json({ error: "Unable to complete the space operation" });
}

spaceRoutes.post("/spaces", async (req, res) => {
  try {
    const created = createSpace({ actorUserId: req.user.user_id, name: req.body?.name });
    const versions = new Map([[req.user.user_id, created.membershipVersion]]);
    await publishLifecycleChange(req, { versions });
    return res.status(201).json({
      space: {
        id: created.spaceId,
        name: created.name,
        role: created.role,
        ownerUserId: created.ownerUserId,
      },
      membershipVersion: created.membershipVersion,
    });
  } catch (error) {
    return lifecycleErrorResponse(res, error);
  }
});

spaceRoutes.get("/spaces/:spaceId", (req, res) => {
  try {
    return res.json(getSpaceDetails({
      actorUserId: req.user.user_id,
      spaceId: req.params.spaceId,
    }));
  } catch (error) {
    return lifecycleErrorResponse(res, error);
  }
});

spaceRoutes.patch("/spaces/:spaceId", async (req, res) => {
  try {
    const result = renameSpace({
      actorUserId: req.user.user_id,
      spaceId: req.params.spaceId,
      name: req.body?.name,
    });
    await publishLifecycleChange(req, result);
    return res.json({ space: { id: result.spaceId, name: result.name } });
  } catch (error) {
    return lifecycleErrorResponse(res, error);
  }
});

spaceRoutes.post("/spaces/:spaceId/invitations", async (req, res) => {
  try {
    const result = createSpaceInvite({
      actorUserId: req.user.user_id,
      spaceId: req.params.spaceId,
      email: req.body?.email,
      role: req.body?.role ?? "editor",
    });
    const emailSent = await sendSpaceInviteEmail(
      result.invite.email,
      result.token,
      result.spaceName,
    );
    await publishLifecycleChange(req, result);
    return res.status(201).json({
      invitation: result.invite,
      invitationUrl: buildSpaceInviteUrl(result.token),
      emailSent,
    });
  } catch (error) {
    return lifecycleErrorResponse(res, error);
  }
});

spaceRoutes.delete("/spaces/:spaceId/invitations/:inviteId", async (req, res) => {
  try {
    const result = revokeSpaceInvite({
      actorUserId: req.user.user_id,
      spaceId: req.params.spaceId,
      inviteId: req.params.inviteId,
    });
    await publishLifecycleChange(req, result);
    return res.status(204).end();
  } catch (error) {
    return lifecycleErrorResponse(res, error);
  }
});

spaceRoutes.post("/spaces/:spaceId/invitations/:inviteId/resend", async (req, res) => {
  try {
    const result = resendSpaceInvite({
      actorUserId: req.user.user_id,
      spaceId: req.params.spaceId,
      inviteId: req.params.inviteId,
    });
    const emailSent = await sendSpaceInviteEmail(
      result.invite.email,
      result.token,
      result.spaceName,
    );
    await publishLifecycleChange(req, result);
    return res.json({
      invitation: result.invite,
      invitationUrl: buildSpaceInviteUrl(result.token),
      emailSent,
    });
  } catch (error) {
    return lifecycleErrorResponse(res, error);
  }
});

spaceRoutes.get("/space-invitations", (req, res) => {
  try {
    return res.json({
      invitations: listPendingSpaceInvitations({ actorUserId: req.user.user_id }),
    });
  } catch (error) {
    return lifecycleErrorResponse(res, error);
  }
});

spaceRoutes.post("/space-invitations/:inviteId/accept", async (req, res) => {
  try {
    const result = acceptPendingSpaceInvitation({
      actorUserId: req.user.user_id,
      inviteId: req.params.inviteId,
    });
    await publishLifecycleChange(req, result);
    return res.json({
      accepted: true,
      spaceId: result.spaceId,
      membershipVersion: result.versions.get(req.user.user_id),
    });
  } catch (error) {
    return lifecycleErrorResponse(res, error);
  }
});

spaceRoutes.post("/space-invitations/accept", async (req, res) => {
  try {
    const result = acceptSpaceInvite({
      actorUserId: req.user.user_id,
      token: req.body?.token,
    });
    await publishLifecycleChange(req, result);
    return res.json({ accepted: true, membershipVersion: result.versions.get(req.user.user_id) });
  } catch (error) {
    return lifecycleErrorResponse(res, error);
  }
});

spaceRoutes.delete("/spaces/:spaceId/members/:userId", async (req, res) => {
  try {
    const result = removeEditorMember({
      actorUserId: req.user.user_id,
      spaceId: req.params.spaceId,
      userId: req.params.userId,
    });
    await publishLifecycleChange(req, result);
    return res.status(204).end();
  } catch (error) {
    return lifecycleErrorResponse(res, error);
  }
});

spaceRoutes.post("/spaces/:spaceId/ownership", async (req, res) => {
  try {
    const result = transferSpaceOwnership({
      actorUserId: req.user.user_id,
      spaceId: req.params.spaceId,
      targetUserId: req.body?.userId,
    });
    await publishLifecycleChange(req, result);
    return res.json({ ownerUserId: result.ownerUserId });
  } catch (error) {
    return lifecycleErrorResponse(res, error);
  }
});

spaceRoutes.post("/spaces/:spaceId/leave", async (req, res) => {
  try {
    const result = leaveSpace({
      actorUserId: req.user.user_id,
      spaceId: req.params.spaceId,
    });
    await publishLifecycleChange(req, result);
    return res.status(204).end();
  } catch (error) {
    return lifecycleErrorResponse(res, error);
  }
});

spaceRoutes.post("/spaces/:spaceId/deletion-request", async (req, res) => {
  try {
    const result = requestSpaceDeletion({
      actorUserId: req.user.user_id,
      spaceId: req.params.spaceId,
    });
    await publishLifecycleChange(req, result);
    return res.status(202).json({ deleteAfter: result.deleteAfter });
  } catch (error) {
    return lifecycleErrorResponse(res, error);
  }
});
