import { parseDbKey } from "./db.js";
import { toCanonicalImageUrl } from "./spaceStorage.js";

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function normalizeReferenceLabel(value) {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function destinationPattern(dbKey) {
  const parsed = parseDbKey(dbKey);
  const qualifier = parsed.kind === "space"
    ? `\\?space=${parsed.id}`
    : "";
  return new RegExp(`^/images/(${UUID_SOURCE})${qualifier}$`);
}

function lineOffsets(text) {
  const lines = [];
  let offset = 0;
  for (const value of text.split(/(?<=\n)/)) {
    lines.push({ value, offset });
    offset += value.length;
  }
  if (text.length === 0) lines.push({ value: "", offset: 0 });
  return lines;
}

function excludedRanges(markdown) {
  const ranges = [];
  let fence = null;
  let htmlBlockTag = null;
  let htmlComment = false;
  for (const line of lineOffsets(markdown)) {
    const body = line.value.replace(/\r?\n$/, "");
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(body);
    if (fence) {
      ranges.push([line.offset, line.offset + line.value.length]);
      if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`).test(body)) fence = null;
      continue;
    }
    if (htmlComment) {
      ranges.push([line.offset, line.offset + line.value.length]);
      if (body.includes("-->")) htmlComment = false;
      continue;
    }
    if (htmlBlockTag) {
      ranges.push([line.offset, line.offset + line.value.length]);
      if (!body.trim() || new RegExp(`</${htmlBlockTag}\\s*>`, "i").test(body)) htmlBlockTag = null;
      continue;
    }
    if (/^ {0,3}<!--/.test(body)) {
      ranges.push([line.offset, line.offset + line.value.length]);
      htmlComment = !body.includes("-->");
      continue;
    }
    const htmlStart = /^ {0,3}<(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|>|\/)/i.exec(body);
    if (htmlStart) {
      ranges.push([line.offset, line.offset + line.value.length]);
      if (!new RegExp(`</${htmlStart[1]}\\s*>`, "i").test(body) && !/\/>\s*$/.test(body)) {
        htmlBlockTag = htmlStart[1];
      }
      continue;
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      ranges.push([line.offset, line.offset + line.value.length]);
      continue;
    }
    if (/^(?: {4}|\t)/.test(body)) {
      ranges.push([line.offset, line.offset + line.value.length]);
      continue;
    }

    // Markdown code spans can contain image-looking text. A matching run of
    // backticks closes only a run of the same length.
    for (let cursor = 0; cursor < body.length;) {
      if (body[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      let length = 1;
      while (body[cursor + length] === "`") length += 1;
      const close = body.indexOf("`".repeat(length), cursor + length);
      if (close < 0) break;
      ranges.push([line.offset + cursor, line.offset + close + length]);
      cursor = close + length;
    }

    // Raw inline HTML is deliberately outside the Markdown-image contract.
    for (const match of body.matchAll(/<[^>\n]*>/g)) {
      ranges.push([line.offset + match.index, line.offset + match.index + match[0].length]);
    }
  }
  return ranges;
}

function isExcluded(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function isEscaped(text, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function collectReferenceLabels(markdown, ranges) {
  const labels = new Set();
  const expression = /!\[[^\]\n]*\]\[([^\]\n]+)\]/g;
  for (const match of markdown.matchAll(expression)) {
    if (!isExcluded(match.index, ranges) && !isEscaped(markdown, match.index)) {
      labels.add(normalizeReferenceLabel(match[1]));
    }
  }
  return labels;
}

function unwrapDestination(raw) {
  return raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
}

function wrapDestination(original, replacement) {
  return original.startsWith("<") ? `<${replacement}>` : replacement;
}

/**
 * Rewrite canonical, same-origin Markdown image destinations only.
 * Everything outside the destination byte spans is returned unchanged.
 */
export function rewriteCanonicalImageDestinations(markdown, {
  sourceDbKey,
  destinationDbKey,
  imageMap = {},
} = {}) {
  const sourcePattern = destinationPattern(sourceDbKey);
  parseDbKey(destinationDbKey);
  const text = typeof markdown === "string" ? markdown : "";
  const ranges = excludedRanges(text);
  const referencedLabels = collectReferenceLabels(text, ranges);
  const replacements = [];
  const sourceImageIds = new Set();
  const missingImageIds = new Set();
  const noncanonicalImageIds = new Set();

  function consider(raw, start, end) {
    const destination = unwrapDestination(raw);
    const match = sourcePattern.exec(destination);
    if (!match) {
      const sameOrigin = new RegExp(`^/images/(${UUID_SOURCE})(?:\\?.*)?$`).exec(destination);
      if (sameOrigin) noncanonicalImageIds.add(sameOrigin[1]);
      return;
    }
    const sourceImageId = match[1];
    sourceImageIds.add(sourceImageId);
    const destinationImageId = imageMap[sourceImageId];
    if (!destinationImageId) {
      missingImageIds.add(sourceImageId);
      return;
    }
    replacements.push({
      start,
      end,
      value: wrapDestination(raw, toCanonicalImageUrl(destinationImageId, destinationDbKey)),
    });
  }

  // Inline image destinations, with an optional Markdown title after the URL.
  const inline = /!\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)\n]+)(?=\s*(?:["'][^"'\n]*["']|\([^\n)]*\))?\s*\))/g;
  for (const match of text.matchAll(inline)) {
    if (isExcluded(match.index, ranges) || isEscaped(text, match.index)) continue;
    const relative = match[0].indexOf(match[1]);
    consider(match[1], match.index + relative, match.index + relative + match[1].length);
  }

  // Only definitions actually referenced by image syntax are eligible. An
  // ordinary link using the same definition must never cause a rewrite.
  const definition = /^ {0,3}\[([^\]\n]+)\]:\s*(<[^>\n]+>|\S+)/gm;
  for (const match of text.matchAll(definition)) {
    if (isExcluded(match.index, ranges)) continue;
    if (!referencedLabels.has(normalizeReferenceLabel(match[1]))) continue;
    const relative = match[0].lastIndexOf(match[2]);
    consider(match[2], match.index + relative, match.index + relative + match[2].length);
  }

  replacements.sort((a, b) => b.start - a.start);
  let content = text;
  for (const replacement of replacements) {
    content = `${content.slice(0, replacement.start)}${replacement.value}${content.slice(replacement.end)}`;
  }
  return {
    content,
    sourceImageIds: [...sourceImageIds],
    missingImageIds: [...missingImageIds],
    noncanonicalImageIds: [...noncanonicalImageIds],
  };
}
