import { describe, it, expect } from 'vitest';
import {
    FILTER_ALL,
    FILTER_PINNED,
    SORT_CREATED_NEWEST_FIRST,
    SORT_CREATED_OLDEST_FIRST,
    SORT_NEWEST_FIRST,
    SORT_OLDEST_FIRST,
    UNKNOWN_TIME_LABEL,
    buildDashboardView,
    filterRecentDocuments,
    formatAbsoluteTime,
    formatRelativeTime,
    formatWordCount,
    groupRecentDocuments,
    matchesDocumentQuery,
    normalizePinned,
    normalizeRecentDocument,
    parseTimestamp,
    resolveTimeGroup,
    sortRecentDocuments,
} from '../../src/utils/recentDocuments.js';

/** Build a normalized document without going through the SQL row shape. */
function doc(overrides = {}) {
    return {
        id: 'note',
        type: 'file',
        name: 'Note',
        folderName: 'Root',
        folderId: null,
        displayedDate: '2026-08-16T09:00:00.000Z',
        createdDate: '2026-08-16T09:00:00.000Z',
        excerpt: '',
        wordCount: 0,
        isPinned: false,
        ...overrides,
    };
}

/** A fixed local instant: Wednesday 2026-08-12, 15:00 local time. */
function wednesdayAt(hours = 15, minutes = 0) {
    return new Date(2026, 7, 12, hours, minutes, 0, 0);
}

/** A local instant on a given local day offset from the fixed Wednesday. */
function localDay(dayOffset, hours = 12) {
    return new Date(2026, 7, 12 + dayOffset, hours, 0, 0, 0).toISOString();
}

describe('normalizeRecentDocument', () => {
    it('maps title, folder, date, excerpt, word count, and pin state', () => {
        const row = {
            id: 'note-1',
            title: '  Project Plan  ',
            folderPath: 'Work / Planning',
            folder_id: 'folder-1',
            updated_at: '2026-02-15T10:00:00.000Z',
            created_at: '2026-02-14T10:00:00.000Z',
            content: 'First paragraph with several words.',
            pinned: 1,
        };

        expect(normalizeRecentDocument(row)).toEqual({
            id: 'note-1',
            type: 'file',
            name: 'Project Plan',
            folderName: 'Work / Planning',
            folderId: 'folder-1',
            displayedDate: '2026-02-15T10:00:00.000Z',
            createdDate: '2026-02-14T10:00:00.000Z',
            excerpt: 'First paragraph with several words.',
            wordCount: 5,
            isPinned: true,
            dbKey: undefined,
            spaceName: null,
            visibility: 'Private',
        });
    });

    it('falls back for empty title and folder', () => {
        const result = normalizeRecentDocument({
            id: 'note-2',
            title: '   ',
            folderName: '   ',
            updated_at: '',
            created_at: '2026-02-14T10:00:00.000Z',
            content: '',
        });

        expect(result.type).toBe('file');
        expect(result.name).toBe('Untitled');
        expect(result.folderName).toBe('Root');
        expect(result.folderId).toBe(null);
        expect(result.displayedDate).toBe('2026-02-14T10:00:00.000Z');
        expect(result.createdDate).toBe('2026-02-14T10:00:00.000Z');
        expect(result.excerpt).toBe('');
        expect(result.wordCount).toBe(0);
        expect(result.isPinned).toBe(false);
    });

    it('truncates long excerpts to 120 characters with ellipsis', () => {
        const result = normalizeRecentDocument({
            id: 'note-3',
            title: 'Long',
            folderName: 'Notes',
            content: 'a'.repeat(140),
        });

        expect(result.excerpt.length).toBe(120);
        expect(result.excerpt.endsWith('…')).toBe(true);
    });

    it('renders pre-migration rows as unpinned', () => {
        expect(normalizeRecentDocument({ id: 'a' }).isPinned).toBe(false);
        expect(normalizeRecentDocument({ id: 'b', pinned: null }).isPinned).toBe(false);
        expect(normalizeRecentDocument({ id: 'c', pinned: 0 }).isPinned).toBe(false);
    });
});

describe('normalizePinned', () => {
    it('treats NULL, undefined, 0, and falsey strings as unpinned', () => {
        for (const value of [null, undefined, 0, false, '', '0', 'false', '  ']) {
            expect(normalizePinned(value)).toBe(false);
        }
    });

    it('treats 1, true, and truthy strings as pinned', () => {
        for (const value of [1, -1, true, '1', 'true']) {
            expect(normalizePinned(value)).toBe(true);
        }
    });
});

