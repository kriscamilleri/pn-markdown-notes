import { computeCacheKey } from "./cache.js";
import { serialize } from "./serialize.js";
import * as SQLite from "../wa-sqlite/sqlite-api.js";
// TOOD: maybe lazily reset only if stmt is reused
export default class Stmt {
    originDB;
    stmtFinalizer;
    cache;
    api;
    base;
    str;
    sql;
    // TOOD: use mode in get/all!
    mode = "o";
    finalized = false;
    bindings = [];
    constructor(originDB, stmtFinalizer, 
    // stmtFinalizationRegistry: FinalizationRegistry<number>,
    cache, api, base, str, sql) {
        this.originDB = originDB;
        this.stmtFinalizer = stmtFinalizer;
        this.cache = cache;
        this.api = api;
        this.base = base;
        this.str = str;
        this.sql = sql;
        stmtFinalizer.set(base, this);
        // stmtFinalizationRegistry.register(this, base);
    }
    run(tx, ...bindArgs) {
        return serialize(this.cache, computeCacheKey(this.sql, this.mode, bindArgs.length > 0 ? bindArgs : this.bindings), () => {
            bindArgs.length > 0 && this.bind(bindArgs);
            return this.api.step(this.base).then(() => this.api.reset(this.base));
        }, tx?.__mutex || this.originDB.__mutex);
    }
    get(tx, ...bindArgs) {
        return serialize(this.cache, computeCacheKey(this.sql, this.mode, bindArgs.length > 0 ? bindArgs : this.bindings), async () => {
            bindArgs.length > 0 && this.bind(bindArgs);
            let ret = null;
            let columnNames = this.mode === "o" ? this.api.column_names(this.base) : null;
            if ((await this.api.step(this.base)) == SQLite.SQLITE_ROW) {
                const row = this.api.row(this.base);
                if (columnNames != null) {
                    const o = {};
                    for (let i = 0; i < columnNames.length; ++i) {
                        o[columnNames[i]] = row[i];
                    }
                    ret = o;
                }
                else {
                    ret = row;
                }
            }
            await this.api.reset(this.base);
            return ret;
        }, tx?.__mutex || this.originDB.__mutex);
    }
    all(tx, ...bindArgs) {
        return serialize(this.cache, computeCacheKey(this.sql, this.mode, bindArgs.length > 0 ? bindArgs : this.bindings), async () => {
            bindArgs.length > 0 && this.bind(bindArgs);
            const ret = [];
            let columnNames = this.mode === "o" ? this.api.column_names(this.base) : null;
            while ((await this.api.step(this.base)) == SQLite.SQLITE_ROW) {
                if (columnNames != null) {
                    const row = {};
                    for (let i = 0; i < columnNames.length; ++i) {
                        row[columnNames[i]] = this.api.column(this.base, i);
                    }
                    ret.push(row);
                }
                else {
                    ret.push(this.api.row(this.base));
                    continue;
                }
            }
            await this.api.reset(this.base);
            return ret;
        }, tx?.__mutex || this.originDB.__mutex);
    }
    async *iterate(tx, ...bindArgs) {
        this.bind(bindArgs);
        while ((await serialize(this.cache, undefined, () => this.api.step(this.base), tx?.__mutex || this.originDB.__mutex)) == SQLite.SQLITE_ROW) {
            yield this.api.row(this.base);
        }
        await serialize(this.cache, undefined, () => this.api.reset(this.base), tx?.__mutex || this.originDB.__mutex);
    }
    raw(isRaw) {
        if (isRaw) {
            this.mode = "a";
        }
        else {
            this.mode = "o";
        }
        return this;
    }
    bind(args) {
        this.bindings = args;
        for (let i = 0; i < args.length; ++i) {
            this.api.bind(this.base, i + 1, args[i]);
        }
        return this;
    }
    /**
     * Release the resources associated with the prepared statement.
     * If you fail to call this it will automatically be called when the statement is garbage collected.
     */
    finalize(tx) {
        return serialize(this.cache, undefined, () => {
            if (this.finalized)
                return;
            this.finalized = true;
            this.api.str_finish(this.str);
            this.stmtFinalizer.delete(this.base);
            return this.api.finalize(this.base);
        }, tx?.__mutex || this.originDB.__mutex);
    }
}