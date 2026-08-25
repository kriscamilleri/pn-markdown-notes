// /backend/api-service/pdf.js
/**
 * ============================================================================
 * PDF GENERATION SERVICE
 * ============================================================================
 *
 * Converts sanitized HTML/CSS into PDF via Puppeteer.
 *
 * FLOW:
 * 1. POST /render-pdf with { htmlContent, cssStyles, printStyles }
 * 2. Sanitize HTML/CSS, embed images as data URIs
 * 3. Build HTML with @page rules and pagebreak helpers
 * 4. Run a draft pdf pass to resolve total pages for header/footer placeholders
 * 5. Render final PDF using Puppeteer's displayHeaderFooter templates
 *
 * DESIGN NOTES:
 * - Images are pre-embedded to avoid localhost fetch issues and enforce SSRF checks
 * - Single browser instance is reused; requests run sequentially to limit memory
 * - Page numbers use a draft render + pdf-lib count to populate %p/%P tokens
 *
 * ============================================================================
 */

import express from 'express';
import puppeteer from 'puppeteer';
import { JSDOM } from 'jsdom';
import DOMPurify from 'dompurify';
import fs from 'fs';
import { promises as dns } from 'dns';
import { getDb } from './db.js';
import { resolveSpaceAccess } from './spaces.js';
import { resolveStoredImagePath } from './spaceStorage.js';
import { PDFDocument } from 'pdf-lib';

export const pdfRoutes = express.Router();

const window = new JSDOM('').window;
const purify = DOMPurify(window);

const CONFIG = {
    EXTERNAL_IMAGE_TIMEOUT: 10000,
    PAGE_LOAD_TIMEOUT: 10000,
    MAX_EXTERNAL_IMAGE_SIZE: 5000,
};
const ENABLE_REMOTE_FONTS = process.env.PDF_DISABLE_REMOTE_FONTS === '1'
    ? false
    : process.env.NODE_ENV !== 'test';

const log = (message, ...args) => console.log(`[PDF] ${message}`, ...args);
const logWarn = (message, ...args) => console.warn(`[PDF] ${message}`, ...args);
const logError = (message, ...args) => console.error(`[PDF] ${message}`, ...args);

// ============================================================================
// PRINT STYLE DEFAULTS + HELPERS
// ============================================================================

