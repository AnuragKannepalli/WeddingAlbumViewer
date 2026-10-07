const fs = require('fs-extra');
const path = require('path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const { getResizedBuffer, getCroppedBuffer } = require('./images');
const { LAYOUT_ROWS, LAYOUT_REGION_DEFS } = require('./pages');

const MARGIN = 30;
const DEFAULT_SPLITS = {
  2: { primary: 0.5 },
  3: { primary: 2 / 3, secondary: 0.5 },
  4: { primary: 0.5, secondary: 0.5 }
};

// Splits one box into two along an axis at the given ratio (first region
// gets `ratio` of the space, second gets the rest), used as the building
// block for every layout made of "two regions with an adjustable divider
// between them" (the newer layout templates, generalized from the same
// idea layouts 2-4 already used).
function splitBox(x, y, w, h, direction, ratio, gap) {
  if (direction === 'cols') {
    const firstW = (w - gap) * ratio;
    const secondW = w - gap - firstW;
    return [{ x, y, w: firstW, h }, { x: x + firstW + gap, y, w: secondW, h }];
  }
  const firstH = (h - gap) * ratio;
  const secondH = h - gap - firstH;
  return [{ x, y, w, h: firstH }, { x, y: y + firstH + gap, w, h: secondH }];
}

// Subdivides one box into `count` equal cells stacked along one direction
// (used for a region that holds a stack of same-size photos, e.g. the
// "3 stacked" side of a "1 large + 3 stacked" layout).
function stackRects(box, count, direction, gap) {
  const rects = [];
  if (direction === 'rows') {
    const cellH = (box.h - gap * (count - 1)) / count;
    let curY = box.y;
    for (let i = 0; i < count; i++) {
      rects.push({ x: box.x, y: curY, w: box.w, h: cellH });
      curY += cellH + gap;
    }
  } else {
    const cellW = (box.w - gap * (count - 1)) / count;
    let curX = box.x;
    for (let i = 0; i < count; i++) {
      rects.push({ x: curX, y: box.y, w: cellW, h: box.h });
      curX += cellW + gap;
    }
  }
  return rects;
}

// Subdivides one box into an equal rows x cols grid (used for e.g. the
// "2x2 grid" side of a "1 large + small 2x2 grid" layout).
function gridRects(box, rows, cols, gap) {
  const cellW = (box.w - gap * (cols - 1)) / cols;
  const cellH = (box.h - gap * (rows - 1)) / rows;
  const rects = [];
  let curY = box.y;
  for (let r = 0; r < rows; r++) {
    let curX = box.x;
    for (let c = 0; c < cols; c++) {
      rects.push({ x: curX, y: curY, w: cellW, h: cellH });
      curX += cellW + gap;
    }
    curY += cellH + gap;
  }
  return rects;
}

function regionRects(box, region, gap) {
  if (region.count === 1) return [box];
  if (region.stack) return stackRects(box, region.count, region.stack, gap);
  if (region.grid) return gridRects(box, region.grid[0], region.grid[1], gap);
  return [box];
}

// Computes rects for one of the declarative LAYOUT_REGION_DEFS shapes (see
// server/pages.js): either a fixed number of equal columns with no divider,
// or a two-region split (adjustable ratio) where each region is a single
// photo, an equal stack, or a small equal grid.
function regionDefRects(def, x, y, w, h, gap, splits) {
  if (def.equalCols) {
    return stackRects({ x, y, w, h }, def.equalCols, 'cols', gap);
  }
  const axis = def.split === 'rows' ? 'secondary' : 'primary';
  const ratio = splits && splits[axis] !== undefined ? splits[axis] : 0.5;
  const boxes = splitBox(x, y, w, h, def.split, ratio, gap);
  return [...regionRects(boxes[0], def.regions[0], gap), ...regionRects(boxes[1], def.regions[1], gap)];
}

function layoutRects(layout, x, y, w, h, gap, splits) {
  const key = String(layout);
  const s = splits || DEFAULT_SPLITS[key];
  switch (key) {
    case '1':
      return [{ x, y, w, h }];
    case '2': {
      const leftW = (w - gap) * s.primary;
      const rightW = w - gap - leftW;
      return [
        { x, y, w: leftW, h },
        { x: x + leftW + gap, y, w: rightW, h }
      ];
    }
    case '3': {
      const bigW = (w - gap) * s.primary;
      const smallW = w - gap - bigW;
      const topH = (h - gap) * s.secondary;
      const bottomH = h - gap - topH;
      return [
        { x, y, w: bigW, h },
        { x: x + bigW + gap, y, w: smallW, h: topH },
        { x: x + bigW + gap, y: y + topH + gap, w: smallW, h: bottomH }
      ];
    }
    case '4': {
      const leftW = (w - gap) * s.primary;
      const rightW = w - gap - leftW;
      const topH = (h - gap) * s.secondary;
      const bottomH = h - gap - topH;
      return [
        { x, y, w: leftW, h: topH },
        { x: x + leftW + gap, y, w: rightW, h: topH },
        { x, y: y + topH + gap, w: leftW, h: bottomH },
        { x: x + leftW + gap, y: y + topH + gap, w: rightW, h: bottomH }
      ];
    }
    default: {
      const rows = LAYOUT_ROWS[key];
      if (rows) {
        const rowCount = rows.length;
        const rowH = (h - gap * (rowCount - 1)) / rowCount;
        const rects = [];
        let curY = y;
        for (const cols of rows) {
          const colW = (w - gap * (cols - 1)) / cols;
          let curX = x;
          for (let c = 0; c < cols; c++) {
            rects.push({ x: curX, y: curY, w: colW, h: rowH });
            curX += colW + gap;
          }
          curY += rowH + gap;
        }
        return rects;
      }
      const regionDef = LAYOUT_REGION_DEFS[key];
      if (regionDef) return regionDefRects(regionDef, x, y, w, h, gap, splits);
      return [{ x, y, w, h }];
    }
  }
}

async function drawImageInRect(doc, buffer, rect) {
  const meta = await sharp(buffer).metadata();
  const imgRatio = meta.width / meta.height;
  const rectRatio = rect.w / rect.h;
  let drawW, drawH;
  if (imgRatio > rectRatio) {
    drawW = rect.w;
    drawH = rect.w / imgRatio;
  } else {
    drawH = rect.h;
    drawW = rect.h * imgRatio;
  }
  const drawX = rect.x + (rect.w - drawW) / 2;
  const drawY = rect.y + (rect.h - drawH) / 2;

  doc.rect(rect.x, rect.y, rect.w, rect.h).fill('#eeeeee');
  doc.image(buffer, drawX, drawY, { width: drawW, height: drawH });
}

// For a photo with a manually chosen crop: the buffer is already the exact
// crop the user selected, so fill the rect completely (clipping any sliver
// of rounding error) rather than letterboxing it.
async function drawImageCover(doc, buffer, rect) {
  const meta = await sharp(buffer).metadata();
  const imgRatio = meta.width / meta.height;
  const rectRatio = rect.w / rect.h;
  let drawW, drawH;
  if (imgRatio > rectRatio) {
    drawH = rect.h;
    drawW = rect.h * imgRatio;
  } else {
    drawW = rect.w;
    drawH = rect.w / imgRatio;
  }
  const drawX = rect.x + (rect.w - drawW) / 2;
  const drawY = rect.y + (rect.h - drawH) / 2;

  doc.save();
  doc.rect(rect.x, rect.y, rect.w, rect.h).clip();
  doc.image(buffer, drawX, drawY, { width: drawW, height: drawH });
  doc.restore();
}

// Renders a preview PDF matching the album's designed layout. Not intended
// for print resolution -- images are downscaled for reasonable file size.
async function exportPdf(state, destPath) {
  const photosById = new Map(state.photos.map((p) => [p.id, p]));
  await fs.ensureDir(path.dirname(destPath));

  const pageSize = state.pageSize || { widthIn: 11, heightIn: 8.5 };
  const PAGE_W = pageSize.widthIn * 72;
  const PAGE_H = pageSize.heightIn * 72;

  const doc = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: 0 });
  const stream = fs.createWriteStream(destPath);
  doc.pipe(stream);

  const contentW = PAGE_W - MARGIN * 2;
  const contentH = PAGE_H - MARGIN * 2 - 24; // leave room for page label
  const gap = state.layoutGap === false ? 0 : 10;

  for (let pageIdx = 0; pageIdx < state.pages.length; pageIdx++) {
    const page = state.pages[pageIdx];
    if (pageIdx > 0) doc.addPage({ size: [PAGE_W, PAGE_H], margin: 0 });

    doc.rect(0, 0, PAGE_W, PAGE_H).fill('#ffffff');

    const rects = layoutRects(page.layout, MARGIN, MARGIN, contentW, contentH, gap, page.splits);
    for (let i = 0; i < page.slots.length; i++) {
      const slot = page.slots[i];
      const rect = rects[i];
      if (!rect) continue;
      if (slot && slot.photoId) {
        const photo = photosById.get(slot.photoId);
        if (photo) {
          const absPath = photo.absPath;
          try {
            if (slot.crop) {
              const buffer = await getCroppedBuffer(absPath, slot.crop, 1200);
              // A "free crop" rectangle isn't guaranteed to match the slot's
              // own shape, so it's letterboxed (contain) rather than
              // cover-filled -- an aspect-locked "fill slot" crop, by
              // construction, always matches exactly, so cover-fill there
              // is just an exact fill with no visible letterboxing.
              if (slot.crop.mode === 'free') {
                await drawImageInRect(doc, buffer, rect);
              } else {
                await drawImageCover(doc, buffer, rect);
              }
            } else {
              const buffer = await getResizedBuffer(absPath, 1200);
              await drawImageInRect(doc, buffer, rect);
            }
          } catch (err) {
            doc.rect(rect.x, rect.y, rect.w, rect.h).fill('#dddddd');
          }
        }
      } else {
        doc.rect(rect.x, rect.y, rect.w, rect.h).fill('#f5f5f5');
      }
    }

    // Floating accent photos sit on top, positioned as fractions of the
    // whole sheet (not just the margin box the grid above uses), so they can
    // overlap the main photo(s) or reach into the margin like a real
    // scrapbook accent.
    for (const float of page.floats || []) {
      const photo = photosById.get(float.photoId);
      if (!photo) continue;
      const rect = { x: float.x * PAGE_W, y: float.y * PAGE_H, w: float.w * PAGE_W, h: float.h * PAGE_H };
      try {
        if (float.crop) {
          const buffer = await getCroppedBuffer(photo.absPath, float.crop, 1200);
          if (float.crop.mode === 'free') {
            await drawImageInRect(doc, buffer, rect);
          } else {
            await drawImageCover(doc, buffer, rect);
          }
        } else {
          const buffer = await getResizedBuffer(photo.absPath, 1200);
          await drawImageCover(doc, buffer, rect);
        }
      } catch (err) {
        // Skip a floating photo that fails to load rather than aborting the whole export.
      }
    }

    doc
      .fillColor('#888888')
      .fontSize(10)
      .text(`Page ${pageIdx + 1}`, MARGIN, PAGE_H - MARGIN - 14, { width: contentW, align: 'center' });
  }

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(destPath));
    stream.on('error', reject);
  });
}

module.exports = { exportPdf };
