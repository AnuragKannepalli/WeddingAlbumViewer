const sharp = require('sharp');
const { getResizedBuffer, getCroppedBuffer } = require('./images');
const { layoutRects, pageDimensions, applyFilter } = require('./pdfExporter');
const {
  DOT_SPACING, DOT_RADIUS, DOT_OPACITY,
  STRIPE_WIDTH, STRIPE_SPACING, STRIPE_OPACITY,
  GRID_SPACING, GRID_OPACITY, normalizeBackground
} = require('./pageBackground');

// Renders one page as a flat raster image (PNG or JPEG) -- a parallel
// rendering path to pdfExporter.js's drawPage, since PDFKit draws vector
// commands into a PDF document and has no way to hand back a plain bitmap.
// Reuses the exact same layout math (layoutRects/pageDimensions) and the
// exact same filter pipeline (applyFilter) as the PDF export, so a PNG/JPEG
// download looks the same as the PDF one -- only the shape clipping and
// mirror/rotation are reimplemented here, in terms sharp understands
// (an SVG mask composited with "dest-in", and .flop()/.rotate()).

const DPI = 150; // print-preview resolution -- plenty for sharing/printing a single page, not a giant file

function ptToPx(pt) {
  return Math.round((pt / 72) * DPI);
}

// The same six shapes clipShape() in pdfExporter.js draws with PDFKit path
// commands, expressed instead as SVG markup at the given pixel size --
// used to rasterize a mask, then cut the photo to that shape via a
// "dest-in" composite (keep the photo only where the mask is opaque).
function shapeSvgMarkup(shape, w, h) {
  switch (shape) {
    case 'circle': {
      const r = Math.min(w, h) / 2;
      return `<circle cx="${w / 2}" cy="${h / 2}" r="${r}"/>`;
    }
    case 'oval':
      return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}"/>`;
    case 'rounded': {
      const r = Math.min(w, h) * 0.12;
      return `<rect width="${w}" height="${h}" rx="${r}" ry="${r}"/>`;
    }
    case 'diamond':
      return `<polygon points="${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}"/>`;
    case 'heart': {
      const cx = w / 2;
      const topY = h * 0.3;
      return `<path d="M ${cx} ${h} C ${-0.1 * w} ${0.55 * h}, ${0.05 * w} 0, ${cx} ${topY} C ${0.95 * w} 0, ${1.1 * w} ${0.55 * h}, ${cx} ${h} Z"/>`;
    }
    default:
      return null;
  }
}