// The canonical print-style defaults for the service. These used to be a fallback for
// `poc/print-defaults.json`, read two directories up from here.
//
// That read never did anything. `poc/` is a proof of concept and is not part of the
// production image — the container's build context is `backend/api-service` — so the read
// always threw ENOENT and every PDF production has ever rendered used these values. In a dev
// checkout the file loaded, but its contents were byte-identical to this object (36 keys, 0
// differing), so it changed nothing there either.
//
// What it did do was maintain two sources of truth for the same styling, where editing the
// poc copy would silently change dev output and never reach production, and emit a warning
// on every production boot for a condition that was normal. Removed 2026-08-16.
const PRINT_STYLE_DEFAULTS = {
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
    customCSS: `#preview-content, [data-testid="preview-content"] {\n  max-width: 72ch;\n  margin-left: auto;\n  margin-right: auto;\n  font-variant-numeric: proportional-nums;\n}\n/* Un-style code blocks inside <pre> so they inherit the parent's style */\npre > code {\n  background: transparent;\n  padding: 0;\n  border-radius: 0;\n  font-size: 1em;\n}\n`,
    googleFontFamily: 'Source Sans 3, JetBrains Mono, Playfair Display',
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

const EXCLUDE_STYLE_KEYS = new Set([
    'customCSS', 'googleFontFamily', 'printHeaderHtml', 'printFooterHtml',
    'headerFontSize', 'headerFontColor', 'headerAlign', 'footerFontSize',
    'footerFontColor', 'footerAlign', 'enablePageNumbers', 'headerHeight',
    'footerHeight', 'pageMargin', 'pageSize',
]);

function printStylesToCss(styleMap = {}) {
    const s = styleMap;
    let css = '';

    if (ENABLE_REMOTE_FONTS && s.googleFontFamily) {
        const families = s.googleFontFamily
            .split(',')
            .map(f => `family=${encodeURIComponent(f.trim())}:wght@400;600;700`)
            .join('&');
        if (families) {
            css += `@import url('https://fonts.googleapis.com/css2?${families}&display=swap');\n\n`;
        }
    }

    const primaryFont = s.googleFontFamily?.split(',')[0]?.trim()?.replace(/['"]/g, '');
    if (primaryFont) {
        css += `body { font-family: "${primaryFont}", sans-serif; }\n\n`;
    }

    for (const key of Object.keys(s)) {
        if (!s[key]) continue;
        if (EXCLUDE_STYLE_KEYS.has(key)) continue;
        css += `${key} { ${s[key]} }\n`;
    }

    if (s.customCSS) {
        css += `\n/* --- Custom CSS --- */\n${s.customCSS}\n`;
    }

    return css;
}

const DEFAULT_PRINT_STYLES = { ...PRINT_STYLE_DEFAULTS };

// ============================================================================
// IMAGE EMBEDDING
// ============================================================================

function isPrivateIp(ip) {
    if (ip.includes(':')) {
        const normalized = ip.toLowerCase();
        if (normalized === '::1') return true;
        if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
        if (normalized.startsWith('fe80')) return true;
        return false;
    }

    const parts = ip.split('.');
    if (parts.length !== 4) return false;

    const first = parseInt(parts[0], 10);
    const second = parseInt(parts[1], 10);

    if (first === 0) return true;
    if (first === 127) return true;
    if (first === 10) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 169 && second === 254) return true;

    return false;
}

export function parseInternalImageSource(source) {
    try {
        const decodedSource = String(source).replace(/&amp;/gi, '&');
        const relative = decodedSource.startsWith('/');
        const parsed = new URL(decodedSource, 'http://panino-internal.invalid');
        if (!relative) {
            const allowedOrigins = new Set([
                process.env.INTERNAL_API_URL,
                process.env.PUBLIC_API_BASE_URL,
            ].filter(Boolean).map((value) => new URL(value).origin));
            if (!allowedOrigins.has(parsed.origin)) return null;
        }
        const match = /^\/(?:api\/)?images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
            .exec(parsed.pathname);
        if (!match) return null;
        const allowedParams = new Set(['space', 'token']);
        if ([...parsed.searchParams.keys()].some((key) => !allowedParams.has(key))) return null;
        const spaces = parsed.searchParams.getAll('space');
        if (spaces.length > 1) return null;
        return { imageId: match[1], spaceId: spaces[0] || null };
    } catch {
        return null;
    }
}

function getInternalImageAsDataUri(source, userId) {
    try {
        const target = parseInternalImageSource(source);
        if (!target) return null;
        let dbKey = `user:${userId}`;
        if (target.spaceId) {
            const access = resolveSpaceAccess({ spaceId: target.spaceId, actorUserId: userId });
            if (!access) return null;
            dbKey = `space:${access.spaceId}`;
        }
        const db = getDb(dbKey);
        const image = target.spaceId
            ? db.prepare('SELECT mime_type, path FROM images WHERE id = ?').get(target.imageId)
            : db.prepare('SELECT mime_type, path FROM images WHERE id = ? AND user_id = ?').get(target.imageId, userId);

        if (!image?.path) return null;
        const absolutePath = resolveStoredImagePath(dbKey, image.path);
        if (!absolutePath || !fs.existsSync(absolutePath)) return null;

        const buffer = fs.readFileSync(absolutePath);
        return `data:${image.mime_type};base64,${buffer.toString('base64')}`;
    } catch {
        return null;
    }
}

async function fetchExternalImageAsDataUri(urlStr) {
    try {
        const urlObj = new URL(urlStr);

        try {
            const { address } = await dns.lookup(urlObj.hostname);

            if (isPrivateIp(address)) {
                logWarn(`Blocked SSRF attempt to ${urlObj.hostname} (${address})`);
                throw new Error('SSRF_BLOCKED');
            }
        } catch (e) {
            if (e.message === 'SSRF_BLOCKED') throw e;
            logWarn(`DNS lookup failed for ${urlObj.hostname}: ${e.message}`);
            return null;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.EXTERNAL_IMAGE_TIMEOUT);

        let response;
        try {
            response = await fetch(urlStr, {
                signal: controller.signal,
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PaninoPDF/1.0)' },
            });
        } catch (err) {
            logWarn(`Fetch failed for ${urlStr}: ${err.message}`);
            return null;
        } finally {
            clearTimeout(timeoutId);
        }

        if (!response.ok) {
            logWarn(`Failed to fetch ${urlStr}: ${response.status} ${response.statusText}`);
            return null;
        }

        const contentType = response.headers.get('content-type') || 'image/png';
        if (!contentType.startsWith('image/')) {
            logWarn(`Invalid content type for ${urlStr}: ${contentType}`);
            return null;
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        if (buffer.length / 1024 > CONFIG.MAX_EXTERNAL_IMAGE_SIZE) {
            logWarn(`Image too large: ${urlStr} (${Math.round(buffer.length / 1024)}KB)`);
            return null;
        }

        return `data:${contentType};base64,${buffer.toString('base64')}`;
    } catch (error) {
        if (error.message === 'SSRF_BLOCKED') throw error;
        return null;
    }
}

async function embedImagesAsDataUri(html, userId) {
    const imgRegex = /<img([^>]*)\ssrc=["']([^"']+)["']([^>]*)>/gi;
    const images = [];
    let match;

    while ((match = imgRegex.exec(html)) !== null) {
        images.push({
            fullMatch: match[0],
            beforeSrc: match[1],
            src: match[2],
            afterSrc: match[3],
        });
    }

    if (images.length === 0) return html;

    log(`Processing ${images.length} images`);
    images.forEach((img, i) => {
        const displaySrc = img.src.startsWith('data:')
            ? `${img.src.substring(0, 40)}... (data URI)`
            : img.src.substring(0, 100);
        log(`  Image ${i + 1}: ${displaySrc}`);
    });

    const replacements = await Promise.all(images.map(async (img, idx) => {
        const { fullMatch, beforeSrc, src, afterSrc } = img;

        if (src.startsWith('data:')) {
            log(`  Image ${idx + 1}: Already embedded, skipping`);
            return { original: fullMatch, replacement: fullMatch };
        }

        const internalMatch = parseInternalImageSource(src);
        if (internalMatch) {
            const dataUri = getInternalImageAsDataUri(src, userId);
            if (dataUri) {
                const sizeKB = Math.round(dataUri.length / 1024);
                log(`  Image ${idx + 1}: Internal ${internalMatch.imageId} converted (${sizeKB}KB)`);
                return { original: fullMatch, replacement: `<img${beforeSrc} src="${dataUri}"${afterSrc}>` };
            }
            log(`  Image ${idx + 1}: Internal lookup ${internalMatch.imageId} failed - falling back to external/cleanup`);
        }

        if (src.startsWith('http://') || src.startsWith('https://')) {
            try {
                const dataUri = await fetchExternalImageAsDataUri(src);
                if (dataUri) {
                    const sizeKB = Math.round(dataUri.length / 1024);
                    log(`  Image ${idx + 1}: External fetched (${sizeKB}KB)`);
                    return { original: fullMatch, replacement: `<img${beforeSrc} src="${dataUri}"${afterSrc}>` };
                }
                log(`  Image ${idx + 1}: External ${src.substring(0, 50)} FAILED - keeping original`);
                return { original: fullMatch, replacement: fullMatch };
            } catch (err) {
                if (err.message === 'SSRF_BLOCKED') {
                    logWarn(`  Image ${idx + 1}: Blocked SSRF - removing image`);
                    return { original: fullMatch, replacement: '<!-- Blocked Image -->' };
                }
                log(`  Image ${idx + 1}: External error - keeping original. ${err.message}`);
                return { original: fullMatch, replacement: fullMatch };
            }
        }

        log(`  Image ${idx + 1}: Unknown source type, keeping: ${src.substring(0, 50)}`);
        return { original: fullMatch, replacement: fullMatch };
    }));

    let result = html;
    for (const { original, replacement } of replacements) {
        result = result.replace(original, replacement);
    }

    const remainingImages = result.match(/<img[^>]*src=["'](?!data:)[^"']+["'][^>]*>/gi) || [];
    if (remainingImages.length > 0) {
        logWarn(`${remainingImages.length} images still have external URLs after processing`);
    }

    return result;
}

// ============================================================================
// BROWSER MANAGEMENT
// ============================================================================

let browserInstance = null;

async function getBrowser() {
    if (!browserInstance || !browserInstance.connected) {
        log('Launching browser...');
        browserInstance = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        });
    }
    return browserInstance;
}

