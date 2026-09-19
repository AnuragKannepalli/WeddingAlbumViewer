const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const multer = require('multer');

const { loadState, saveState, snapshotState, listSnapshots, loadSnapshot, DATA_DIR } = require('./store');
const { scanFolder, mergeScannedPhotos, photoIdForPath } = require('./scanner');
const { getCachedImage } = require('./images');
const { makePage, resizeSlotsForLayout, nextPageId, defaultSplitsForLayout } = require('./pages');
const { exportForPhotographer } = require('./exporter');
const { exportPdf } = require('./pdfExporter');
const onedrive = require('./onedrive');

const app = express();
const PORT = process.env.PORT || 4173;

// A bug in one request handler should never take down the whole running
// server (and every in-progress editing session) -- log it and keep going.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server kept running):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server kept running):', err);
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

let state = loadState();
if (!state.exports) state.exports = [];
if (!state.pageSize) state.pageSize = { widthIn: 11, heightIn: 8.5 };
if (state.layoutGap === undefined) state.layoutGap = true;
if (!state.oneDrive) state.oneDrive = { clientId: null };

// Back-fill pages saved before adjustable splits existed.
for (const page of state.pages) {
  if (page.splits === undefined) page.splits = defaultSplitsForLayout(page.layout);
}

// Back-fill photo records saved before absPath/source existed on them, so
// existing albums keep working (same ids, same slot assignments) after
// upgrading to the version of this app that added "add from my computer".
for (const photo of state.photos) {
  if (!photo.source) photo.source = 'scan';
  if (!photo.absPath && photo.source === 'scan' && state.sourceFolder && photo.relPath) {
    photo.absPath = path.join(state.sourceFolder, photo.relPath);
  }
}

function persist() {
  saveState(state);
}
persist();

