// backend/api-service/websocket.js
//
// COLLAB-00 §4 versioned WebSocket protocol (Phase 2 subset): a v1
// subscribe/unsubscribe envelope layered on top of the existing legacy
// handshake (token + siteId query params, unversioned `{type:'sync'}`
// pokes for personal connections). Personal poke behavior is left
// byte-for-byte unchanged; this module only adds the new v1 control
// messages and a second, additive poke path for shared spaces.
//
// Never logs user ids, space ids, or message payload content — only stable
// event names and error codes.
import { validate as validateUuid } from "uuid";
import jwt from "jsonwebtoken";
import { URL } from "url";
import { getAuthDb, parseDbKey } from "./db.js";
import { resolveSpaceAccess, getSpaceMembershipVersion } from "./spaces.js";
import { COLLAB_LIMITS, createCollabSessionManager } from "./collab.js";

export const WS_PROTOCOL_VERSION = 1;

// COLLAB-00 §4 resource limits.
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
export const MAX_MESSAGE_BYTES = COLLAB_LIMITS.maxMessageBytes;
export const MAX_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
export const MAX_SPACE_SUBSCRIPTIONS = 100;
export const MAX_TOTAL_SUBSCRIPTIONS = MAX_SPACE_SUBSCRIPTIONS + 1; // +1 personal
export const MAX_CONNECTIONS_PER_USER = 10;

const SITE_ID_PATTERN = /^[0-9a-f]{32}$/;

export function isValidSiteId(value) {
  return typeof value === "string" && SITE_ID_PATTERN.test(value);
}

function isValidRequestId(value) {
  return typeof value === "string" && validateUuid(value);
}

/** Creates the per-socket state stored in the `clients` map at handshake. */
export function createClientState({ userId, siteId }) {
  return {
    userId,
    siteId,
    // dbKey -> siteId, the v1 subscription set. Starts empty per COLLAB-00
    // §4 ("new sockets begin with empty subscriptions"); the legacy
    // userId/siteId fields above remain the sole source of truth for
    // legacy personal pokes so that behavior is unaffected by this map.
    subscriptions: new Map(),
  };
}

function errorEnvelope(type, requestId, code, message, retryable = false) {
  return {
    v: WS_PROTOCOL_VERSION,
    type,
    requestId: requestId ?? null,
    ok: false,
    error: { code, message, retryable },
  };
}

function okEnvelope(type, requestId, payload) {
  return {
    v: WS_PROTOCOL_VERSION,
    type,
    requestId: requestId ?? null,
    ok: true,
    payload,
  };
}

/** Sends a JSON envelope, respecting outbound backpressure (COLLAB-00 §4). */
export function safeSend(ws, envelope) {
  if (!ws || ws.readyState !== 1 /* OPEN */) return false;
  if ((ws.bufferedAmount || 0) > MAX_BACKPRESSURE_BYTES) {
    try {
      ws.close(1013, "Too much backlog");
    } catch {
      // Best-effort; the socket may already be closing.
    }
    return false;
  }
  try {
    ws.send(JSON.stringify(envelope));
    return true;
  } catch (err) {
    console.error("[websocket] Failed to send envelope:", err?.code || err?.message || "unknown error");
    return false;
  }
}

function subscriptionsToPayload(subscriptions) {
  return [...subscriptions.entries()].map(([dbKey, siteId]) => ({ dbKey, siteId }));
}

function countSpaceSubscriptions(subscriptions) {
  let count = 0;
  for (const dbKey of subscriptions.keys()) {
    if (dbKey.startsWith("space:")) count += 1;
  }
  return count;
}

/**
 * Authorizes one dbKey for one actor. Returns `authorized: true` when the
 * dbKey may be subscribed to, `false` for an ordinary "no access" outcome
 * (unknown space, non-member, flag-disabled, or a foreign user key — all
 * indistinguishable to the caller). `internalError: true` signals a genuine
 * metadata operational failure (e.g. `_spaces.db` unreadable): this is
 * never coerced into an ordinary rejection, so the caller can surface it as
 * a real server failure instead of a false "not found".
 */
function isDbKeyAuthorized(dbKey, actorUserId) {
  let parsed;
  try {
    parsed = parseDbKey(dbKey);
  } catch {
    return { authorized: false, malformed: true };
  }

  if (parsed.kind === "user") {
    return { authorized: parsed.id === actorUserId, malformed: false };
  }

  // parsed.kind === "space"
  try {
    const access = resolveSpaceAccess(parsed.id, actorUserId);
    return { authorized: !!access, malformed: false };
  } catch (error) {
    console.error("[websocket] space access check failed:", error?.code || error?.message || "unknown error");
    return { authorized: false, malformed: false, internalError: true };
  }
}

