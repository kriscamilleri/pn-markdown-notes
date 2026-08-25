// /frontend/src/store/markdownStore.js
import { defineStore } from 'pinia'
import { ref, watch, computed } from 'vue'
import MarkdownIt from 'markdown-it'
import markdownItTaskLists from 'markdown-it-task-lists'
import { useSyncStore } from './syncStore'
import { useAuthStore } from './authStore'
import { useGlobalVariablesStore } from './globalVariablesStore'
import { withImageAuthToken } from '@/utils/imageUrl'

export const useMarkdownStore = defineStore('markdownStore', () => {
  const syncStore = useSyncStore();
  const authStore = useAuthStore();
  const globalVariablesStore = useGlobalVariablesStore();

  function normalizeVariableName(name) {
    return (name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function parseFrontMatter(markdown) {
    if (!markdown) return { metadata: {}, body: '' };
    const lines = markdown.split(/\r?\n/);
    let idx = 0;
    while (idx < lines.length && lines[idx].trim() === '') idx += 1;
    if (idx >= lines.length || lines[idx].trim() !== '---') {
      return { metadata: {}, body: markdown };
    }

    const metadata = {};
    idx += 1;
    for (; idx < lines.length; idx += 1) {
      const line = lines[idx];
      const trimmed = line.trim();
      if (trimmed === '---') {
        idx += 1;
        break;
      }
      if (!trimmed) continue;
      const match = line.match(/^([^:\n]+?)\s*:\s*(.+)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (key) metadata[key] = value;
      }
    }

    const body = lines.slice(idx).join('\n');
    return { metadata, body };
  }

  function extractDocumentMetadata(markdown) {
    return parseFrontMatter(markdown).metadata;
  }

  function applyMetadataVariables(markdown) {
    if (!markdown) return '';
    const { metadata, body } = parseFrontMatter(markdown);
    const variableMap = new Map();

    const now = new Date();
    variableMap.set(normalizeVariableName('GLOBAL_DATE'), now.toLocaleDateString());
    variableMap.set(normalizeVariableName('GLOBAL_TIME'), now.toLocaleTimeString());

    globalVariablesStore.globalsMap.forEach((value, key) => {
      if (key) variableMap.set(key, value);
    });

    Object.entries(metadata).forEach(([key, value]) => {
      const normalizedKey = normalizeVariableName(key);
      if (normalizedKey) variableMap.set(normalizedKey, value);
    });

    return body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, name) => {
      const normalizedName = normalizeVariableName(name);
      if (!normalizedName) return match;
      const value = variableMap.get(normalizedName);
      return value !== undefined ? value : match;
    });
  }

  const printStylesCssString = computed(() => {
    const s = printStyles.value;
    let css = '';

    // Handle Google Font import
    if (s.googleFontFamily) {
      const families = s.googleFontFamily
        .split(',')
        .map(f => `family=${encodeURIComponent(f.trim())}:wght@400;600;700`)
        .join('&');
      if (families) {
        css += `@import url('https://fonts.googleapis.com/css2?${families}&display=swap');\n\n`;
      }
    }

    // Add a base body style using the primary font
    const primaryFont = s.googleFontFamily?.split(',')[0]?.trim()?.replace(/['"]/g, '');
    if (primaryFont) {
      css += `body { font-family: "${primaryFont}", sans-serif; }\n\n`;
    }

    // Generate rules for each element by filtering out non-CSS keys
    for (const key in s) {
      if (
        Object.prototype.hasOwnProperty.call(s, key) &&
        s[key] &&
        ![
          'customCSS', 'googleFontFamily', 'printHeaderHtml', 'printFooterHtml',
          'headerFontSize', 'headerFontColor', 'headerAlign', 'footerFontSize',
          'footerFontColor', 'footerAlign', 'enablePageNumbers'
        ].includes(key)
      ) {
        css += `${key} { ${s[key]} }\n`;
      }
    }

    // Append custom CSS last to allow overrides
    if (s.customCSS) {
      css += `\n/* --- Custom CSS --- */\n${s.customCSS}\n`;
    }

    return css;
  });

  // Default styles
  const defaultStyles = {
    h1: 'font-family: "Playfair Display", "Source Sans 3", Georgia, serif; font-size: 2.25rem; line-height: 1.15; color: #111827; margin-top: 2.5rem; margin-bottom: 1rem; font-weight: 600;',
    h2: 'font-family: "Playfair Display", "Source Sans 3", Georgia, serif; font-size: 1.75rem; line-height: 1.2; color: #1f2937; margin-top: 2rem; margin-bottom: .75rem; font-weight: 600;',
    h3: 'font-size: 1.5rem; line-height: 1.25; color: #1f2937; margin-top: 1.5rem; margin-bottom: .5rem; font-weight: 600;',
    h4: 'font-size: 1.25rem; line-height: 1.3; color: #374151; margin-top: 1.25rem; margin-bottom: .5rem; font-weight: 600;',
    h5: 'font-size: 1rem; line-height: 1.4; margin-top: 1rem; margin-bottom: .25rem; font-weight: 600; color: #374151;',
    h6: 'font-size: .875rem; line-height: 1.4; margin-top: 1rem; margin-bottom: .25rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: #4b5563;',
    p: 'margin: 0 0 1rem 0; line-height: 1.55;',
    ul: 'list-style-type: disc; margin: 0 0 1rem 1.5rem; padding: 0;',
    ol: 'list-style-type: decimal; margin: 0 0 1rem 1.5rem; padding: 0;',
    li: 'margin: .25rem 0;',
    code: 'font-family: "JetBrains Mono", ui-monospace, monospace; background-color: #f3f4f6; color: #111827; padding: .1rem .35rem; border-radius: 4px; font-size: .875em; font-variant-ligatures: none;',
    pre: 'display: block; width: 100%; box-sizing: border-box; font-family: "JetBrains Mono", ui-monospace, monospace; background-color: #f3f4f6; color: #111827; padding: 1rem 1.25rem; border-radius: 8px; overflow: auto; font-size: .875rem; line-height: 1.5; margin: 1.5rem 0; font-variant-ligatures: none;',
    blockquote: 'margin: 1.5rem 0; padding: .5rem 1rem; border-left: 4px solid #d1d5db; background-color: rgba(209, 213, 219, 0.08);',
    hr: 'border: 0; border-top: 1px solid #d1d5db; margin: 2rem 0;',
    em: 'font-style: italic;',
    strong: 'font-weight: 600;',
    a: 'color: #2563eb; text-decoration: underline; text-underline-offset: 2px;',
    img: 'max-width: 100%; height: auto; border-radius: 4px; margin: 1rem 0;',
    table: 'width: 100%; border-collapse: collapse; margin: 1.5rem 0; font-size: .875rem;',
    tr: 'border-bottom: 1px solid #e5e7eb;',
    th: 'border: 1px solid #d1d5db; background-color: #f3f4f6; padding: .5rem .75rem; text-align: left; font-weight: 600;',
    td: 'border: 1px solid #d1d5db; padding: .5rem .75rem;',
    customCSS: `
#preview-content, [data-testid="preview-content"] {
  max-width: 72ch;
  margin-left: auto;
  margin-right: auto;
  font-variant-numeric: proportional-nums;
}
/* Un-style code blocks inside <pre> so they inherit the parent's style */
pre > code {
  background: transparent;
  padding: 0;
  border-radius: 0;
  font-size: 1em;
}
`,
    googleFontFamily: 'Source Sans 3, JetBrains Mono, Playfair Display',
  };

  const defaultPrintStyles = {
    // Start with the same defaults as the on-screen preview styles so the Print
    // Styles page exposes the same inputs and initial values.
    ...defaultStyles,

    // Print-specific extras (kept separate so editing print styles doesn't affect preview styles)
    printHeaderHtml: 'Professional Document',
    printFooterHtml: 'Page %p of %P',
    headerFontSize: '10',
    headerFontColor: '#666666',
    headerAlign: 'center',
    footerFontSize: '10',
    footerFontColor: '#666666',
    footerAlign: 'center',
    headerHeight: '2cm',
    footerHeight: '2.5cm',
    pageMargin: '2cm',
    enablePageNumbers: true,
  };

  const styles = ref({ ...defaultStyles });
  const printStyles = ref({ ...defaultPrintStyles });
  let settingsLoaded = false;

  // Debounce DB writes
  const debounce = (fn, wait) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  };

  const saveStylesToDB = debounce(async () => {
    if (!settingsLoaded || !syncStore.isInitialized) return;
    try {
      await syncStore.personalRepository().transaction(async (repo) => {
        await repo.exec(
          'INSERT OR REPLACE INTO settings (id, value) VALUES (?, ?)',
          ['previewStyles', JSON.stringify(styles.value)]
        );
        await repo.exec(
          'INSERT OR REPLACE INTO settings (id, value) VALUES (?, ?)',
          ['printStyles', JSON.stringify(printStyles.value)]
        );
      });
    } catch (err) {
      console.error('[markdownStore] Failed to save styles', err);
    }
  }, 500);

  async function loadStylesFromDB() {
    if (!syncStore.isInitialized) return;
    try {
      const result = await syncStore.personalRepository().execute(`SELECT id, value FROM settings WHERE id IN ('previewStyles', 'printStyles')`);
      const loadedSettings = result || [];

      const preview = loadedSettings.find(s => s.id === 'previewStyles');
      if (preview) Object.assign(styles.value, JSON.parse(preview.value));

      const print = loadedSettings.find(s => s.id === 'printStyles');
      if (print) Object.assign(printStyles.value, JSON.parse(print.value));

      settingsLoaded = true;
    } catch (err) {
      console.error('[markdownStore] Failed to load styles', err);
      settingsLoaded = true;
    }
  }

  // Watch for DB initialization to load settings
  watch(() => syncStore.isInitialized, (ready) => {
    if (ready) loadStylesFromDB();
  }, { immediate: true });

  // Actions
  function updateStyle(key, value) {
    if (styles.value[key] !== undefined) {
      styles.value[key] = value;
      saveStylesToDB();
    }
  }

  function updatePrintStyle(key, value) {
    if (printStyles.value[key] !== undefined) {
      printStyles.value[key] = value;
      saveStylesToDB();
    }
  }

  function resetStyles() {
    styles.value = { ...defaultStyles };
    saveStylesToDB();
  }

  function resetPrintStyles() {
    printStyles.value = { ...defaultPrintStyles };
    saveStylesToDB();
  }

  // Create a base instance of MarkdownIt with common plugins
  const baseMd = () => {
    return new MarkdownIt({
      html: true,
      linkify: true,
      typographer: true,
    }).use(markdownItTaskLists);
  };

  // Inject CSS into document head
  function addCustomCSSToDocument(cssContent, targetDoc = document) {
    const styleId = 'markdown-custom-styles';
    let styleElement = targetDoc.getElementById(styleId);
    if (!styleElement) {
      styleElement = targetDoc.createElement('style');
      styleElement.id = styleId;
      targetDoc.head.appendChild(styleElement);
    }
    styleElement.textContent = cssContent;
  }

  // Configure renderer with styles
  function configureRenderer(md, styleMap, { injectGlobalStyles = true } = {}) {
    let combinedCSS = '';
    if (styleMap.customCSS) {
      combinedCSS += styleMap.customCSS;
    }

    if (styleMap.googleFontFamily) {
      const families = styleMap.googleFontFamily.split(',')
        .map(f => `family=${encodeURIComponent(f.trim())}:wght@400;600;700`)
        .join('&');
      if (families) {
        combinedCSS += `@import url('https://fonts.googleapis.com/css2?${families}&display=swap');\n`;
        const primaryFont = styleMap.googleFontFamily.split(',')[0].trim().replace(/['"]/g, '');
        combinedCSS += `
     #preview-content, [data-testid="preview-content"] {
      font-family: "${primaryFont}", system-ui, sans-serif;
     }
    `;
      }
    }

    if (combinedCSS && injectGlobalStyles) {
      addCustomCSSToDocument(combinedCSS);
    }

    // Helper to safely get and wrap the original renderer rule
    const wrapRule = (ruleName, styleKey) => {
      const originalRule = md.renderer.rules[ruleName] || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
      md.renderer.rules[ruleName] = (tokens, idx, options, env, self) => {
        const css = styleMap[styleKey];
        if (css) tokens[idx].attrSet('style', css);
        return originalRule(tokens, idx, options, env, self);
      };
    };

    // Headings - special handling to get tag name (h1, h2, etc.)
    const originalHeadingOpen = md.renderer.rules.heading_open || ((t, i, o, e, s) => s.renderToken(t, i, o));
    md.renderer.rules.heading_open = (tokens, idx, opts, env, self) => {
      const token = tokens[idx];
      const css = styleMap[token.tag];
      if (css) token.attrSet('style', css);
      return originalHeadingOpen(tokens, idx, opts, env, self);
    };

    // Basic rules
    wrapRule('paragraph_open', 'p');
    wrapRule('bullet_list_open', 'ul');
    wrapRule('ordered_list_open', 'ol');
    wrapRule('list_item_open', 'li');
    wrapRule('blockquote_open', 'blockquote');
    wrapRule('em_open', 'em');
    wrapRule('strong_open', 'strong');
    wrapRule('code_inline', 'code');
    wrapRule('hr', 'hr');

    // Code blocks (fence for ```, code_block for indented)
    const originalFence = md.renderer.rules.fence || ((t, i, o, e, s) => s.renderToken(t, i, o));
    md.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const css = styleMap.pre;
      if (css) tokens[idx].attrSet('style', css);
      return originalFence(tokens, idx, options, env, self);
    };
    const originalCodeBlock = md.renderer.rules.code_block || ((t, i, o, e, s) => s.renderToken(t, i, o));
    md.renderer.rules.code_block = (tokens, idx, options, env, self) => {
      const css = styleMap.pre;
      if (css) tokens[idx].attrSet('style', css);
      return originalCodeBlock(tokens, idx, options, env, self);
    };


    // Links
    const originalLinkOpen = md.renderer.rules.link_open || ((t, i, o, e, s) => s.renderToken(t, i, o));
    md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      const css = styleMap.a;
      if (css) tokens[idx].attrSet('style', css);
      const href = tokens[idx].attrGet('href');
      if (href && (href.startsWith('http') || href.startsWith('//'))) {
        tokens[idx].attrSet('target', '_blank');
        tokens[idx].attrSet('rel', 'noopener noreferrer');
      }
      return originalLinkOpen(tokens, idx, options, env, self);
    };

    // Image
    const originalImage = md.renderer.rules.image || ((t, i, o, e, s) => s.renderToken(t, i, o));
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const srcIndex = token.attrIndex('src');

      if (srcIndex >= 0) {
        let src = token.attrs[srcIndex][1];
        const apiUrl = import.meta.env.VITE_API_SERVICE_URL || '';

        const isInternalImage = (apiUrl && src.startsWith(apiUrl) && src.includes('/images/')) ||
          (!src.startsWith('http') && (src.startsWith('/images/') || src.startsWith('/api/images/')));

        if (isInternalImage && authStore.token) {
          try {
            token.attrs[srcIndex][1] = withImageAuthToken(src, authStore.token, {
              origin: apiUrl || window.location.origin,
              absolute: Boolean(apiUrl),
            });
          } catch (e) {
            console.error("Failed to parse image URL for token injection:", src, e);
          }
        }
      }

      const css = styleMap.img;
      if (css) token.attrSet('style', css);

      return originalImage(tokens, idx, options, env, self);
    };

    // Table styles
    wrapRule('table_open', 'table');
    wrapRule('tr_open', 'tr');
    wrapRule('th_open', 'th');
    wrapRule('td_open', 'td');
  }

  function getMarkdownIt() {
    const md = baseMd();
    configureRenderer(md, styles.value, { injectGlobalStyles: true });
    return md;
  }

  async function getPrintMarkdownIt() {
    const md = baseMd();
    configureRenderer(md, printStyles.value, { injectGlobalStyles: false });
    return md;
  }

  return {
    styles, printStyles,
    updateStyle, updatePrintStyle,
    resetStyles, resetPrintStyles,
    loadStylesFromDB,
    getMarkdownIt, getPrintMarkdownIt, printStylesCssString,
    extractDocumentMetadata, applyMetadataVariables
  };
});