process.on('exit', async () => {
    if (browserInstance) {
        await browserInstance.close();
        browserInstance = null;
    }
});

// ============================================================================
// REQUEST QUEUE (sequential processing)
// ============================================================================

let isProcessing = false;
const queue = [];

async function processQueue() {
    if (isProcessing || queue.length === 0) return;

    isProcessing = true;
    const { req, res, resolve } = queue.shift();

    try {
        await generatePdf(req, res);
    } catch (error) {
        logError('Generation failed:', error.message);
        if (!res.headersSent) {
            res.status(500).send(`PDF generation failed: ${error.message}`);
        }
    } finally {
        isProcessing = false;
        resolve();
        if (queue.length > 0) setTimeout(processQueue, 50);
    }
}

pdfRoutes.post('/render-pdf', (req, res) => {
    return new Promise((resolve) => {
        queue.push({ req, res, resolve });
        processQueue();
    });
});

// ============================================================================
// PDF GENERATION
// ============================================================================

function buildHeaderFooterTemplate(html, align, fontSize, color, pageMargin, totalPagesText) {
    if (!html) return '';
    const replaced = html
        .replace(/%P/g, totalPagesText || '<span class="totalPages"></span>')
        .replace(/%p/g, '<span class="pageNumber"></span>');

    const safeAlign = ['left', 'right', 'center'].includes((align || '').toLowerCase())
        ? align.toLowerCase()
        : 'center';

    return `
        <div style="
            font-size: ${parseInt(fontSize, 10) || 10}px;
            color: ${color || '#666'};
            width: 100%;
            padding: 0 ${pageMargin || '2cm'};
            text-align: ${safeAlign};
        ">
            ${replaced}
        </div>
    `;
}

