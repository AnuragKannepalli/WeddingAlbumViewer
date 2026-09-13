const fs = require('fs-extra');
const path = require('path');

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Copies original full-resolution files into Page-XX folders, prefixed with
// their print order, and writes an index.txt summary for the photographer.
async function exportForPhotographer(state, destRoot) {
  const photosById = new Map(state.photos.map((p) => [p.id, p]));
  await fs.ensureDir(destRoot);

  const indexLines = [];
  indexLines.push('Wedding Album Export');
  indexLines.push(`Generated: ${new Date().toLocaleString()}`);
  indexLines.push('');

  let usedCount = 0;
  const usedPhotoIds = new Set();

  for (let pageIdx = 0; pageIdx < state.pages.length; pageIdx++) {
    const page = state.pages[pageIdx];
    const pageNum = pageIdx + 1;
    const filledSlots = page.slots.filter((s) => s && s.photoId);
    if (filledSlots.length === 0) {
      indexLines.push(`Page ${pageNum} (Layout: ${page.layout} photo${page.layout > 1 ? 's' : ''}) - EMPTY`);
      indexLines.push('');
      continue;
    }

    const pageFolder = path.join(destRoot, `Page-${pad2(pageNum)}`);
    await fs.ensureDir(pageFolder);

    indexLines.push(`Page ${pageNum} (Layout: ${page.layout} photo${page.layout > 1 ? 's' : ''})`);

    let slotNum = 0;
    for (const slot of page.slots) {
      if (!slot || !slot.photoId) continue;
      slotNum += 1;
      const photo = photosById.get(slot.photoId);
      if (!photo) continue;

      const srcAbsPath = photo.absPath;
      const heroTag = slot.hero ? 'HERO_' : '';
      const destFilename = `${pad2(slotNum)}_${heroTag}${photo.filename}`;
      const destPath = path.join(pageFolder, destFilename);
      await fs.copyFile(srcAbsPath, destPath);

      indexLines.push(`  ${destFilename}${slot.hero ? ' (hero)' : ''}`);
      usedCount += 1;
      usedPhotoIds.add(photo.id);
    }
    indexLines.push('');
  }

  indexLines.push(`Summary: ${usedPhotoIds.size} of ${state.photos.length} photos used across ${state.pages.length} pages`);

  await fs.writeFile(path.join(destRoot, 'index.txt'), indexLines.join('\n'), 'utf-8');

  return {
    destRoot,
    pagesExported: state.pages.length,
    photosUsed: usedPhotoIds.size,
    totalPhotos: state.photos.length
  };
}

module.exports = { exportForPhotographer };
