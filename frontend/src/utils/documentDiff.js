import { diffLines } from 'diff';

/**
 * Turns a `diffLines` result into the flat `{ type, prefix, text }` list used
 * by the shared diff renderer. Extracted so the revision panel and the
 * COLLAB-01 conflict compare dialog render diffs identically.
 *
 * @param {string | null | undefined} oldText
 * @param {string | null | undefined} newText
 * @returns {{ type: 'added' | 'removed' | 'unchanged', prefix: string, text: string }[]}
 */
export function buildDiffLineItems(oldText, newText) {
  const hunks = diffLines(oldText ?? '', newText ?? '');
  const result = [];
  for (const hunk of hunks) {
    // `diffLines` keeps a trailing newline on the final hunk; strip it so the
    // renderer does not emit an empty trailing line.
    const lines = hunk.value.replace(/\n$/, '').split('\n');
    for (const line of lines) {
      if (hunk.added) {
        result.push({ type: 'added', prefix: '+', text: line });
      } else if (hunk.removed) {
        result.push({ type: 'removed', prefix: '-', text: line });
      } else {
        result.push({ type: 'unchanged', prefix: ' ', text: line });
      }
    }
  }
  return result;
}
