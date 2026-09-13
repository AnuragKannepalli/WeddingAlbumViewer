const fs = require('fs-extra');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const DEFAULT_STATE = {
  sourceFolder: null,
  photos: [],
  pages: [],
  lastScan: null,
  exports: [],
  pageSize: { widthIn: 11, heightIn: 8.5 }
};

function ensureDataDir() {
  fs.ensureDirSync(DATA_DIR);
  fs.ensureDirSync(path.join(DATA_DIR, 'cache'));
  fs.ensureDirSync(path.join(DATA_DIR, 'exports'));
  fs.ensureDirSync(path.join(DATA_DIR, 'uploads'));
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

module.exports = { loadState, saveState, DATA_DIR, STATE_FILE };
