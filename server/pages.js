const LAYOUT_SLOT_COUNT = { 1: 1, 2: 2, 3: 3, 4: 4 };

function makeEmptySlots(layout) {
  const count = LAYOUT_SLOT_COUNT[layout] || 1;
  return Array.from({ length: count }, () => ({ photoId: null, hero: false, crop: null }));
}

function makePage(id, layout = 1) {
  return { id, layout, slots: makeEmptySlots(layout) };
}

// Resize a page's slots array when its layout changes, keeping photos
// already placed in slots that still exist and dropping any that overflow.
function resizeSlotsForLayout(existingSlots, newLayout) {
  const count = LAYOUT_SLOT_COUNT[newLayout] || 1;
  const next = makeEmptySlots(newLayout);
  for (let i = 0; i < count && i < existingSlots.length; i++) {
    next[i] = existingSlots[i];
  }
  return next;
}

function nextPageId(pages) {
  let max = 0;
  for (const p of pages) {
    const n = parseInt(String(p.id).replace('page-', ''), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return `page-${max + 1}`;
}

module.exports = { LAYOUT_SLOT_COUNT, makeEmptySlots, makePage, resizeSlotsForLayout, nextPageId };
