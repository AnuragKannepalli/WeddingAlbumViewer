# Wedding Album Selector

A local web app for picking your favorite wedding photos and laying them out
into album pages, then exporting:

- **A folder of original files** for your photographer, organized by page and
  print order (`Wedding-Album-Final/Page-01/01_IMG_2456.jpg`, ...) with an
  `index.txt` summary.
- **A PDF preview** of the album exactly as you designed it, for yourself.

Runs entirely on your own machine against a local folder (e.g. your
OneDrive-synced photos folder). No login, no cloud services, no database —
just a JSON file on disk.

## Setup

```
npm install
npm start
```

Then open [http://localhost:4173](http://localhost:4173) in your browser.

## Using it

1. **Setup tab** — paste the full path to your synced photo folder (subfolders
   are scanned too) and click "Scan Folder".
2. **Library tab** — browse all photos, search by filename, and mark
   favorites. Photos that look like part of a rapid burst (same filename
   prefix, taken within a few seconds of each other) are flagged `dup?`.
3. **Editor tab** — set your total page count, pick a layout per page
   (1 / 2 / 3 / 4 photos), and fill slots either by dragging a photo from the
   left panel or by clicking a slot to open a searchable picker. Click a
   filled slot's star to mark it as the page's "hero" photo, or the × to
   remove it. The page rail along the bottom shows every page at a glance;
   use the ↑/↓ buttons to reorder the current page.
4. **Export tab** — export the photographer's folder (original files, full
   resolution, numbered) and/or generate the PDF preview for yourself. The
   destination folder defaults to `Wedding-Album-Final` created right next to
   your source photos, but you can point it anywhere.

Progress auto-saves to `data/state.json` after every change, and reloads
automatically the next time you start the app.

## Notes

- Supported image types: jpg, jpeg, png, heic, heif, tif, tiff, bmp.
- Thumbnails and PDF preview images are resized/cached under `data/cache/`;
  the photographer export always copies the original, untouched files.
