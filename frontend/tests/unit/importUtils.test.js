import { describe, it, expect } from 'vitest';
import {
    sanitizePathSegments,
    extractTitleFromFrontMatter,
    titleFromFilename,
    getTextByteLength,
    isMarkdownFile,
    isHiddenSegment,
    buildFolderTree,
    validateImportLimits,
    IMPORT_LIMITS,
    normalizeLocalImagePath,
    collectLocalMarkdownImagePaths,
    replaceLocalMarkdownImageReferences,
} from '../../src/utils/importUtils.js';

// ── sanitizePathSegments ─────────────────────────────────────

describe('sanitizePathSegments', () => {
    it('splits a normal path into segments', () => {
        expect(sanitizePathSegments('vault/daily/note.md')).toEqual(['vault', 'daily', 'note.md']);
    });

    it('strips ".." segments', () => {
        expect(sanitizePathSegments('../../etc/passwd')).toEqual(['etc', 'passwd']);
    });

    it('strips "." segments', () => {
        expect(sanitizePathSegments('./vault/./note.md')).toEqual(['vault', 'note.md']);
    });

    it('strips empty segments (double slashes)', () => {
        expect(sanitizePathSegments('vault//note.md')).toEqual(['vault', 'note.md']);
    });

    it('strips drive letters', () => {
        expect(sanitizePathSegments('C:\\Users\\docs\\note.md')).toEqual(['Users', 'docs', 'note.md']);
    });

    it('strips leading slashes', () => {
        expect(sanitizePathSegments('/etc/shadow')).toEqual(['etc', 'shadow']);
    });

    it('handles Windows backslashes', () => {
        expect(sanitizePathSegments('vault\\daily\\note.md')).toEqual(['vault', 'daily', 'note.md']);
    });

    it('strips control characters', () => {
        expect(sanitizePathSegments('vault/na\x00me\x01.md')).toEqual(['vault', 'name.md']);
    });

    it('truncates segments to 500 chars', () => {
        const longName = 'a'.repeat(600) + '.md';
        const result = sanitizePathSegments(`vault/${longName}`);
        expect(result[1].length).toBe(500);
    });

    it('normalizes Unicode to NFC', () => {
        // é as combining sequence (NFD) vs precomposed (NFC)
        const nfd = 'cafe\u0301.md';
        const result = sanitizePathSegments(nfd);
        expect(result[0]).toBe('caf\u00e9.md');
    });

    it('returns empty array for null/undefined/empty', () => {
        expect(sanitizePathSegments(null)).toEqual([]);
        expect(sanitizePathSegments(undefined)).toEqual([]);
        expect(sanitizePathSegments('')).toEqual([]);
    });

    it('handles path traversal with mixed separators', () => {
        expect(sanitizePathSegments('..\\..\\Windows\\System32\\config')).toEqual(['Windows', 'System32', 'config']);
    });
});

// ── extractTitleFromFrontMatter ──────────────────────────────

