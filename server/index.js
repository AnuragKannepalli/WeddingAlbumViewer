const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const multer = require('multer');
const archiver = require('archiver');
const unzipper = require('unzipper');

const { loadState, saveState, snapshotState, listSnapshots, loadSnapshot, DATA_DIR } = require('./store');
const { scanFolder, mergeScannedPhotos, photoIdForPath } = require('./scanner');
const { getCachedImage, getDisplayDimensions, getCroppedBuffer, getPerceptualHash, hashDistance } = require('./images');
const { makePage, resizeSlotsForLayout, nextPageId, defaultSplitsForLayout } = require('./pages');
const { exportForPhotographer } = require('./exporter');
const { exportPdf, renderSinglePagePdfBuffer, layoutRects, MARGIN: PDF_MARGIN } = require('./pdfExporter');
const { renderPageToImageBuffer } = require('./pageImageExporter');
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

function defaultProjectFields() {
  return { pageSize: { widthIn: 11, heightIn: 8.5 }, layoutGap: true };
}

let appData = loadState();

// Migrate pre-multi-project installs: the single shared
// photos/pages/pageSize/etc. this app used to have becomes the first
// project, so nothing about an existing album changes -- it just gets a
// name and lives alongside any other projects created from here on. Each
// project is otherwise exactly the shape state.json already had.
if (!appData.projects) {
  appData = {
    oneDrive: appData.oneDrive || { clientId: null },
    activeProjectId: 'project-1',
    projects: [{
      id: 'project-1',
      name: 'Album 1',
      sourceFolder: appData.sourceFolder || null,
      photos: appData.photos || [],
      removedPhotos: appData.removedPhotos || [],
      pageStylePresets: appData.pageStylePresets || [],
      pages: appData.pages || [],
      lastScan: appData.lastScan || null,
      exports: appData.exports || [],
      pageSize: appData.pageSize || { widthIn: 11, heightIn: 8.5 },
      layoutGap: appData.layoutGap === undefined ? true : appData.layoutGap
    }]
  };
}
if (!appData.oneDrive) appData.oneDrive = { clientId: null };
if (!appData.activeProjectId || !appData.projects.some((p) => p.id === appData.activeProjectId)) {
  appData.activeProjectId = appData.projects[0].id;
}

function activeProject() {
  let project = appData.projects.find((p) => p.id === appData.activeProjectId);
  if (!project) {
    project = appData.projects[0];
    appData.activeProjectId = project.id;
  }
  return project;
}

function isPhotoInUse(pages, photoId) {
  for (const page of pages) {
    if (page.slots.some((s) => s && s.photoId === photoId)) return true;
    if ((page.floats || []).some((f) => f.photoId === photoId)) return true;
  }
  return false;
}

// Moves a photo out of the active library into the Removed tray -- but only
// if nothing on any page still points at it, since the same photo can be
// placed in more than one slot/float (see the duplicate-use badge), and
// removing just one of those occurrences shouldn't make it vanish from the
// library while it's still sitting in another one.
function releasePhotoIfUnused(state, photoId) {
  if (!photoId || isPhotoInUse(state.pages, photoId)) return;
  const idx = state.photos.findIndex((p) => p.id === photoId);
  if (idx === -1) return;
  const [photo] = state.photos.splice(idx, 1);
  state.removedPhotos.push({ ...photo, removedAt: new Date().toISOString() });
}

// The other direction: un-evicts a photo from the Removed tray back into
// the active library, if it's sitting there -- called before a slot/float
// route points at a given photoId, so dragging a tray photo straight into
// a slot "just works" the same way dragging a regular library photo does,
// and undoing a removal (which re-sends the slot's old photoId) revives it
// too, with no separate restore step either client needs to know about.
function reviveIfRemoved(state, photoId) {
  if (!photoId || state.photos.some((p) => p.id === photoId)) return;
  const idx = state.removedPhotos.findIndex((p) => p.id === photoId);
  if (idx === -1) return;
  const [photo] = state.removedPhotos.splice(idx, 1);
  delete photo.removedAt;
  state.photos.push(photo);
}

// Back-fill every project's own fields -- the same per-field backfills this
// app has always done, just run once per project instead of once globally.
for (const project of appData.projects) {
  if (!project.exports) project.exports = [];
  if (!project.pageSize) project.pageSize = defaultProjectFields().pageSize;
  if (project.layoutGap === undefined) project.layoutGap = true;
  if (project.sourceFolder === undefined) project.sourceFolder = null;
  if (project.lastScan === undefined) project.lastScan = null;
  if (!project.removedPhotos) project.removedPhotos = [];
  if (!project.pageStylePresets) project.pageStylePresets = [];

  for (const page of project.pages) {
    if (page.splits === undefined) page.splits = defaultSplitsForLayout(page.layout);
    if (!page.floats) page.floats = [];
    if (page.isCover === undefined) page.isCover = false;
    if (page.coverTitle === undefined) page.coverTitle = '';
    if (page.coverSubtitle === undefined) page.coverSubtitle = '';
    if (page.coverDate === undefined) page.coverDate = '';
    for (const float of page.floats) {
      if (float.crop === undefined) float.crop = null;
      if (float.shape === undefined) float.shape = null;
      if (float.mirrored === undefined) float.mirrored = false;
      if (float.rotation === undefined) float.rotation = 0;
      if (float.filter === undefined) float.filter = null;
    }
    for (const slot of page.slots) {
      if (slot.shape === undefined) slot.shape = null;
      if (slot.rect === undefined) slot.rect = null;
      if (slot.mirrored === undefined) slot.mirrored = false;
      if (slot.rotation === undefined) slot.rotation = 0;
      if (slot.filter === undefined) slot.filter = null;
    }
  }

  for (const photo of project.photos) {
    if (!photo.source) photo.source = 'scan';
    if (!photo.absPath && photo.source === 'scan' && project.sourceFolder && photo.relPath) {
      photo.absPath = path.join(project.sourceFolder, photo.relPath);
    }
  }
}

function persist() {
  saveState(appData);
}
persist();

function timestampSuffix() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// Every project already gets a real name at creation (falling back to
// "Album N" there if none was typed -- see POST /api/projects below), so
// this is just making that name safe to put in a filename, with "Album"
// as a last-resort fallback for the pathological case of a name that's
// nothing but characters this strips out.
function safeFileName(name) {
  const cleaned = (name || '').replace(/[^a-z0-9 _-]/gi, '').trim();
  return cleaned || 'Album';
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

// For importing an exported album .zip (see /api/projects/import below) --
// stored to a temp file first since zips can be large and need to be read
// back (not just streamed through once) to pull out album.json and every
// photo inside.
const importUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(DATA_DIR, 'tmp')),
    filename: (req, file, cb) => cb(null, `import-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.zip`)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

