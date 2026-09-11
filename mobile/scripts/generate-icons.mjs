/**
 * Generates a placeholder app icon, adaptive-icon layers, favicon and splash
 * image for Bachat, and writes them into assets/images/.
 *
 * Bachat has no source artwork yet. Rather than leave the icon pipeline
 * broken until a designer delivers a logo, this draws a clean placeholder
 * mark programmatically: a rounded square badge in the app's brand colour
 * with the initial "B" centred on it. Swap in real artwork later by editing
 * BADGE_BG / BADGE_FG / INITIAL below, or -- once real source art exists --
 * replacing this generator with one that crops it (see IntelliVault's
 * scripts/generate-icons.mjs for that pattern: measured `.extract()` bounds
 * on a source image instead of a drawn SVG).
 *
 * Run with `npm run icons`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', 'assets');
const IMAGES = join(ASSETS, 'images');

/**
 * Placeholder brand palette. Matches the greens already chosen in app.json
 * (adaptiveIcon.backgroundColor, notification color) so the placeholder mark
 * looks intentional rather than mismatched. Swap for real brand colours
 * once real artwork exists.
 */
const BADGE_BG = '#0B7A4B';
const BADGE_FG = '#FFFFFF';
const INITIAL = 'B';

/** Adaptive-icon background -- matches app.json android.adaptiveIcon.backgroundColor. */
const ADAPTIVE_BG = '#0F2E27';

/** Splash / favicon ground -- matches app.json backgroundColor. */
const GROUND = '#ECEFE9';

/** Rounded-rect alpha mask, so the badge reads as a tile rather than a hard square. */
function roundedMask(size, radiusRatio) {
  const r = Math.round(size * radiusRatio);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
       <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/>
     </svg>`,
  );
}

/** The placeholder badge: solid background plus a centred initial. `rounded` applies the tile mask. */
async function badge(size, { rounded = false } = {}) {
  const fontSize = Math.round(size * 0.56);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect width="${size}" height="${size}" fill="${BADGE_BG}"/>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central"
          font-family="Arial, Helvetica, sans-serif" font-weight="700"
          font-size="${fontSize}" fill="${BADGE_FG}">${INITIAL}</text>
  </svg>`;

  let image = sharp(Buffer.from(svg)).png();

  if (rounded) {
    const base = await image.toBuffer();
    image = sharp(base).composite([
      { input: roundedMask(size, 0.22), blend: 'dest-in' },
    ]);
  }

  return image.png().toBuffer();
}

/**
 * The badge inset inside a transparent square, for the Android adaptive-icon
 * foreground. Android crops the outer ~33%, so the artwork has to sit inside
 * the safe zone (~60% of the canvas) or the launcher will clip its edges.
 */
async function adaptiveForeground(size) {
  const inner = Math.round(size * 0.6);
  const pad = Math.round((size - inner) / 2);

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: await badge(inner, { rounded: true }), top: pad, left: pad }])
    .png()
    .toBuffer();
}

/** Solid layer for the adaptive-icon background. */
function solid(size, fill) {
  return sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${fill}"/></svg>`,
  ))
    .png()
    .toBuffer();
}

await mkdir(IMAGES, { recursive: true });

const targets = [
  // Full-bleed badge: Android and iOS apply their own masking.
  ['icon.png', await badge(1024)],
  ['favicon.png', await badge(96, { rounded: true })],
  // Splash sits on white, so the badge is rounded to read as a tile.
  ['splash-icon.png', await badge(512, { rounded: true })],
  ['android-icon-foreground.png', await adaptiveForeground(432)],
  ['android-icon-background.png', await solid(432, ADAPTIVE_BG)],
];

for (const [name, buffer] of targets) {
  await writeFile(join(IMAGES, name), buffer);
  const { width, height } = await sharp(buffer).metadata();
  console.log(`${name}  ${width}x${height}  ${(buffer.length / 1024).toFixed(1)}KB`);
}

console.log('');
console.log('Placeholder icons generated from a drawn mark, not real artwork.');
console.log('Swap in a real logo later by editing BADGE_BG / BADGE_FG / INITIAL above,');
console.log('or replace this script with a crop-based one once source art exists.');