describe('matchesDocumentQuery', () => {
    const target = doc({
        name: 'Quarterly Review',
        folderName: 'Work / Planning',
        excerpt: 'Budget allocation and campaign timeline.',
    });

    it('matches an empty query', () => {
        expect(matchesDocumentQuery(target, '')).toBe(true);
        expect(matchesDocumentQuery(target, '   ')).toBe(true);
    });

    it('matches the title case-insensitively', () => {
        expect(matchesDocumentQuery(target, 'quarterly')).toBe(true);
        expect(matchesDocumentQuery(target, 'REVIEW')).toBe(true);
    });

    it('matches the folder path', () => {
        expect(matchesDocumentQuery(target, 'planning')).toBe(true);
        expect(matchesDocumentQuery(target, 'work / plan')).toBe(true);
    });

    it('matches the excerpt', () => {
        expect(matchesDocumentQuery(target, 'campaign')).toBe(true);
    });

    it('rejects text present in none of the three fields', () => {
        expect(matchesDocumentQuery(target, 'invoice')).toBe(false);
    });
});

describe('filterRecentDocuments', () => {
    const documents = [
        doc({ id: 'a', name: 'Alpha', isPinned: true, folderName: 'Work' }),
        doc({ id: 'b', name: 'Beta', isPinned: false, folderName: 'Work / Deep' }),
        doc({ id: 'c', name: 'Gamma', isPinned: true, folderName: 'Personal' }),
    ];

    it('returns everything by default', () => {
        expect(filterRecentDocuments(documents).map((d) => d.id)).toEqual(['a', 'b', 'c']);
    });

    it('limits to pinned documents', () => {
        const result = filterRecentDocuments(documents, { filter: FILTER_PINNED });
        expect(result.map((d) => d.id)).toEqual(['a', 'c']);
    });

    it('combines the pinned filter with the quick filter', () => {
        const result = filterRecentDocuments(documents, { filter: FILTER_PINNED, query: 'personal' });
        expect(result.map((d) => d.id)).toEqual(['c']);
    });

    it('does not mutate the input collection', () => {
        filterRecentDocuments(documents, { filter: FILTER_PINNED });
        expect(documents).toHaveLength(3);
    });

    it('tolerates a missing collection', () => {
        expect(filterRecentDocuments(undefined, { filter: FILTER_ALL })).toEqual([]);
    });
});

describe('sortRecentDocuments', () => {
    const documents = [
        doc({ id: 'middle', displayedDate: '2026-08-10T10:00:00.000Z' }),
        doc({ id: 'newest', displayedDate: '2026-08-12T10:00:00.000Z' }),
        doc({ id: 'undated', displayedDate: '' }),
        doc({ id: 'oldest', displayedDate: '2026-08-01T10:00:00.000Z' }),
        doc({ id: 'invalid', displayedDate: 'not-a-date' }),
    ];

    it('sorts newest first by default, undated last', () => {
        expect(sortRecentDocuments(documents).map((d) => d.id))
            .toEqual(['newest', 'middle', 'oldest', 'undated', 'invalid']);
    });

    it('sorts oldest first, still keeping undated last', () => {
        expect(sortRecentDocuments(documents, SORT_OLDEST_FIRST).map((d) => d.id))
            .toEqual(['oldest', 'middle', 'newest', 'undated', 'invalid']);
    });

    it('sorts by creation date in either direction, independently of modification date', () => {
        const created = [
            doc({
                id: 'created-middle',
                displayedDate: '2026-08-12T10:00:00.000Z',
                createdDate: '2026-08-10T10:00:00.000Z',
            }),
            doc({
                id: 'created-newest',
                displayedDate: '2026-08-01T10:00:00.000Z',
                createdDate: '2026-08-12T10:00:00.000Z',
            }),
            doc({
                id: 'created-oldest',
                displayedDate: '2026-08-10T10:00:00.000Z',
                createdDate: '2026-08-01T10:00:00.000Z',
            }),
            doc({ id: 'missing-created', createdDate: '' }),
        ];

        expect(sortRecentDocuments(created, SORT_CREATED_NEWEST_FIRST).map((d) => d.id))
            .toEqual(['created-newest', 'created-middle', 'created-oldest', 'missing-created']);
        expect(sortRecentDocuments(created, SORT_CREATED_OLDEST_FIRST).map((d) => d.id))
            .toEqual(['created-oldest', 'created-middle', 'created-newest', 'missing-created']);
    });

    it('is stable for equal timestamps', () => {
        const tied = [
            doc({ id: 'first', displayedDate: '2026-08-10T10:00:00.000Z' }),
            doc({ id: 'second', displayedDate: '2026-08-10T10:00:00.000Z' }),
        ];
        expect(sortRecentDocuments(tied, SORT_NEWEST_FIRST).map((d) => d.id)).toEqual(['first', 'second']);
    });

    it('does not mutate the input collection', () => {
        sortRecentDocuments(documents, SORT_OLDEST_FIRST);
        expect(documents[0].id).toBe('middle');
    });
});