// ---- Projects ----
// Each project is a fully independent album: its own photo library and its
// own pages, so you can build separate albums (e.g. "Ceremony" and
// "Reception") without them sharing or mixing content. The OneDrive sign-in
// is the one thing shared across all of them, since that's an account
// connection, not album data.

app.get('/api/state', (req, res) => {
  const project = activeProject();
  res.json({
    ...project,
    oneDrive: appData.oneDrive,
    activeProjectId: appData.activeProjectId,
    projects: appData.projects.map((p) => ({
      id: p.id,
      name: p.name,
      photoCount: p.photos.length,
      pageCount: p.pages.length
    }))
  });
});

app.post('/api/projects', (req, res) => {
  const name = (req.body.name || '').trim() || `Album ${appData.projects.length + 1}`;
  const id = `project-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const project = {
    id,
    name,
    sourceFolder: null,
    photos: [],
    removedPhotos: [],
    pageStylePresets: [],
    pages: [],
    lastScan: null,
    exports: [],
    ...defaultProjectFields()
  };
  appData.projects.push(project);
  appData.activeProjectId = id;
  persist();
  res.json({ ok: true, projectId: id });
});

app.post('/api/projects/:id/activate', (req, res) => {
  if (!appData.projects.some((p) => p.id === req.params.id)) {
    return res.status(404).json({ ok: false, error: 'Project not found' });
  }
  appData.activeProjectId = req.params.id;
  persist();
  res.json({ ok: true });
});

app.put('/api/projects/:id', (req, res) => {
  const project = appData.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Name cannot be empty.' });
  project.name = name;
  persist();
  res.json({ ok: true });
});

// Deletes an entire project (its photo library and pages), never the files
// a "scanned" source folder points to (those were never copied) -- only
// individually-added photos are physical copies this app made, and those
// get cleaned up too. A restore point is saved first since this discards
// a whole album at once. The last remaining project can't be deleted.
app.delete('/api/projects/:id', async (req, res) => {
  if (appData.projects.length <= 1) {
    return res.status(400).json({ ok: false, error: 'Cannot delete the only remaining project.' });
  }
  const idx = appData.projects.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Project not found' });
  snapshotState(appData);
  const [removed] = appData.projects.splice(idx, 1);
  if (appData.activeProjectId === req.params.id) {
    appData.activeProjectId = appData.projects[0].id;
  }
  try {
    for (const photo of removed.photos) {
      if (photo.source === 'upload' && photo.absPath && photo.absPath.startsWith(uploadsDir)) {
        await fs.remove(photo.absPath).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Failed to clean up deleted project\'s uploaded files:', err.message);
  }
  persist();
  res.json({ ok: true });
});

// Bundles one album (its pages plus every photo it actually uses) into a
// single .zip that someone else can hand to their own copy of this app and
// import as a brand-new, fully independent album -- see
// POST /api/projects/import below. Nothing else (other albums, OneDrive
// sign-in) is included.
app.get('/api/projects/:id/export', async (req, res) => {
  const project = appData.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });

  res.attachment(`${safeFileName(project.name)}_Edit.zip`);

  // Store rather than deflate: nearly everything in here is already a
  // compressed JPEG (or similar), so spending CPU time trying to compress
  // it further saves almost no space but makes a several-hundred-photo
  // export take many times longer than it needs to.
  const archive = archiver('zip', { store: true });
  archive.on('error', (err) => {
    console.error('Album export failed:', err.message);
    res.end();
  });
  archive.pipe(res);

  const exportedPhotos = [];
  for (const photo of project.photos) {
    // Skip anything missing on disk rather than failing the whole export --
    // a stale reference shouldn't block handing off everything else.
    if (!photo.absPath || !(await fs.pathExists(photo.absPath))) continue;
    const ext = path.extname(photo.absPath) || path.extname(photo.filename) || '.jpg';
    const zipPath = `photos/${photo.id}${ext}`;
    archive.file(photo.absPath, { name: zipPath });
    exportedPhotos.push({
      id: photo.id,
      zipPath,
      filename: photo.filename,
      size: photo.size,
      mtimeMs: photo.mtimeMs,
      burstGroup: photo.burstGroup,
      possibleDuplicate: photo.possibleDuplicate,
      favorite: photo.favorite
    });
  }

  const bundle = {
    formatVersion: 1,
    name: project.name,
    pages: project.pages,
    pageSize: project.pageSize,
    layoutGap: project.layoutGap,
    photos: exportedPhotos
  };
  archive.append(JSON.stringify(bundle, null, 2), { name: 'album.json' });
  await archive.finalize();
});

// Imports an album .zip made by the export route above as a brand-new
// project here -- its own copies of every photo and its own pages,
// completely separate from any album already in this app.
app.post('/api/projects/import', importUpload.single('albumZip'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file received.' });
  try {
    const directory = await unzipper.Open.file(req.file.path);
    const albumEntry = directory.files.find((f) => f.path === 'album.json');
    if (!albumEntry) {
      throw new Error("This doesn't look like an exported album (missing album.json).");
    }
    const albumJson = JSON.parse((await albumEntry.buffer()).toString('utf-8'));

    await fs.ensureDir(uploadsDir);
    const idMap = new Map(); // the sender's photo id -> this app's new id for it
    const newPhotos = [];
    for (const photo of albumJson.photos || []) {
      const entry = directory.files.find((f) => f.path === photo.zipPath);
      if (!entry) continue; // the export itself was already missing this one
      const ext = path.extname(photo.zipPath || '') || '.jpg';
      const unique = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
      const destPath = path.join(uploadsDir, `${unique}${ext}`);
      const buffer = await entry.buffer();
      await fs.writeFile(destPath, buffer);
      const newId = photoIdForPath(destPath);
      idMap.set(photo.id, newId);
      newPhotos.push({
        id: newId,
        absPath: destPath,
        relPath: null,
        filename: photo.filename || path.basename(destPath),
        size: photo.size || buffer.length,
        mtimeMs: photo.mtimeMs || Date.now(),
        burstGroup: photo.burstGroup || null,
        possibleDuplicate: !!photo.possibleDuplicate,
        favorite: !!photo.favorite,
        source: 'upload'
      });
    }

    // Every page/slot/float referenced the sender's own photo ids -- remap
    // them to the new ones just assigned above, and drop anything that
    // pointed at a photo this import couldn't bring across.
    const newPages = (albumJson.pages || []).map((page) => ({
      ...page,
      slots: (page.slots || []).map((slot) => {
        if (!slot || !slot.photoId) return slot;
        const mappedId = idMap.get(slot.photoId);
        return mappedId ? { ...slot, photoId: mappedId } : { photoId: null, hero: false, crop: null };
      }),
      floats: (page.floats || [])
        .filter((f) => idMap.has(f.photoId))
        .map((f) => ({ ...f, photoId: idMap.get(f.photoId) })),
      splits: page.splits === undefined ? defaultSplitsForLayout(page.layout) : page.splits
    }));

    const newProjectId = `project-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const newProject = {
      id: newProjectId,
      name: albumJson.name ? `${albumJson.name} (Imported)` : 'Imported Album',
      sourceFolder: null,
      photos: newPhotos,
      pages: newPages,
      lastScan: null,
      exports: [],
      pageSize: albumJson.pageSize || { widthIn: 11, heightIn: 8.5 },
      layoutGap: albumJson.layoutGap === undefined ? true : albumJson.layoutGap
    };
    appData.projects.push(newProject);
    appData.activeProjectId = newProjectId;
    persist();
    res.json({ ok: true, projectId: newProjectId, photoCount: newPhotos.length, pageCount: newPages.length });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  } finally {
    await fs.remove(req.file.path).catch(() => {});
  }
});

