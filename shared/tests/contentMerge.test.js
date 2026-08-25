import { describe, expect, it } from 'vitest';
import {
    normalizeContent,
    contentHash,
    mergeContent,
    withinContentMergeBudget,
    serializeConflictHunks,
    buildConflictResolutionPlan,
    applyConflictResolution,
    CONTENT_MERGE_LIMITS,
} from '../contentMerge.js';

describe('normalizeContent', () => {
    it('maps null/undefined to an empty string', () => {
        expect(normalizeContent(null)).toBe('');
        expect(normalizeContent(undefined)).toBe('');
    });

    it('converts CRLF to LF and leaves everything else alone', () => {
        expect(normalizeContent('a\r\nb')).toBe('a\nb');
        expect(normalizeContent('a\nb')).toBe('a\nb');
        expect(normalizeContent('  spaced  ')).toBe('  spaced  ');
        expect(normalizeContent('trailing\n')).toBe('trailing\n');
    });
});

describe('contentHash', () => {
    it('produces lowercase hexadecimal SHA-256 over UTF-8 bytes', async () => {
        expect(await contentHash('')).toBe(
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        );
        expect(await contentHash('hello')).toBe(
            '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        );
    });

    it('normalizes CRLF before hashing', async () => {
        expect(await contentHash('hello\r\nworld')).toBe(await contentHash('hello\nworld'));
    });

    it('treats null and empty identically', async () => {
        expect(await contentHash(null)).toBe(await contentHash(''));
    });
});

describe('mergeContent', () => {
    it('merges disjoint paragraph edits cleanly and keeps both', () => {
        const result = mergeContent({
            base: 'p1\n\np2',
            mine: 'p1 MINE\n\np2',
            theirs: 'p1\n\np2 THEIRS',
        });
        expect(result.status).toBe('clean');
        expect(result.content).toBe('p1 MINE\n\np2 THEIRS');
        expect(result.conflicts).toEqual([]);
    });

    it('merges identical edits cleanly without duplication', () => {
        const result = mergeContent({
            base: 'p1\np2',
            mine: 'p1\np2 X',
            theirs: 'p1\np2 X',
        });
        expect(result.status).toBe('clean');
        expect(result.content).toBe('p1\np2 X');
    });

    it('reports a conflict for same-line edits and preserves both versions', () => {
        const result = mergeContent({
            base: 'p1\np2',
            mine: 'p1 MINE\np2',
            theirs: 'p1 THEIRS\np2',
        });
        expect(result.status).toBe('conflict');
        expect(result.content).toBe('p1 THEIRS\np2');
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0].mineLines).toEqual(['p1 MINE']);
        expect(result.conflicts[0].theirsLines).toEqual(['p1 THEIRS']);
    });

    it('merges pure append on both sides cleanly and keeps both', () => {
        const result = mergeContent({
            base: 'p1',
            mine: 'p1\nA',
            theirs: 'p1\nB',
        });
        expect(result.status).toBe('clean');
        expect(result.content).toBe('p1\nA\nB');
    });

    it('reports a conflict when one side deletes a section the other edited', () => {
        const result = mergeContent({
            base: 'p1\np2\np3',
            mine: 'p1\np2 MINE\np3',
            theirs: 'p1\np3',
        });
        expect(result.status).toBe('conflict');
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0].theirsLines).toEqual([]);
    });

    it('reports a conflict for a new document created on both sides, losing nothing', () => {
        const result = mergeContent({
            base: '',
            mine: 'MINE',
            theirs: 'THEIRS',
        });
        expect(result.status).toBe('conflict');
        expect(result.conflicts[0].mineLines).toEqual(['MINE']);
        expect(result.conflicts[0].theirsLines).toEqual(['THEIRS']);
    });

    it('treats null content as empty', () => {
        const result = mergeContent({
            base: null,
            mine: 'x',
            theirs: 'x',
        });
        expect(result.status).toBe('clean');
        expect(result.content).toBe('x');
    });

    it('does not report a spurious conflict for a trailing-newline-only difference', () => {
        const result = mergeContent({
            base: 'p1\np2\n',
            mine: 'p1\np2\n',
            theirs: 'p1\np2',
        });
        expect(result.status).toBe('clean');
    });

    it('returns a budget status for an oversized body without merging', () => {
        const large = 'a'.repeat(CONTENT_MERGE_LIMITS.maxContentBytes + 1);
        const result = mergeContent({
            base: 'p1',
            mine: large,
            theirs: 'p1',
        });
        expect(result.status).toBe('budget');
        expect(result.content).toBe('p1');
    });

    it('merges a large but in-budget body within the budget', () => {
        const body = 'x'.repeat(64 * 1024);
        const result = mergeContent({
            base: body,
            mine: `${body}\nMINE`,
            theirs: body,
        });
        expect(result.status).toBe('clean');
        expect(result.content).toBe(`${body}\nMINE`);
    });
});

