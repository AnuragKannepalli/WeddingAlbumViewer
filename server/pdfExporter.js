const fs = require('fs-extra');
const path = require('path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const { getResizedBuffer, getCroppedBuffer } = require('./images');
const { LAYOUT_ROWS, LAYOUT_REGION_DEFS } = require('./pages');
const {
  DOT_SPACING, DOT_RADIUS, DOT_OPACITY,
  STRIPE_WIDTH, STRIPE_SPACING, STRIPE_OPACITY,
  GRID_SPACING, GRID_OPACITY, normalizeBackground
} = require('./pageBackground');

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

// Builds a clip path on `doc` matching one of the selectable photo shapes,
// sized to `rect` -- the PDF-side counterpart of the CSS clip-path/
// border-radius rules in style.css. Caller must doc.save() before and
// doc.restore() after (it only sets up the path and clips, doesn't bracket).
function clipShape(doc, shape, rect) {
  if (!shape || shape === 'none') return false;
  const { x, y, w, h } = rect;
  switch (shape) {
    case 'circle': {
      const r = Math.min(w, h) / 2;
      doc.circle(x + w / 2, y + h / 2, r);
      break;
    }
    case 'oval': {
      doc.ellipse(x + w / 2, y + h / 2, w / 2, h / 2);
      break;
    }
    case 'rounded': {
      const r = Math.min(w, h) * 0.12;
      doc.roundedRect(x, y, w, h, r);
      break;
    }
    case 'diamond': {
      doc
        .moveTo(x + w / 2, y)
        .lineTo(x + w, y + h / 2)
        .lineTo(x + w / 2, y + h)
        .lineTo(x, y + h / 2)
        .closePath();
      break;
    }
    case 'heart': {
      const cx = x + w / 2;
      const topY = y + h * 0.3;
      doc
        .moveTo(cx, y + h)
        .bezierCurveTo(x - w * 0.1, y + h * 0.55, x + w * 0.05, y, cx, topY)
        .bezierCurveTo(x + w * 0.95, y, x + w * 1.1, y + h * 0.55, cx, y + h)
        .closePath();
      break;
    }
    default:
      return false;
  }
  doc.clip();
  return true;
}

// Draws `buffer` so its final (post-rotation) visual footprint is exactly
// (drawX, drawY, drawW, drawH), optionally also mirrored left-right.
// Rotation is a coordinate-system rotation around that footprint's own
// center (doc.rotate), not a re-encode of the image data, so for a 90/270
// rotation the image must then be drawn at its PRE-rotation dimensions
// (width/height swapped back) for the rotated result to land on the
// intended footprint -- same idea as rotating a photo print on a table:
// the paper's own width/height don't change, only its orientation.
function drawImageTransformed(doc, buffer, drawX, drawY, drawW, drawH, mirrored, rotation) {
  const rotated = rotation === 90 || rotation === 270;
  doc.save();
  const cx = drawX + drawW / 2;
  const cy = drawY + drawH / 2;
  if (rotation) doc.rotate(rotation, { origin: [cx, cy] });
  const preW = rotated ? drawH : drawW;
  const preH = rotated ? drawW : drawH;
  const preX = cx - preW / 2;
  const preY = cy - preH / 2;
  if (mirrored) {
    doc.save();
    doc.translate(preX + preW, preY).scale(-1, 1);
    doc.image(buffer, 0, 0, { width: preW, height: preH });
    doc.restore();
  } else {
    doc.image(buffer, preX, preY, { width: preW, height: preH });
  }
  doc.restore();
}

// Re-encodes `buffer` with one of the selectable color filters baked in --
// the PDF-side counterpart of the CSS `filter:` the preview uses -- so an
// exported/printed page matches what was previewed in the editor.
async function applyFilter(buffer, filter) {
  if (!filter) return buffer;
  let img = sharp(buffer);
  switch (filter) {
    case 'bw':
      img = img.grayscale();
      break;
    case 'warm':
      img = img.tint({ r: 255, g: 235, b: 205 });
      break;
    case 'cool':
      img = img.tint({ r: 210, g: 230, b: 255 });
      break;
    case 'muted':
      img = img.modulate({ saturation: 0.55 });
      break;
    case 'vivid':
      img = img.modulate({ saturation: 1.5 }).linear(1.15, -18);
      break;
    case 'sepia':
      img = img.grayscale().tint({ r: 112, g: 66, b: 20 });
      break;
    case 'vintage':
      img = img.modulate({ saturation: 0.55, brightness: 1.05 }).tint({ r: 235, g: 215, b: 180 }).linear(0.92, 12);
      break;
    default:
      return buffer;
  }
  return img.jpeg({ quality: 85 }).toBuffer();
}

async function drawImageInRect(doc, buffer, rect, mirrored, rotation, filter) {
  buffer = await applyFilter(buffer, filter);
  const meta = await sharp(buffer).metadata();
  const rotated = rotation === 90 || rotation === 270;
  const imgRatio = rotated ? meta.height / meta.width : meta.width / meta.height;
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
  drawImageTransformed(doc, buffer, drawX, drawY, drawW, drawH, mirrored, rotation);
}

// For a photo with a manually chosen crop: the buffer is already the exact
// crop the user selected, so fill the rect completely (clipping any sliver
// of rounding error) rather than letterboxing it.
async function drawImageCover(doc, buffer, rect, mirrored, rotation, filter) {
  buffer = await applyFilter(buffer, filter);
  const meta = await sharp(buffer).metadata();
  const rotated = rotation === 90 || rotation === 270;
  const imgRatio = rotated ? meta.height / meta.width : meta.width / meta.height;
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
  drawImageTransformed(doc, buffer, drawX, drawY, drawW, drawH, mirrored, rotation);
  doc.restore();
}

// Fills the whole page with white first, then (for anything other than
// "none") layers the chosen pattern on top -- always starting from white
// means every pattern's own math (dot/stripe/grid spacing, gradient stops)
// only has to describe the pattern itself, not account for what color was
// there before.
function drawBackground(doc, page, PAGE_W, PAGE_H) {
  doc.rect(0, 0, PAGE_W, PAGE_H).fill('#ffffff');
  const bg = normalizeBackground(page.background);
  switch (bg.type) {
    case 'solid':
      doc.rect(0, 0, PAGE_W, PAGE_H).fill(bg.color);
      break;
    case 'gradient': {
      const grad = doc.linearGradient(0, 0, 0, PAGE_H);
      grad.stop(0, bg.color).stop(1, '#ffffff');
      doc.rect(0, 0, PAGE_W, PAGE_H).fill(grad);
      break;
    }
    case 'dots': {
      doc.save();
      for (let y = DOT_SPACING / 2; y < PAGE_H; y += DOT_SPACING) {
        for (let x = DOT_SPACING / 2; x < PAGE_W; x += DOT_SPACING) {
          doc.circle(x, y, DOT_RADIUS).fillOpacity(DOT_OPACITY).fill(bg.color);
        }
      }
      doc.restore();
      break;
    }
    case 'stripes': {
      doc.save();
      doc.fillOpacity(STRIPE_OPACITY);
      for (let x = 0; x < PAGE_W; x += STRIPE_SPACING) {
        doc.rect(x, 0, STRIPE_WIDTH, PAGE_H).fill(bg.color);
      }
      doc.restore();
      break;
    }
    case 'grid': {
      doc.save();
      doc.strokeOpacity(GRID_OPACITY).strokeColor(bg.color).lineWidth(1);
      for (let x = 0; x <= PAGE_W; x += GRID_SPACING) {
        doc.moveTo(x, 0).lineTo(x, PAGE_H).stroke();
      }
      for (let y = 0; y <= PAGE_H; y += GRID_SPACING) {
        doc.moveTo(0, y).lineTo(PAGE_W, y).stroke();
      }
      doc.restore();
      break;
    }
    default:
      break; // 'none' -- the white fill above is already enough
  }
}

// Draws one page's full content (background, every slot, every floating
// photo, and the page-number footer) onto `doc` at its current position in
// the document -- shared by exportPdf (looping over every page) and
// exportSinglePagePdf (just one), so the two can never drift apart in how
// a page actually renders.
async function drawPage(doc, photosById, page, pageIdx, { PAGE_W, PAGE_H, MARGIN, contentW, contentH, gap }) {
  drawBackground(doc, page, PAGE_W, PAGE_H);

  // A page with any slot resized via its free-form drag handle has
  // "graduated" out of the named-template grid -- every slot's own rect
  // (fractions of the content box, seeded from the template at the moment
  // of the first resize -- see slots/rects route) wins over layoutRects(),
  // including any gaps left where a shrunk slot no longer reaches a
  // neighbor.
  const usesCustomRects = page.slots.some((s) => s.rect);
  const rects = usesCustomRects
    ? page.slots.map((slot) => {
        const r = slot.rect;
        return r
          ? { x: MARGIN + r.x * contentW, y: MARGIN + r.y * contentH, w: r.w * contentW, h: r.h * contentH }
          : { x: MARGIN, y: MARGIN, w: contentW, h: contentH };
      })
    : layoutRects(page.layout, MARGIN, MARGIN, contentW, contentH, gap, page.splits);
  for (let i = 0; i < page.slots.length; i++) {
    const slot = page.slots[i];
    const rect = rects[i];
    if (!rect) continue;
    if (slot && slot.photoId) {
      const photo = photosById.get(slot.photoId);
      if (photo) {
        const absPath = photo.absPath;
        doc.save();
        clipShape(doc, slot.shape, rect);
        try {
          if (slot.crop) {
            const buffer = await getCroppedBuffer(absPath, slot.crop, 1200);
            // A "free crop" rectangle isn't guaranteed to match the slot's
            // own shape, so it's letterboxed (contain) rather than
            // cover-filled -- an aspect-locked "fill slot" crop, by
            // construction, always matches exactly, so cover-fill there
            // is just an exact fill with no visible letterboxing.
            if (slot.crop.mode === 'free') {
              await drawImageInRect(doc, buffer, rect, slot.mirrored, slot.rotation, slot.filter);
            } else {
              await drawImageCover(doc, buffer, rect, slot.mirrored, slot.rotation, slot.filter);
            }
          } else {
            const buffer = await getResizedBuffer(absPath, 1200);
            await drawImageInRect(doc, buffer, rect, slot.mirrored, slot.rotation, slot.filter);
          }
        } catch (err) {
          doc.rect(rect.x, rect.y, rect.w, rect.h).fill('#dddddd');
        }
        doc.restore();
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
    doc.save();
    clipShape(doc, float.shape, rect);
    try {
      if (float.crop) {
        const buffer = await getCroppedBuffer(photo.absPath, float.crop, 1200);
        if (float.crop.mode === 'free') {
          await drawImageInRect(doc, buffer, rect, float.mirrored, float.rotation, float.filter);
        } else {
          await drawImageCover(doc, buffer, rect, float.mirrored, float.rotation, float.filter);
        }
      } else {
        const buffer = await getResizedBuffer(photo.absPath, 1200);
        await drawImageCover(doc, buffer, rect, float.mirrored, float.rotation, float.filter);
      }
    } catch (err) {
      // Skip a floating photo that fails to load rather than aborting the whole export.
    }
    doc.restore();
  }

  // A cover page's title/subtitle/date overlay goes on top of everything
  // else -- a semi-transparent band across the bottom third so it reads
  // over any photo underneath, with the three lines stacked and centered
  // inside it.
  if (page.isCover && (page.coverTitle || page.coverSubtitle || page.coverDate)) {
    const bandH = PAGE_H * 0.26;
    const bandY = PAGE_H - bandH;
    doc.save();
    doc.rect(0, bandY, PAGE_W, bandH).fillOpacity(0.45).fill('#000000');
    doc.restore();

    let textY = bandY + bandH * 0.22;
    const textWidth = PAGE_W - MARGIN * 2;
    if (page.coverTitle) {
      doc.fillColor('#ffffff').fontSize(32).text(page.coverTitle, MARGIN, textY, { width: textWidth, align: 'center' });
      textY += 40;
    }
    if (page.coverSubtitle) {
      doc.fillColor('#ffffff').fontSize(16).text(page.coverSubtitle, MARGIN, textY, { width: textWidth, align: 'center' });
      textY += 24;
    }
    if (page.coverDate) {
      doc.fillColor('#ffffff').fontSize(12).text(page.coverDate, MARGIN, textY, { width: textWidth, align: 'center' });
    }
  }

  // The "Page N" footer would clash with a cover page's own overlay text,
  // and doesn't make sense on a title page anyway.
  if (!page.isCover) {
    doc
      .fillColor('#888888')
      .fontSize(10)
      .text(`Page ${pageIdx + 1}`, MARGIN, PAGE_H - MARGIN - 14, { width: contentW, align: 'center' });
  }
}

function pageDimensions(state) {
  const pageSize = state.pageSize || { widthIn: 11, heightIn: 8.5 };
  const PAGE_W = pageSize.widthIn * 72;
  const PAGE_H = pageSize.heightIn * 72;
  const contentW = PAGE_W - MARGIN * 2;
  const contentH = PAGE_H - MARGIN * 2 - 24; // leave room for page label
  const gap = state.layoutGap === false ? 0 : 10;
  return { PAGE_W, PAGE_H, MARGIN, contentW, contentH, gap };
}

// Renders a preview PDF matching the album's designed layout. Not intended
// for print resolution -- images are downscaled for reasonable file size.
async function exportPdf(state, destPath) {
  const photosById = new Map(state.photos.map((p) => [p.id, p]));
  await fs.ensureDir(path.dirname(destPath));

  const dims = pageDimensions(state);
  const doc = new PDFDocument({ size: [dims.PAGE_W, dims.PAGE_H], margin: 0 });
  const stream = fs.createWriteStream(destPath);
  doc.pipe(stream);

  for (let pageIdx = 0; pageIdx < state.pages.length; pageIdx++) {
    if (pageIdx > 0) doc.addPage({ size: [dims.PAGE_W, dims.PAGE_H], margin: 0 });
    await drawPage(doc, photosById, state.pages[pageIdx], pageIdx, dims);
  }

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(destPath));
    stream.on('error', reject);
  });
}

// Same per-page drawing as exportPdf, but for exactly one page, collected
// in memory rather than written to disk -- for the Editor's "download this
// page" button, which has no reason to leave a file behind the way the
// whole-album export does.
async function renderSinglePagePdfBuffer(state, pageIndex) {
  const page = state.pages[pageIndex];
  if (!page) throw new Error('Page not found');
  const photosById = new Map(state.photos.map((p) => [p.id, p]));
  const dims = pageDimensions(state);
  const doc = new PDFDocument({ size: [dims.PAGE_W, dims.PAGE_H], margin: 0 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  await drawPage(doc, photosById, page, pageIndex, dims);
  doc.end();
  return done;
}

module.exports = { exportPdf, renderSinglePagePdfBuffer, layoutRects, MARGIN, pageDimensions, applyFilter };