function buildHtmlDocument(content, css, printStyles) {
    const {
        pageSize = 'A4',
        pageMargin = '2cm',
        headerHeight = '1.5cm',
        footerHeight = '1.5cm',
        googleFontFamily = '',
    } = printStyles;

    let fontsLink = '';
    if (ENABLE_REMOTE_FONTS && googleFontFamily) {
        const families = googleFontFamily
            .split(',')
            .map(f => `family=${encodeURIComponent(f.trim())}:wght@400;600;700`)
            .join('&');
        fontsLink = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${families}&display=swap">`;
    }

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>PDF</title>
    ${fontsLink}
    <style>
        @page { 
            size: ${pageSize}; 
            margin: ${headerHeight} ${pageMargin} ${footerHeight} ${pageMargin};
        }
        html, body { 
            margin: 0; 
            padding: 0; 
        }
        body {
            font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #333;
        }
        .pagebreak {
            display: none;
        }
        .pagebreak + * {
            break-before: page !important;
            page-break-before: always !important;
        }
        ${css}
    </style>
</head>
<body>${content}</body>
</html>`;
}

async function countPdfPages(buffer) {
    const doc = await PDFDocument.load(buffer);
    return doc.getPageCount();
}

async function generatePdf(req, res) {
    const { htmlContent = '', cssStyles = '', printStyles: incomingPrintStyles = {} } = req.body || {};
    const userId = req.user?.user_id;

    if (!userId) {
        return res.status(401).send('Authentication required');
    }

    const mergedPrintStyles = { ...DEFAULT_PRINT_STYLES, ...incomingPrintStyles };

    const cleanHtml = purify.sanitize(htmlContent, {
        ADD_ATTR: ['style'],
    });

    if (htmlContent.includes('break-after') || htmlContent.includes('pagebreak')) {
        log('Input HTML contains pagebreak markers');
        log('Sample: ' + htmlContent.substring(0, 500));
    }
    if (cleanHtml.includes('break-after') || cleanHtml.includes('pagebreak')) {
        log('Sanitized HTML contains pagebreak markers');
    } else if (htmlContent.includes('break-after') || htmlContent.includes('pagebreak')) {
        logWarn('Pagebreak markers were STRIPPED by DOMPurify!');
    }

    const processedPrintStyles = { ...mergedPrintStyles };

    if (processedPrintStyles.printHeaderHtml) {
        processedPrintStyles.printHeaderHtml = purify.sanitize(processedPrintStyles.printHeaderHtml);
    }
    if (processedPrintStyles.printFooterHtml) {
        processedPrintStyles.printFooterHtml = purify.sanitize(processedPrintStyles.printFooterHtml);
    }

    const cleanCssInput = (cssStyles || '').replace(/<\/style>/gi, '');
    const cleanCss = cleanCssInput.trim() ? cleanCssInput : printStylesToCss(processedPrintStyles);

    if (!cleanHtml) {
        return res.status(400).send('Invalid htmlContent');
    }

    log('Embedding images in content...');
    const htmlWithImages = await embedImagesAsDataUri(cleanHtml, userId);

    const htmlWithPageBreaks = htmlWithImages
        .replace(/\\pagebreak/g, '<div class="pagebreak" style="break-after: page; page-break-after: always; clear: both;"></div>')
        .replace(/<!--\s*pagebreak\s*-->/g, '<div class="pagebreak" style="break-after: page; page-break-after: always; clear: both;"></div>')
        .replace(/---\s*pagebreak\s*---/gi, '<div class="pagebreak" style="break-after: page; page-break-after: always; clear: both;"></div>');

    if (processedPrintStyles.printHeaderHtml) {
        log('Embedding images in header...');
        processedPrintStyles.printHeaderHtml = await embedImagesAsDataUri(processedPrintStyles.printHeaderHtml, userId);
    }
    if (processedPrintStyles.printFooterHtml) {
        log('Embedding images in footer...');
        processedPrintStyles.printFooterHtml = await embedImagesAsDataUri(processedPrintStyles.printFooterHtml, userId);
    }

    const fullHtml = buildHtmlDocument(htmlWithPageBreaks, cleanCss, processedPrintStyles);

    const needsHeaderFooter = Boolean(processedPrintStyles.printHeaderHtml || processedPrintStyles.printFooterHtml);

    const basePdfOptions = {
        format: processedPrintStyles.pageSize || 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        margin: needsHeaderFooter ? {
            top: processedPrintStyles.headerHeight || '1.5cm',
            bottom: processedPrintStyles.footerHeight || '1.5cm',
            left: processedPrintStyles.pageMargin || '2cm',
            right: processedPrintStyles.pageMargin || '2cm',
        } : undefined,
    };

    let totalPagesText = null;
    let context = null;

    try {
        const browser = await getBrowser();
        context = await browser.createBrowserContext();
        const page = await context.newPage();

        await page.emulateMediaType('print');

        await page.setContent(fullHtml, {
            waitUntil: 'load',
            timeout: CONFIG.PAGE_LOAD_TIMEOUT,
        });

        if (needsHeaderFooter) {
            const draftBuffer = await page.pdf({
                ...basePdfOptions,
                displayHeaderFooter: true,
                headerTemplate: '<span></span>',
                footerTemplate: '<span></span>',
            });
            const totalPages = await countPdfPages(draftBuffer);
            totalPagesText = String(totalPages);
        }

        const headerTemplate = needsHeaderFooter ? buildHeaderFooterTemplate(
            processedPrintStyles.printHeaderHtml,
            processedPrintStyles.headerAlign,
            processedPrintStyles.headerFontSize,
            processedPrintStyles.headerFontColor,
            processedPrintStyles.pageMargin,
            totalPagesText,
        ) : '<span></span>';

        const footerTemplate = needsHeaderFooter ? buildHeaderFooterTemplate(
            processedPrintStyles.printFooterHtml,
            processedPrintStyles.footerAlign,
            processedPrintStyles.footerFontSize,
            processedPrintStyles.footerFontColor,
            processedPrintStyles.pageMargin,
            totalPagesText,
        ) : '<span></span>';

        const pdfBuffer = await page.pdf({
            ...basePdfOptions,
            displayHeaderFooter: needsHeaderFooter,
            headerTemplate,
            footerTemplate,
        });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename=document.pdf');
        res.send(Buffer.from(pdfBuffer));

    } finally {
        if (context) {
            try {
                await context.close();
            } catch { /* ignore */ }
        }
    }
}
