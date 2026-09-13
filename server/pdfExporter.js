const fs = require('fs-extra');
const path = require('path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const { getResizedBuffer, getCroppedBuffer } = require('./images');

const MARGIN = 30;
const GAP = 10;

function layoutRects(layout, x, y, w, h) {
  switch (layout) {
    case 1:
      return [{ x, y, w, h }];
    case 2: {
      const halfW = (w - GAP) / 2;
      return [
        { x, y, w: halfW, h },
        { x: x + halfW + GAP, y, w: halfW, h }
      ];
    }
    case 3: {
      const bigW = (w - GAP) * (2 / 3);
      const smallW = w - GAP - bigW;
      const smallH = (h - GAP) / 2;
      return [
        { x, y, w: bigW, h },
        { x: x + bigW + GAP, y, w: smallW, h: smallH },
        { x: x + bigW + GAP, y: y + smallH + GAP, w: smallW, h: smallH }
      ];
    }
    case 4: {
      const halfW = (w - GAP) / 2;
      const halfH = (h - GAP) / 2;
      return [
        { x, y, w: halfW, h: halfH },
        { x: x + halfW + GAP, y, w: halfW, h: halfH },
        { x, y: y + halfH + GAP, w: halfW, h: halfH },
        { x: x + halfW + GAP, y: y + halfH + GAP, w: halfW, h: halfH }
      ];
    }
    default:
      return [{ x, y, w, h }];
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

  for (let pageIdx = 0; pageIdx < state.pages.length; pageIdx++) {
    const page = state.pages[pageIdx];
    if (pageIdx > 0) doc.addPage({ size: [PAGE_W, PAGE_H], margin: 0 });

    doc.rect(0, 0, PAGE_W, PAGE_H).fill('#ffffff');

    const rects = layoutRects(page.layout, MARGIN, MARGIN, contentW, contentH);
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
              await drawImageCover(doc, buffer, rect);
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
