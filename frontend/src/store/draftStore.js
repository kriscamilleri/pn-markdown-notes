import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Holds ephemeral "draft" text for each file currently being edited, plus the
 * per-document "base" it is being edited from.
 * - Editor.vue writes keystrokes to this store.
 * - Preview.vue reads from this store so it updates immediately.
 * - The actual DB save (docStore.updateFileContent) is done on a debounce, so
 *   we don't conflict or spam the DB with every keystroke.
 *
 * The base is the content the editor last agreed on: the value loaded on open,
 * adopted on a remote change, or written by a local save. It distinguishes
 * "content I am editing from" (base) from "content now in the database"
 * (theirs) and "content in my textarea" (mine). See COLLAB-01.
 */
export const useDraftStore = defineStore('draftStore', () => {
    // A Map-like object keyed by fileId => string (the "draft" text)
    const drafts = ref({})

    // A Map-like object keyed by fileId => string (the "base" text)
    const bases = ref({})

    function getDraft(fileId) {
        return Object.prototype.hasOwnProperty.call(drafts.value, fileId)
            ? drafts.value[fileId]
            : undefined
    }
    function setDraft(fileId, text) {
        drafts.value[fileId] = text
    }

    function clearDraft(fileId) {
        delete drafts.value[fileId]
    }

    function getBase(fileId) {
        return Object.prototype.hasOwnProperty.call(bases.value, fileId)
            ? bases.value[fileId]
            : undefined
    }
    function setBase(fileId, text) {
        bases.value[fileId] = text
    }

    function clearBase(fileId) {
        delete bases.value[fileId]
    }

    function clearAll() {
        drafts.value = {}
        bases.value = {}
    }

    return {
        getDraft,
        setDraft,
        clearDraft,
        getBase,
        setBase,
        clearBase,
        clearAll,
    }
})
