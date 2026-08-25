// Flat ESLint config for the Panino monorepo.
//
// Ruleset per docs/specs/dx/dx-01-backend-test-runnability.md section 6 Phase 5 Option A:
// eslint:recommended + vue3-recommended, with all stylistic/formatting rules off. Lint is
// here to catch real defects — unused imports, stray console.log, undefined identifiers —
// not to argue about whitespace. Formatting is Prettier's job.
//
// Named .mjs, not .js, because the root package.json has no "type": "module".

import js from "@eslint/js";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";

/** Vue rules from vue3-recommended that only concern formatting. */
const vueStylisticOff = {
  "vue/attributes-order": "off",
  "vue/component-tags-order": "off",
  "vue/first-attribute-linebreak": "off",
  "vue/html-closing-bracket-newline": "off",
  "vue/html-closing-bracket-spacing": "off",
  "vue/html-indent": "off",
  "vue/html-quotes": "off",
  "vue/html-self-closing": "off",
  "vue/max-attributes-per-line": "off",
  "vue/multiline-html-element-content-newline": "off",
  "vue/mustache-interpolation-spacing": "off",
  "vue/no-multi-spaces": "off",
  "vue/no-spaces-around-equal-signs-in-attribute": "off",
  "vue/singleline-html-element-content-newline": "off",
  "vue/attribute-hyphenation": "off",
  "vue/v-on-event-hyphenation": "off",
  "vue/this-in-template": "off",
  "vue/block-order": "off",
};

export default [
  {
    // Generated output, vendored bundles, and real user data. Mirrors .llmignore.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-ssr/**",
      "**/coverage/**",
      "backend/api-service/vendor/**",
      "backend/api-service/data/**",
      "backend/api-service/uploads/**",
      "backend/font-service/**",
      "frontend/src/vendor/**",
      "poc/**",
      ".vscode/**",
    ],
  },

  js.configs.recommended,
  ...pluginVue.configs["flat/recommended"],

  // Repo-wide rule tuning. Declared before the per-area blocks below so those can
  // override it — flat config is last-match-wins.
  {
    rules: {
      // console.warn/error are legitimate; a bare console.log in shipped frontend code is
      // not. A warning so it surfaces in review without blocking CI. Off for the backend.
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      // Allow deliberately-unused args prefixed with _ (common in catch/callback signatures).
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Editor.vue, Navbar.vue, Documents.vue and Preview.vue predate this config and are
      // referenced by name throughout the app. Renaming them is a refactor, not a lint fix.
      "vue/multi-word-component-names": "off",
      // Raw HTML is prohibited by default. The two sanitized preview surfaces have narrow,
      // file-specific exemptions below.
      "vue/no-v-html": "warn",
    },
  },

  // Frontend: browser runtime, ES modules.
  {
    files: ["frontend/**/*.{js,vue}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: vueStylisticOff,
  },

  {
    files: [
      "frontend/src/components/Preview.vue",
      "frontend/src/pages/StylesPage.vue",
    ],
    rules: {
      // Both surfaces sanitize their MarkdownIt output with DOMPurify before rendering.
      "vue/no-v-html": "off",
    },
  },

  // Build/tooling config files run under Node even inside the frontend tree.
  {
    files: ["**/*.config.{js,mjs,cjs}", "**/vite.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },

  // Backend: Node runtime, ES modules ("type": "module").
  {
    files: ["backend/api-service/**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // The backend has no logger abstraction — console IS the logging mechanism, and
      // several of these lines are the structured sync/incident logs that the runbooks
      // in docs/runbooks/ tell an operator to grep for. Flagging them is pure noise.
      "no-console": "off",
    },
  },

  // Filename and path sanitizers legitimately match ASCII control characters; that is
  // the point of the regex. See frontend/AGENTS.md on import-time path sanitization.
  {
    files: [
      "frontend/src/utils/importUtils.js",
      "frontend/src/store/importExportStore.js",
    ],
    rules: { "no-control-regex": "off" },
  },

  // Tests, both layers. Vitest is imported explicitly, but allow the globals too.
  {
    files: ["**/tests/**/*.{js,mjs}", "**/*.test.{js,mjs}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
    },
  },

  // Repo-level operational scripts (production backup and friends). Node runtime, ES
  // modules. console is these scripts' user interface, not stray debug output.
  {
    files: ["scripts/**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-console": "off",
    },
  },

  // Root CommonJS tooling.
  {
    files: ["*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },
];
