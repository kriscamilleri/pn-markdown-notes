/**
 * Client-side CR-SQLite packed-primary-key parsing, mirroring
 * `parsePkId` in `backend/api-service/sync.js`. A pk must never be guessed:
 * an unparseable pk returns `null` so the caller can treat it as a recoverable
 * conflict rather than silently accepting the remote body.
 */

function hexToBytes(hex) {
    if (typeof hex !== 'string') return null;
    const trimmed = hex.trim();
    if (trimmed.length === 0 || trimmed.length % 2 !== 0) return null;
    const bytes = new Uint8Array(trimmed.length / 2);
    for (let i = 0; i < trimmed.length; i += 2) {
        const byte = parseInt(trimmed.slice(i, i + 2), 16);
        if (Number.isNaN(byte)) return null;
        bytes[i / 2] = byte;
    }
    return bytes;
}

function objectToBytes(obj) {
    if (obj == null) return null;
    if (obj instanceof Uint8Array || obj instanceof ArrayBuffer) return new Uint8Array(obj);
    if (Array.isArray(obj)) return new Uint8Array(obj.map((n) => Number(n) & 0xff));
    const keys = Object.keys(obj);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
        return new Uint8Array(
            keys
                .sort((a, b) => Number(a) - Number(b))
                .map((k) => Number(obj[k]) & 0xff),
        );
    }
    return null;
}

function bytesToUtf8(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Extracts the note id from a packed primary key. Accepts the hex form the
 * `/sync` response returns, plus the array/object forms the local change table
 * may surface, to stay compatible with the backend parser.
 *
 * @param {string | Array | Uint8Array | Record<string, number> | null | undefined} pk
 * @returns {string | null}
 */
export function parsePkId(pk) {
    if (pk == null) return null;

    if (Array.isArray(pk)) {
        return pk.length > 0 ? String(pk[0]) : null;
    }

    let bytes = null;

    if (typeof pk === 'string') {
        const trimmed = pk.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) return parsed.length > 0 ? String(parsed[0]) : null;
                if (parsed != null && typeof parsed === 'object') {
                    bytes = objectToBytes(parsed);
                } else if (parsed != null) {
                    return String(parsed);
                }
            } catch {
                /* fall through to hex */
            }
        }
        if (bytes == null) bytes = hexToBytes(trimmed);
    } else if (typeof pk === 'object') {
        bytes = objectToBytes(pk);
    } else {
        return String(pk);
    }

    if (bytes == null || bytes.length === 0) return null;

    const utf8 = bytesToUtf8(bytes);
    const uuidMatch = utf8.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    if (uuidMatch) return uuidMatch[0];

    const printable = utf8.replace(/[^\x20-\x7E]/g, '');
    const tokenMatch = printable.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/);
    if (tokenMatch) return tokenMatch[0];

    return null;
}
