const LAYOUT_SLOT_COUNT = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8 };

// Default split ratios per layout, matching the fixed proportions the app
// used before splits became adjustable (2:1 for the layout-3 main column,
// even halves everywhere else). Layouts of 5-8 use LAYOUT_ROWS instead --
// equal-size cells, no adjustable divider.
const DEFAULT_SPLITS = {
  1: null,
  2: { primary: 0.5 },
  3: { primary: 2 / 3, secondary: 0.5 },
  4: { primary: 0.5, secondary: 0.5 }
};

// How many photos sit in each row, left to right, top to bottom, for
// layouts that aren't the adjustable-split shapes above. All cells within a
// row are equal width; all rows are equal height. Must match LAYOUT_ROWS in
// public/js/app.js exactly.
const LAYOUT_ROWS = {
  5: [3, 2],
  6: [3, 3],
  7: [4, 3],
  8: [4, 4]
};

function defaultSplitsForLayout(layout) {
  const base = DEFAULT_SPLITS[layout];
  return base ? { ...base } : null;
}

function makeEmptySlots(layout) {
  const count = LAYOUT_SLOT_COUNT[layout] || 1;
  return Array.from({ length: count }, () => ({ photoId: null, hero: false, crop: null }));
}

function makePage(id, layout = 1) {
  return { id, layout, slots: makeEmptySlots(layout), splits: defaultSplitsForLayout(layout) };
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

module.exports = {
  LAYOUT_SLOT_COUNT,
  LAYOUT_ROWS,
  makeEmptySlots,
  makePage,
  resizeSlotsForLayout,
  nextPageId,
  defaultSplitsForLayout
};
