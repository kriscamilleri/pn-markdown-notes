import { IDENTITY_PALETTE } from './identityColor.js';

/**
 * Shared verification for the identity palette (COLLAB-03 §3). Both the
 * `scripts/verify-identity-palette.cjs` CLI and the Vitest suite consume this
 * so the thresholds stay testable rather than editorial.
 *
 * An identity swatch must:
 *   - clear >= 3:1 against both surfaces (graphical object threshold)
 *   - clear >= 4.5:1 against white initials (text threshold)
 *   - be at least Delta E 12 from --pn-primary and --pn-accent
 *   - have an HSL hue outside the inclusive 200-260 degree blue range
 */

// These mirror the dark-mode CSS variables in frontend/src/assets/main.css.
export const LIGHT_SURFACE = '#ffffff';
export const DARK_SURFACE = '#151515';
export const PN_PRIMARY = '#77a0a5';
export const PN_ACCENT = '#9377a5';
export const INITIALS_COLOR = '#ffffff';

const SWATCH_MIN_CONTRAST = 3.0;
const INITIALS_MIN_CONTRAST = 4.5;
const MIN_DELTA_E = 12.0;
const BLUE_HUE_MIN = 200;
const BLUE_HUE_MAX = 260;

function hexToRgb(hex) {
    const value = hex.replace('#', '');
    if (value.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(value)) {
        throw new Error(`Invalid hex colour: ${hex}`);
    }
    return {
        r: parseInt(value.slice(0, 2), 16) / 255,
        g: parseInt(value.slice(2, 4), 16) / 255,
        b: parseInt(value.slice(4, 6), 16) / 255,
    };
}