describe('extractTitleFromFrontMatter', () => {
    it('extracts a plain title', () => {
        const content = '---\ntitle: My Note Title\n---\n\n# Content';
        expect(extractTitleFromFrontMatter(content)).toBe('My Note Title');
    });

    it('extracts a quoted title (double quotes)', () => {
        const content = '---\ntitle: "My Note Title"\n---\n\n# Content';
        expect(extractTitleFromFrontMatter(content)).toBe('My Note Title');
    });

    it('extracts a quoted title (single quotes)', () => {
        const content = "---\ntitle: 'My Note Title'\n---\n\n# Content";
        expect(extractTitleFromFrontMatter(content)).toBe('My Note Title');
    });

    it('returns null when no front matter', () => {
        expect(extractTitleFromFrontMatter('# Just a heading\n\nContent')).toBeNull();
    });

    it('returns null when no title field in front matter', () => {
        const content = '---\nauthor: Someone\ndate: 2026-01-01\n---\n\nContent';
        expect(extractTitleFromFrontMatter(content)).toBeNull();
    });

    it('returns null when title is empty', () => {
        const content = '---\ntitle:   \n---\n\nContent';
        expect(extractTitleFromFrontMatter(content)).toBeNull();
    });

    it('returns null when front matter not at byte 0', () => {
        const content = '\n---\ntitle: My Title\n---\n\nContent';
        expect(extractTitleFromFrontMatter(content)).toBeNull();
    });

    it('only scans first 4 KB', () => {
        const bigContent = '---\n' + 'x: ' + 'a'.repeat(5000) + '\ntitle: Hidden\n---\n\nContent';
        // The front matter block exceeds 4KB so title line is beyond 4KB boundary
        expect(extractTitleFromFrontMatter(bigContent)).toBeNull();
    });

    it('handles \\r\\n line endings', () => {
        const content = '---\r\ntitle: Windows Title\r\n---\r\n\r\nContent';
        expect(extractTitleFromFrontMatter(content)).toBe('Windows Title');
    });

    it('returns null for malformed delimiters', () => {
        const content = '----\ntitle: Bad\n----\n\nContent';
        expect(extractTitleFromFrontMatter(content)).toBeNull();
    });

    it('returns null for null/undefined input', () => {
        expect(extractTitleFromFrontMatter(null)).toBeNull();
        expect(extractTitleFromFrontMatter(undefined)).toBeNull();
    });

    it('strips control characters from title', () => {
        const content = '---\ntitle: Bad\x00Title\x01Here\n---\n\nContent';
        expect(extractTitleFromFrontMatter(content)).toBe('BadTitleHere');
    });

    it('normalizes Unicode NFC in title', () => {
        const nfd = '---\ntitle: cafe\u0301\n---\n\nContent';
        expect(extractTitleFromFrontMatter(nfd)).toBe('caf\u00e9');
    });

    it('truncates title to 500 chars', () => {
        const longTitle = 'a'.repeat(600);
        const content = `---\ntitle: ${longTitle}\n---\n\nContent`;
        expect(extractTitleFromFrontMatter(content).length).toBe(500);
    });
});

// ── titleFromFilename ────────────────────────────────────────

describe('titleFromFilename', () => {
    it('strips .md extension', () => {
        expect(titleFromFilename('my-note.md')).toBe('my-note');
    });

    it('strips .markdown extension', () => {
        expect(titleFromFilename('my-note.markdown')).toBe('my-note.markdown');
    });

    it('returns "Untitled" for just ".md"', () => {
        expect(titleFromFilename('.md')).toBe('Untitled');
    });

    it('returns "Untitled" for empty string', () => {
        expect(titleFromFilename('')).toBe('Untitled');
    });

    it('returns "Untitled" for null', () => {
        expect(titleFromFilename(null)).toBe('Untitled');
    });

    it('preserves name without .md extension', () => {
        expect(titleFromFilename('readme.txt')).toBe('readme.txt');
    });

    it('strips control characters from filename-derived title', () => {
        expect(titleFromFilename('bad\x00title\x01.md')).toBe('badtitle');
    });

    it('normalizes filename-derived title to NFC', () => {
        expect(titleFromFilename('cafe\u0301.md')).toBe('caf\u00e9');
    });

    it('truncates filename-derived title to 500 chars', () => {
        const longName = `${'a'.repeat(600)}.md`;
        expect(titleFromFilename(longName)).toHaveLength(500);
    });

    it('returns "Untitled" when filename-derived title is whitespace/control only', () => {
        expect(titleFromFilename(' \x00\x01 .md')).toBe('Untitled');
    });
});

// ── getTextByteLength ────────────────────────────────────────

describe('getTextByteLength', () => {
    it('returns UTF-8 byte length for ASCII text', () => {
        expect(getTextByteLength('hello')).toBe(5);
    });

    it('returns UTF-8 byte length for multibyte text', () => {
        expect(getTextByteLength('café')).toBe(5);
    });

    it('returns 0 for empty or null input', () => {
        expect(getTextByteLength('')).toBe(0);
        expect(getTextByteLength(null)).toBe(0);
    });
});

// ── isMarkdownFile ───────────────────────────────────────────

describe('isMarkdownFile', () => {
    it('matches .md', () => expect(isMarkdownFile('note.md')).toBe(true));
    it('rejects .markdown', () => expect(isMarkdownFile('note.markdown')).toBe(false));
    it('matches .MD (case-insensitive)', () => expect(isMarkdownFile('note.MD')).toBe(true));
    it('rejects .txt', () => expect(isMarkdownFile('note.txt')).toBe(false));
    it('rejects .json', () => expect(isMarkdownFile('data.json')).toBe(false));
    it('rejects null', () => expect(isMarkdownFile(null)).toBe(false));
    it('rejects empty', () => expect(isMarkdownFile('')).toBe(false));
});