describe('manual conflict resolution', () => {
    it('preserves clean regions and applies a separate decision to each conflict', () => {
        const plan = buildConflictResolutionPlan({
            base: 'same\ngap\nsame',
            mine: 'mine one\ngap\nmine two',
            theirs: 'theirs one\ngap\ntheirs two',
        });

        expect(plan.status).toBe('conflict');
        expect(plan.regions.filter((region) => region.type === 'conflict')).toHaveLength(2);
        expect(applyConflictResolution(plan, { 0: 'mine', 1: 'theirs' })).toBe(
            'mine one\ngap\ntheirs two',
        );
    });

    it('resolves a delete-versus-edit conflict without inserting placeholder lines', () => {
        const plan = buildConflictResolutionPlan({
            base: 'before\nsection\nafter',
            mine: 'before\nsection edited\nafter',
            theirs: 'before\nafter',
        });

        expect(applyConflictResolution(plan, { 0: 'theirs' })).toBe('before\nafter');
    });

    it('reconstructs duplicate base lines by region order instead of text search', () => {
        const plan = buildConflictResolutionPlan({
            base: 'same\ngap\nsame',
            mine: 'mine one\ngap\nmine two',
            theirs: 'theirs one\ngap\ntheirs two',
        });

        expect(applyConflictResolution(plan, { 0: 'theirs', 1: 'mine' })).toBe(
            'theirs one\ngap\nmine two',
        );
    });

    it('preserves trailing newlines in a resolved document', () => {
        const plan = buildConflictResolutionPlan({
            base: 'line\n',
            mine: 'mine\n',
            theirs: 'theirs\n',
        });

        expect(applyConflictResolution(plan, { 0: 'mine' })).toBe('mine\n');
    });

    it('exposes a clean candidate when manual write-back was disabled', () => {
        const plan = buildConflictResolutionPlan({
            base: 'p1\n\np2',
            mine: 'p1 mine\n\np2',
            theirs: 'p1\n\np2 theirs',
        });

        expect(plan.status).toBe('clean');
        expect(plan.content).toBe('p1 mine\n\np2 theirs');
    });

    it('requires an explicit valid choice for every conflict region', () => {
        const plan = buildConflictResolutionPlan({ base: 'base', mine: 'mine', theirs: 'theirs' });
        expect(() => applyConflictResolution(plan, {})).toThrow('needs a decision');
        expect(() => applyConflictResolution(plan, { 0: 'both' })).toThrow('needs a decision');
    });

    it('returns a budget plan without invoking per-hunk resolution', () => {
        const plan = buildConflictResolutionPlan({
            base: 'base',
            mine: 'x'.repeat(CONTENT_MERGE_LIMITS.maxContentBytes + 1),
            theirs: 'theirs',
        });
        expect(plan.status).toBe('budget');
        expect(plan.regions).toEqual([]);
    });
});

describe('merge budgets', () => {
    it('rejects content over 1 MiB', () => {
        expect(withinContentMergeBudget('a'.repeat(1024 * 1024))).toBe(true);
        expect(withinContentMergeBudget('a'.repeat(1024 * 1024 + 1))).toBe(false);
    });
});

describe('serializeConflictHunks', () => {
    it('serializes conflict hunks to JSON', () => {
        const hunks = [{ baseLines: [], mineLines: ['a'], theirsLines: ['b'] }];
        expect(serializeConflictHunks(hunks)).toBe(
            JSON.stringify(hunks),
        );
    });

    it('serializes an empty list as "[]"', () => {
        expect(serializeConflictHunks(undefined)).toBe('[]');
    });
});
