import { diff3Merge } from 'node-diff3';
/* global TextEncoder, crypto */

/**
 * Canonical content-merge module for Panino (`@panino/content-merge`).
 *
 * Owns normalization, hashing, three-way line merge, conflict-hunk
 * serialization, budgets and test vectors. Both the frontend (browser) and the
 * backend (Node) consume this package through a `file:` dependency and must
 * never carry their own merge implementation. See COLLAB-00 §4 and COLLAB-02.
 */

export const CONTENT_MERGE_LIMITS = Object.freeze({
    /** Maximum normalized document body, in bytes, eligible for automatic merge. */
    maxContentBytes: 1024 * 1024, // 1 MiB
    /** Maximum documents merged per sync turn. */
    maxDocumentsPerSync: 50,
});

/**
 * Maps `null`/`undefined` to `""` and converts CRLF to LF. Performs no Unicode
 * normalization, whitespace trimming or trailing-newline rewriting.
 *
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function normalizeContent(value) {
    if (value == null) return '';
    return String(value).replace(/\r\n/g, '\n');
}

/**
 * Lowercase hexadecimal SHA-256 over the UTF-8 bytes of `normalizeContent(value)`.
 * Uses the Web Crypto API, available identically in Node and modern browsers.
 *
 * @param {string | null | undefined} value
 * @returns {Promise<string>}
 */
export async function contentHash(value) {
    const bytes = new TextEncoder().encode(normalizeContent(value));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/** Byte length of the normalized content. */
export function contentByteLength(value) {
    return new TextEncoder().encode(normalizeContent(value)).length;
}

/** Whether a document body is within the automatic-merge budget. */
export function withinContentMergeBudget(value) {
    return contentByteLength(value) <= CONTENT_MERGE_LIMITS.maxContentBytes;
}

/**
 * Three-way line merge of a document body. `mine` and `theirs` are the two
 * divergent sides; `base` is the last value they agreed on.
 *
 * Returns:
 *   - `{ status: 'clean', content, conflicts: [] }` when the merge is automatic.
 *   - `{ status: 'conflict', content: theirs, conflicts: [...] }` when at least
 *     one region overlaps; `content` is `theirs` so the caller keeps the remote
 *     body and preserves `mine` in its conflict table.
 *   - `{ status: 'budget', content: theirs, conflicts: [] }` when a body exceeds
 *     the merge budget; the caller treats this as a recoverable conflict.
 *
 * A conflict hunk is `{ baseLines, mineLines, theirsLines }` — arrays of lines.
 * Concurrent insertions at the same point (empty base region) merge cleanly by
 * concatenation, which is what makes "pure append on both sides" lossless.
 *
 * @param {{ base: string | null | undefined, mine: string | null | undefined, theirs: string | null | undefined }} parts
 */
export function mergeContent({ base, mine, theirs }) {
    const plan = buildConflictResolutionPlan({ base, mine, theirs });

    if (plan.status === 'budget') {
        return { status: 'budget', content: plan.theirs, conflicts: [] };
    }

    if (plan.status === 'conflict') {
        return {
            status: 'conflict',
            content: plan.theirs,
            conflicts: plan.regions
                .filter((region) => region.type === 'conflict')
                .map(({ baseLines, mineLines, theirsLines }) => ({
                    baseLines,
                    mineLines,
                    theirsLines,
                })),
        };
    }

    return { status: 'clean', content: plan.content, conflicts: [] };
}

/**
 * Builds the ordered region stream used by the manual conflict resolver. Clean
 * regions are retained alongside conflicts so applying per-hunk decisions can
 * reconstruct the complete document without searching for duplicated text.
 *
 * @param {{ base: string | null | undefined, mine: string | null | undefined, theirs: string | null | undefined }} parts
 */
export function buildConflictResolutionPlan({ base, mine, theirs }) {
    const nb = normalizeContent(base);
    const nm = normalizeContent(mine);
    const nt = normalizeContent(theirs);

    if (nm === nt) {
        return { status: 'clean', content: nm, base: nb, mine: nm, theirs: nt, regions: [] };
    }

    if (
        contentByteLength(nb) > CONTENT_MERGE_LIMITS.maxContentBytes ||
        contentByteLength(nm) > CONTENT_MERGE_LIMITS.maxContentBytes ||
        contentByteLength(nt) > CONTENT_MERGE_LIMITS.maxContentBytes
    ) {
        return { status: 'budget', base: nb, mine: nm, theirs: nt, regions: [] };
    }

    const diffRegions = diff3Merge(nm.split('\n'), nb.split('\n'), nt.split('\n'), {
        excludeFalseConflicts: true,
    });
    const regions = [];
    let conflictIndex = 0;

    for (const region of diffRegions) {
        if (region.ok) {
            regions.push({ type: 'clean', lines: region.ok });
            continue;
        }

        const { a, o, b } = region.conflict;
        if (o.length === 0 && nb !== '') {
            regions.push({ type: 'clean', lines: [...a, ...b] });
            continue;
        }

        regions.push({
            type: 'conflict',
            index: conflictIndex,
            baseLines: o,
            mineLines: a,
            theirsLines: b,
        });
        conflictIndex += 1;
    }

    if (conflictIndex === 0) {
        return {
            status: 'clean',
            content: regions.flatMap((region) => region.lines).join('\n'),
            base: nb,
            mine: nm,
            theirs: nt,
            regions,
        };
    }

    return { status: 'conflict', base: nb, mine: nm, theirs: nt, regions };
}

/**
 * Applies an explicit mine/theirs decision to every conflict in a plan.
 * Missing or unknown choices throw so no side is selected implicitly.
 *
 * @param {ReturnType<typeof buildConflictResolutionPlan>} plan
 * @param {Record<number, 'mine' | 'theirs'> | Map<number, 'mine' | 'theirs'>} choices
 */
export function applyConflictResolution(plan, choices) {
    if (!plan || plan.status !== 'conflict') {
        throw new Error('A conflict resolution plan is required.');
    }

    const resolved = [];
    for (const region of plan.regions) {
        if (region.type === 'clean') {
            resolved.push(...region.lines);
            continue;
        }

        const choice = choices instanceof Map ? choices.get(region.index) : choices?.[region.index];
        if (choice !== 'mine' && choice !== 'theirs') {
            throw new Error(`Conflict region ${region.index + 1} needs a decision.`);
        }
        resolved.push(...(choice === 'mine' ? region.mineLines : region.theirsLines));
    }

    return resolved.join('\n');
}

/**
 * Serializes conflict hunks for the `note_conflicts.conflict_hunks` column.
 *
 * @param {Array<{ baseLines: string[], mineLines: string[], theirsLines: string[] }>} conflicts
 * @returns {string}
 */
export function serializeConflictHunks(conflicts) {
    return JSON.stringify(conflicts ?? []);
}