/**
 * Validates and, only if the entire request is valid, atomically commits a
 * batch of subscriptions onto `clientState.subscriptions`. Re-subscribing to
 * an already-subscribed dbKey with the same siteId is a no-op (idempotent)
 * and does not count against capacity.
 */
export function handleSubscribe(clientState, actorUserId, payload) {
  // COLLAB-00 §4: the subscribe request payload is `{ databases: [...] }`;
  // the success *response* payload is `{ subscriptions, membershipVersion }`
  // (see the return value below) — the two are deliberately named
  // differently and must not be confused or aliased.
  const items = Array.isArray(payload?.databases) ? payload.databases : null;
  if (!items || items.length === 0) {
    return { code: "INVALID_SUBSCRIPTION", message: "databases must be a non-empty array" };
  }

  // Pass 1: structural validation + intra-request dedupe/conflict check.
  // Nothing is mutated yet.
  const requestedByDbKey = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object") {
      return { code: "INVALID_SUBSCRIPTION", message: "each subscription entry must be an object" };
    }
    const { dbKey, siteId } = item;
    if (typeof dbKey !== "string" || dbKey.length === 0) {
      return { code: "INVALID_SUBSCRIPTION", message: "dbKey is required" };
    }
    if (!isValidSiteId(siteId)) {
      return { code: "INVALID_SITE_ID", message: "siteId must be 32 lowercase hex characters" };
    }
    const previous = requestedByDbKey.get(dbKey);
    if (previous && previous !== siteId) {
      return { code: "SUBSCRIPTION_CONFLICT", message: "dbKey requested with conflicting site ids" };
    }
    requestedByDbKey.set(dbKey, siteId);
  }

  // Pass 2: authorize against the current actor and detect conflicts with
  // subscriptions already committed on this socket. Still read-only.
  const toCommit = [];
  for (const [dbKey, siteId] of requestedByDbKey) {
    const existingSiteId = clientState.subscriptions.get(dbKey);
    if (existingSiteId) {
      if (existingSiteId !== siteId) {
        return { code: "SUBSCRIPTION_CONFLICT", message: "dbKey already subscribed under a different site id" };
      }
      // Exact duplicate of an existing subscription: idempotent no-op.
      continue;
    }

    const { authorized, malformed, internalError } = isDbKeyAuthorized(dbKey, actorUserId);
    if (malformed) {
      return { code: "INVALID_SUBSCRIPTION", message: "dbKey is malformed" };
    }
    if (internalError) {
      return {
        code: "INTERNAL_ERROR",
        message: "Temporarily unable to verify subscription access",
        retryable: true,
      };
    }
    if (!authorized) {
      return { code: "SPACE_NOT_FOUND", message: "Subscription target not found" };
    }

    toCommit.push({ dbKey, siteId, isSpace: dbKey.startsWith("space:") });
  }

  // Capacity check over the *projected* final state (existing + new).
  const projectedSpaceCount =
    countSpaceSubscriptions(clientState.subscriptions) + toCommit.filter((e) => e.isSpace).length;
  if (projectedSpaceCount > MAX_SPACE_SUBSCRIPTIONS) {
    return { code: "SUBSCRIPTION_LIMIT", message: "Too many space subscriptions" };
  }
  const projectedTotal = clientState.subscriptions.size + toCommit.length;
  if (projectedTotal > MAX_TOTAL_SUBSCRIPTIONS) {
    return { code: "SUBSCRIPTION_LIMIT", message: "Too many subscriptions" };
  }

  // Resolve the response's membershipVersion *before* committing anything,
  // so a metadata operational failure here aborts the whole request (no
  // partial commit) instead of silently reporting a stale/default version
  // for an otherwise-successful subscribe.
  let currentMembershipVersion;
  try {
    currentMembershipVersion = getSpaceMembershipVersion(actorUserId);
  } catch (error) {
    console.error("[websocket] membership version lookup failed:", error?.code || error?.message || "unknown error");
    return {
      code: "INTERNAL_ERROR",
      message: "Temporarily unable to complete subscription",
      retryable: true,
    };
  }

  // Commit: only now do we mutate client state.
  for (const { dbKey, siteId } of toCommit) {
    clientState.subscriptions.set(dbKey, siteId);
  }

  return {
    subscriptions: subscriptionsToPayload(clientState.subscriptions),
    membershipVersion: currentMembershipVersion,
  };
}

