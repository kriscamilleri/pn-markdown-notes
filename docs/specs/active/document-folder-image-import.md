# Local Document Folder Image Import

> Status: active
> Created: 2026-08-25
> Last updated: 2026-08-25

## Summary

Import one selected Markdown document and its relative local image assets from a directory
chosen with the File System Access API. Imported image files are uploaded to the user's Panino
image library and their Markdown links are rewritten to Panino image URLs.

## Goals

1. Let Chromium users select a local source directory with `showDirectoryPicker()`.
2. Let them choose a Markdown document discovered in that directory.
3. Upload each supported, locally-relative image used by the chosen document.
4. Rewrite successfully uploaded image references to `/images/<uuid>` (or `/api/images/<uuid>`
   in production).
5. Preserve the existing safe document overwrite and revision behavior.
6. Report missing, invalid, unsupported, and failed image imports without preventing the
   Markdown document itself from being imported.

## Non-goals

- No filesystem synchronization or background permission persistence.
- No external URL downloads, absolute local paths, `data:` URIs, or parent-directory traversal.
- No import of images used by Markdown documents other than the one the user selects.
- No image deduplication, resizing, or transcoding.
- No fallback that silently changes browser security guarantees.

## User experience

The Import dialog has a **Document with Linked Images** option. It asks the user to choose the
folder containing the document and its assets. The app enumerates Markdown documents within the
chosen folder and presents them for selection. Import is enabled after one is selected.

The option is available only where `window.showDirectoryPicker` is supported. Unsupported
browsers show a direct explanation rather than attempting an insecure file-path fallback.

## Processing

1. Read the selected Markdown file as UTF-8 (maximum 1 MB).
2. Parse inline Markdown image destinations (`![alt](relative/path.png)`).
3. Reject image destinations that are external URLs, absolute paths, contain traversal segments,
   or cannot be resolved within the selected directory.
4. For valid destinations, obtain the file from the selected directory handle, enforce import
   file and aggregate size limits, and upload it through the authenticated image endpoint.
5. Rewrite only each reference whose upload returned an image ID. Leave every skipped reference
   unchanged.
6. Apply the resulting document through the existing transactional import pipeline. Existing
   document overwrites retain revision capture and unsafe-overwrite confirmation behavior.

## Security and limits

- The browser picker remains the only path to local data; no paths are sent to the API.
- Traversal, absolute paths, URL schemes, and control characters are rejected before handle
  lookup.
- Existing import limits apply: 10,000 files, 1,000 directories, 500 MB total, and 1 MB per
  imported file.
- Upload errors are surfaced as item-level skips; server-side MIME, ownership, and size checks
  remain authoritative.
- Markdown is stored raw and is sanitized by the existing preview boundary.

## Tests

- Parse and rewrite relative image references while preserving unrelated Markdown.
- Reject URL, absolute, and traversal destinations.
- Import a document with a mocked directory tree, upload valid images, and rewrite only successful
  uploads.
- Ensure failed and missing images are reported while the document still imports.
- Verify unsupported browser and supported-picker UI states.