async function maskToShape(buffer, w, h, shape) {
  if (!shape || shape === 'none') return buffer;
  const markup = shapeSvgMarkup(shape, w, h);
  if (!markup) return buffer;
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><g fill="#fff">${markup}</g></svg>`;
  const mask = await sharp(Buffer.from(svg)).png().toBuffer();
  return sharp(buffer).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

// Produces exactly a (w x h)-pixel image of one photo, already
// cropped/filled, filtered, mirrored, rotated and shape-clipped -- ready to
// place directly onto the page canvas at the slot/float's position.
async function renderPhotoLayer(photo, w, h, { mirrored, rotation, filter, shape, crop }) {
  const rotated = rotation === 90 || rotation === 270;
  const preW = rotated ? h : w;
  const preH = rotated ? w : h;
  const fetchWidth = Math.max(preW, preH, 1) * 2;

  let buffer;
  if (crop) {
    const cropped = await getCroppedBuffer(photo.absPath, crop, fetchWidth);
    buffer = await sharp(cropped)
      .resize(preW, preH, crop.mode === 'free' ? { fit: 'contain', background: '#eeeeee' } : { fit: 'cover' })
      .toBuffer();
  } else {
    const resized = await getResizedBuffer(photo.absPath, fetchWidth);
    buffer = await sharp(resized).resize(preW, preH, { fit: 'cover' }).toBuffer();
  }

  buffer = await applyFilter(buffer, filter);

  let pipeline = sharp(buffer);
  if (mirrored) pipeline = pipeline.flop();
  if (rotation) pipeline = pipeline.rotate(rotation);
  buffer = await pipeline.toBuffer();

  return maskToShape(buffer, w, h, shape);
}

// Clips a composite layer to whatever portion of it actually falls within
// the page canvas -- a floating photo is allowed to hang off the sheet
// edge (a deliberate scrapbook look), which PDFKit's own page clipping
// handles for free but sharp's composite() does not: it rejects a layer
// positioned (or sized) outside the base image.
async function clampedComposite(composites, layerBuffer, rect, canvasW, canvasH) {
  const fullLeft = Math.round(rect.x);
  const fullTop = Math.round(rect.y);
  const fullW = Math.round(rect.w);
  const fullH = Math.round(rect.h);
  const visLeft = Math.max(0, fullLeft);
  const visTop = Math.max(0, fullTop);
  const visRight = Math.min(canvasW, fullLeft + fullW);
  const visBottom = Math.min(canvasH, fullTop + fullH);
  const visW = visRight - visLeft;
  const visH = visBottom - visTop;
  if (visW <= 0 || visH <= 0) return; // entirely off-canvas
  let finalBuffer = layerBuffer;
  if (visW !== fullW || visH !== fullH) {
    finalBuffer = await sharp(layerBuffer)
      .extract({ left: visLeft - fullLeft, top: visTop - fullTop, width: visW, height: visH })
      .toBuffer();
  }
  composites.push({ input: finalBuffer, left: visLeft, top: visTop });
}

async function renderPageToImageBuffer(state, pageIndex, format) {
  const page = state.pages[pageIndex];
  if (!page) throw new Error('Page not found');
  const photosById = new Map(state.photos.map((p) => [p.id, p]));
  const dims = pageDimensions(state);
  const PAGE_W = ptToPx(dims.PAGE_W);
  const PAGE_H = ptToPx(dims.PAGE_H);
  const MARGIN = ptToPx(dims.MARGIN);
  const contentW = PAGE_W - MARGIN * 2;
  const contentH = PAGE_H - MARGIN * 2 - ptToPx(24);
  const gap = ptToPx(dims.gap);

  const usesCustomRects = page.slots.some((s) => s.rect);
  const rects = usesCustomRects
    ? page.slots.map((slot) => (slot.rect
      ? { x: MARGIN + slot.rect.x * contentW, y: MARGIN + slot.rect.y * contentH, w: slot.rect.w * contentW, h: slot.rect.h * contentH }
      : { x: MARGIN, y: MARGIN, w: contentW, h: contentH }))
    : layoutRects(page.layout, MARGIN, MARGIN, contentW, contentH, gap, page.splits);

  const composites = [];
  for (let i = 0; i < page.slots.length; i++) {
    const slot = page.slots[i];
    const rect = rects[i];
    if (!rect) continue;
    const w = Math.max(1, Math.round(rect.w));
    const h = Math.max(1, Math.round(rect.h));
    if (slot && slot.photoId) {
      const photo = photosById.get(slot.photoId);
      if (photo) {
        try {
          const layer = await renderPhotoLayer(photo, w, h, {
            mirrored: slot.mirrored, rotation: slot.rotation, filter: slot.filter, shape: slot.shape, crop: slot.crop
          });
          await clampedComposite(composites, layer, rect, PAGE_W, PAGE_H);
          continue;
        } catch (err) {
          // Fall through to the placeholder fill below.
        }
      }
    }
    const fillColor = slot && slot.photoId ? '#dddddd' : '#f5f5f5';
    const placeholder = await sharp({ create: { width: w, height: h, channels: 3, background: fillColor } }).png().toBuffer();
    await clampedComposite(composites, placeholder, rect, PAGE_W, PAGE_H);
  }

  for (const float of page.floats || []) {
    const photo = photosById.get(float.photoId);
    if (!photo) continue;
    const rect = { x: float.x * PAGE_W, y: float.y * PAGE_H, w: float.w * PAGE_W, h: float.h * PAGE_H };
    const w = Math.max(1, Math.round(rect.w));
    const h = Math.max(1, Math.round(rect.h));
    try {
      const layer = await renderPhotoLayer(photo, w, h, {
        mirrored: float.mirrored, rotation: float.rotation, filter: float.filter, shape: float.shape, crop: float.crop
      });
      await clampedComposite(composites, layer, rect, PAGE_W, PAGE_H);
    } catch (err) {
      // Skip a floating photo that fails to load rather than aborting the whole export.
    }
  }

  if (page.isCover && (page.coverTitle || page.coverSubtitle || page.coverDate)) {
    const overlay = await renderCoverOverlay(page, PAGE_W, PAGE_H);
    composites.push({ input: overlay, left: 0, top: 0 });
  }

  const bgSvg = renderBackgroundSvg(page, PAGE_W, PAGE_H);
  const base = sharp(Buffer.from(bgSvg)).composite(composites);
  if (format === 'png') return base.png().toBuffer();
  return base.flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
}

function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// The PNG/JPEG counterpart of the cover-page overlay drawPage() draws with
// PDFKit text commands: a semi-transparent band across the bottom third,
// with the title/subtitle/date stacked and centered inside it. Expressed
// as SVG (rasterized by sharp) since sharp itself has no text-drawing API.
async function renderCoverOverlay(page, PAGE_W, PAGE_H) {
  const bandH = Math.round(PAGE_H * 0.26);
  const bandY = PAGE_H - bandH;
  const centerX = PAGE_W / 2;
  let textY = bandY + bandH * 0.32;
  const lines = [];
  if (page.coverTitle) {
    lines.push(`<text x="${centerX}" y="${textY}" font-size="${Math.round(PAGE_H * 0.045)}" font-family="sans-serif" font-weight="bold" fill="#fff" text-anchor="middle">${escapeXml(page.coverTitle)}</text>`);
    textY += PAGE_H * 0.055;
  }
  if (page.coverSubtitle) {
    lines.push(`<text x="${centerX}" y="${textY}" font-size="${Math.round(PAGE_H * 0.022)}" font-family="sans-serif" fill="#fff" text-anchor="middle">${escapeXml(page.coverSubtitle)}</text>`);
    textY += PAGE_H * 0.032;
  }
  if (page.coverDate) {
    lines.push(`<text x="${centerX}" y="${textY}" font-size="${Math.round(PAGE_H * 0.017)}" font-family="sans-serif" fill="#fff" text-anchor="middle">${escapeXml(page.coverDate)}</text>`);
  }
  const svg = `<svg width="${PAGE_W}" height="${PAGE_H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="${bandY}" width="${PAGE_W}" height="${bandH}" fill="#000000" fill-opacity="0.45"/>
    ${lines.join('\n')}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// The PNG/JPEG counterpart of drawBackground() in pdfExporter.js -- same
// patterns (dots/stripes/grid/gradient), same spacing/opacity constants
// (shared via pageBackground.js), just expressed as SVG <pattern>s so
// sharp can rasterize them instead of PDFKit drawing them as vectors. This
// becomes the base image everything else gets composited onto, replacing
// the plain white canvas a page without a background still gets.
function renderBackgroundSvg(page, PAGE_W, PAGE_H) {
  const bg = normalizeBackground(page.background);
  let content = `<rect width="100%" height="100%" fill="#ffffff"/>`;
  switch (bg.type) {
    case 'solid':
      content = `<rect width="100%" height="100%" fill="${bg.color}"/>`;
      break;
    case 'gradient':
      content = `
        <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${bg.color}"/>
          <stop offset="100%" stop-color="#ffffff"/>
        </linearGradient></defs>
        <rect width="100%" height="100%" fill="url(#g)"/>`;
      break;
    case 'dots':
      content = `
        <defs><pattern id="p" width="${DOT_SPACING}" height="${DOT_SPACING}" patternUnits="userSpaceOnUse">
          <circle cx="${DOT_SPACING / 2}" cy="${DOT_SPACING / 2}" r="${DOT_RADIUS}" fill="${bg.color}" fill-opacity="${DOT_OPACITY}"/>
        </pattern></defs>
        <rect width="100%" height="100%" fill="#ffffff"/>
        <rect width="100%" height="100%" fill="url(#p)"/>`;
      break;
    case 'stripes':
      content = `
        <defs><pattern id="p" width="${STRIPE_SPACING}" height="8" patternUnits="userSpaceOnUse">
          <rect width="${STRIPE_WIDTH}" height="8" fill="${bg.color}" fill-opacity="${STRIPE_OPACITY}"/>
        </pattern></defs>
        <rect width="100%" height="100%" fill="#ffffff"/>
        <rect width="100%" height="100%" fill="url(#p)"/>`;
      break;
    case 'grid':
      content = `
        <defs><pattern id="p" width="${GRID_SPACING}" height="${GRID_SPACING}" patternUnits="userSpaceOnUse">
          <path d="M ${GRID_SPACING} 0 L 0 0 0 ${GRID_SPACING}" fill="none" stroke="${bg.color}" stroke-opacity="${GRID_OPACITY}" stroke-width="1"/>
        </pattern></defs>
        <rect width="100%" height="100%" fill="#ffffff"/>
        <rect width="100%" height="100%" fill="url(#p)"/>`;
      break;
    default:
      break; // 'none' -- plain white, already the default content
  }
  return `<svg width="${PAGE_W}" height="${PAGE_H}" xmlns="http://www.w3.org/2000/svg">${content}</svg>`;
}

module.exports = { renderPageToImageBuffer };