/** Unsubscribing an unknown/absent dbKey is idempotent, not an error. */
export function handleUnsubscribe(clientState, payload) {
  const dbKeys = Array.isArray(payload?.dbKeys) ? payload.dbKeys : null;
  if (!dbKeys || dbKeys.length === 0) {
    return { code: "INVALID_SUBSCRIPTION", message: "dbKeys must be a non-empty array" };
  }
  for (const dbKey of dbKeys) {
    if (typeof dbKey !== "string" || dbKey.length === 0) {
      return { code: "INVALID_SUBSCRIPTION", message: "each dbKey must be a non-empty string" };
    }
  }

  for (const dbKey of dbKeys) {
    clientState.subscriptions.delete(dbKey);
  }

  return { subscriptions: subscriptionsToPayload(clientState.subscriptions) };
}

/**
 * Top-level entry point for one inbound WebSocket message. `rawData` is
 * whatever the `ws` library hands to the `message` event (Buffer or
 * string). Always safe to call: malformed/unsupported messages get a
 * versioned error response and never mutate `clientState`.
 */
export function handleClientMessage(ws, clientState, rawData, collabManager = null) {
  const buffer = Buffer.isBuffer(rawData) ? rawData : Buffer.from(String(rawData ?? ""), "utf8");
  if (buffer.length > MAX_MESSAGE_BYTES) {
    try {
      ws.close(1009, "Message too large");
    } catch {
      // Best-effort.
    }
    return;
  }

  let msg;
  try {
    msg = JSON.parse(buffer.toString("utf8"));
  } catch {
    safeSend(ws, errorEnvelope("error", null, "UNKNOWN_MESSAGE", "Message is not valid JSON"));
    return;
  }

  if (!msg || typeof msg !== "object") {
    safeSend(ws, errorEnvelope("error", null, "UNKNOWN_MESSAGE", "Message must be a JSON object"));
    return;
  }

  const requestId = isValidRequestId(msg.requestId) ? msg.requestId : null;
  const responseType = typeof msg.type === "string" ? msg.type : "error";

  if (!responseType.startsWith("collab:") && buffer.length > MAX_CONTROL_FRAME_BYTES) {
    try {
      ws.close(1009, "Message too large");
    } catch {
      // Best-effort.
    }
    return;
  }

  if (msg.v !== WS_PROTOCOL_VERSION) {
    safeSend(
      ws,
      errorEnvelope(responseType, requestId, "UNSUPPORTED_PROTOCOL", "Unsupported protocol version"),
    );
    return;
  }

  if (!isValidRequestId(msg.requestId)) {
    safeSend(
      ws,
      errorEnvelope(responseType, null, "INVALID_REQUEST", "requestId must be a UUID"),
    );
    return;
  }

  if (responseType.startsWith("collab:") && collabManager) {
    void collabManager.handle(ws, clientState, msg);
    return;
  }

  if (responseType !== "subscribe" && responseType !== "unsubscribe") {
    safeSend(ws, errorEnvelope(responseType, requestId, "UNKNOWN_MESSAGE", "Unsupported message type"));
    return;
  }

  const actorUserId = clientState.userId;

  if (responseType === "subscribe") {
    const result = handleSubscribe(clientState, actorUserId, msg.payload);
    if (result?.code) {
      safeSend(ws, errorEnvelope("subscribe", requestId, result.code, result.message, !!result.retryable));
      return;
    }
    safeSend(ws, okEnvelope("subscribe", requestId, result));
    return;
  }

  // responseType === "unsubscribe"
  const result = handleUnsubscribe(clientState, msg.payload);
  if (result?.code) {
    safeSend(ws, errorEnvelope("unsubscribe", requestId, result.code, result.message));
    return;
  }
  safeSend(ws, okEnvelope("unsubscribe", requestId, result));
}

/**
 * Legacy personal poke: notifies same-user sockets other than the
 * originating siteId. Byte-for-byte identical to the pre-Phase-2 behavior
 * (`{type:'sync'}`, no `v`/`payload`) so existing clients are unaffected.
 */
export function pokePersonalClients(clients, userId, excludeSiteId) {
  clients.forEach((clientState, clientWs) => {
    if (clientState.userId === userId && clientState.siteId !== excludeSiteId) {
      if (clientWs.readyState === 1) {
        clientWs.send(JSON.stringify({ type: "sync" }));
      }
    }
  });
}

/**
 * Space poke: notifies every socket currently subscribed to `dbKey`
 * (excluding the originating siteId for that same dbKey), re-checking
 * membership at poke time. A subscriber who has lost access is dropped from
 * its subscription set and, best-effort, told so via a revocation notice
 * rather than silently poked. A metadata *operational* failure while
 * re-checking is not the same as losing access: it never revokes a real
 * subscription, and it never aborts delivery to the other subscribers on
 * this dbKey — the affected client is simply skipped for this poke and
 * re-checked again on the next subscribe/poke.
 */
