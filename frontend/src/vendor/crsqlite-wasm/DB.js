import { cryb64, firstPick, } from "../xplat-api/xplat-api.js";
import { SQLITE_UTF8 } from "../wa-sqlite/sqlite-api.js";
import { serialize, topLevelMutex } from "./serialize.js";
import TX from "./TX.js";
export class DB {
    api;
    db;
    filename;
    __mutex = topLevelMutex;
    stmtFinalizer = new Map();
    // private stmtFinalizationRegistry = new FinalizationRegistry(
    //   (base: number) => {
    //     const ref = this.stmtFinalizer.get(base);
    //     const stmt = ref?.deref();
    //     if (stmt) {
    //       console.log("finalized ", base);
    //       stmt.finalize();
    //     }
    //     this.stmtFinalizer.delete(base);
    //   }
    // );
    #siteid = null;
    #tablesUsedStmt = null;
    cache = new Map();
    #updateHooks = null;
    #closed = false;
    #tx;
    constructor(api, db, filename) {
        this.api = api;
        this.db = db;
        this.filename = filename;
        this.#tx = new TX(api, db, topLevelMutex, this.#assertOpen, this.stmtFinalizer);
    }
    get siteid() {
        return this.#siteid;
    }
    _setSiteid(siteid) {
        if (this.#siteid) {
            throw new Error("Site id already set");
        }
        this.#siteid = siteid;
    }
    _setTablesUsedStmt(stmt) {
        this.#tablesUsedStmt = stmt;
    }
    get tablesUsedStmt() {
        if (this.#tablesUsedStmt == null) {
            throw new Error("tablesUsedStmt not set");
        }
        return this.#tablesUsedStmt;
    }
    async automigrateTo(schemaName, schemaContent) {
        // less safety checks for local db than server db.
        const version = cryb64(schemaContent);
        const storedName = firstPick(await this.execA(`SELECT value FROM crsql_master WHERE key = 'schema_name'`));
        const storedVersion = firstPick(await this.execA(`SELECT value FROM crsql_master WHERE key = 'schema_version'`));
        if (storedName === schemaName && BigInt(storedVersion || 0) === version) {
            return "noop";
        }
        const ret = storedName === undefined || storedName !== schemaName
            ? "apply"
            : "migrate";
        await this.tx(async (tx) => {
            if (storedVersion == null || storedName !== schemaName) {
                if (storedName !== schemaName) {
                    // drop all tables since a schema name change is a reformat of the db.
                    const tables = await tx.execA(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'crsql_%'`);
                    for (const table of tables) {
                        await tx.exec(`DROP TABLE [${table[0]}]`);
                    }
                }
                await tx.exec(schemaContent);
            }
            else {
                await tx.exec(`SELECT crsql_automigrate(?, 'SELECT crsql_finalize();')`, [schemaContent]);
            }
            await tx.exec(`INSERT OR REPLACE INTO crsql_master (key, value) VALUES (?, ?)`, ["schema_version", version]);
            await tx.exec(`INSERT OR REPLACE INTO crsql_master (key, value) VALUES (?, ?)`, ["schema_name", schemaName]);
        });
        await this.exec(`VACUUM;`);
        return ret;
    }
    execMany(sql) {
        return this.#tx.execMany(sql);
    }
    exec(sql, bind) {
        return this.#tx.exec(sql, bind);
    }
    #assertOpen = () => {
        if (this.#closed) {
            throw new Error("The DB is closed");
        }
    };
    /**
     * @returns returns an object for each row, e.g. `{ col1: valA, col2: valB, ... }`
     */
    execO(sql, bind) {
        return this.#tx.execO(sql, bind);
    }
    // TODO: execOCached() -- which takes a table list
    /**
     * @returns returns an array for each row, e.g. `[ valA, valB, ... ]`
     */
    execA(sql, bind) {
        return this.#tx.execA(sql, bind);
    }
    prepare(sql) {
        return this.#tx.prepare(sql);
    }
    tx(cb) {
        return this.#tx.tx(cb);
    }
    imperativeTx() {
        return this.#tx.imperativeTx();
    }
    /**
     * Close the database and finalize any prepared statements that were not freed for the given DB.
     */
    async close() {
        for (const stmt of this.stmtFinalizer.values()) {
            await stmt.finalize(this);
        }
        this.#tablesUsedStmt?.finalize(this);
        return this.exec("SELECT crsql_finalize()").then(() => {
            this.#closed = true;
            return serialize(this.cache, undefined, () => this.api.close(this.db), this.__mutex);
        });
    }
    createFunction(name, fn, opts) {
        this.#assertOpen();
        this.api.create_function(this.db, name, fn.length, SQLITE_UTF8, 0, (context, values) => {
            const args = [];
            for (let i = 0; i < fn.length; ++i) {
                args.push(this.api.value(values[i]));
            }
            const r = fn(...args);
            if (r !== undefined) {
                this.api.result(context, r);
            }
        });
    }
    onUpdate(cb) {
        if (this.#updateHooks == null) {
            this.api.update_hook(this.db, this.#onUpdate);
            this.#updateHooks = new Set();
        }
        this.#updateHooks.add(cb);
        return () => this.#updateHooks?.delete(cb);
    }
    #onUpdate = (type, dbName, tblName, rowid) => {
        if (this.#updateHooks == null) {
            return;
        }
        this.#updateHooks.forEach((h) => {
            // we wrap these since listeners can be thought of as separate threads of execution
            // one dieing shouldn't prevent others from being notified.
            try {
                h(type, dbName, tblName, rowid);
            }
            catch (e) {
                console.error("Failed notifying a DB update listener");
                console.error(e);
            }
        });
    };
}