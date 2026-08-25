const isDebug = globalThis.__vlcn_wa_crsqlite_dbg;
export default function log(...data) {
    if (isDebug) {
        console.log("crsqlite-wasm: ", ...data);
    }
}