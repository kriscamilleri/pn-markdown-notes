/**
 * Determines whether editor content differs from the persisted document content.
 *
 * Treat legacy null content as an empty document, matching the editor's value.
 *
 * @param {string | null | undefined} persistedContent
 * @param {string | null | undefined} nextContent
 * @returns {boolean}
 */
export function hasDocumentContentChanged(persistedContent, nextContent) {
  return (persistedContent ?? "") !== (nextContent ?? "");
}

/**
 * Classifies a remote content change for an open editor as `adopt`, `ignore`,
 * or `conflict` (COLLAB-01 §4.2).
 *
 * - `adopt`: the editor is clean — remote content should replace the textarea.
 * - `ignore`: remote content equals the base — nothing meaningful changed.
 * - `conflict`: the editor and the remote side both diverged from the base.
 *
 * @param {{ mine: string | null | undefined, base: string | null | undefined, theirs: string | null | undefined }} parts
 * @returns {'adopt' | 'ignore' | 'conflict'}
 */
export function classifyEditorConflict({ mine, base, theirs }) {
  if (!hasDocumentContentChanged(theirs, base)) return "ignore";
  if (!hasDocumentContentChanged(mine, base)) return "adopt";
  return "conflict";
}
