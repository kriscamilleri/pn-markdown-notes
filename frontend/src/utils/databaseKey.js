import { validate as validateUuid } from 'uuid';

export const DATABASE_KINDS = Object.freeze({
  USER: 'user',
  SPACE: 'space',
});

/**
 * Build the only accepted database identifier shape.
 *
 * @param {'user'|'space'} kind
 * @param {string} id
 * @returns {string}
 */
export function createDatabaseKey(kind, id) {
  if (!Object.values(DATABASE_KINDS).includes(kind) || !validateUuid(id)) {
    throw new Error('Database scope must be a canonical user:<uuid> or space:<uuid> key.');
  }
  return `${kind}:${id.toLowerCase()}`;
}

/**
 * Parse and validate a canonical database key without accepting bare IDs.
 *
 * @param {string} dbKey
 * @returns {{ dbKey: string, kind: 'user'|'space', id: string }}
 */
export function parseDatabaseKey(dbKey) {
  if (typeof dbKey !== 'string') {
    throw new Error('Database scope is required.');
  }
  const separator = dbKey.indexOf(':');
  if (separator <= 0 || separator !== dbKey.lastIndexOf(':')) {
    throw new Error('Database scope must be a canonical user:<uuid> or space:<uuid> key.');
  }
  const kind = dbKey.slice(0, separator);
  const id = dbKey.slice(separator + 1);
  const canonical = createDatabaseKey(kind, id);
  if (canonical !== dbKey) {
    throw new Error('Database scope must use its canonical lowercase key.');
  }
  return { dbKey, kind, id };
}

/**
 * Return a stable browser database filename for one canonical database key.
 * Existing personal database names deliberately remain unchanged.
 *
 * @param {string} dbKey
 * @returns {string}
 */
export function localDatabaseName(dbKey) {
  const { kind, id } = parseDatabaseKey(dbKey);
  return kind === DATABASE_KINDS.USER
    ? `panino-${id}.db`
    : `panino-space-${id}.db`;
}

/**
 * Phase 4 adapter for APIs whose space-qualified routes do not exist until
 * Phase 6. The explicit scope prevents a shared node from hitting a plausible
 * personal endpoint.
 */
export function requirePersonalDatabaseKey(dbKey, operation = 'This operation') {
  const parsed = parseDatabaseKey(dbKey);
  if (parsed.kind !== DATABASE_KINDS.USER) {
    throw new Error(`${operation} is not available for shared-space Documents yet.`);
  }
  return parsed.dbKey;
}
