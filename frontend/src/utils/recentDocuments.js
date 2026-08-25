/**
 * Pure helpers behind the document dashboards (global Recent Documents and the
 * per-folder view). Everything here is deliberately store-free and takes an
 * explicit `now` where time matters, so grouping and relative-time formatting
 * stay testable without freezing the clock.
 */

/** Sort orders offered by the dashboard toolbar. */
export const SORT_NEWEST_FIRST = 'newest';
export const SORT_OLDEST_FIRST = 'oldest';
export const SORT_CREATED_NEWEST_FIRST = 'created-newest';
export const SORT_CREATED_OLDEST_FIRST = 'created-oldest';

/** Type-filter values offered by the dashboard toolbar. */
export const FILTER_ALL = 'all';
export const FILTER_PINNED = 'pinned';

/** Time-group keys, in the order the list renders them. */
export const TIME_GROUPS = [
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: 'earlier-this-week', label: 'Earlier this week' },
    { key: 'earlier', label: 'Earlier' },
];

export const UNKNOWN_TIME_LABEL = 'Unknown update time';

const MS_PER_DAY = 86400000;

function normalizeTitle(title) {
    const trimmed = String(title || '').trim();
    return trimmed || 'Untitled';
}

function normalizeFolderName(folderName) {
    const trimmed = String(folderName || '').trim();
    return trimmed || 'Root';
}

function extractExcerpt(content, maxLength = 120) {
    const compact = String(content || '').replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function countWords(content) {
    const words = String(content || '').trim().match(/\S+/g);
    return words ? words.length : 0;
}

/**
 * Coerce a stored `pinned` value to a boolean. Databases created before the
 * migration return `undefined` or `NULL`; both mean "not pinned".
 *
 * @param {unknown} value raw column value
 * @returns {boolean}
 */
export function normalizePinned(value) {
    if (value === true) return true;
    if (value === false || value === null || value === undefined) return false;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const trimmed = value.trim().toLowerCase();
        if (!trimmed || trimmed === '0' || trimmed === 'false') return false;
        return true;
    }
    return Boolean(value);
}

/**
 * Map a raw document row onto the model every dashboard card and row consumes.
 *
 * @param {object} row document row joined with its recursive folder path
 * @returns {{id: string, type: 'file', name: string, folderName: string,
 *   folderId: string|null, displayedDate: string, createdDate: string, excerpt: string,
 *   wordCount: number, isPinned: boolean}}
 */
export function normalizeRecentDocument(row = {}) {
    return {
        id: row.id,
        type: 'file',
        name: normalizeTitle(row.title),
        folderName: normalizeFolderName(row.folderPath || row.folderName),
        folderId: row.folder_id ?? null,
        displayedDate: row.updated_at || row.created_at || '',
        createdDate: row.created_at || '',
        excerpt: extractExcerpt(row.content),
        wordCount: countWords(row.content),
        isPinned: normalizePinned(row.pinned),
        dbKey: row.dbKey,
        spaceName: row.spaceName || null,
        visibility: row.spaceName ? `Shared in ${row.spaceName}` : 'Private',
    };
}

/**
 * Parse a stored timestamp, returning `null` when it is absent or unparseable.
 *
 * @param {string} value ISO 8601 timestamp
 * @returns {Date|null}
 */
export function parseTimestamp(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Format a word count with the user's locale grouping.
 *
 * @param {number} wordCount
 * @returns {string} e.g. `"2,359 words"` / `"1 word"`
 */
export function formatWordCount(wordCount) {
    const count = Number.isFinite(wordCount) && wordCount > 0 ? Math.floor(wordCount) : 0;
    const formatted = new Intl.NumberFormat().format(count);
    return `${formatted} ${count === 1 ? 'word' : 'words'}`;
}

/**
 * Absolute timestamp for `title` tooltips.
 *
 * @param {string} value ISO 8601 timestamp
 * @returns {string} localized date-time, or `''` when unparseable
 */
export function formatAbsoluteTime(value) {
    const target = parseTimestamp(value);
    return target ? target.toLocaleString() : '';
}

/**
 * Relative "edited" label. Falls back to an absolute date beyond a week and to
 * an explicit unknown label rather than emitting `Invalid Date`.
 *
 * @param {string} value ISO 8601 timestamp
 * @param {number|Date} [now] reference instant, injectable for tests
 * @returns {string}
 */
export function formatRelativeTime(value, now = Date.now()) {
    const target = parseTimestamp(value);
    if (!target) return UNKNOWN_TIME_LABEL;

    const reference = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isFinite(reference)) return UNKNOWN_TIME_LABEL;

    const secondsDiff = Math.round((target.getTime() - reference) / 1000);
    const absoluteSeconds = Math.abs(secondsDiff);
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

    if (absoluteSeconds < 60) return rtf.format(secondsDiff, 'second');
    if (absoluteSeconds < 3600) return rtf.format(Math.round(secondsDiff / 60), 'minute');
    if (absoluteSeconds < 86400) return rtf.format(Math.round(secondsDiff / 3600), 'hour');
    if (absoluteSeconds < 604800) return rtf.format(Math.round(secondsDiff / 86400), 'day');

    return target.toLocaleDateString();
}

/**
 * Case-insensitive substring match over the fields the quick filter advertises:
 * title, folder path, and excerpt. Deliberately not tags or full document content —
 * that is the separate Advanced Search feature.
 *
 * @param {object} doc normalized document
 * @param {string} query raw user input
 * @returns {boolean}
 */