// ---- Setup / scanning ----

app.post('/api/setup', (req, res) => {
  const state = activeProject();
  const { sourceFolder } = req.body;
  try {
    const scanned = scanFolder(sourceFolder);
    snapshotState(appData);
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
  const state = activeProject();
  if (!state.sourceFolder) {
    return res.status(400).json({ ok: false, error: 'No source folder set yet.' });
  }
  try {
    const scanned = scanFolder(state.sourceFolder);
    snapshotState(appData);
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
  const state = activeProject();
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

// Saves already-downloaded image bytes as a new library photo in the given
// project (used by both the drag-a-link import below and the OneDrive
// browser import), and, if a slot was specified, places it there directly.
async function addDownloadedPhoto(state, buffer, filename, pageId, slotIndex) {
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
  const state = activeProject();
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
    const { record, page } = await addDownloadedPhoto(state, buffer, name, pageId, slotIndex);
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
// The sign-in itself is shared across every project; which project an
// imported photo lands in depends on whichever project is active.

app.get('/api/onedrive/status', async (req, res) => {
  try {
    const clientId = appData.oneDrive.clientId;
    if (!clientId) return res.json({ ok: true, configured: false, connected: false, account: null });
    const account = await onedrive.getAccount(clientId);
    res.json({ ok: true, configured: true, connected: !!account, account: account ? account.username : null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/onedrive/config', (req, res) => {
  appData.oneDrive.clientId = (req.body.clientId || '').trim() || null;
  persist();
  res.json({ ok: true, oneDrive: appData.oneDrive });
});

app.post('/api/onedrive/logout', async (req, res) => {
  try {
    await onedrive.signOut(appData.oneDrive.clientId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/auth/onedrive/login', async (req, res) => {
  const clientId = appData.oneDrive.clientId;
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
    const clientId = appData.oneDrive.clientId;
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
    const clientId = appData.oneDrive.clientId;
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
// and adds them to the active project's library, same as any other
// imported photo.
app.post('/api/onedrive/import', async (req, res) => {
  const state = activeProject();
  try {
    const clientId = appData.oneDrive.clientId;
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
      const result = await addDownloadedPhoto(state, buffer, meta.name, isFirst ? pageId : undefined, isFirst ? slotIndex : undefined);
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

// Clears the active project's photo catalog and album layout so a new
// source folder can be scanned fresh. This never touches your original
// synced photos -- it only forgets what the app has recorded in
// state.json. Photos individually added via "Add from my computer" are
// physical copies this app made in data/uploads/, so those files are
// removed too as part of starting over. Other projects are untouched.
app.post('/api/reset', async (req, res) => {
  const state = activeProject();
  snapshotState(appData);
  const uploadedPaths = [...state.photos, ...state.removedPhotos]
    .filter((p) => p.source === 'upload')
    .map((p) => p.absPath);
  state.sourceFolder = null;
  state.photos = [];
  state.removedPhotos = [];
  state.pages = [];
  state.lastScan = null;
  try {
    for (const absPath of uploadedPaths) {
      await fs.remove(absPath).catch(() => {});
    }
  } catch (err) {
    console.error('Failed to clear this project\'s uploaded files:', err.message);
  }
  persist();
  res.json({ ok: true, state });
});

// ---- Version history ----
// A restore point is taken automatically before any action that replaces
// or clears a project's photo catalog (switching source folders, rescanning,
// clearing the library, deleting a page or a whole project), so an
// unintended change is never unrecoverable. One history covers every
// project at once, since restoring is a whole-app undo.

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
    snapshotState(appData); // the current state becomes its own restore point first
    appData = snapshot;
    if (!appData.oneDrive) appData.oneDrive = { clientId: null };
    if (!appData.projects) {
      // A snapshot taken before multi-project support existed: wrap it the
      // same way the startup migration does.
      appData = {
        oneDrive: appData.oneDrive,
        activeProjectId: 'project-1',
        projects: [{
          id: 'project-1',
          name: 'Album 1',
          sourceFolder: appData.sourceFolder || null,
          photos: appData.photos || [],
          pages: appData.pages || [],
          lastScan: appData.lastScan || null,
          exports: appData.exports || [],
          pageSize: appData.pageSize || { widthIn: 11, heightIn: 8.5 },
          layoutGap: appData.layoutGap === undefined ? true : appData.layoutGap
        }]
      };
    }
    if (!appData.activeProjectId || !appData.projects.some((p) => p.id === appData.activeProjectId)) {
      appData.activeProjectId = appData.projects[0].id;
    }
    for (const project of appData.projects) {
      if (!project.exports) project.exports = [];
      if (project.layoutGap === undefined) project.layoutGap = true;
      if (!project.pageSize) project.pageSize = { widthIn: 11, heightIn: 8.5 };
      if (!project.removedPhotos) project.removedPhotos = [];
      if (!project.pageStylePresets) project.pageStylePresets = [];
      for (const page of project.pages) {
        if (page.splits === undefined) page.splits = defaultSplitsForLayout(page.layout);
        if (!page.floats) page.floats = [];
        if (page.isCover === undefined) page.isCover = false;
        if (page.coverTitle === undefined) page.coverTitle = '';
        if (page.coverSubtitle === undefined) page.coverSubtitle = '';
        if (page.coverDate === undefined) page.coverDate = '';
        for (const float of page.floats) {
          if (float.crop === undefined) float.crop = null;
          if (float.shape === undefined) float.shape = null;
          if (float.mirrored === undefined) float.mirrored = false;
          if (float.rotation === undefined) float.rotation = 0;
          if (float.filter === undefined) float.filter = null;
        }
        for (const slot of page.slots) {
          if (slot.shape === undefined) slot.shape = null;
          if (slot.rect === undefined) slot.rect = null;
          if (slot.mirrored === undefined) slot.mirrored = false;
          if (slot.rotation === undefined) slot.rotation = 0;
          if (slot.filter === undefined) slot.filter = null;
        }
      }
    }
    persist();
    res.json({ ok: true, state: activeProject() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ---- Images ----

app.get('/api/thumb/:id', async (req, res) => {
  const state = activeProject();
  // Falls back to the Removed tray so a photo's thumbnail keeps loading
  // there too, even though it's no longer in the active library.
  const photo = state.photos.find((p) => p.id === req.params.id)
    || state.removedPhotos.find((p) => p.id === req.params.id);
  if (!photo) return res.status(404).end();
  try {
    const cached = await getCachedImage(photo.absPath, 'thumb');
    res.sendFile(cached);
  } catch (err) {
    res.status(500).end();
  }
});

app.get('/api/preview/:id', async (req, res) => {
  const state = activeProject();
  const photo = state.photos.find((p) => p.id === req.params.id);
  if (!photo) return res.status(404).end();
  try {
    const cached = await getCachedImage(photo.absPath, 'preview');
    res.sendFile(cached);
  } catch (err) {
    res.status(500).end();
  }
});

// Renders a free-shape crop (one whose rectangle doesn't necessarily match
// its slot/float's own aspect ratio) as an actual cropped image, rather than
// the CSS pan/zoom trick used for aspect-locked "fill slot" crops -- the
// browser then just letterboxes this already-cropped image within its box.
app.get('/api/crop-preview/:id', async (req, res) => {
  const state = activeProject();
  const photo = state.photos.find((p) => p.id === req.params.id);
  if (!photo) return res.status(404).end();
  const { x, y, w, h } = req.query;
  if (x === undefined || y === undefined || w === undefined || h === undefined) {
    return res.status(400).end();
  }
  try {
    const buffer = await getCroppedBuffer(
      photo.absPath,
      { x: parseFloat(x), y: parseFloat(y), w: parseFloat(w), h: parseFloat(h) },
      400
    );
    res.set('Content-Type', 'image/jpeg');
    res.send(buffer);
  } catch (err) {
    res.status(500).end();
  }
});

// ---- Favorites ----

app.post('/api/favorite', (req, res) => {
  const state = activeProject();
  const { id, favorite } = req.body;
  const photo = state.photos.find((p) => p.id === id);
  if (!photo) return res.status(404).json({ ok: false, error: 'Photo not found' });
  photo.favorite = !!favorite;
  persist();
  res.json({ ok: true });
});

// Removes one or more photos from this project's library entirely (not
// just unassigning them), clearing any slot or floating-photo reference to
// them across every page so nothing is left pointing at a photo that no
// longer exists. A physical copy this app made (an upload/import) is
// deleted from disk too; a photo that came from scanning a folder is only
// forgotten from the catalog -- its real file is never touched. A restore
// point is saved first since this can affect many pages at once.
app.post('/api/photos/delete', async (req, res) => {
  const state = activeProject();
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ ok: false, error: 'No photo ids given.' });
  }
  snapshotState(appData);
  const idSet = new Set(ids);
  const toDelete = state.photos.filter((p) => idSet.has(p.id));
  state.photos = state.photos.filter((p) => !idSet.has(p.id));
  for (const page of state.pages) {
    for (const slot of page.slots) {
      if (slot.photoId && idSet.has(slot.photoId)) {
        slot.photoId = null;
        slot.hero = false;
        slot.crop = null;
      }
    }
    page.floats = page.floats.filter((f) => !idSet.has(f.photoId));
  }
  for (const photo of toDelete) {
    if (photo.source === 'upload' && photo.absPath) {
      await fs.remove(photo.absPath).catch(() => {});
    }
  }
  persist();
  res.json({ ok: true, photos: state.photos, pages: state.pages });
});

// ---- Removed tray ----
// A photo pulled out of a slot or floating photo (and not placed anywhere
// else) lands here instead of being deleted outright. Dragging it back
// into a slot/float un-evicts it automatically (see reviveIfRemoved
// above, called from the slot/float routes that accept a photoId) -- there
// is deliberately no separate "restore" endpoint, so a tray photo can be
// dropped exactly like a regular library one with no extra round trip.

// Sweeps the whole library in one pass: every photo not currently placed
// in any slot or floating photo on any page moves to the Removed tray,
// same as removing it from a slot would one at a time -- for catching
// photos that were never actually placed (so the one-at-a-time flow never
// touched them) as well as any that slipped through for other reasons.
app.post('/api/removed-photos/sweep-unused', (req, res) => {
  const state = activeProject();
  const candidates = state.photos.filter((p) => !isPhotoInUse(state.pages, p.id)).map((p) => p.id);
  for (const id of candidates) releasePhotoIfUnused(state, id);
  persist();
  res.json({ ok: true, photos: state.photos, removedPhotos: state.removedPhotos, movedCount: candidates.length });
});

// Permanently deletes one photo from the Removed tray. It's already
// unreferenced by every page (that's how it got here), so this only ever
// touches the tray itself -- and, same as the regular library delete, only
// removes a physical copy this app made (an upload); a photo that came
// from scanning the OneDrive folder is only forgotten, never touched on
// disk.
app.post('/api/removed-photos/:id/delete', async (req, res) => {
  const state = activeProject();
  const idx = state.removedPhotos.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Photo not found in the Removed tray' });
  const [photo] = state.removedPhotos.splice(idx, 1);
  if (photo.source === 'upload' && photo.absPath) {
    await fs.remove(photo.absPath).catch(() => {});
  }
  persist();
  res.json({ ok: true, removedPhotos: state.removedPhotos });
});

// Empties the whole Removed tray at once (same disk-deletion rule as above
// for each one). The client shows its own "this can't be undone"
// confirmation before calling this.
app.post('/api/removed-photos/delete-all', async (req, res) => {
  const state = activeProject();
  const toDelete = state.removedPhotos;
  state.removedPhotos = [];
  for (const photo of toDelete) {
    if (photo.source === 'upload' && photo.absPath) {
      await fs.remove(photo.absPath).catch(() => {});
    }
  }
  persist();
  res.json({ ok: true, removedPhotos: state.removedPhotos });
});

// ---- Fill empty slots ----
// Walks every page in order, and every empty slot in order, handing each
// one the next favorited-and-unused photo -- so a big album's layout can
// be roughed in from your favorites in one click instead of dragging each
// one individually. Stops once either runs out; never touches a slot that
// already has a photo, and never reaches for a non-favorited photo.
app.post('/api/pages/fill-empty-slots', (req, res) => {
  const state = activeProject();
  const used = new Set();
  for (const page of state.pages) {
    for (const slot of page.slots) if (slot && slot.photoId) used.add(slot.photoId);
    for (const float of page.floats || []) used.add(float.photoId);
  }
  const candidates = state.photos.filter((p) => p.favorite && !used.has(p.id));
  let cursor = 0;
  let filledCount = 0;
  for (const page of state.pages) {
    for (let i = 0; i < page.slots.length; i++) {
      if (cursor >= candidates.length) break;
      if (!page.slots[i].photoId) {
        page.slots[i].photoId = candidates[cursor].id;
        page.slots[i].crop = null;
        cursor += 1;
        filledCount += 1;
      }
    }
  }
  persist();
  res.json({
    ok: true,
    pages: state.pages,
    filledCount,
    favoritesRemaining: candidates.length - cursor
  });
});

// ---- Page style presets ----
// A named {shape, mirrored, filter} bundle, applied to every photo on a
// page in one click via the existing bulk-style route -- defined up front
// (not captured from a page's current state, since different slots on the
// same page can already have different styles) so what a preset will do
// is never ambiguous.
app.post('/api/style-presets', (req, res) => {
  const state = activeProject();
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Enter a name for this preset.' });
  const preset = {
    id: `preset-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    name,
    shape: req.body.shape || null,
    mirrored: !!req.body.mirrored,
    filter: normalizeFilter(req.body.filter)
  };
  state.pageStylePresets.push(preset);
  persist();
  res.json({ ok: true, pageStylePresets: state.pageStylePresets });
});

app.delete('/api/style-presets/:id', (req, res) => {
  const state = activeProject();
  state.pageStylePresets = state.pageStylePresets.filter((p) => p.id !== req.params.id);
  persist();
  res.json({ ok: true, pageStylePresets: state.pageStylePresets });
});

// ---- Print-size check ----
// Flags any placed photo whose actual pixel resolution won't cover its
// printed size at a reasonable quality -- uses the exact same layout math
// as the PDF export (layoutRects) so the physical size it checks against
// matches what will actually print, not an approximation of it.
const PRINT_DPI_THRESHOLD = 150;
app.get('/api/photos/print-check', async (req, res) => {
  const state = activeProject();
  const photosById = new Map(state.photos.map((p) => [p.id, p]));
  const pageSize = state.pageSize || { widthIn: 11, heightIn: 8.5 };
  const PAGE_W = pageSize.widthIn * 72;
  const PAGE_H = pageSize.heightIn * 72;
  const contentW = PAGE_W - PDF_MARGIN * 2;
  const contentH = PAGE_H - PDF_MARGIN * 2 - 24;
  const gap = state.layoutGap === false ? 0 : 10;
  const warnings = [];

  const checkOne = async (photo, rectPt, location) => {
    if (!photo) return;
    try {
      const { width, height } = await getDisplayDimensions(photo.absPath);
      const printWIn = rectPt.w / 72;
      const printHIn = rectPt.h / 72;
      if (printWIn <= 0 || printHIn <= 0) return;
      const dpi = Math.min(width / printWIn, height / printHIn);
      if (dpi < PRINT_DPI_THRESHOLD) {
        warnings.push({ ...location, photoId: photo.id, filename: photo.filename, dpi: Math.round(dpi) });
      }
    } catch (err) {
      // Unreadable file -- skip rather than failing the whole check.
    }
  };

  for (let pageIndex = 0; pageIndex < state.pages.length; pageIndex++) {
    const page = state.pages[pageIndex];
    const usesCustomRects = page.slots.some((s) => s.rect);
    const rects = usesCustomRects
      ? page.slots.map((slot) => (slot.rect
        ? { w: slot.rect.w * contentW, h: slot.rect.h * contentH }
        : null))
      : layoutRects(page.layout, PDF_MARGIN, PDF_MARGIN, contentW, contentH, gap, page.splits);
    for (let i = 0; i < page.slots.length; i++) {
      const slot = page.slots[i];
      const rect = rects[i];
      if (!slot || !slot.photoId || !rect) continue;
      await checkOne(photosById.get(slot.photoId), rect, { pageIndex, type: 'slot', slotIndex: i });
    }
    for (const float of page.floats || []) {
      const rect = { w: float.w * PAGE_W, h: float.h * PAGE_H };
      await checkOne(photosById.get(float.photoId), rect, { pageIndex, type: 'float', floatId: float.id });
    }
  }

  res.json({ ok: true, warnings, threshold: PRINT_DPI_THRESHOLD });
});

// ---- Near-duplicate photo detector ----
// Visual-similarity grouping across the whole library using a perceptual
// hash (see images.js) -- distinct from the filename/timestamp "burst"
// guess the scanner already makes (possibleDuplicate/burstGroup): this one
// actually looks at pixel content, so it catches similar photos that
// aren't from the same camera-generated filename sequence too (e.g. two
// different people's phones at the same moment).
app.get('/api/photos/duplicate-groups', async (req, res) => {
  const state = activeProject();
  const HASH_DISTANCE_THRESHOLD = 10; // out of 64 bits -- fairly strict
  const hashes = [];
  for (const photo of state.photos) {
    try {
      const hash = await getPerceptualHash(photo.absPath);
      hashes.push({ id: photo.id, hash });
    } catch (err) {
      // Unreadable file -- just excluded from grouping.
    }
  }

  // Union-find so a chain of near-identical photos (A~B, B~C) all land in
  // one group even if A and C individually fall just outside the
  // threshold of each other.
  const parent = new Map(hashes.map((h) => [h.id, h.id]));
  const find = (id) => {
    while (parent.get(id) !== id) id = parent.get(id);
    return id;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) {
      if (hashDistance(hashes[i].hash, hashes[j].hash) <= HASH_DISTANCE_THRESHOLD) {
        union(hashes[i].id, hashes[j].id);
      }
    }
  }
  const groupsByRoot = new Map();
  for (const h of hashes) {
    const root = find(h.id);
    if (!groupsByRoot.has(root)) groupsByRoot.set(root, []);
    groupsByRoot.get(root).push(h.id);
  }
  const groups = Array.from(groupsByRoot.values()).filter((g) => g.length > 1);
  res.json({ ok: true, groups });
});

// ---- Page size (applies to every page in this project's album) ----

app.post('/api/page-size', (req, res) => {
  const state = activeProject();
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
  const state = activeProject();
  state.layoutGap = !!req.body.layoutGap;
  persist();
  res.json({ ok: true, layoutGap: state.layoutGap });
});

// ---- Pages ----

app.post('/api/pages/count', (req, res) => {
  const state = activeProject();
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
  const state = activeProject();
  const { layout } = req.body;
  const page = state.pages.find((p) => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ ok: false, error: 'Page not found' });
  page.slots = resizeSlotsForLayout(page.slots, layout);
  // Picking a layout (even re-picking the current one) is a deliberate
  // "start over" action, so any free-form slot sizing from the resize
  // handles is cleared and the page goes back to the template's own grid.
  page.slots.forEach((slot) => { slot.rect = null; });
  page.layout = layout;
  page.splits = defaultSplitsForLayout(layout);
  persist();
  res.json({ ok: true, page });
});

// Batch-sets every slot's free-form rect (fractions of the page's content
// box, same frame of reference as layoutRects() in pdfExporter.js) in one
// call -- used both to seed the current template's computed positions the
// first time a slot is resized, and to persist the result of a resize drag
// (which may also have shrunk neighboring slots to avoid overlap). A null
// entry clears that slot back to no custom rect.
app.put('/api/pages/:pageId/slots/rects', (req, res) => {
  const state = activeProject();
  const page = state.pages.find((p) => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ ok: false, error: 'Page not found' });
  const { rects } = req.body;
  if (!Array.isArray(rects) || rects.length !== page.slots.length) {
    return res.status(400).json({ ok: false, error: "Rects must match the page's slot count." });
  }
  page.slots.forEach((slot, i) => {
    const r = rects[i];
    if (!r) { slot.rect = null; return; }
    const w = Math.min(1, Math.max(0.03, parseFloat(r.w)));
    const h = Math.min(1, Math.max(0.03, parseFloat(r.h)));
    slot.rect = {
      x: Math.min(1 - w, Math.max(0, parseFloat(r.x))),
      y: Math.min(1 - h, Math.max(0, parseFloat(r.y))),
      w,
      h
    };
  });
  persist();
  res.json({ ok: true, page });
});

app.put('/api/pages/:pageId/splits', (req, res) => {
  const state = activeProject();
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

// ---- Floating accent photos ----
// Independent of a page's slot grid: small photos that can be freely
// positioned and resized anywhere on the page (even overlapping the main
// slot photo), for a scrapbook/collage look. x/y/w/h are fractions (0-1) of
// the whole printed sheet, not just the margin area the slot grid uses.

const FLOAT_DEFAULT_WIDTH_FRACTION = 0.22;
const FLOAT_START_POSITIONS = [
  { x: 0.62, y: 0.08 },
  { x: 0.08, y: 0.62 },
  { x: 0.62, y: 0.62 },
  { x: 0.08, y: 0.08 }
];

// Only 0/90/180/270 are meaningful rotations for a photo (anything else
// would require re-cropping math this app doesn't support), so any other
// value -- including a non-multiple-of-90 -- just falls back to no rotation
// rather than being rejected outright.
function normalizeRotation(v) {
  const n = ((parseInt(v, 10) % 360) + 360) % 360;
  return [0, 90, 180, 270].includes(n) ? n : 0;
}

const VALID_FILTERS = new Set(['warm', 'cool', 'muted', 'bw', 'vivid', 'sepia', 'vintage']);
function normalizeFilter(v) {
  return VALID_FILTERS.has(v) ? v : null;
}

app.post('/api/pages/:pageId/floats', async (req, res) => {
  const state = activeProject();
  const page = state.pages.find((p) => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ ok: false, error: 'Page not found' });
  reviveIfRemoved(state, req.body.photoId);
  const photo = state.photos.find((p) => p.id === req.body.photoId);
  if (!photo) return res.status(404).json({ ok: false, error: 'Photo not found' });
  try {
    const { width, height } = await getDisplayDimensions(photo.absPath);
    const pageAspect = state.pageSize.widthIn / state.pageSize.heightIn;
    const w = FLOAT_DEFAULT_WIDTH_FRACTION;
    const h = Math.min(0.9, w * pageAspect * (height / width));
    const pos = FLOAT_START_POSITIONS[page.floats.length % FLOAT_START_POSITIONS.length];
    const float = {
      id: `float-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      photoId: photo.id,
      x: pos.x,
      y: pos.y,
      w,
      h,
      crop: null,
      shape: null,
      mirrored: false,
      rotation: 0,
      filter: null
    };
    page.floats.push(float);
    persist();
    res.json({ ok: true, page, photos: state.photos, removedPhotos: state.removedPhotos });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.put('/api/pages/:pageId/floats/:floatId', (req, res) => {
  const state = activeProject();
  const page = state.pages.find((p) => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ ok: false, error: 'Page not found' });
  const float = page.floats.find((f) => f.id === req.params.floatId);
  if (!float) return res.status(404).json({ ok: false, error: 'Floating photo not found' });
  const clampSize = (v) => Math.min(1, Math.max(0.03, v));
  const { x, y, w, h, crop, photoId, shape, mirrored, rotation, filter, keepCrop } = req.body;
  // Replacing which photo a float shows (e.g. by dropping a new one onto
  // it) keeps its position/size exactly where they were -- only the
  // content changes -- and by default clears any crop, which was framed
  // for the old photo and likely wouldn't make sense on the new one;
  // `keepCrop` opts out of that, for e.g. swapping in another shot from the
  // same burst where the old framing still applies.
  if (photoId !== undefined) {
    reviveIfRemoved(state, photoId);
    const photo = state.photos.find((p) => p.id === photoId);
    if (!photo) return res.status(404).json({ ok: false, error: 'Photo not found' });
    float.photoId = photoId;
    if (!keepCrop) float.crop = null;
  }
  // A float may hang partway off the page edge (a common scrapbook look),
  // so position is clamped relative to its own half-width/height, not to
  // [0,1] outright -- and must use whichever size (new or existing) is
  // current once both x/y and w/h are applied below.
  if (w !== undefined) float.w = clampSize(parseFloat(w));
  if (h !== undefined) float.h = clampSize(parseFloat(h));
  if (x !== undefined) float.x = Math.min(1 - float.w / 2, Math.max(-float.w / 2, parseFloat(x)));
  if (y !== undefined) float.y = Math.min(1 - float.h / 2, Math.max(-float.h / 2, parseFloat(y)));
  if (crop !== undefined) float.crop = crop;
  if (shape !== undefined) float.shape = shape || null;
  if (mirrored !== undefined) float.mirrored = !!mirrored;
  if (rotation !== undefined) float.rotation = normalizeRotation(rotation);
  if (filter !== undefined) float.filter = normalizeFilter(filter);
  persist();
  res.json({ ok: true, page, photos: state.photos, removedPhotos: state.removedPhotos });
});

app.delete('/api/pages/:pageId/floats/:floatId', (req, res) => {
  const state = activeProject();
  const page = state.pages.find((p) => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ ok: false, error: 'Page not found' });
  const removedFloat = page.floats.find((f) => f.id === req.params.floatId);
  page.floats = page.floats.filter((f) => f.id !== req.params.floatId);
  if (removedFloat) releasePhotoIfUnused(state, removedFloat.photoId);
  persist();
  res.json({ ok: true, page, photos: state.photos, removedPhotos: state.removedPhotos });
});

app.put('/api/pages/:pageId/slot/:slotIndex', (req, res) => {
  const state = activeProject();
  const page = state.pages.find((p) => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ ok: false, error: 'Page not found' });
  const idx = parseInt(req.params.slotIndex, 10);
  if (idx < 0 || idx >= page.slots.length) {
    return res.status(400).json({ ok: false, error: 'Invalid slot index' });
  }
  const { photoId, remove, hero, crop, shape, mirrored, rotation, filter, keepCrop } = req.body;
  if (remove) {
    const removedPhotoId = page.slots[idx].photoId;
    page.slots[idx] = { photoId: null, hero: false, crop: null, shape: null, mirrored: false, rotation: 0, filter: null };
    releasePhotoIfUnused(state, removedPhotoId);
  } else {
    if (photoId !== undefined) {
      reviveIfRemoved(state, photoId);
      page.slots[idx].photoId = photoId;
      // By default a new photo starts with no crop applied, since one
      // framed for the old photo likely wouldn't make sense on the new
      // one -- `keepCrop` opts out, for e.g. swapping in another shot from
      // the same burst where the old framing still applies.
      if (!keepCrop) page.slots[idx].crop = null;
    }
    if (hero !== undefined) page.slots[idx].hero = !!hero;
    if (crop !== undefined) page.slots[idx].crop = crop;
    if (shape !== undefined) page.slots[idx].shape = shape || null;
    if (mirrored !== undefined) page.slots[idx].mirrored = !!mirrored;
    if (rotation !== undefined) page.slots[idx].rotation = normalizeRotation(rotation);
    if (filter !== undefined) page.slots[idx].filter = normalizeFilter(filter);
  }
  persist();
  res.json({ ok: true, page, photos: state.photos, removedPhotos: state.removedPhotos });
});

// Rearranges two slots on the same page by swapping their entire contents
// (photo, hero flag, crop) -- used when dragging a filled slot onto
// another slot to reposition it, instead of overwriting the target.
app.post('/api/pages/:pageId/slots/swap', (req, res) => {
  const state = activeProject();
  const page = state.pages.find((p) => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ ok: false, error: 'Page not found' });
  const idxA = parseInt(req.body.a, 10);
  const idxB = parseInt(req.body.b, 10);
  if (idxA < 0 || idxA >= page.slots.length || idxB < 0 || idxB >= page.slots.length) {
    return res.status(400).json({ ok: false, error: 'Invalid slot index' });
  }
  const tmp = page.slots[idxA];
  page.slots[idxA] = page.slots[idxB];
  page.slots[idxB] = tmp;
  persist();
  res.json({ ok: true, page });
});

// Deep-clones a page (layout, splits, every slot's photo/crop/shape/
// mirrored/rotation, and every floating photo) and inserts the copy right
// after the original -- floats get freshly generated ids so they're never
// confused with the originals'.
app.post('/api/pages/:pageId/duplicate', (req, res) => {
  const state = activeProject();
  const idx = state.pages.findIndex((p) => p.id === req.params.pageId);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Page not found' });
  const clone = JSON.parse(JSON.stringify(state.pages[idx]));
  clone.id = nextPageId(state.pages);
  clone.floats = (clone.floats || []).map((f) => ({
    ...f,
    id: `float-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  }));
  state.pages.splice(idx + 1, 0, clone);
  persist();
  res.json({ ok: true, pages: state.pages, newPageId: clone.id });
});

// Downloads just the current page -- as a PDF (vector, matches the
// whole-album export), or rasterized to PNG/JPEG for dropping straight
// into a chat or a social post. Streamed directly in the response rather
// than written to data/exports like the whole-album export, since a
// single page is cheap to regenerate and doesn't need to be kept around.
const PAGE_EXPORT_CONTENT_TYPES = { pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg' };
app.get('/api/pages/:pageId/export', async (req, res) => {
  const state = activeProject();
  const pageIndex = state.pages.findIndex((p) => p.id === req.params.pageId);
  if (pageIndex === -1) return res.status(404).json({ ok: false, error: 'Page not found' });
  let format = (req.query.format || 'pdf').toLowerCase();
  if (format === 'jpg') format = 'jpeg';
  if (!PAGE_EXPORT_CONTENT_TYPES[format]) {
    return res.status(400).json({ ok: false, error: 'Unsupported format (use pdf, png, or jpeg).' });
  }
  try {
    const buffer = format === 'pdf'
      ? await renderSinglePagePdfBuffer(state, pageIndex)
      : await renderPageToImageBuffer(state, pageIndex, format);
    res.set('Content-Type', PAGE_EXPORT_CONTENT_TYPES[format]);
    res.set('Content-Disposition', `attachment; filename="page-${pageIndex + 1}.${format === 'jpeg' ? 'jpg' : format}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Applies one shape and/or mirrored setting to every filled slot and
// floating photo on a page in a single call, for "make this whole page
// consistent" instead of clicking through each photo individually. Empty
// slots are skipped since there's no photo to style.
app.put('/api/pages/:pageId/bulk-style', (req, res) => {
  const state = activeProject();
  const page = state.pages.find((p) => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ ok: false, error: 'Page not found' });
  const { shape, mirrored, filter } = req.body;
  const applyTo = (item) => {
    if (!item.photoId) return;
    if (shape !== undefined) item.shape = shape || null;
    if (mirrored !== undefined) item.mirrored = !!mirrored;
    if (filter !== undefined) item.filter = normalizeFilter(filter);
  };
  page.slots.forEach(applyTo);
  (page.floats || []).forEach(applyTo);
  persist();
  res.json({ ok: true, page });
});

// Marks a page as a cover/title page and sets its overlay text. This
// doesn't change the page's layout or photos at all -- a cover page is
// still an ordinary page underneath, just with a title/subtitle/date
// overlay drawn on top of it at export time (see drawPage in
// pdfExporter.js and renderPageToImageBuffer in pageImageExporter.js).
app.put('/api/pages/:pageId/cover', (req, res) => {
  const state = activeProject();
  const page = state.pages.find((p) => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ ok: false, error: 'Page not found' });
  const { isCover, coverTitle, coverSubtitle, coverDate } = req.body;
  if (isCover !== undefined) page.isCover = !!isCover;
  if (coverTitle !== undefined) page.coverTitle = String(coverTitle).slice(0, 200);
  if (coverSubtitle !== undefined) page.coverSubtitle = String(coverSubtitle).slice(0, 200);
  if (coverDate !== undefined) page.coverDate = String(coverDate).slice(0, 100);
  persist();
  res.json({ ok: true, page });
});

// "Auto-compose": a lightweight heuristic pass over every filled slot on a
// page that nudges the arrangement toward a more editorial look, without
// touching the photos' pixels on disk -- the two moves it makes are the same
// two a person composing the page by hand might reach for: pulling the one
// photo whose aspect ratio least suits a uniform grid cell out into a
// free-floating accent, and giving a couple of the rest a warm/muted filter
// so the page doesn't read as five unrelated, untouched snapshots. It's
// intentionally conservative -- most slots come out untouched, and at most
// one photo ever becomes floating -- since a heavy-handed automatic edit is
// harder to want to keep than a light one.
app.post('/api/pages/:pageId/auto-compose', async (req, res) => {
  const state = activeProject();
  const page = state.pages.find((p) => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ ok: false, error: 'Page not found' });
  const photosById = new Map(state.photos.map((p) => [p.id, p]));
  const prevPage = JSON.parse(JSON.stringify(page));

  const filledIdx = [];
  for (let i = 0; i < page.slots.length; i++) {
    if (page.slots[i] && page.slots[i].photoId && photosById.has(page.slots[i].photoId)) filledIdx.push(i);
  }
  if (filledIdx.length === 0) {
    return res.json({ ok: true, page, prevPage });
  }

  const aspectOf = {};
  for (const idx of filledIdx) {
    const photo = photosById.get(page.slots[idx].photoId);
    try {
      const { width, height } = await getDisplayDimensions(photo.absPath);
      aspectOf[idx] = width / height;
    } catch (err) {
      aspectOf[idx] = 1;
    }
  }

  // Only pull one photo out into a float, and only when enough photos are
  // left (4+) to still read as a full page, and only when one really stands
  // out as an awkward fit for a uniform grid cell (aspect ratio far from
  // square -- a panorama or a tall portrait crop).
  let floatIdx = null;
  if (filledIdx.length >= 4) {
    let best = null;
    for (const idx of filledIdx) {
      const deviation = Math.abs(Math.log(aspectOf[idx]));
      if (deviation > 0.4 && (!best || deviation > best.deviation)) best = { idx, deviation };
    }
    if (best) floatIdx = best.idx;
  }

  if (floatIdx !== null) {
    const slot = page.slots[floatIdx];
    const photo = photosById.get(slot.photoId);
    const pageAspect = state.pageSize.widthIn / state.pageSize.heightIn;
    const w = FLOAT_DEFAULT_WIDTH_FRACTION;
    const h = Math.min(0.9, (w * pageAspect) / aspectOf[floatIdx]);
    const pos = FLOAT_START_POSITIONS[page.floats.length % FLOAT_START_POSITIONS.length];
    page.floats.push({
      id: `float-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      photoId: photo.id,
      x: pos.x,
      y: pos.y,
      w,
      h,
      crop: null,
      shape: null,
      mirrored: false,
      rotation: 0,
      filter: null
    });
    page.slots[floatIdx] = { photoId: null, hero: false, crop: null, shape: null, mirrored: false, rotation: 0, filter: null };
  }

  // A handful of the remaining photos (alternating) get a gentle filter;
  // the rest -- including the page's hero photo, if any -- stay untouched
  // so the mix reads as a deliberate accent rather than a blanket effect.
  const FILTER_CYCLE = ['warm', null, 'muted', null];
  let cursor = 0;
  for (const idx of filledIdx) {
    if (idx === floatIdx) continue;
    if (page.slots[idx].hero) continue;
    page.slots[idx].filter = FILTER_CYCLE[cursor % FILTER_CYCLE.length];
    cursor++;
  }

  persist();
  res.json({ ok: true, page, prevPage });
});

// Overwrites a page wholesale with a previously-returned page object for the
// same id -- the one-level-undo counterpart to auto-compose above, which can
// touch several slots and floats in one go, too much to unwind field-by-
// field through the regular slot/float PUT routes.
app.put('/api/pages/:pageId/replace', (req, res) => {
  const state = activeProject();
  const idx = state.pages.findIndex((p) => p.id === req.params.pageId);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Page not found' });
  const incoming = req.body.page;
  if (!incoming || incoming.id !== req.params.pageId) {
    return res.status(400).json({ ok: false, error: 'Invalid page payload' });
  }
  state.pages[idx] = incoming;
  persist();
  res.json({ ok: true, page: state.pages[idx] });
});

app.post('/api/pages/move', (req, res) => {
  const state = activeProject();
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
  const state = activeProject();
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

// Deletes one page entirely (its slot photos and any floating photos on it
// are gone, but the underlying photos stay in the library). A restore
// point is saved first since this discards a whole page's layout at once.
app.delete('/api/pages/:pageId', (req, res) => {
  const state = activeProject();
  const idx = state.pages.findIndex((p) => p.id === req.params.pageId);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Page not found' });
  snapshotState(appData);
  state.pages.splice(idx, 1);
  persist();
  res.json({ ok: true, pages: state.pages });
});

// ---- Export ----

app.post('/api/export/photographer', async (req, res) => {
  const state = activeProject();
  const { baseFolder } = req.body;
  const base = baseFolder || state.sourceFolder;
  if (!base) {
    return res.status(400).json({ ok: false, error: 'No export location set. Enter a folder path first.' });
  }
  // A relative path (e.g. "Downloads" instead of "C:\Users\you\Downloads")
  // would resolve against this server process's own working directory --
  // the app's install folder -- landing real photos inside the project
  // instead of wherever the user meant. Require a full path instead.
  if (!path.isAbsolute(base)) {
    return res.status(400).json({
      ok: false,
      error: `"${base}" isn't a full path. Enter the complete folder path (e.g. C:\\Users\\yourname\\Downloads), not just a folder name.`
    });
  }
  try {
    const target = path.join(base, `${safeFileName(state.name)}_Photographer_${timestampSuffix()}`);
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
  const state = activeProject();
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
  const state = activeProject();
  const destPath = path.join(DATA_DIR, 'exports', 'wedding-album.pdf');
  try {
    await exportPdf(state, destPath);
    res.json({ ok: true, downloadUrl: '/api/export/pdf/download' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/export/pdf/download', (req, res) => {
  const state = activeProject();
  const destPath = path.join(DATA_DIR, 'exports', 'wedding-album.pdf');
  if (!fs.existsSync(destPath)) return res.status(404).end();
  res.download(destPath, `${safeFileName(state.name)}_PDF.pdf`);
});

// Every page, rendered separately as PNG or JPEG (see pageImageExporter.js),
// bundled into one ZIP -- for sharing a handful of pages without sending
// the whole PDF. Streamed straight into the response, same as the album
// export/import ZIP, since there's no reason to keep a copy on disk.
app.get('/api/export/pages-zip', async (req, res) => {
  const state = activeProject();
  let format = (req.query.format || 'png').toLowerCase();
  if (format === 'jpg') format = 'jpeg';
  if (format !== 'png' && format !== 'jpeg') {
    return res.status(400).json({ ok: false, error: 'Unsupported format (use png or jpeg).' });
  }
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  res.attachment(`${safeFileName(state.name)}_Pages.zip`);
  const archive = archiver('zip', { store: true });
  archive.on('error', (err) => {
    console.error('Page image ZIP export failed:', err.message);
    res.end();
  });
  archive.pipe(res);
  for (let i = 0; i < state.pages.length; i++) {
    try {
      const buffer = await renderPageToImageBuffer(state, i, format);
      archive.append(buffer, { name: `page-${String(i + 1).padStart(2, '0')}.${ext}` });
    } catch (err) {
      // Skip a page that fails to render rather than aborting the whole ZIP.
    }
  }
  archive.finalize();
});

app.listen(PORT, () => {
  console.log(`Wedding Album Viewer running at http://localhost:${PORT}`);
});
