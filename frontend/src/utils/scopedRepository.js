import { parseDatabaseKey } from './databaseKey.js';

/**
 * Create a repository that can never silently change database scope.
 *
 * @param {string} dbKey
 * @param {(dbKey:string) => {exec:Function,execO:Function}} resolveDatabase
 */
export function createScopedRepository(dbKey, resolveDatabase) {
  parseDatabaseKey(dbKey);
  if (typeof resolveDatabase !== 'function') {
    throw new Error('A scoped database resolver is required.');
  }

  const database = () => {
    const resolved = resolveDatabase(dbKey);
    if (!resolved) throw new Error(`Database scope ${dbKey} is not initialized.`);
    return resolved;
  };

  return Object.freeze({
    dbKey,
    execute(sql, params = []) {
      return database().execO(sql, params);
    },
    exec(sql, params = []) {
      return database().exec(sql, params);
    },
    async transaction(work) {
      const db = database();
      await db.exec('BEGIN');
      try {
        const result = await work({
          dbKey,
          execute: (sql, params = []) => db.execO(sql, params),
          exec: (sql, params = []) => db.exec(sql, params),
        });
        await db.exec('COMMIT');
        return result;
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    },
  });
}
