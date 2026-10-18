const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');

function cachePathFor(absPath, kind) {
  const hash = crypto.createHash('sha1').update(absPath).digest('hex');
  return path.join(CACHE_DIR, `${hash}_${kind}.jpg`);
}

const SIZES = {
  thumb: 400,
  preview: 1600
};

// Returns an absolute path to a cached, resized JPEG for the given source
// image. Generates it on first request, then reuses the cached file.
async function getCachedImage(absPath, kind) {
  const width = SIZES[kind];
  const cached = cachePathFor(absPath, kind);
  if (await fs.pathExists(cached)) {
    return cached;
  }
  fs.ensureDirSync(CACHE_DIR);
  await sharp(absPath, { failOn: 'none' })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality: kind === 'thumb' ? 72 : 82 })
    .toFile(cached);
  return cached;
}

// Resized JPEG buffer for embedding in the PDF export (not written to disk).
async function getResizedBuffer(absPath, maxWidth) {
  return sharp(absPath, { failOn: 'none' })
    .rotate()
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function getImageMeta(absPath) {
  const meta = await sharp(absPath, { failOn: 'none' }).metadata();
  return { width: meta.width, height: meta.height };
}

// Dimensions of the image as it actually displays (after EXIF rotation is
// applied), since metadata() reports the raw, pre-rotation pixel grid.
async function getDisplayDimensions(absPath) {
  const meta = await sharp(absPath, { failOn: 'none' }).metadata();
  const swapped = meta.orientation >= 5 && meta.orientation <= 8;
  return swapped ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
}

// Extracts the given crop rectangle (fractions 0-1, relative to the
// displayed/rotated image) and returns a resized JPEG buffer for it.
async function getCroppedBuffer(absPath, crop, maxWidth) {
  const { width: fullW, height: fullH } = await getDisplayDimensions(absPath);
  const left = Math.min(fullW - 1, Math.max(0, Math.round(crop.x * fullW)));
  const top = Math.min(fullH - 1, Math.max(0, Math.round(crop.y * fullH)));
  const width = Math.max(1, Math.min(fullW - left, Math.round(crop.w * fullW)));
  const height = Math.max(1, Math.min(fullH - top, Math.round(crop.h * fullH)));
  return sharp(absPath, { failOn: 'none' })
    .rotate()
    .extract({ left, top, width, height })
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

// A "difference hash": shrink to 9x8 grayscale, then for each row compare
// each pixel to the one right of it -- 8 comparisons per row x 8 rows = 64
// bits, returned as a hex string. Two photos that look visually similar
// (crops, re-exports, near-identical burst shots) end up with hashes that
// differ in only a few bits, even though their files are completely
// different on disk -- unlike the filename/timestamp burst-grouping
// heuristic this app already does elsewhere, this looks at actual pixel
// content.
async function getPerceptualHash(absPath) {
  const { data } = await sharp(absPath, { failOn: 'none' })
    .rotate()
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = data[row * 9 + col];
      const right = data[row * 9 + col + 1];
      bits += left < right ? '1' : '0';
    }
  }
  // Store as hex (16 chars for 64 bits) -- compact and easy to diff.
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

// Hamming distance between two same-length hex hashes from the function
// above -- the number of differing bits, so 0 means visually identical (as
// far as this coarse a fingerprint can tell) and higher means less alike.
function hashDistance(hexA, hexB) {
  let distance = 0;
  for (let i = 0; i < hexA.length; i++) {
    let x = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

module.exports = {
  getCachedImage, getResizedBuffer, getImageMeta, getCroppedBuffer, getDisplayDimensions,
  getPerceptualHash, hashDistance
};
