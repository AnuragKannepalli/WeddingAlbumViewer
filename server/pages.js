const LAYOUT_SLOT_COUNT = {
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8,
  '2b': 2, '3b': 3, '3c': 3, '3d': 3, '4b': 4, '4c': 4, '4d': 4, '4e': 4, '5b': 5, '6b': 6,
  '5c': 5, '5d': 5, '5e': 5, '6c': 6, '6d': 6, '7b': 7, '7c': 7, '8b': 8, '8c': 8
};

// Default split ratios per layout, matching the fixed proportions the app
// used before splits became adjustable (2:1 for the layout-3 main column,
// even halves everywhere else). Layouts made up of all-equal cells (5-8,
// 3d, 4e, 6b) use LAYOUT_ROWS or an equal-columns shape instead -- no
// adjustable divider, so they have no entry here.
const DEFAULT_SPLITS = {
  1: null,
  2: { primary: 0.5 },
  3: { primary: 2 / 3, secondary: 0.5 },
  4: { primary: 0.5, secondary: 0.5 },
  '2b': { secondary: 0.5 },
  '3b': { primary: 1 / 3 },
  '3c': { secondary: 0.6 },
  '4b': { primary: 2 / 3 },
  '4c': { primary: 1 / 3 },
  '4d': { secondary: 0.55 },
  '5b': { primary: 0.45 }
};

// How many photos sit in each row, left to right, top to bottom, for the
// simplest "equal cells" layouts. All cells within a row are equal width;
// all rows are equal height. Must match LAYOUT_ROWS in public/js/app.js
// exactly.
const LAYOUT_ROWS = {
  5: [3, 2],
  6: [3, 3],
  7: [4, 3],
  8: [4, 4],
  '6b': [2, 2, 2],
  '5c': [2, 3],
  '5d': [1, 4],
  '5e': [4, 1],
  '6c': [2, 4],
  '6d': [4, 2],
  '7b': [3, 4],
  '7c': [1, 3, 3],
  '8b': [2, 3, 3],
  '8c': [1, 3, 4]
};

// Structural description for the more varied layout templates (an
// alternative to LAYOUT_ROWS above): the page is split in two along one
// axis at an adjustable ratio, and each side holds either a single photo,
// an equal stack of photos, or a small equal grid of photos -- or, for the
// "equalCols" shape, the whole page is just N equal columns with no split
// at all. Must match LAYOUT_REGION_DEFS in public/js/app.js exactly.
const LAYOUT_REGION_DEFS = {
  '2b': { split: 'rows', regions: [{ count: 1 }, { count: 1 }] },
  '3b': { split: 'cols', regions: [{ count: 2, stack: 'rows' }, { count: 1 }] },
  '3c': { split: 'rows', regions: [{ count: 1 }, { count: 2, stack: 'cols' }] },
  '3d': { equalCols: 3 },
  '4b': { split: 'cols', regions: [{ count: 1 }, { count: 3, stack: 'rows' }] },
  '4c': { split: 'cols', regions: [{ count: 3, stack: 'rows' }, { count: 1 }] },
  '4d': { split: 'rows', regions: [{ count: 1 }, { count: 3, stack: 'cols' }] },
  '4e': { equalCols: 4 },
  '5b': { split: 'cols', regions: [{ count: 1 }, { count: 4, grid: [2, 2] }] }
};

// Every selectable layout, grouped by photo count, in the order shown in
// the picker. Labels are what a screen reader / title tooltip announces.
const LAYOUT_CATALOG = [
  { count: 1, layouts: [{ id: '1', label: 'Full page' }] },
  { count: 2, layouts: [
    { id: '2', label: 'Side by side' },
    { id: '2b', label: 'Stacked top and bottom' }
  ] },
  { count: 3, layouts: [
    { id: '3', label: 'Large left, 2 stacked right' },
    { id: '3b', label: 'Large right, 2 stacked left' },
    { id: '3c', label: 'Large top, 2 side by side bottom' },
    { id: '3d', label: '3 equal columns' }
  ] },
  { count: 4, layouts: [
    { id: '4', label: '2x2 grid' },
    { id: '4b', label: 'Large left, 3 stacked right' },
    { id: '4c', label: 'Large right, 3 stacked left' },
    { id: '4d', label: 'Large top, 3 side by side bottom' },
    { id: '4e', label: '4 equal columns' }
  ] },
  { count: 5, layouts: [
    { id: '5', label: 'Row of 3, row of 2' },
    { id: '5b', label: 'Large left, 2x2 grid right' },
    { id: '5c', label: '2 top, 3 bottom' },
    { id: '5d', label: '1 top, 4 bottom' },
    { id: '5e', label: '4 top, 1 bottom' }
  ] },
  { count: 6, layouts: [
    { id: '6', label: '2 rows of 3' },
    { id: '6b', label: '3 rows of 2' },
    { id: '6c', label: '2 top, 4 bottom' },
    { id: '6d', label: '4 top, 2 bottom' }
  ] },
  { count: 7, layouts: [
    { id: '7', label: 'Row of 4, row of 3' },
    { id: '7b', label: 'Row of 3, row of 4' },
    { id: '7c', label: '1 top, 3 middle, 3 bottom' }
  ] },
  { count: 8, layouts: [
    { id: '8', label: '2 rows of 4' },
    { id: '8b', label: '2 top, 3 middle, 3 bottom' },
    { id: '8c', label: '1 top, 3 middle, 4 bottom' }
  ] }
];

function defaultSplitsForLayout(layout) {
  const base = DEFAULT_SPLITS[layout];
  return base ? { ...base } : null;
}

function makeEmptySlots(layout) {
  const count = LAYOUT_SLOT_COUNT[layout] || 1;
  return Array.from({ length: count }, () => ({ photoId: null, hero: false, crop: null, shape: null, rect: null, mirrored: false, rotation: 0, filter: null }));
}

function makePage(id, layout = 1) {
  return {
    id, layout, slots: makeEmptySlots(layout), splits: defaultSplitsForLayout(layout), floats: [],
    isCover: false, coverTitle: '', coverSubtitle: '', coverDate: ''
  };
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
  LAYOUT_REGION_DEFS,
  LAYOUT_CATALOG,
  makeEmptySlots,
  makePage,
  resizeSlotsForLayout,
  nextPageId,
  defaultSplitsForLayout
};