export function pokeSpaceSubscribers(clients, dbKey, excludeSiteId) {
  let parsed;
  try {
    parsed = parseDbKey(dbKey);
  } catch {
    return;
  }
  if (parsed.kind !== "space") return;

  clients.forEach((clientState, clientWs) => {
    const subscribedSiteId = clientState.subscriptions.get(dbKey);
    if (!subscribedSiteId) return;

    let access;
    try {
      access = resolveSpaceAccess(parsed.id, clientState.userId);
    } catch (error) {
      console.error("[websocket] poke membership re-check failed:", error?.code || error?.message || "unknown error");
      return;
    }
    if (!access) {
      clientState.subscriptions.delete(dbKey);
      safeSend(clientWs, {
        v: WS_PROTOCOL_VERSION,
        type: "subscription:revoked",
        requestId: null,
        ok: true,
        payload: { dbKey },
      });
      return;
    }

    if (subscribedSiteId === excludeSiteId) return;

    safeSend(clientWs, {
      v: WS_PROTOCOL_VERSION,
      type: "sync",
      payload: { dbKey },
    });
  });
}

/**
 * Immediately revoke one space subscription for the named users. Membership
 * mutations call this only after their metadata transaction commits, so the
 * notice never gets ahead of authorization state.
 */
export function revokeSpaceSubscribers(clients, dbKey, userIds) {
  const revokedUsers = new Set(userIds || []);
  clients?.forEach((clientState, clientWs) => {
    if (!revokedUsers.has(clientState.userId)) return;
    if (!clientState.subscriptions?.has(dbKey)) return;
    clientState.collabManager?.revokeSocket(clientWs, clientState, dbKey);
    clientState.subscriptions.delete(dbKey);
    safeSend(clientWs, {
      v: WS_PROTOCOL_VERSION,
      type: "subscription:revoked",
      requestId: null,
      ok: true,
      payload: { dbKey },
    });
  });
}

function collabManagers(clients) {
  return new Set([...clients.values()].map((state) => state.collabManager).filter(Boolean));
}

export function closeCollabDocumentSessions(clients, dbKey, noteIds) {
  for (const manager of collabManagers(clients)) {
    for (const noteId of noteIds || []) manager.closeDocument(dbKey, noteId, "revoked");
  }
}

export function closeCollabSpaceSessions(clients, dbKey) {
  for (const manager of collabManagers(clients)) manager.closeSpace(dbKey, "revoked");
}

/** Notify connected clients that their space-list payload changed. */
export function notifySpaceMembershipChanged(clients, versionsByUser) {
  const versions = versionsByUser instanceof Map
    ? versionsByUser
    : new Map(Object.entries(versionsByUser || {}));
  clients?.forEach((clientState, clientWs) => {
    const version = versions.get(clientState.userId);
    if (!Number.isInteger(version)) return;
    safeSend(clientWs, {
      v: WS_PROTOCOL_VERSION,
      type: "membership:changed",
      payload: { membershipVersion: version },
    });
  });
}

function countConnectionsForUser(clients, userId) {
  let count = 0;
  clients.forEach((clientState) => {
    if (clientState.userId === userId) count += 1;
  });
  return count;
}

/**
 * Wires up the WebSocket handshake (legacy token/siteId query params, kept
 * unchanged) plus the new v1 message handler and a per-account connection
 * cap. Extracted from index.js so the whole protocol is unit-testable
 * independent of a live HTTP/WS server.
 */
export function attachWebSocketHandlers(wss, clients, jwtSecret) {
  const collabManager = createCollabSessionManager({
    poke: (dbKey, excludeSiteId) => pokeSpaceSubscribers(clients, dbKey, excludeSiteId),
  });
  wss.on("connection", (ws, req) => {
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const token = params.get("token");
    const siteId = params.get("siteId");

    if (!token || !siteId) return ws.close(1008, "Token and siteId required");

    jwt.verify(token, jwtSecret, (err, payload) => {
      if (err) return ws.close(1008, "Invalid token");

      const userId = payload.user_id;
      if (!getAuthDb().prepare("SELECT 1 FROM users WHERE id = ?").get(userId)) {
        return ws.close(1008, "Invalid token");
      }
      if (countConnectionsForUser(clients, userId) >= MAX_CONNECTIONS_PER_USER) {
        return ws.close(1008, "Too many connections for this account");
      }

      const clientState = createClientState({ userId, siteId });
      clientState.collabManager = collabManager;
      clients.set(ws, clientState);
      console.log("WebSocket client connected and authenticated");

      ws.on("message", (data) => {
        handleClientMessage(ws, clientState, data, collabManager);
      });

      ws.on("close", () => {
        collabManager.socketClosed(ws, clientState);
        clients.delete(ws);
        console.log("WebSocket client disconnected");
      });
    });
  });
  return collabManager;
}