describe('resolveTimeGroup', () => {
    const now = wednesdayAt();

    it('groups the current local calendar date as today', () => {
        expect(resolveTimeGroup(localDay(0, 0), now)).toBe('today');
        expect(resolveTimeGroup(localDay(0, 23), now)).toBe('today');
    });

    it('groups the preceding local calendar date as yesterday', () => {
        expect(resolveTimeGroup(localDay(-1, 23), now)).toBe('yesterday');
        expect(resolveTimeGroup(localDay(-1, 0), now)).toBe('yesterday');
    });

    it('groups Monday of the current week as earlier this week', () => {
        // 2026-08-10 is the Monday of the week containing Wednesday 2026-08-12.
        expect(resolveTimeGroup(localDay(-2, 9), now)).toBe('earlier-this-week');
    });

    it('groups the previous Sunday as earlier', () => {
        expect(resolveTimeGroup(localDay(-3, 23), now)).toBe('earlier');
        expect(resolveTimeGroup(localDay(-30), now)).toBe('earlier');
    });

    it('groups missing and invalid timestamps as earlier', () => {
        expect(resolveTimeGroup('', now)).toBe('earlier');
        expect(resolveTimeGroup('not-a-date', now)).toBe('earlier');
        expect(resolveTimeGroup(null, now)).toBe('earlier');
    });

    it('uses local midnight, not a rolling 24 hours', () => {
        const justAfterMidnight = new Date(2026, 7, 12, 0, 10, 0, 0);
        // 22:00 the previous evening is less than 24h earlier but is still yesterday.
        expect(resolveTimeGroup(localDay(-1, 22), justAfterMidnight)).toBe('yesterday');
        expect(resolveTimeGroup(localDay(0, 0), justAfterMidnight)).toBe('today');
    });

    it('leaves nothing between yesterday and the week start on a Monday', () => {
        const monday = new Date(2026, 7, 10, 12, 0, 0, 0);
        expect(resolveTimeGroup(localDay(-2, 9), monday)).toBe('today');
        expect(resolveTimeGroup(localDay(-3, 9), monday)).toBe('yesterday');
        expect(resolveTimeGroup(localDay(-4, 9), monday)).toBe('earlier');
    });
});

describe('groupRecentDocuments', () => {
    const now = wednesdayAt();

    it('returns the four groups in chronological order and omits empty ones', () => {
        const groups = groupRecentDocuments([
            doc({ id: 'today', displayedDate: localDay(0, 9) }),
            doc({ id: 'week', displayedDate: localDay(-2, 9) }),
            doc({ id: 'old', displayedDate: localDay(-40) }),
        ], now);

        expect(groups.map((g) => g.key)).toEqual(['today', 'earlier-this-week', 'earlier']);
        expect(groups.map((g) => g.label)).toEqual(['Today', 'Earlier this week', 'Earlier']);
        expect(groups[2].documents.map((d) => d.id)).toEqual(['old']);
    });

    it('preserves incoming order within a group', () => {
        const groups = groupRecentDocuments([
            doc({ id: 'a', displayedDate: localDay(0, 14) }),
            doc({ id: 'b', displayedDate: localDay(0, 9) }),
        ], now);

        expect(groups[0].documents.map((d) => d.id)).toEqual(['a', 'b']);
    });

    it('keeps undated documents visible in Earlier', () => {
        const groups = groupRecentDocuments([doc({ id: 'undated', displayedDate: '' })], now);
        expect(groups).toHaveLength(1);
        expect(groups[0].key).toBe('earlier');
    });

    it('returns no groups for an empty result set', () => {
        expect(groupRecentDocuments([], now)).toEqual([]);
        expect(groupRecentDocuments(undefined, now)).toEqual([]);
    });
});