function timestampFolderName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `Wedding-Album-Final_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

const CONTENT_TYPE_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff'
};

const uploadsDir = path.join(DATA_DIR, 'uploads');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const unique = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
      cb(null, `${unique}${path.extname(file.originalname)}`);
    }
  }),
  limits: { fileSize: 200 * 1024 * 1024 }
});

// ---- Setup / scanning ----

app.get('/api/state', (req, res) => {
  res.json(state);
});

app.post('/api/setup', (req, res) => {
  const { sourceFolder } = req.body;
  try {
    const scanned = scanFolder(sourceFolder);
    snapshotState(state);
    state.sourceFolder = sourceFolder;
    state.photos = mergeScannedPhotos(state.photos, scanned);
    state.lastScan = new Date().toISOString();
    persist();
    res.json({ ok: true, photoCount: state.photos.length, state });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/rescan', (req, res) => {
  if (!state.sourceFolder) {
    return res.status(400).json({ ok: false, error: 'No source folder set yet.' });
  }
  try {
    const scanned = scanFolder(state.sourceFolder);
    snapshotState(state);
    const stillPresentIds = new Set([...scanned.map((p) => p.id), ...state.photos.filter((p) => p.source === 'upload').map((p) => p.id)]);
    state.photos = mergeScannedPhotos(state.photos, scanned);
    // Drop slot references to photos that no longer exist on disk.
    for (const page of state.pages) {
      for (const slot of page.slots) {
        if (slot.photoId && !stillPresentIds.has(slot.photoId)) {
          slot.photoId = null;
          slot.hero = false;
        }
      }
    }
    state.lastScan = new Date().toISOString();
    persist();
    res.json({ ok: true, photoCount: state.photos.length, state });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Lets you add individual photos from anywhere on your computer -- not just
// the scanned source folder. Since browsers never expose a real filesystem
// path for a file picked this way, the file's bytes are copied into this
// app's own data/uploads/ folder so it can be treated like any other photo
// (thumbnailed, placed in a slot, exported) from then on.
app.post('/api/upload', upload.array('photos', 50), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ ok: false, error: 'No files received' });
  }
  const added = [];
  for (const file of req.files) {
    const id = photoIdForPath(file.path);
    if (state.photos.some((p) => p.id === id)) continue;
    const record = {
      id,
      absPath: file.path,
      relPath: null,
      filename: file.originalname,
      size: file.size,
      mtimeMs: Date.now(),
      burstGroup: null,
      possibleDuplicate: false,
      favorite: false,
      source: 'upload'
    };
    state.photos.push(record);
    added.push(record);
  }
  persist();
  res.json({ ok: true, added, state });
});

// Saves already-downloaded image bytes as a new library photo (used by both
// the drag-a-link import below and the OneDrive browser import), and, if a
// slot was specified, places it there directly.
async function addDownloadedPhoto(buffer, filename, pageId, slotIndex) {
  const ext = path.extname(filename || '') || '.jpg';
  const unique = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const destPath = path.join(uploadsDir, `${unique}${ext}`);
  await fs.ensureDir(uploadsDir);
  await fs.writeFile(destPath, buffer);

  const id = photoIdForPath(destPath);
  const record = {
    id,
    absPath: destPath,
    relPath: null,
    filename: filename || path.basename(destPath),
    size: buffer.length,
    mtimeMs: Date.now(),
    burstGroup: null,
    possibleDuplicate: false,
    favorite: false,
    source: 'upload'
  };
  state.photos.push(record);

  let page = null;
  if (pageId !== undefined && slotIndex !== undefined) {
    page = state.pages.find((p) => p.id === pageId) || null;
    if (page) {
      const idx = parseInt(slotIndex, 10);
      if (idx >= 0 && idx < page.slots.length) {
        page.slots[idx].photoId = id;
        page.slots[idx].crop = null;
      }
    }
  }
  return { record, page };
}

// Lets you drag a photo straight out of a OneDrive browser tab and drop it
// onto a page slot. A web page can't hand our JS the actual file bytes for
// something dragged from another origin -- but OneDrive's web UI (like
// Gmail/Google Drive) sets a "DownloadURL" drag payload: a short-lived,
// self-authenticating link meant for exactly this kind of drag-out, so the
// browser's JS just passes that URL here and the server fetches it directly
// (no cookies needed, which is also why it expires quickly -- if it fails,
// dragging again from OneDrive gets a fresh one).
app.post('/api/import-url', async (req, res) => {
  const { url, filename, pageId, slotIndex } = req.body;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: 'A valid http(s) URL is required.' });
  }
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WeddingAlbumSelector/1.0)' }
    });
    if (!response.ok) {
      throw new Error(`That link didn't return a photo (HTTP ${response.status}). OneDrive drag links expire quickly -- try dragging it again.`);
    }
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
    if (!contentType.startsWith('image/')) {
      throw new Error('That link did not point to an image file.');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const name = filename || `photo${CONTENT_TYPE_EXT[contentType] || '.jpg'}`;
    const { record, page } = await addDownloadedPhoto(buffer, name, pageId, slotIndex);
    persist();
    res.json({ ok: true, photo: record, page });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ---- OneDrive integration ----
// Lets you sign in with your own Microsoft account and browse/import photos
// straight from OneDrive's web app, since dragging out of onedrive.com
// directly doesn't work (its web UI only shares an internal item reference
// on drag, not an actual file or URL -- see the comment above import-url).

app.get('/api/onedrive/status', async (req, res) => {
  try {
    const clientId = state.oneDrive.clientId;
    if (!clientId) return res.json({ ok: true, configured: false, connected: false, account: null });
    const account = await onedrive.getAccount(clientId);
    res.json({ ok: true, configured: true, connected: !!account, account: account ? account.username : null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/onedrive/config', (req, res) => {
  state.oneDrive.clientId = (req.body.clientId || '').trim() || null;
  persist();
  res.json({ ok: true, oneDrive: state.oneDrive });
});

app.post('/api/onedrive/logout', async (req, res) => {
  try {
    await onedrive.signOut(state.oneDrive.clientId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/auth/onedrive/login', async (req, res) => {
  const clientId = state.oneDrive.clientId;
  if (!clientId) return res.status(400).send('Set a OneDrive Client ID on the Setup tab first, then try connecting again.');
  try {
    const url = await onedrive.getAuthUrl(clientId, PORT);
    res.redirect(url);
  } catch (err) {
    res.status(500).send(`Could not start OneDrive sign-in: ${err.message}`);
  }
});

app.get('/auth/onedrive/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);
    await onedrive.handleCallback(req.query.code, PORT);
    res.redirect('/?onedrive=connected');
  } catch (err) {
    res.redirect(`/?onedrive=error&msg=${encodeURIComponent(err.message)}`);
  }
});

app.get('/api/onedrive/browse', async (req, res) => {
  try {
    const clientId = state.oneDrive.clientId;
    const token = await onedrive.getAccessToken(clientId);
    const folderPath = req.query.id ? `/me/drive/items/${req.query.id}/children` : '/me/drive/root/children';
    const response = await onedrive.graphFetch(token, `${folderPath}?$top=200&$select=id,name,folder,file,image`);
    if (!response.ok) throw new Error(`OneDrive returned an error (HTTP ${response.status}).`);
    const data = await response.json();
    const items = (data.value || [])
      .filter((it) => it.folder || (it.file && it.image))
      .map((it) => ({ id: it.id, name: it.name, isFolder: !!it.folder }));
    res.json({ ok: true, items });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/onedrive/thumb/:itemId', async (req, res) => {
  try {
    const clientId = state.oneDrive.clientId;
    const token = await onedrive.getAccessToken(clientId);
    const response = await onedrive.graphFetch(token, `/me/drive/items/${req.params.itemId}/thumbnails/0/medium/content`);
    if (!response.ok) return res.status(404).end();
    res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.status(500).end();
  }
});

// Downloads the full-resolution original(s) for the given OneDrive item ids
// and adds them to the library, same as any other imported photo.
app.post('/api/onedrive/import', async (req, res) => {
  try {
    const clientId = state.oneDrive.clientId;
    const { itemIds, pageId, slotIndex } = req.body;
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'No photos selected.' });
    }
    const token = await onedrive.getAccessToken(clientId);
    const added = [];
    let page = null;
    for (const itemId of itemIds) {
      const metaRes = await onedrive.graphFetch(token, `/me/drive/items/${itemId}?$select=name,@microsoft.graph.downloadUrl`);
      if (!metaRes.ok) continue;
      const meta = await metaRes.json();
      const downloadUrl = meta['@microsoft.graph.downloadUrl'];
      if (!downloadUrl) continue;
      const fileRes = await fetch(downloadUrl); // pre-authenticated by Graph, no Bearer header needed
      if (!fileRes.ok) continue;
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      const isFirst = added.length === 0;
      const result = await addDownloadedPhoto(buffer, meta.name, isFirst ? pageId : undefined, isFirst ? slotIndex : undefined);
      added.push(result.record);
      if (result.page) page = result.page;
    }
    if (added.length === 0) {
      return res.status(400).json({ ok: false, error: 'Could not download any of the selected photos.' });
    }
    persist();
    res.json({ ok: true, added, page });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Clears the app's photo catalog and album layout so a new source folder can
// be scanned fresh. This never touches your original synced photos -- it
// only forgets what the app has recorded in state.json. Photos individually
// added via "Add from my computer" are physical copies this app made in
// data/uploads/, so those files are removed too as part of starting over.
app.post('/api/reset', async (req, res) => {
  snapshotState(state);
  state.sourceFolder = null;
  state.photos = [];
  state.pages = [];
  state.lastScan = null;
  try {
    await fs.emptyDir(uploadsDir);
  } catch (err) {
    console.error('Failed to clear uploads dir:', err.message);
  }
  persist();
  res.json({ ok: true, state });
});

// ---- Version history ----
// A restore point is taken automatically before any action that replaces
// or clears the photo catalog (switching source folders, rescanning,
// clearing the library), so an unintended change is never unrecoverable.

app.get('/api/history', (req, res) => {
  try {
    res.json({ ok: true, snapshots: listSnapshots() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/history/:id/restore', (req, res) => {
  try {
    const snapshot = loadSnapshot(req.params.id);
    snapshotState(state); // the current state becomes its own restore point first
    state = snapshot;
    if (!state.exports) state.exports = [];
    if (state.layoutGap === undefined) state.layoutGap = true;
    if (!state.oneDrive) state.oneDrive = { clientId: null };
    for (const page of state.pages) {
      if (page.splits === undefined) page.splits = defaultSplitsForLayout(page.layout);
    }
    persist();
    res.json({ ok: true, state });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ---- Images ----

app.get('/api/thumb/:id', async (req, res) => {
  const photo = state.photos.find((p) => p.id === req.params.id);
  if (!photo) return res.status(404).end();
  try {
    const cached = await getCachedImage(photo.absPath, 'thumb');
    res.sendFile(cached);
  } catch (err) {
    res.status(500).end();
  }
});

app.get('/api/preview/:id', async (req, res) => {
  const photo = state.photos.find((p) => p.id === req.params.id);
  if (!photo) return res.status(404).end();
  try {
    const cached = await getCachedImage(photo.absPath, 'preview');
    res.sendFile(cached);
  } catch (err) {
    res.status(500).end();
  }
});

// ---- Favorites ----

app.post('/api/favorite', (req, res) => {
  const { id, favorite } = req.body;
  const photo = state.photos.find((p) => p.id === id);
  if (!photo) return res.status(404).json({ ok: false, error: 'Photo not found' });
  photo.favorite = !!favorite;
  persist();
  res.json({ ok: true });
});

// ---- Page size (applies to every page in the album) ----

app.post('/api/page-size', (req, res) => {
  const widthIn = parseFloat(req.body.widthIn);
  const heightIn = parseFloat(req.body.heightIn);
  if (!(widthIn > 0) || !(heightIn > 0)) {
    return res.status(400).json({ ok: false, error: 'Width and height must be positive numbers.' });
  }
  state.pageSize = { widthIn, heightIn };
  persist();
  res.json({ ok: true, pageSize: state.pageSize });
});

app.post('/api/layout-gap', (req, res) => {
  state.layoutGap = !!req.body.layoutGap;
  persist();
  res.json({ ok: true, layoutGap: state.layoutGap });
});

// ---- Pages ----

app.post('/api/pages/count', (req, res) => {
  const { count } = req.body;
  const target = Math.max(0, parseInt(count, 10) || 0);
  if (target > state.pages.length) {
    while (state.pages.length < target) {
      state.pages.push(makePage(nextPageId(state.pages), 1));
    }
  } else if (target < state.pages.length) {
    state.pages = state.pages.slice(0, target);
  }
  persist();
  res.json({ ok: true, pages: state.pages });
});

app.put('/api/pages/:pageId/layout', (req, res) => {
  const { layout } = req.body;
  const page = state.pages.find((p) => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ ok: false, error: 'Page not found' });
  page.slots = resizeSlotsForLayout(page.slots, layout);
  page.layout = layout;
  page.splits = defaultSplitsForLayout(layout);
  persist();
  res.json({ ok: true, page });
});

app.put('/api/pages/:pageId/splits', (req, res) => {
  const page = state.pages.find((p) => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ ok: false, error: 'Page not found' });
  const { primary, secondary } = req.body;
  if (!page.splits) {
    return res.status(400).json({ ok: false, error: 'This layout has no adjustable split.' });
  }
  const clamp = (v) => Math.min(0.85, Math.max(0.15, v));
  if (primary !== undefined) page.splits.primary = clamp(parseFloat(primary));
  if (secondary !== undefined && page.splits.secondary !== undefined) {
    page.splits.secondary = clamp(parseFloat(secondary));
  }
  persist();
  res.json({ ok: true, page });
});

app.put('/api/pages/:pageId/slot/:slotIndex', (req, res) => {
  const page = state.pages.find((p) => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ ok: false, error: 'Page not found' });
  const idx = parseInt(req.params.slotIndex, 10);
  if (idx < 0 || idx >= page.slots.length) {
    return res.status(400).json({ ok: false, error: 'Invalid slot index' });
  }
  const { photoId, remove, hero, crop } = req.body;
  if (remove) {
    page.slots[idx] = { photoId: null, hero: false, crop: null };
  } else {
    if (photoId !== undefined) {
      page.slots[idx].photoId = photoId;
      page.slots[idx].crop = null; // a new photo starts with no crop applied
    }
    if (hero !== undefined) page.slots[idx].hero = !!hero;
    if (crop !== undefined) page.slots[idx].crop = crop;
  }
  persist();
  res.json({ ok: true, page });
});

app.post('/api/pages/move', (req, res) => {
  const { pageId, direction } = req.body;
  const idx = state.pages.findIndex((p) => p.id === pageId);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Page not found' });
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= state.pages.length) {
    return res.json({ ok: true, pages: state.pages });
  }
  [state.pages[idx], state.pages[swapWith]] = [state.pages[swapWith], state.pages[idx]];
  persist();
  res.json({ ok: true, pages: state.pages });
});

// Reorders pages to an arbitrary new order (used by drag-to-reorder in the
// page rail). `order` must list every existing page id exactly once.
app.post('/api/pages/reorder', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) {
    return res.status(400).json({ ok: false, error: 'order must be an array of page ids.' });
  }
  const byId = new Map(state.pages.map((p) => [p.id, p]));
  const isValid = order.length === state.pages.length && order.every((id) => byId.has(id));
  if (!isValid) {
    return res.status(400).json({ ok: false, error: 'order must include every existing page exactly once.' });
  }
  state.pages = order.map((id) => byId.get(id));
  persist();
  res.json({ ok: true, pages: state.pages });
});

// ---- Export ----

app.post('/api/export/photographer', async (req, res) => {
  const { baseFolder } = req.body;
  const base = baseFolder || state.sourceFolder;
  if (!base) {
    return res.status(400).json({ ok: false, error: 'No export location set. Enter a folder path first.' });
  }
  try {
    const target = path.join(base, timestampFolderName());
    const summary = await exportForPhotographer(state, target);
    const record = {
      id: crypto.randomUUID(),
      folderName: path.basename(target),
      destRoot: target,
      createdAt: new Date().toISOString(),
      photosUsed: summary.photosUsed,
      pagesExported: summary.pagesExported
    };
    state.exports.unshift(record);
    persist();
    res.json({ ok: true, ...summary, exportRecord: record });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/exports/:id', async (req, res) => {
  const record = state.exports.find((e) => e.id === req.params.id);
  if (!record) return res.status(404).json({ ok: false, error: 'Export not found' });
  try {
    await fs.remove(record.destRoot);
    state.exports = state.exports.filter((e) => e.id !== req.params.id);
    persist();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/export/pdf', async (req, res) => {
  const destPath = path.join(DATA_DIR, 'exports', 'wedding-album.pdf');
  try {
    await exportPdf(state, destPath);
    res.json({ ok: true, downloadUrl: '/api/export/pdf/download' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/export/pdf/download', (req, res) => {
  const destPath = path.join(DATA_DIR, 'exports', 'wedding-album.pdf');
  if (!fs.existsSync(destPath)) return res.status(404).end();
  res.download(destPath, 'Wedding-Album.pdf');
});

app.listen(PORT, () => {
  console.log(`Wedding Album Viewer running at http://localhost:${PORT}`);
});