// ── isHiddenSegment ──────────────────────────────────────────

describe('isHiddenSegment', () => {
    it('detects dot-prefixed', () => expect(isHiddenSegment('.git')).toBe(true));
    it('detects double-underscore-prefixed', () => expect(isHiddenSegment('__MACOSX')).toBe(true));
    it('allows normal names', () => expect(isHiddenSegment('vault')).toBe(false));
    it('returns false for empty', () => expect(isHiddenSegment('')).toBe(false));
    it('returns false for null', () => expect(isHiddenSegment(null)).toBe(false));
});

// ── buildFolderTree ──────────────────────────────────────────

describe('buildFolderTree', () => {
    it('handles flat files (no dirs)', () => {
        const entries = [
            { relativePath: 'note-a.md', content: '# A' },
            { relativePath: 'note-b.md', content: '# B' },
        ];
        const { folders, notes } = buildFolderTree(entries);
        expect(folders.size).toBe(0);
        expect(notes).toHaveLength(2);
        expect(notes[0].folderPath).toBeNull();
        expect(notes[0].title).toBe('note-a');
    });

    it('builds single-level directory', () => {
        const entries = [
            { relativePath: 'vault/note.md', content: 'content' },
        ];
        const { folders, notes } = buildFolderTree(entries);
        expect(folders.size).toBe(1);
        expect(folders.get('vault')).toEqual({ name: 'vault', parentPath: null });
        expect(notes[0].folderPath).toBe('vault');
    });

    it('builds deeply nested directories', () => {
        const entries = [
            { relativePath: 'vault/projects/panino/todo.md', content: '' },
        ];
        const { folders, notes } = buildFolderTree(entries);
        expect(folders.size).toBe(3);
        expect(folders.get('vault')).toEqual({ name: 'vault', parentPath: null });
        expect(folders.get('vault/projects')).toEqual({ name: 'projects', parentPath: 'vault' });
        expect(folders.get('vault/projects/panino')).toEqual({ name: 'panino', parentPath: 'vault/projects' });
        expect(notes[0].folderPath).toBe('vault/projects/panino');
    });

    it('builds mixed files and dirs', () => {
        const entries = [
            { relativePath: 'vault/note-a.md', content: '' },
            { relativePath: 'vault/daily/2026-04-18.md', content: '' },
            { relativePath: 'vault/daily/2026-04-17.md', content: '' },
            { relativePath: 'vault/projects/panino/todo.md', content: '' },
        ];
        const { folders, notes } = buildFolderTree(entries);
        expect(folders.size).toBe(4); // vault, daily, projects, panino
        expect(notes).toHaveLength(4);
    });

    it('skips hidden files', () => {
        const entries = [
            { relativePath: '.obsidian/config.md', content: '' },
            { relativePath: 'vault/note.md', content: '' },
        ];
        const { notes } = buildFolderTree(entries);
        expect(notes).toHaveLength(1);
        expect(notes[0].title).toBe('note');
    });

    it('skips __MACOSX directories', () => {
        const entries = [
            { relativePath: '__MACOSX/vault/note.md', content: '' },
            { relativePath: 'vault/note.md', content: '' },
        ];
        const { notes } = buildFolderTree(entries);
        expect(notes).toHaveLength(1);
    });

    it('skips non-markdown files', () => {
        const entries = [
            { relativePath: 'vault/image.png', content: '' },
            { relativePath: 'vault/note.md', content: '' },
        ];
        const { notes } = buildFolderTree(entries);
        expect(notes).toHaveLength(1);
    });

    it('handles empty input', () => {
        const { folders, notes } = buildFolderTree([]);
        expect(folders.size).toBe(0);
        expect(notes).toHaveLength(0);
    });

    it('uses front-matter title when available', () => {
        const entries = [
            { relativePath: 'vault/note.md', content: '---\ntitle: Custom Title\n---\n\n# Content' },
        ];
        const { notes } = buildFolderTree(entries);
        expect(notes[0].title).toBe('Custom Title');
    });

    it('falls back to filename when no front-matter title', () => {
        const entries = [
            { relativePath: 'vault/my-note.md', content: '# Just content' },
        ];
        const { notes } = buildFolderTree(entries);
        expect(notes[0].title).toBe('my-note');
    });

    // Security tests
    it('strips path traversal from ZIP entry paths', () => {
        const entries = [
            { relativePath: '../../etc/passwd.md', content: 'malicious' },
        ];
        const { folders, notes } = buildFolderTree(entries);
        expect(folders.size).toBe(1); // "etc" folder
        expect(notes[0].title).toBe('passwd');
        expect(notes[0].folderPath).toBe('etc');
    });

    it('handles null bytes in paths', () => {
        const entries = [
            { relativePath: 'vault/no\x00te.md', content: '' },
        ];
        const { notes } = buildFolderTree(entries);
        expect(notes[0].title).toBe('note');
    });

    it('treats __proto__ and constructor as normal folder names', () => {
        const entries = [
            { relativePath: '__proto__/note.md', content: '' },
        ];
        // __proto__ starts with __ so it's treated as hidden and skipped
        const { notes } = buildFolderTree(entries);
        expect(notes).toHaveLength(0);
    });

    it('handles constructor as a folder name safely', () => {
        const entries = [
            { relativePath: 'constructor/note.md', content: '' },
        ];
        const { folders, notes } = buildFolderTree(entries);
        expect(folders.has('constructor')).toBe(true);
        expect(notes).toHaveLength(1);
    });
});

