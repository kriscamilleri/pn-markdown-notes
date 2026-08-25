#!/usr/bin/env node
/**
 * combine-files.js
 *
 * Recursively collects files from a directory and concatenates their
 * contents into a single file.  
 *
 * **What’s new?**  
 * • `--file-types/-f` now accepts *either* an extension (e.g. `.js`) **or**
 *   an exact filename (e.g. `docStore.js`).  
 *   That makes it possible to gather a small, explicit set of files
 *   without also pulling in every file that shares their extension.
 *
 * Example – include only the five highlighted files from the question:
 * ```bash
 * node combine-files.js \
 *   -p ./frontend \
 *   -f docStore.js,markdownStore.js,PrintStylesPage.vue,CustomizeStylesPage.vue,StylesPage.vue \
 *   -o selected_files.txt
 * ```
 */

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

/* ------------------------------------------------------------------ */
/* 1. Parse CLI arguments                                             */
/* ------------------------------------------------------------------ */
const argv = minimist(process.argv.slice(2), {
  string: ['path', 'file-types', 'output-file'],
  alias: { p: 'path', f: 'file-types', o: 'output-file' },
  default: {
    path: process.cwd(),
    // You can mix extensions *and* exact filenames, separated by commas.
    //   e.g. ".js,.vue,docStore.js,PrintStylesPage.vue"
    'file-types': ',.js,.json,.yml,.yaml,.vue,.html,.sql,Dockerfile,.cjs,.md',
    'output-file': 'combined_content.txt',
  },
});

const baseDir = path.resolve(argv.path);
const fileTokens = argv['file-types'].split(',').map(s => s.trim()).filter(Boolean);
const outputFile = path.resolve(argv['output-file']);

/* ------------------------------------------------------------------ */
/* 2. Helpers for .llmignore-style filtering                          */
/* ------------------------------------------------------------------ */
function patternToRegExp(pattern) {
  let modified = pattern.replace(/\\/g, '/');

  const dirOnly = modified.endsWith('/');
  if (dirOnly) modified = modified.slice(0, -1);

  modified = modified
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '(.+)?')
    .replace(/\*/g, '[^/]+')
    .replace(/\?/g, '[^/]');

  return new RegExp(`^${modified}${dirOnly ? '(?:/.*)?$' : '$'}`);
}

function createGitignoreFilter(dir) {
  const llmignorePath = path.join(dir, '.llmignore');
  let patterns = [];

  try {
    const content = fs.readFileSync(llmignorePath, 'utf8');
    patterns = content
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(pat => ({ raw: pat, re: patternToRegExp(pat) }));
  } catch {
    /* no .llmignore – silently ignore */
  }

  return relPath => !patterns.some(({ raw, re }) => {
    if (raw === 'node_modules' && relPath.includes('node_modules')) return true;
    if (raw === 'package-lock.json' && relPath.endsWith('package-lock.json')) return true;
    return re.test(relPath);
  });
}

/* ------------------------------------------------------------------ */
/* 3. Gather files                                                    */
/* ------------------------------------------------------------------ */
function getFiles(startDir, tokens) {
  const isAllowed = createGitignoreFilter(startDir);
  const results = [];

  const stack = [startDir];
  while (stack.length) {
    const cur = stack.pop();
    if (!fs.existsSync(cur)) continue;

    for (const entry of fs.readdirSync(cur)) {
      const full = path.join(cur, entry);
      const stat = fs.statSync(full);

      if (stat.isDirectory()) {
        if (isAllowed(path.relative(startDir, full).replace(/\\/g, '/'))) stack.push(full);
        continue;
      }

      const ext = path.extname(full);
      const filename = path.basename(full);
      const match =
        (ext && tokens.includes(ext)) || // by extension (".js")
        tokens.includes(filename);            // by exact filename

      if (match && isAllowed(path.relative(startDir, full).replace(/\\/g, '/')))
        results.push(full);
    }
  }

  // Sort: same-folder groups together, alphabetical inside each
  return results.sort((a, b) => {
    const dirA = path.dirname(a);
    const dirB = path.dirname(b);
    return dirA === dirB ? a.localeCompare(b) : dirA.localeCompare(dirB);
  });
}

/* ------------------------------------------------------------------ */
/* 4. Concatenate and write output                                    */
/* ------------------------------------------------------------------ */
function concatFiles(files, dest) {
  fs.writeFileSync(dest, '');                          // clear / create

  const promptFile = './prompt.md';
  if (fs.existsSync(promptFile)) {
    const promptContent = fs.readFileSync(promptFile, 'utf8');
    fs.appendFileSync(
      dest,
      `${promptContent}\n\n CODE:\n\n`
    );
  }

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(
      dest,
      `----- START: ${file} -----\n${content}\n----- END: ${file} -----\n\n`
    );
  }
}

/* ------------------------------------------------------------------ */
/* 5. Main                                                            */
/* ------------------------------------------------------------------ */
(async () => {
  const files = getFiles(baseDir, fileTokens);
  concatFiles(files, outputFile);

  console.info(`✅ Combined ${files.length} file(s) → ${outputFile}`);
})().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
