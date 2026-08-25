# Document Folder Image Import

**Agent:** Copilot CLI runtime in VS Code
**Started:** 2026-08-25 07:50
**Status:** completed

## Objective

Add a Chromium File System Access API workflow that imports one Markdown document selected from
a local folder, uploads its relative linked images, and rewrites those references to Panino image
URLs.

## Progress

- [x] Defined the File System Access API workflow and security boundaries.
- [x] Added Markdown image-path parsing and rewriting utilities with security tests.
- [x] Added transactional document import with authenticated image upload.
- [x] Added an Import dialog mode for choosing a source folder and discovered Markdown document.
- [x] Verified the provided CF Estates manual fixture has 20 linked images and every link resolves
  under its selected `docs` folder.
- [x] Ran focused tests, the full frontend suite, lint, and a production build.

## Changes Made

- Added [`docs/specs/active/document-folder-image-import.md`](../../specs/active/document-folder-image-import.md).
- Added safe local image reference parsing and selective rewriting in
  [`frontend/src/utils/importUtils.js`](../../../../frontend/src/utils/importUtils.js).
- Added source-folder enumeration plus linked-image upload/import orchestration in
  [`frontend/src/store/importExportStore.js`](../../../../frontend/src/store/importExportStore.js),
  exposed through [`frontend/src/store/docStore.js`](../../../../frontend/src/store/docStore.js).
- Added the **Document with Linked Images** picker flow in
  [`frontend/src/components/ImportModal.vue`](../../../../frontend/src/components/ImportModal.vue).
- Added utility, store, nested-path, failure-path, and modal tests.

## Tests

- `cd frontend && npx vitest run --reporter=verbose tests/unit/importUtils.test.js tests/unit/importExportStore.test.js tests/unit/importModal.test.js`
  — 86 passed.
- `cd frontend && npm run build` — passed; existing Vite chunk/dynamic-import warnings only.
- `npm run lint` — passed with 40 existing warnings and no errors.
- `npm run test:fe` — 25 files, 385 tests passed. Existing test stderr and generated-vendor
  sourcemap warnings remain non-failing.
- Checked all 20 unique image references in
  `/home/kris/Development/cf-estates-odoo/docs/CF_ESTATES_USER_MANUAL_CHAPTERS_01-03.md`
  resolve under `/home/kris/Development/cf-estates-odoo/docs`.

## Open Items / Notes

- Browser end-to-end selection of the local fixture is intentionally manual: `showDirectoryPicker`
  requires a real user gesture and permission grant. In Chromium, choose
  `/home/kris/Development/cf-estates-odoo/docs`, select
  `CF_ESTATES_USER_MANUAL_CHAPTERS_01-03.md`, and import. The flow will upload the 20 resolved
  linked images and rewrite their Markdown destinations.
- The active spec remains active until the feature is released.
