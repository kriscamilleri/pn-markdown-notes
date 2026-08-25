import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
    new URL('../../src/components/ImportModal.vue', import.meta.url),
    'utf8'
);

describe('ImportModal document with linked images', () => {
    it('offers a dedicated File System Access API import mode', () => {
        expect(source).toContain("title=\"Document with Linked Images\"");
        expect(source).toContain("selectMode('document-images')");
        expect(source).toContain('window.showDirectoryPicker');
        expect(source).toContain('File System Access API support');
    });

    it('lists discovered documents and imports the user-selected one with its source folder', () => {
        expect(source).toContain('docStore.listMarkdownDocumentsInDirectory(directoryHandle)');
        expect(source).toContain('selectedLinkedDocumentPath');
        expect(source).toContain('docStore.importDocumentWithLinkedImages(');
        expect(source).toContain('linkedSourceDirectory.value');
    });
});