export function matchesDocumentQuery(doc, query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return true;
    if (!doc) return false;

    return [doc.name, doc.folderName, doc.excerpt]
        .some((field) => String(field || '').toLowerCase().includes(needle));
}

/**
 * Apply the type filter and the quick filter to a loaded document collection.
 *
 * @param {object[]} documents normalized documents
 * @param {{query?: string, filter?: string}} [options]
 * @returns {object[]} a new array; the input is not mutated
 */
export function filterRecentDocuments(documents, options = {}) {
    const { query = '', filter = FILTER_ALL } = options;
    const pinnedOnly = filter === FILTER_PINNED;

    return (documents || []).filter((doc) => {
        if (pinnedOnly && doc?.isPinned !== true) return false;
        return matchesDocumentQuery(doc, query);
    });
}

/**
 * Sort by the selected date. Documents without a usable timestamp always sort
 * last, in both directions, so they stay visible in `Earlier` instead of
 * leading the list.
 *
 * @param {object[]} documents normalized documents
 * @param {string} [sortOrder] one of the exported dashboard sort orders
 * @returns {object[]} a new array; the input is not mutated
 */
export function sortRecentDocuments(documents, sortOrder = SORT_NEWEST_FIRST) {
    const sortByCreated = sortOrder === SORT_CREATED_NEWEST_FIRST
        || sortOrder === SORT_CREATED_OLDEST_FIRST;
    const direction = sortOrder === SORT_OLDEST_FIRST || sortOrder === SORT_CREATED_OLDEST_FIRST
        ? 1
        : -1;
    const dateField = sortByCreated ? 'createdDate' : 'displayedDate';

    return (documents || [])
        .map((doc, index) => ({ doc, index, time: parseTimestamp(doc?.[dateField])?.getTime() ?? null }))
        .sort((a, b) => {
            if (a.time === null && b.time === null) return a.index - b.index;
            if (a.time === null) return 1;
            if (b.time === null) return -1;
            if (a.time === b.time) return a.index - b.index;
            return (a.time - b.time) * direction;
        })
        .map((entry) => entry.doc);
}

function startOfLocalDay(date) {
    const start = new Date(date.getTime());
    start.setHours(0, 0, 0, 0);
    return start.getTime();
}

/**
 * Start of the current Monday–Sunday week, in local time.
 *
 * @param {Date} date
 * @returns {number} epoch ms
 */
function startOfLocalWeek(date) {
    const today = startOfLocalDay(date);
    // getDay(): 0 = Sunday … 6 = Saturday. Monday is the week start here.
    const weekday = new Date(today).getDay();
    const daysSinceMonday = (weekday + 6) % 7;
    const monday = new Date(today);
    monday.setDate(monday.getDate() - daysSinceMonday);
    monday.setHours(0, 0, 0, 0);
    return monday.getTime();
}

/**
 * Resolve which time group a timestamp belongs to, using local calendar
 * boundaries rather than fixed 24-hour windows.
 *
 * @param {string} value ISO 8601 timestamp
 * @param {number|Date} [now] reference instant, injectable for tests
 * @returns {'today'|'yesterday'|'earlier-this-week'|'earlier'}
 */
export function resolveTimeGroup(value, now = Date.now()) {
    const target = parseTimestamp(value);
    if (!target) return 'earlier';

    const reference = new Date(now instanceof Date ? now.getTime() : Number(now));
    if (Number.isNaN(reference.getTime())) return 'earlier';

    const dayStart = startOfLocalDay(reference);
    const time = target.getTime();

    if (time >= dayStart) return 'today';
    if (time >= dayStart - MS_PER_DAY) return 'yesterday';
    if (time >= startOfLocalWeek(reference)) return 'earlier-this-week';
    return 'earlier';
}

/**
 * Bucket an already-sorted collection into the four time groups, preserving
 * incoming order within each group and omitting empty groups.
 *
 * @param {object[]} documents normalized documents, already sorted
 * @param {number|Date} [now] reference instant, injectable for tests
 * @returns {{key: string, label: string, documents: object[]}[]}
 */
export function groupRecentDocuments(documents, now = Date.now(), dateField = 'displayedDate') {
    const buckets = new Map(TIME_GROUPS.map((group) => [group.key, []]));

    for (const doc of documents || []) {
        buckets.get(resolveTimeGroup(doc?.[dateField], now)).push(doc);
    }

    return TIME_GROUPS
        .map((group) => ({ ...group, documents: buckets.get(group.key) }))
        .filter((group) => group.documents.length > 0);
}

/**
 * The dashboard pipeline: filter, then sort, then group. Callers use
 * `documents` for the Continue Writing rail and `groups` for the list, so both
 * always describe the same result set.
 *
 * @param {object[]} documents normalized documents
 * @param {{query?: string, filter?: string, sortOrder?: string, now?: number|Date}} [options]
 * @returns {{documents: object[], groups: {key: string, label: string, documents: object[]}[]}}
 */
export function buildDashboardView(documents, options = {}) {
    const { query = '', filter = FILTER_ALL, sortOrder = SORT_NEWEST_FIRST, now = Date.now() } = options;
    const visible = sortRecentDocuments(filterRecentDocuments(documents, { query, filter }), sortOrder);
    const dateField = sortOrder === SORT_CREATED_NEWEST_FIRST || sortOrder === SORT_CREATED_OLDEST_FIRST
        ? 'createdDate'
        : 'displayedDate';

    return { documents: visible, groups: groupRecentDocuments(visible, now, dateField) };
}
