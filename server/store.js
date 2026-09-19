const fs = require('fs-extra');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const MAX_SNAPSHOTS = 20;

const DEFAULT_STATE = {
  sourceFolder: null,
  photos: [],
  pages: [],
  lastScan: null,
  exports: [],
  pageSize: { widthIn: 11, heightIn: 8.5 },
  layoutGap: true,
  oneDrive: { clientId: null }
};

function ensureDataDir() {
  fs.ensureDirSync(DATA_DIR);
  fs.ensureDirSync(path.join(DATA_DIR, 'cache'));
  fs.ensureDirSync(path.join(DATA_DIR, 'exports'));
  fs.ensureDirSync(path.join(DATA_DIR, 'uploads'));
  fs.ensureDirSync(HISTORY_DIR);
}

function loadState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    return { ...DEFAULT_STATE };
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
  } catch (err) {
    console.error('Failed to read state.json, starting fresh:', err.message);
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// Only filenames of this exact shape (epoch-ms timestamp + .json) are ever
// trusted for reading/restoring, so a snapshot id can never be used to
// escape the history directory.
const SNAPSHOT_FILENAME_RE = /^\d+\.json$/;

// Saves a copy of the given state as a restore point, named by the moment
// it was taken. Called right before a change that could lose real work
// (switching source folders, rescanning, clearing the library), so there's
// always something to fall back to. Keeps only the most recent snapshots.
function snapshotState(state) {
  ensureDataDir();
  const filename = `${Date.now()}.json`;
  fs.writeFileSync(path.join(HISTORY_DIR, filename), JSON.stringify(state, null, 2), 'utf-8');

  const files = fs.readdirSync(HISTORY_DIR).filter((f) => SNAPSHOT_FILENAME_RE.test(f));
  files.sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
  for (const stale of files.slice(MAX_SNAPSHOTS)) {
    fs.removeSync(path.join(HISTORY_DIR, stale));
  }
}

// Lightweight summary of each snapshot (without loading every full file's
// photo list into the response) for showing a restore-point list in the UI.
function listSnapshots() {
  ensureDataDir();
  const files = fs.readdirSync(HISTORY_DIR).filter((f) => SNAPSHOT_FILENAME_RE.test(f));
  files.sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
  return files.map((filename) => {
    const raw = fs.readFileSync(path.join(HISTORY_DIR, filename), 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      id: filename,
      createdAt: new Date(parseInt(filename, 10)).toISOString(),
      sourceFolder: parsed.sourceFolder || null,
      photoCount: (parsed.photos || []).length,
      pageCount: (parsed.pages || []).length
    };
  });
}

function loadSnapshot(filename) {
  if (!SNAPSHOT_FILENAME_RE.test(filename)) {
    throw new Error('Invalid snapshot id.');
  }
  const filePath = path.join(HISTORY_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error('Snapshot not found.');
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  return { ...DEFAULT_STATE, ...JSON.parse(raw) };
}

module.exports = {
  loadState,
  saveState,
  snapshotState,
  listSnapshots,
  loadSnapshot,
  DATA_DIR,
  STATE_FILE
};
