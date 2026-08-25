/**
 * Identity palette (COLLAB-03). Colours that encode *who someone is*, never
 * *what a control does*. They are a documented, hard-coded exception to the
 * design system's "blue is for links, gray is for controls" rule.
 *
 * Assignment is deterministic from the canonical ASCII Panino user UUID, so the
 * same person renders the same colour on every device without coordination.
 */

export const IDENTITY_PALETTE = [
    '#be3455', // rose
    '#c2410c', // orange
    '#a16207', // amber
    '#4d7c0f', // olive
    '#15803d', // green
    '#0f766e', // teal
    '#0e7490', // cyan
    '#be185d', // pink
];

/**
 * FNV-1a over UTF-16 code units. Panino user ids are canonical ASCII UUIDs, so
 * single-byte code points are processed identically in every supported runtime.
 *
 * @param {string} userId
 * @returns {string} a hex colour from {@link IDENTITY_PALETTE}
 */
export function identityColorFor(userId) {
    let h = 0x811c9dc5;
    for (let i = 0; i < userId.length; i++) {
        h ^= userId.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return IDENTITY_PALETTE[h % IDENTITY_PALETTE.length];
}

/**
 * Derives up to two white initials for an avatar swatch. Falls back to the
 * email local part, then a bare "?" when neither is usable.
 *
 * @param {string | null | undefined} name
 * @param {string | null | undefined} email
 * @returns {string}
 */
export function initialsFor(name, email) {
    const trimmed = (name || '').trim();
    if (trimmed) {
        const parts = trimmed.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[1][0]).toUpperCase();
        }
        return trimmed.slice(0, 2).toUpperCase();
    }

    const local = (email || '').split('@')[0].trim();
    if (local) {
        return local.slice(0, 2).toUpperCase();
    }

    return '?';
}
