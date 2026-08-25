import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useEditorStore } from '../../src/store/editorStore.js';

describe('editorStore', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.restoreAllMocks();
    });

    it('forwards insertImageFromLibrary to exposed editor method', () => {
        const store = useEditorStore();
        const insertImagesFromLibrary = vi.fn();

        store.setEditorRef({ insertImagesFromLibrary });

        const images = [
            { id: 'img-1', filename: 'a.png', imageUrl: 'http://localhost:8000/images/img-1' },
            { id: 'img-2', filename: 'b.png', imageUrl: 'http://localhost:8000/images/img-2' },
        ];

        store.insertImageFromLibrary(images);

        expect(insertImagesFromLibrary).toHaveBeenCalledWith(images);
    });

    it('does not throw when image library insert is unavailable', () => {
        const store = useEditorStore();
        store.setEditorRef({});
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(() => store.insertImageFromLibrary([{ id: 'img-1' }])).not.toThrow();
        expect(warning).toHaveBeenCalledWith('Editor not available for insertImagesFromLibrary');
    });

    it('forwards insertText to exposed editor method', () => {
        const store = useEditorStore();
        const insertText = vi.fn();

        store.setEditorRef({ insertText });
        store.insertText(' dictated words');

        expect(insertText).toHaveBeenCalledWith(' dictated words');
    });

    it('does not throw when insertText is unavailable', () => {
        const store = useEditorStore();
        store.setEditorRef({});
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(() => store.insertText('dictated words')).not.toThrow();
        expect(warning).toHaveBeenCalledWith('Editor not available for insertText');
    });
});
