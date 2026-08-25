export const UPDATE_TYPE = {
    DELETE: 9,
    INSERT: 18,
    UPDATE: 23,
};
export const version = 1;
export function cryb64(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296n * BigInt(h2) + BigInt(h1);
}
export function first(data) {
    if (!data) {
        return undefined;
    }
    return data[0];
}
export function firstPick(data) {
    const d = data[0];
    if (d == null) {
        return undefined;
    }
    return d[Object.keys(d)[0]];
}
export function pick(data) {
    return data.map((d) => d[Object.keys(d)[0]]);
}