describe('buildDashboardView', () => {
    const now = wednesdayAt();
    const documents = [
        doc({ id: 'a', name: 'Alpha', displayedDate: localDay(0, 9), isPinned: true }),
        doc({ id: 'b', name: 'Beta', displayedDate: localDay(-1, 9) }),
        doc({ id: 'c', name: 'Gamma', displayedDate: localDay(-40), isPinned: true }),
    ];

    it('filters, sorts, and groups consistently', () => {
        const view = buildDashboardView(documents, { now });
        expect(view.documents.map((d) => d.id)).toEqual(['a', 'b', 'c']);
        expect(view.groups.map((g) => g.key)).toEqual(['today', 'yesterday', 'earlier']);
    });

    it('keeps the flat list and the groups describing the same result set', () => {
        const view = buildDashboardView(documents, { now, filter: FILTER_PINNED });
        const grouped = view.groups.flatMap((g) => g.documents.map((d) => d.id));
        expect(view.documents.map((d) => d.id)).toEqual(['a', 'c']);
        expect(grouped).toEqual(['a', 'c']);
    });

    it('applies the oldest-first sort order', () => {
        const view = buildDashboardView(documents, { now, sortOrder: SORT_OLDEST_FIRST });
        expect(view.documents.map((d) => d.id)).toEqual(['c', 'b', 'a']);
    });

    it('returns an empty view when the quick filter matches nothing', () => {
        const view = buildDashboardView(documents, { now, query: 'nothing-here' });
        expect(view.documents).toEqual([]);
        expect(view.groups).toEqual([]);
    });
});

describe('formatWordCount', () => {
    it('formats zero, one, and many', () => {
        expect(formatWordCount(0)).toBe('0 words');
        expect(formatWordCount(1)).toBe('1 word');
        expect(formatWordCount(2)).toBe('2 words');
    });

    it('groups thousands', () => {
        expect(formatWordCount(2359)).toMatch(/2\D?359 words/);
    });

    it('clamps invalid and negative counts to zero', () => {
        expect(formatWordCount(undefined)).toBe('0 words');
        expect(formatWordCount(-4)).toBe('0 words');
        expect(formatWordCount(Number.NaN)).toBe('0 words');
    });
});

describe('formatRelativeTime', () => {
    const now = new Date('2026-08-16T12:00:00.000Z');

    it('reports seconds, minutes, hours, and days', () => {
        expect(formatRelativeTime('2026-08-16T11:59:30.000Z', now)).toMatch(/second|now/i);
        expect(formatRelativeTime('2026-08-16T11:57:00.000Z', now)).toMatch(/3 minutes ago/);
        expect(formatRelativeTime('2026-08-16T09:00:00.000Z', now)).toMatch(/3 hours ago/);
        expect(formatRelativeTime('2026-08-13T12:00:00.000Z', now)).toMatch(/3 days ago/);
    });

    it('falls back to an absolute date beyond a week', () => {
        const result = formatRelativeTime('2026-06-01T12:00:00.000Z', now);
        expect(result).not.toMatch(/ago/);
        expect(result).not.toBe(UNKNOWN_TIME_LABEL);
    });

    it('returns the unknown label instead of an invalid relative string', () => {
        expect(formatRelativeTime('', now)).toBe(UNKNOWN_TIME_LABEL);
        expect(formatRelativeTime('not-a-date', now)).toBe(UNKNOWN_TIME_LABEL);
        expect(formatRelativeTime(null, now)).toBe(UNKNOWN_TIME_LABEL);
        expect(formatRelativeTime('2026-08-16T12:00:00.000Z', 'nonsense')).toBe(UNKNOWN_TIME_LABEL);
    });

    it('accepts an epoch-millisecond reference', () => {
        expect(formatRelativeTime('2026-08-16T11:57:00.000Z', now.getTime())).toMatch(/3 minutes ago/);
    });
});

describe('formatAbsoluteTime and parseTimestamp', () => {
    it('returns an empty string for unusable timestamps', () => {
        expect(formatAbsoluteTime('')).toBe('');
        expect(formatAbsoluteTime('not-a-date')).toBe('');
        expect(parseTimestamp('not-a-date')).toBe(null);
        expect(parseTimestamp('')).toBe(null);
    });

    it('parses a valid ISO timestamp', () => {
        expect(parseTimestamp('2026-08-16T12:00:00.000Z').toISOString()).toBe('2026-08-16T12:00:00.000Z');
        expect(formatAbsoluteTime('2026-08-16T12:00:00.000Z')).not.toBe('');
    });
});
