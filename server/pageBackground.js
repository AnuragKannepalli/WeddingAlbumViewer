// Shared constants for page background patterns -- kept in one place so the
// PDF export (vector, drawn with PDFKit) and the PNG/JPEG export (raster,
// drawn as SVG and rasterized by sharp) produce visually matching patterns,
// even though the two use completely different drawing APIs and each has
// its own copy of the actual drawing code.
const VALID_BACKGROUND_TYPES = new Set(['none', 'solid', 'gradient', 'dots', 'stripes', 'grid']);

const DOT_SPACING = 36;
const DOT_RADIUS = 4;
const DOT_OPACITY = 0.45;

const STRIPE_WIDTH = 24;
const STRIPE_SPACING = 48;
const STRIPE_OPACITY = 0.22;

const GRID_SPACING = 30;
const GRID_OPACITY = 0.28;

const DEFAULT_COLOR = '#f3e9dc';

function normalizeBackground(bg) {
  if (!bg || !VALID_BACKGROUND_TYPES.has(bg.type)) return { type: 'none', color: DEFAULT_COLOR };
  const color = typeof bg.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(bg.color) ? bg.color : DEFAULT_COLOR;
  return { type: bg.type, color };
}

module.exports = {
  VALID_BACKGROUND_TYPES,
  DOT_SPACING, DOT_RADIUS, DOT_OPACITY,
  STRIPE_WIDTH, STRIPE_SPACING, STRIPE_OPACITY,
  GRID_SPACING, GRID_OPACITY,
  DEFAULT_COLOR,
  normalizeBackground
};