// ── validateImportLimits ─────────────────────────────────────

describe('validateImportLimits', () => {
    it('does not throw for valid counts', () => {
        expect(() => validateImportLimits(100, 10, 1000)).not.toThrow();
    });

    it('throws when file count exceeds limit', () => {
        expect(() => validateImportLimits(10_001, 0)).toThrow(/too many files/);
    });

    it('throws when directory count exceeds limit', () => {
        expect(() => validateImportLimits(0, 1_001)).toThrow(/too many directories/);
    });

    it('throws when total bytes exceeds limit', () => {
        expect(() => validateImportLimits(1, 1, 600 * 1024 * 1024)).toThrow(/500 MB/);
    });

    it('allows when totalBytes is undefined', () => {
        expect(() => validateImportLimits(100, 10)).not.toThrow();
    });
});

// ── IMPORT_LIMITS ────────────────────────────────────────────

describe('IMPORT_LIMITS', () => {
    it('has expected values', () => {
        expect(IMPORT_LIMITS.MAX_FILES).toBe(10_000);
        expect(IMPORT_LIMITS.MAX_TOTAL_BYTES).toBe(500 * 1024 * 1024);
        expect(IMPORT_LIMITS.MAX_FILE_BYTES).toBe(1 * 1024 * 1024);
        expect(IMPORT_LIMITS.MAX_DIRECTORIES).toBe(1_000);
    });

    describe('local Markdown image references', () => {
        it('normalizes relative image paths for a selected directory', () => {
            expect(normalizeLocalImagePath('./evidence/cafe\u0301.png')).toEqual({
                path: 'evidence/café.png',
                segments: ['evidence', 'café.png'],
            });
        });

        it.each([
            '/etc/passwd',
            '\\\\server\\share\\image.png',
            '../outside.png',
            'assets/../../outside.png',
            'https://example.test/image.png',
            'data:image/png;base64,abc',
            'image\x00.png',
        ])('rejects unsafe local image destination %s', (destination) => {
            expect(normalizeLocalImagePath(destination)).toBeNull();
        });

        it('collects unique valid inline image paths and reports unsafe destinations', () => {
            const content = [
                '![One](evidence/one.png)',
                '![Duplicate](./evidence/one.png)',
                '![Two](<evidence/two image.png>)',
                '![External](https://example.test/image.png)',
            ].join('\n');

            expect(collectLocalMarkdownImagePaths(content)).toEqual({
                paths: ['evidence/one.png', 'evidence/two image.png'],
                skippedItems: [{
                    path: 'https://example.test/image.png',
                    reason: 'image path is external, absolute, or unsafe',
                }],
            });
        });

        it('rewrites only successful local image uploads and preserves title syntax', () => {
            const content = '![One](evidence/one.png "caption")\n![Two](<evidence/two.png>)\n![Remote](https://example.test/remote.png)';
            const rewritten = replaceLocalMarkdownImageReferences(content, new Map([
                ['evidence/one.png', '/images/image-one'],
                ['evidence/two.png', '/images/image-two'],
            ]));

            expect(rewritten).toBe('![One](/images/image-one "caption")\n![Two](/images/image-two)\n![Remote](https://example.test/remote.png)');
        });
    });
});
