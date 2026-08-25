import { Mutex } from "async-mutex";
import { computeCacheKey } from "./cache.js";
import { serialize, serializeTx } from "./serialize.js";
import Stmt from "./Stmt.js";
import * as SQLite from "../wa-sqlite/sqlite-api.js";
export default class TX {
    api;
    db;
    __mutex;
    assertOpen;
    stmtFinalizer;
    cache = new Map();
    constructor(api, db, __mutex, assertOpen, stmtFinalizer) {
        this.api = api;
        this.db = db;
        this.__mutex = __mutex;
        this.assertOpen = assertOpen;
        this.stmtFinalizer = stmtFinalizer;
    }
    execMany(sql) {
        this.assertOpen();
        return serialize(this.cache, null, () => this.api.exec(this.db, sql.join("")), this.__mutex);
    }
    exec(sql, bind) {
        this.assertOpen();
        return serialize(this.cache, computeCacheKey(sql, "a", bind), () => {
            return this.statements(sql, false, bind);
        }, this.__mutex);
    }
    execO(sql, bind) {
        this.assertOpen();
        return serialize(this.cache, computeCacheKey(sql, "o", bind), () => this.statements(sql, true, bind), this.__mutex);
    }
    execA(sql, bind) {
        this.assertOpen();
        return serialize(this.cache, computeCacheKey(sql, "a", bind), () => this.statements(sql, false, bind), this.__mutex);
    }
    prepare(sql) {
        this.assertOpen();
        return serialize(this.cache, undefined, async () => {
            const str = this.api.str_new(this.db, sql);
            const prepared = await this.api.prepare_v2(this.db, this.api.str_value(str));
            if (prepared == null) {
                this.api.str_finish(str);
                throw new Error(`Could not prepare ${sql}`);
            }
            return new Stmt(this, this.stmtFinalizer, 
            // this.stmtFinalizationRegistry,
            this.cache, this.api, prepared.stmt, str, sql);
        }, this.__mutex);
    }
    tx(cb) {
        this.assertOpen();
        const id = 'crsql' + crypto.randomUUID().replaceAll("-", "");
        return serializeTx(async (tx) => {
            await tx.exec("SAVEPOINT " + id);
            try {
                await cb(tx);
            }
            catch (e) {
                await tx.exec("ROLLBACK TO " + id);
                await tx.exec("RELEASE " + id);
                throw e;
            }
            await tx.exec("RELEASE " + id);
        }, this.__mutex, this);
    }
    imperativeTx() {
        return this.__mutex.acquire().then((release) => {
            const subMutex = new Mutex();
            return [
                release,
                new TX(this.api, this.db, subMutex, this.assertOpen, this.stmtFinalizer),
            ];
        });
    }
    async statements(sql, retObjects, bind) {
        const results = [];
        const str = this.api.str_new(this.db, sql);
        let prepared = {
            stmt: null,
            sql: this.api.str_value(str),
        };
        try {
            while ((prepared = await this.api.prepare_v2(this.db, prepared.sql))) {
                const stmt = prepared.stmt;
                const rows = [];
                const columns = this.api.column_names(stmt);
                if (bind) {
                    this.bind(stmt, bind);
                }
                while ((await this.api.step(stmt)) === SQLite.SQLITE_ROW) {
                    const row = this.api.row(stmt);
                    rows.push(row);
                }
                if (columns.length) {
                    results.push({ columns, rows });
                }
                this.api.finalize(prepared.stmt);
                prepared.stmt = null;
            }
        }
        catch (error) {
            console.error(`Failed running ${sql}`, error);
            throw error;
        }
        finally {
            if (prepared?.stmt) {
                this.api.finalize(prepared.stmt);
            }
            this.api.str_finish(str);
        }
        // we'll only return results for first stmt
        // if (results.length > 1) {
        //   throw new Error("We currently only support 1 statement per query.");
        // }
        const returning = results[0];
        if (returning == null)
            return null;
        if (!retObjects) {
            return returning.rows;
        }
        const objects = [];
        for (const row of returning.rows) {
            const o = {};
            for (let i = 0; i < returning.columns.length; ++i) {
                o[returning.columns[i]] = row[i];
            }
            objects.push(o);
        }
        return objects;
    }
    bind(stmt, values) {
        for (let i = 0; i < values.length; ++i) {
            const v = values[i];
            this.api.bind(stmt, i + 1, typeof v === "boolean" ? (v && 1) || 0 : v);
        }
    }
}