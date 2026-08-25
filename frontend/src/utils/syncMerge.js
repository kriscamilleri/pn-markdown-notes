import { normalizeContent, mergeContent } from '@panino/content-merge';

/**
 * Pure dispatch for the sync-time content merge (COLLAB-02 §5.3). Takes the
 * per-document base/mine/theirs and the server capability and returns a single
 * decision the sync transaction can execute. Keeping this decision a pure
 * function makes the merge table testable without the CR-SQLite WASM.
 */

export const WRITEBACK_WINDOW_MS = 60 * 1000;
/** The fourth write-back within a minute is suppressed and becomes a conflict. */
export const WRITEBACK_MAX_COUNT = 3;

/**
 * @param {{ hasBase: boolean, hasMine?: boolean, base: string | null | undefined, mine: string | null | undefined, theirs: string | null | undefined, capabilityEnabled: boolean }} parts
 * @returns {{
 *   action: 'record-base' | 'adopt-theirs' | 'restore-mine' | 'write-merge' | 'record-conflict',
 *   content: string,
 *   conflicts: Array<{ baseLines: string[], mineLines: string[], theirsLines: string[] }>,
 *   reason?: string,
 *   pendingMerged?: string,
 * }}
 */
export function resolveSyncMerge({ hasBase, hasMine = true, base, mine, theirs, capabilityEnabled }) {
    const nb = normalizeContent(base);
    const nm = normalizeContent(mine);
    const nt = normalizeContent(theirs);

    if (!hasBase) {
        // A row that did not exist before remote apply is a first-time pull,
        // not an empty local edit competing with the remote body.
        if (!hasMine) {
            return { action: 'record-base', content: nt, conflicts: [] };
        }
        if (nm === nt) {
            return { action: 'record-base', content: nt, conflicts: [] };
        }
        return {
            action: 'record-conflict',
            content: nt,
            conflicts: [{ baseLines: [], mineLines: nm.split('\n'), theirsLines: nt.split('\n') }],
            reason: 'no-base',
        };
    }

    if (nm === nb) {
        return { action: 'adopt-theirs', content: nt, conflicts: [] };
    }

    if (nt === nb) {
        return { action: 'restore-mine', content: nm, conflicts: [] };
    }

    const merge = mergeContent({ base: nb, mine: nm, theirs: nt });

    if (merge.status === 'conflict') {
        return { action: 'record-conflict', content: nt, conflicts: merge.conflicts };
    }

    if (merge.status === 'budget') {
        return { action: 'record-conflict', content: nt, conflicts: [], reason: 'budget' };
    }

    // Clean three-way merge.
    if (!capabilityEnabled) {
        return {
            action: 'record-conflict',
            content: nt,
            conflicts: [],
            reason: 'writeback-disabled',
            pendingMerged: merge.content,
        };
    }

    return { action: 'write-merge', content: merge.content, conflicts: [] };
}

/**
 * Rolling write-back oscillation guard (COLLAB-02 §6.3). The first write-back
 * starts the window; the fourth within 60 seconds is suppressed. Elapsing the
 * window resets the count.
 *
 * @param {{ writebackCount: number, windowStartedAt: string | null | undefined, now?: number }} state
 * @returns {{ allowed: boolean, writebackCount: number, windowStartedAt: string }}
 */
export function evaluateWritebackGuard({ writebackCount = 0, windowStartedAt = null, now = Date.now() }) {
    if (windowStartedAt == null) {
        return { allowed: true, writebackCount: 1, windowStartedAt: new Date(now).toISOString() };
    }

    const startedAtMs = new Date(windowStartedAt).getTime();
    if (Number.isNaN(startedAtMs) || now - startedAtMs >= WRITEBACK_WINDOW_MS) {
        return { allowed: true, writebackCount: 1, windowStartedAt: new Date(now).toISOString() };
    }

    if (writebackCount >= WRITEBACK_MAX_COUNT) {
        return { allowed: false, writebackCount, windowStartedAt };
    }

    return { allowed: true, writebackCount: writebackCount + 1, windowStartedAt };
}