function channel(value) {
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance, 0..1. */
export function relativeLuminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio between two hex colours. */
export function contrastRatio(hexA, hexB) {
    const la = relativeLuminance(hexA);
    const lb = relativeLuminance(hexB);
    const lighter = Math.max(la, lb);
    const darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
}

function rgbToHsl(hex) {
    const { r, g, b } = hexToRgb(hex);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    if (delta !== 0) {
        if (max === r) h = ((g - b) / delta) % 6;
        else if (max === g) h = (b - r) / delta + 2;
        else h = (r - g) / delta + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h, s: 0, l: 0 };
}

export function hueInBlueRange(hex) {
    const { h } = rgbToHsl(hex);
    return h >= BLUE_HUE_MIN && h <= BLUE_HUE_MAX;
}

// ── CIEDE2000 ───────────────────────────────────────────────────────────────
function xyzToLab({ x, y, z }) {
    const refX = 0.95047;
    const refY = 1.0;
    const refZ = 1.08883;

    const fx = f(x / refX);
    const fy = f(y / refY);
    const fz = f(z / refZ);

    return {
        L: 116 * fy - 16,
        a: 500 * (fx - fy),
        b: 200 * (fy - fz),
    };
}

function f(t) {
    const delta = 6 / 29;
    return t > Math.pow(delta, 3)
        ? Math.cbrt(t)
        : t / (3 * delta * delta) + 4 / 29;
}

function rgbToLab(hex) {
    const rgb = hexToRgb(hex);
    const R = rgb.r;
    const G = rgb.g;
    const B = rgb.b;

    const x = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
    const y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
    const z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;

    return xyzToLab({ x, y, z });
}

function degreesToRadians(deg) {
    return (deg * Math.PI) / 180;
}

/**
 * CIEDE2000 colour difference. Returns a positive distance in Delta E units.
 */
export function deltaE2000(hexA, hexB) {
    const lab1 = rgbToLab(hexA);
    const lab2 = rgbToLab(hexB);

    const L1 = lab1.L;
    const a1 = lab1.a;
    const b1 = lab1.b;
    const L2 = lab2.L;
    const a2 = lab2.a;
    const b2 = lab2.b;

    const C1 = Math.sqrt(a1 * a1 + b1 * b1);
    const C2 = Math.sqrt(a2 * a2 + b2 * b2);
    const Cbar = (C1 + C2) / 2;

    const G = 0.5 * (1 - Math.sqrt(Math.pow(Cbar, 7) / (Math.pow(Cbar, 7) + Math.pow(25, 7))));
    const a1p = (1 + G) * a1;
    const a2p = (1 + G) * a2;

    const C1p = Math.sqrt(a1p * a1p + b1 * b1);
    const C2p = Math.sqrt(a2p * a2p + b2 * b2);

    const h1p = hueAngle(b1, a1p);
    const h2p = hueAngle(b2, a2p);

    const dLp = L2 - L1;
    const dCp = C2p - C1p;
    const dhp = hueDelta(C1p, C2p, h1p, h2p);
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(degreesToRadians(dhp) / 2);

    const Lbarp = (L1 + L2) / 2;
    const Cbarp = (C1p + C2p) / 2;

    const hbarp = hueMean(C1p, C2p, h1p, h2p);

    const T = 1
        - 0.17 * Math.cos(degreesToRadians(hbarp - 30))
        + 0.24 * Math.cos(degreesToRadians(2 * hbarp))
        + 0.32 * Math.cos(degreesToRadians(3 * hbarp + 6))
        - 0.20 * Math.cos(degreesToRadians(4 * hbarp - 63));

    const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
    const Rc = 2 * Math.sqrt(Math.pow(Cbarp, 7) / (Math.pow(Cbarp, 7) + Math.pow(25, 7)));

    const Sl = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
    const Sc = 1 + 0.045 * Cbarp;
    const Sh = 1 + 0.015 * Cbarp * T;

    const Rt = -Math.sin(degreesToRadians(2 * dTheta)) * Rc;

    const dL = dLp / Sl;
    const dC = dCp / Sc;
    const dH = dHp / Sh;

    return Math.sqrt(dL * dL + dC * dC + dH * dH + Rt * dC * dH);
}

function hueAngle(b, a) {
    if (a === 0 && b === 0) return 0;
    let h = (Math.atan2(b, a) * 180) / Math.PI;
    if (h < 0) h += 360;
    return h;
}

function hueDelta(C1, C2, h1, h2) {
    if (C1 === 0 || C2 === 0) return 0;
    let diff = h2 - h1;
    if (Math.abs(diff) <= 180) return diff;
    if (diff > 180) return diff - 360;
    return diff + 360;
}

function hueMean(C1, C2, h1, h2) {
    if (C1 === 0 || C2 === 0) return h1 + h2;
    const sum = h1 + h2;
    if (Math.abs(h1 - h2) <= 180) return sum / 2;
    if (sum < 360) return (sum + 360) / 2;
    return (sum - 360) / 2;
}

/**
 * Verifies every palette entry against the COLLAB-03 thresholds.
 *
 * @returns {{ violations: string[] }}
 */
export function verifyIdentityPalette() {
    const violations = [];

    for (const colour of IDENTITY_PALETTE) {
        const vsLight = contrastRatio(colour, LIGHT_SURFACE);
        const vsDark = contrastRatio(colour, DARK_SURFACE);
        const vsInitials = contrastRatio(colour, INITIALS_COLOR);

        if (vsLight < SWATCH_MIN_CONTRAST) {
            violations.push(`${colour} fails swatch contrast vs light surface (${vsLight.toFixed(2)})`);
        }
        if (vsDark < SWATCH_MIN_CONTRAST) {
            violations.push(`${colour} fails swatch contrast vs dark surface (${vsDark.toFixed(2)})`);
        }
        if (vsInitials < INITIALS_MIN_CONTRAST) {
            violations.push(`${colour} fails white-initials contrast (${vsInitials.toFixed(2)})`);
        }

        const dEprimary = deltaE2000(colour, PN_PRIMARY);
        const dEaccent = deltaE2000(colour, PN_ACCENT);
        if (dEprimary < MIN_DELTA_E) {
            violations.push(`${colour} is too close to --pn-primary (Delta E ${dEprimary.toFixed(2)})`);
        }
        if (dEaccent < MIN_DELTA_E) {
            violations.push(`${colour} is too close to --pn-accent (Delta E ${dEaccent.toFixed(2)})`);
        }

        if (hueInBlueRange(colour)) {
            violations.push(`${colour} falls in the reserved blue hue range (200-260°)`);
        }
    }

    return { violations };
}
