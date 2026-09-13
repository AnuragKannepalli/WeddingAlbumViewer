const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff', '.bmp']);

// Every photo is identified by a hash of its absolute path on disk, whether
// it came from scanning the source folder or was individually added from
// elsewhere on the computer -- both kinds resolve the same way downstream.
function photoIdForPath(absPath) {
  return crypto.createHash('sha1').update(absPath).digest('hex');
}

function walk(dir, root, results) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, root, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTS.has(ext)) {
        const relPath = path.relative(root, full);
        const stat = fs.statSync(full);
        results.push({
          absPath: full,
          relPath,
          filename: entry.name,
          size: stat.size,
          mtimeMs: stat.mtimeMs
        });
      }
    }
  }
}

// Strip trailing digits from a filename stem to find a "burst prefix",
// e.g. IMG_2456 -> IMG_, DSC00123 -> DSC.
function burstPrefix(filename) {
  const stem = path.basename(filename, path.extname(filename));
  return stem.replace(/\d+$/, '');
}

function detectBursts(photos) {
  const sorted = [...photos].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const BURST_WINDOW_MS = 3000;
  let groupId = 0;
  let prevPrefix = null;
  let prevTime = null;
  const groupMap = new Map();

  for (const p of sorted) {
    const prefix = burstPrefix(p.filename);
    const isSameBurst =
      prevPrefix !== null &&
      prefix === prevPrefix &&
      prevTime !== null &&
      p.mtimeMs - prevTime <= BURST_WINDOW_MS;

    if (!isSameBurst) {
      groupId += 1;
    }
    groupMap.set(p.absPath, groupId);
    prevPrefix = prefix;
    prevTime = p.mtimeMs;
  }

  // Count group sizes so we only flag groups with 2+ members.
  const groupSizes = new Map();
  for (const gid of groupMap.values()) {
    groupSizes.set(gid, (groupSizes.get(gid) || 0) + 1);
  }

  return photos.map((p) => {
    const gid = groupMap.get(p.absPath);
    const size = groupSizes.get(gid) || 1;
    return {
      ...p,
      burstGroup: size > 1 ? gid : null,
      possibleDuplicate: size > 1
    };
  });
}

function scanFolder(sourceFolder) {
  if (!fs.existsSync(sourceFolder) || !fs.statSync(sourceFolder).isDirectory()) {
    throw new Error(`Folder not found: ${sourceFolder}`);
  }
  const results = [];
  walk(sourceFolder, sourceFolder, results);
  const withBursts = detectBursts(results);
  return withBursts.map((p) => ({
    id: photoIdForPath(p.absPath),
    absPath: p.absPath,
    relPath: p.relPath,
    filename: p.filename,
    size: p.size,
    mtimeMs: p.mtimeMs,
    burstGroup: p.burstGroup,
    possibleDuplicate: p.possibleDuplicate,
    source: 'scan'
  }));
}

// Merges freshly re-scanned folder photos into the existing catalog:
// preserves favorite flags for scan photos that still exist, drops scan
// photos no longer found on disk, and leaves individually-added photos
// (source: 'upload') untouched since they aren't part of the folder scan.
function mergeScannedPhotos(existingPhotos, scannedPhotos) {
  const existingById = new Map(existingPhotos.map((p) => [p.id, p]));
  const mergedScanned = scannedPhotos.map((p) => {
    const prev = existingById.get(p.id);
    return {
      ...p,
      favorite: prev ? !!prev.favorite : false
    };
  });
  const uploaded = existingPhotos.filter((p) => p.source === 'upload');
  return [...mergedScanned, ...uploaded];
}

module.exports = { scanFolder, mergeScannedPhotos, photoIdForPath, IMAGE_EXTS };
