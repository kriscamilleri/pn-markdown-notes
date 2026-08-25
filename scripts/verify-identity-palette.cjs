#!/usr/bin/env node
/* global console, process */
/**
 * Verifies the COLLAB-03 identity palette against its WCAG contrast,
 * CIEDE2000 colour-distance, and blue-hue-reservation thresholds.
 *
 * Usage: node scripts/verify-identity-palette.cjs
 * Exit code: 0 when every palette entry passes, 1 otherwise.
 */
async function main() {
    const { verifyIdentityPalette } = await import(
        '../frontend/src/utils/identityPaletteVerify.js'
    );
    const { IDENTITY_PALETTE } = await import(
        '../frontend/src/utils/identityColor.js'
    );

    const { violations } = verifyIdentityPalette();

    console.info(`Identity palette size: ${IDENTITY_PALETTE.length}`);

    if (violations.length === 0) {
        console.info('PASS: every identity swatch satisfies contrast, colour-distance and hue constraints.');
        return 0;
    }

    console.error('FAIL: identity palette violations found:');
    for (const violation of violations) {
        console.error(`  - ${violation}`);
    }
    return 1;
}

main()
    .then((code) => {
        process.exitCode = code;
    })
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
