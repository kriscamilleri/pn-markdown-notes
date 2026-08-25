<template>
  <StyleCustomizer :config="markdownStylesConfig">
    <div class="h-full overflow-y-auto p-8">
      <!-- `previewHtmlContent` is sanitized with DOMPurify below. -->
      <div
        id="preview-content"
        v-html="previewHtmlContent"
        data-testid="preview-content"
      ></div>
    </div>
  </StyleCustomizer>
</template>

<script setup>
import { computed } from 'vue';
import { useDocStore } from '@/store/docStore';
import { useMarkdownStore } from '@/store/markdownStore';
import StyleCustomizer from '@/components/StyleCustomizer.vue';
import DOMPurify from 'dompurify';

const docStore = useDocStore();
const markdownStore = useMarkdownStore();

const sampleMarkdown = `# Sample Document for Markdown Preview

This document demonstrates how your selected markdown styles will appear in the application's live preview pane.

## Text Formatting

This is a paragraph containing **bold text**, _italic text_, and \`inline code\`. Strikethrough is also available using \`~~\` (e.g., ~~mistake~~).

### Lists

- Unordered List Item 1
- Unordered List Item 2
    - Nested Item A
    - Nested Item B

1. Ordered List Item 1
2. Ordered List Item 2
    1. Sub-ordered Item
    2. Another Sub-ordered Item

- [x] A completed task
- [ ] An incomplete task

## Block Elements

> This is a blockquote. It's useful for quoting text from other sources.
> It can span multiple lines.

\`\`\`javascript
// This is a JavaScript code block
function greet(name) {
    console.log(\`Hello, \${name}!\`);
}
greet('Developer');
\`\`\`

---

## Tables

| Left-aligned | Center-aligned | Right-aligned |
| :----------- | :------------: | ------------: |
| Content      |    Content     |      Content |
| Item         |      Item      |          Item |

## Links and Images

A link to the [Vue.js documentation](https://vuejs.org/).

An image:
![Vue Logo](https://vuejs.org/images/logo.png)
`;

const markdownStylesConfig = {
  title: 'Customize Markdown Styles',
  getStyles: () => ({ ...docStore.styles }),
  updateStyleAction: docStore.updateStyle,
  getMarkdownIt: docStore.getMarkdownIt,
  sampleMarkdown,
  styleCategories: {
    Headings: ['h1', 'h2', 'h3', 'h4'],
    Text: ['p', 'em', 'strong', 'code', 'blockquote'],
    Lists: ['ul', 'ol', 'li'],
    'Links & Media': ['a', 'img'],
    Tables: ['table', 'tr', 'th', 'td'],
    Other: ['hr', 'pre']
  },
  extraFieldsTitle: 'Additional Settings',
  extraFields: [
    {
      id: 'googleFontFamily',
      label: 'Google Font Family (e.g., Inter, Open Sans)',
      type: 'input',
      inputType: 'text',
      modelKey: 'googleFontFamily',
      placeholder: 'e.g., Inter:wght@400;700'
    },
    {
      id: 'customCSS',
      label: 'Custom CSS Block',
      type: 'textarea',
      modelKey: 'customCSS',
      rows: 8,
      placeholder:
        '/* Add any custom CSS here */\n.my-custom-class {\n  color: #ff0000;\n}\n\n/* You can also override existing styles */\nh1 {\n  text-shadow: 2px 2px 4px rgba(0,0,0,0.3);\n}'
    }
  ],
  resetStyles: () => markdownStore.resetStyles()
};

const previewHtmlContent = computed(() => {
  const md = markdownStylesConfig.getMarkdownIt();
  return DOMPurify.sanitize(md.render(markdownStylesConfig.sampleMarkdown));
});
</script>
