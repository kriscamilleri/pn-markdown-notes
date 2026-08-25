import SQLiteAsyncESMFactory from "./crsqlite.mjs";
import * as SQLite from "../wa-sqlite/sqlite-api.js";
// @ts-ignore
import { IDBBatchAtomicVFS } from "../wa-sqlite/examples/IDBBatchAtomicVFS.js";
import { serialize, topLevelMutex } from "./serialize.js";
import { DB } from "./DB.js";
export { DB } from "./DB.js";
let api = null;
export class SQLite3 {
    base;
    constructor(base) {
        this.base = base;
    }
    open(filename, mode = "c") {
        return serialize(null, undefined, () => {
            return this.base.open_v2(filename || ":memory:", SQLite.SQLITE_OPEN_CREATE |
                SQLite.SQLITE_OPEN_READWRITE |
                SQLite.SQLITE_OPEN_URI, filename != null ? "idb-batch-atomic" : undefined);
        }, topLevelMutex).then((db) => {
            const ret = new DB(this.base, db, filename || ":memory:");
            return ret
                .prepare(`SELECT tbl_name FROM tables_used(?) AS u
        JOIN sqlite_master ON sqlite_master.name = u.name
        WHERE u.schema = 'main'`)
                .then((stmt) => {
                stmt.raw(true);
                ret._setTablesUsedStmt(stmt);
            })
                .then(() => ret.execA("select quote(crsql_site_id());"))
                .then((siteid) => {
                ret._setSiteid(siteid[0][0].replace(/'|X/g, ""));
                return ret;
            });
        });
    }
}
export default async function initWasm(locateWasm) {
    if (api != null) {
        return api;
    }
    const wasmModule = await SQLiteAsyncESMFactory({
        locateFile(file) {
            if (locateWasm) {
                return locateWasm(file);
            }
            return new URL("crsqlite.wasm", import.meta.url).href;
        },
    });
    const sqlite3 = SQLite.Factory(wasmModule);
    sqlite3.vfs_register(new IDBBatchAtomicVFS("idb-batch-atomic", { durability: "relaxed" }));
    api = new SQLite3(sqlite3);
    return api;
}