(() => {
  'use strict';

  let appState = { sourceFolder: null, photos: [], pages: [] };
  let currentPageIndex = 0;
  let pickerTarget = null; // { pageId, slotIndex }
  let slotFileTarget = null; // { pageId, slotIndex }

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  async function api(method, url, body) {
    const isFormData = body instanceof FormData;
    const res = await fetch(url, {
      method,
      headers: body && !isFormData ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? (isFormData ? body : JSON.stringify(body)) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Request failed: ${url}`);
    }
    return data;
  }

  function flashSaved() {
    const el = $('#saveIndicator');
    el.textContent = 'Saved';
    el.style.color = '#3b7a3b';
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(() => { el.textContent = ''; }, 1500);
  }

  function flashError(msg) {
    const el = $('#saveIndicator');
    el.textContent = msg || 'Error';
    el.style.color = '#b3432b';
  }

  // ---------------- Tabs ----------------

  function initTabs() {
    $$('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.tab-btn').forEach((b) => b.classList.remove('active'));
        $$('.tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        $(`#tab-${btn.dataset.tab}`).classList.add('active');
        if (btn.dataset.tab === 'library') renderLibraryTab();
        if (btn.dataset.tab === 'editor') renderEditorTab();
        if (btn.dataset.tab === 'export') renderExportTab();
      });
    });
  }

  // ---------------- Setup ----------------

  function initSetup() {
    $('#sourceFolderInput').value = appState.sourceFolder || '';

    $('#scanBtn').addEventListener('click', async () => {
      const sourceFolder = $('#sourceFolderInput').value.trim();
      if (!sourceFolder) {
        setStatus('#setupStatus', 'Please enter a source folder path.', true);
        return;
      }
      setStatus('#setupStatus', 'Scanning...', false);
      try {
        const data = await api('POST', '/api/setup', { sourceFolder });
        appState = data.state;
        setStatus('#setupStatus', `Found ${data.photoCount} photos.`, false, true);
        renderLibraryTab();
      } catch (err) {
        setStatus('#setupStatus', err.message, true);
      }
    });

    $('#rescanBtn').addEventListener('click', async () => {
      setStatus('#setupStatus', 'Rescanning...', false);
      try {
        const data = await api('POST', '/api/rescan');
        appState = data.state;
        setStatus('#setupStatus', `Rescanned: ${data.photoCount} photos found.`, false, true);
        renderLibraryTab();
        renderEditorTab();
      } catch (err) {
        setStatus('#setupStatus', err.message, true);
      }
    });

    $('#clearLibraryBtn').addEventListener('click', async () => {
      const confirmed = window.confirm(
        'This clears every photo and page this app has cataloged so you can start over. ' +
        'Your real photo files are never touched. Continue?'
      );
      if (!confirmed) return;
      setStatus('#clearLibraryStatus', 'Clearing...', false);
      try {
        const data = await api('POST', '/api/reset');
        appState = data.state;
        currentPageIndex = 0;
        $('#sourceFolderInput').value = '';
        $('#librarySearch').value = '';
        $('#favOnlyToggle').checked = false;
        setStatus('#clearLibraryStatus', 'Library cleared.', false, true);
        renderLibraryTab();
        renderEditorTab();
        renderExportTab();
      } catch (err) {
        setStatus('#clearLibraryStatus', err.message, true);
      }
    });
  }

  function setStatus(sel, msg, isError, isOk) {
    const el = $(sel);
    el.textContent = msg;
    el.className = 'status' + (isError ? ' error' : isOk ? ' ok' : '');
  }

  // ---------------- Photo grid rendering ----------------

  function usedPhotoIds() {
    const used = new Set();
    for (const page of appState.pages) {
      for (const slot of page.slots) {
        if (slot && slot.photoId) used.add(slot.photoId);
      }
    }
    return used;
  }

  function filterPhotos(photos, { search, favOnly, unusedOnly }) {
    const used = unusedOnly ? usedPhotoIds() : null;
    return photos.filter((p) => {
      if (search && !p.filename.toLowerCase().includes(search.toLowerCase())) return false;
      if (favOnly && !p.favorite) return false;
      if (unusedOnly && used.has(p.id)) return false;
      return true;
    });
  }

  function photoCardHtml(photo, { draggable }) {
    return `
      <div class="photo-card ${photo.favorite ? 'favorite' : ''}" data-id="${photo.id}" ${draggable ? 'draggable="true"' : ''}>
        <img src="/api/thumb/${photo.id}" alt="${escapeHtml(photo.filename)}" loading="lazy" />
        <button class="fav-star" title="Toggle favorite" data-action="fav">&#9733;</button>
        ${photo.possibleDuplicate ? '<span class="dup-badge" title="Possible burst/duplicate">dup?</span>' : ''}
        <span class="filename-label">${escapeHtml(photo.filename)}</span>
      </div>`;
  }

  function renderPhotoGrid(container, photos, { draggable, onSelect } = {}) {
    container.innerHTML = photos.map((p) => photoCardHtml(p, { draggable })).join('');
    container.querySelectorAll('.photo-card').forEach((card) => {
      const id = card.dataset.id;
      const photo = appState.photos.find((p) => p.id === id);

      card.querySelector('[data-action="fav"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        await toggleFavorite(photo);
      });

      if (draggable) {
        card.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', id);
        });
      }

      if (onSelect) {
        card.addEventListener('click', () => onSelect(photo));
      }
    });
  }

  async function toggleFavorite(photo) {
    photo.favorite = !photo.favorite;
    try {
      await api('POST', '/api/favorite', { id: photo.id, favorite: photo.favorite });
      flashSaved();
    } catch (err) {
      photo.favorite = !photo.favorite;
      flashError(err.message);
    }
    renderLibraryTab();
    if ($('#tab-editor').classList.contains('active')) renderEditorLibrary();
  }

  // ---------------- Library tab ----------------

  function renderLibraryTab() {
    const search = $('#librarySearch').value;
    const favOnly = $('#favOnlyToggle').checked;
    const filtered = filterPhotos(appState.photos, { search, favOnly });
    $('#libraryCount').textContent = `${filtered.length} of ${appState.photos.length} photos`;
    renderPhotoGrid($('#libraryGrid'), filtered, { draggable: false });
  }

  function initLibraryTab() {
    $('#librarySearch').addEventListener('input', renderLibraryTab);
    $('#favOnlyToggle').addEventListener('change', renderLibraryTab);
  }

  // ---------------- Editor tab ----------------

  function initEditorTab() {
    $('#editorSearch').addEventListener('input', renderEditorLibrary);
    $('#editorFavOnly').addEventListener('change', renderEditorLibrary);
    $('#editorUnusedOnly').addEventListener('change', renderEditorLibrary);

    $('#pageCountInput').addEventListener('change', async (e) => {
      const count = Math.max(0, parseInt(e.target.value, 10) || 0);
      try {
        const data = await api('POST', '/api/pages/count', { count });
        appState.pages = data.pages;
        if (currentPageIndex >= appState.pages.length) currentPageIndex = appState.pages.length - 1;
        if (currentPageIndex < 0) currentPageIndex = 0;
        flashSaved();
      } catch (err) {
        flashError(err.message);
      }
      renderEditorTab();
    });

    $('#layoutPicker').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-layout]');
      if (!btn) return;
      const page = appState.pages[currentPageIndex];
      if (!page) return;
      const layout = parseInt(btn.dataset.layout, 10);
      try {
        const data = await api('PUT', `/api/pages/${page.id}/layout`, { layout });
        appState.pages[currentPageIndex] = data.page;
        flashSaved();
      } catch (err) {
        flashError(err.message);
      }
      renderEditorCanvas();
      renderPageRail();
    });

    $('#pageMoveUp').addEventListener('click', () => movePage('up'));
    $('#pageMoveDown').addEventListener('click', () => movePage('down'));

    $('#pageSizePreset').addEventListener('change', async (e) => {
      if (e.target.value === 'landscape') {
        $('#pageSizeCustomInputs').hidden = true;
        await applyPageSize(11, 8.5);
      } else {
        $('#pageSizeCustomInputs').hidden = false;
        $('#pageSizeWidth').value = appState.pageSize.widthIn;
        $('#pageSizeHeight').value = appState.pageSize.heightIn;
      }
    });
    $('#pageSizeApplyBtn').addEventListener('click', async () => {
      const widthIn = parseFloat($('#pageSizeWidth').value);
      const heightIn = parseFloat($('#pageSizeHeight').value);
      if (!(widthIn > 0) || !(heightIn > 0)) {
        flashError('Enter a valid width and height.');
        return;
      }
      await applyPageSize(widthIn, heightIn);
    });

    $('#pickerClose').addEventListener('click', closePicker);
    $('#pickerModal').addEventListener('click', (e) => {
      if (e.target === $('#pickerModal')) closePicker();
    });
    $('#pickerSearch').addEventListener('input', renderPickerGrid);
    $('#pickerRemoveBtn').addEventListener('click', async () => {
      if (!pickerTarget) return;
      await assignSlot(pickerTarget.pageId, pickerTarget.slotIndex, { remove: true });
      closePicker();
    });

    $('#pickerUploadBtn').addEventListener('click', () => {
      $('#pickerUploadInput').click();
    });
    $('#pickerUploadInput').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;
      const formData = new FormData();
      for (const file of files) formData.append('photos', file);
      setStatus('#pickerUploadStatus', `Adding ${files.length} photo(s)...`, false);
      try {
        const data = await api('POST', '/api/upload', formData);
        appState.photos.push(...data.added);
        setStatus('#pickerUploadStatus', `Added ${data.added.length} photo(s).`, false, true);
        renderPickerGrid();
        renderLibraryTab();
        renderEditorLibrary();
      } catch (err) {
        setStatus('#pickerUploadStatus', err.message, true);
      }
      e.target.value = '';
    });

    $('#slotFileInput').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file || !slotFileTarget) return;
      const { pageId, slotIndex } = slotFileTarget;
      const formData = new FormData();
      formData.append('photos', file);
      setStatus('#slotUploadStatus', 'Adding photo...', false);
      try {
        const data = await api('POST', '/api/upload', formData);
        appState.photos.push(...data.added);
        renderLibraryTab();
        renderEditorLibrary();
        if (data.added[0]) {
          await assignSlot(pageId, slotIndex, { photoId: data.added[0].id });
        }
        setStatus('#slotUploadStatus', '', false);
      } catch (err) {
        setStatus('#slotUploadStatus', err.message, true);
      }
    });

    $('#lightbox').addEventListener('click', () => $('#lightbox').classList.remove('active'));
  }

  async function movePage(direction) {
    const page = appState.pages[currentPageIndex];
    if (!page) return;
    try {
      const data = await api('POST', '/api/pages/move', { pageId: page.id, direction });
      appState.pages = data.pages;
      currentPageIndex = appState.pages.findIndex((p) => p.id === page.id);
      flashSaved();
    } catch (err) {
      flashError(err.message);
    }
    renderEditorTab();
  }

  function syncPageSizeControls() {
    const { widthIn, heightIn } = appState.pageSize || { widthIn: 11, heightIn: 8.5 };
    const isDefaultLandscape = widthIn === 11 && heightIn === 8.5;
    $('#pageSizePreset').value = isDefaultLandscape ? 'landscape' : 'custom';
    $('#pageSizeCustomInputs').hidden = isDefaultLandscape;
    $('#pageSizeWidth').value = widthIn;
    $('#pageSizeHeight').value = heightIn;
  }

  function renderEditorTab() {
    $('#pageCountInput').value = appState.pages.length;
    syncPageSizeControls();
    renderEditorLibrary();
    renderEditorCanvas();
    renderPageRail();
  }

  function renderEditorLibrary() {
    const search = $('#editorSearch').value;
    const favOnly = $('#editorFavOnly').checked;
    const unusedOnly = $('#editorUnusedOnly').checked;
    const filtered = filterPhotos(appState.photos, { search, favOnly, unusedOnly });
    renderPhotoGrid($('#editorLibraryGrid'), filtered, { draggable: true });
  }

  async function applyPageSize(widthIn, heightIn) {
    try {
      const data = await api('POST', '/api/page-size', { widthIn, heightIn });
      appState.pageSize = data.pageSize;
      flashSaved();
    } catch (err) {
      flashError(err.message);
    }
    applyPageSizeToStage();
  }

  function applyPageSizeToStage() {
    const stage = $('#pageStage');
    const { widthIn, heightIn } = appState.pageSize || { widthIn: 11, heightIn: 8.5 };
    stage.style.aspectRatio = `${widthIn} / ${heightIn}`;
  }

  function renderEditorCanvas() {
    applyPageSizeToStage();
    const stage = $('#pageStage');
    const page = appState.pages[currentPageIndex];

    $$('#layoutPicker button').forEach((b) => {
      b.classList.toggle('active', page && parseInt(b.dataset.layout, 10) === page.layout);
    });

    if (!page) {
      stage.innerHTML = '<p class="empty-hint">Set a page count above to start designing your album.</p>';
      return;
    }

    const grid = document.createElement('div');
    grid.className = `page-grid layout-${page.layout}`;

    page.slots.forEach((slot, idx) => {
      const slotEl = document.createElement('div');
      slotEl.className = 'slot' + (slot.photoId ? ' filled' : '');
      slotEl.dataset.slotIndex = idx;

      if (slot.photoId) {
        const photo = appState.photos.find((p) => p.id === slot.photoId);
        const cropStyle = slot.crop
          ? `position:absolute; left:${(-slot.crop.x / slot.crop.w * 100).toFixed(3)}%; top:${(-slot.crop.y / slot.crop.h * 100).toFixed(3)}%; width:${(100 / slot.crop.w).toFixed(3)}%; height:${(100 / slot.crop.h).toFixed(3)}%; object-fit:fill;`
          : '';
        slotEl.innerHTML = `
          ${slot.hero ? '<span class="hero-tag">HERO</span>' : ''}
          <img src="/api/thumb/${slot.photoId}" alt="${photo ? escapeHtml(photo.filename) : ''}" title="Click to view full size" style="${cropStyle}" />
          <div class="slot-actions">
            <button class="slot-crop-btn" title="Adjust crop">&#9986;</button>
            <button class="hero-toggle-btn" title="Toggle hero">${slot.hero ? '&#9733;' : '&#9734;'}</button>
            <button class="slot-library-btn" title="Pick from already-added photos">&#9638;</button>
            <button class="slot-remove-btn" title="Remove photo, then add a new one">&times;</button>
          </div>
        `;
        slotEl.querySelector('.slot-crop-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          openCropEditor(page.id, idx);
        });
        slotEl.querySelector('.hero-toggle-btn').addEventListener('click', async (e) => {
          e.stopPropagation();
          await assignSlot(page.id, idx, { hero: !slot.hero });
        });
        slotEl.querySelector('.slot-library-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          openPicker(page.id, idx);
        });
        slotEl.querySelector('.slot-remove-btn').addEventListener('click', async (e) => {
          e.stopPropagation();
          await assignSlot(page.id, idx, { remove: true });
        });
        slotEl.addEventListener('click', () => openLightbox(slot.photoId));
      } else {
        slotEl.innerHTML = `
          <span class="add-photo-btn">
            + Add Photo
            <button class="browse-library-link">or pick from already-added photos</button>
          </span>
        `;
        slotEl.querySelector('.browse-library-link').addEventListener('click', (e) => {
          e.stopPropagation();
          openPicker(page.id, idx);
        });
        slotEl.addEventListener('click', () => openSlotFileBrowser(page.id, idx));
      }

      slotEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        slotEl.classList.add('drag-over');
      });
      slotEl.addEventListener('dragleave', () => slotEl.classList.remove('drag-over'));
      slotEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        slotEl.classList.remove('drag-over');
        const photoId = e.dataTransfer.getData('text/plain');
        if (photoId) await assignSlot(page.id, idx, { photoId });
      });

      grid.appendChild(slotEl);
    });

    stage.innerHTML = '';
    stage.appendChild(grid);
  }

  function renderPageRail() {
    const rail = $('#pageRail');
    rail.innerHTML = appState.pages.map((page, idx) => {
      const filled = page.slots.some((s) => s.photoId);
      const total = page.slots.length;
      const filledCount = page.slots.filter((s) => s.photoId).length;
      return `<div class="rail-page ${idx === currentPageIndex ? 'current' : ''} ${filled ? 'filled' : ''}" data-idx="${idx}">
        <span>${filledCount}/${total}</span>
        <span class="rail-label">Pg ${idx + 1}</span>
      </div>`;
    }).join('');
    rail.querySelectorAll('.rail-page').forEach((el) => {
      el.addEventListener('click', () => {
        currentPageIndex = parseInt(el.dataset.idx, 10);
        renderEditorCanvas();
        renderPageRail();
      });
    });
  }

  async function assignSlot(pageId, slotIndex, body) {
    try {
      const data = await api('PUT', `/api/pages/${pageId}/slot/${slotIndex}`, body);
      const pageIdx = appState.pages.findIndex((p) => p.id === pageId);
      if (pageIdx !== -1) appState.pages[pageIdx] = data.page;
      flashSaved();
    } catch (err) {
      flashError(err.message);
    }
    renderEditorCanvas();
    renderPageRail();
    renderEditorLibrary();
  }

  // Opens the real OS file-browsing dialog (via a hidden file input) so a
  // slot can be filled directly from anywhere on disk, not just the scanned
  // library. Browsers never expose a real filesystem path for a file picked
  // this way, so the chosen file's bytes are uploaded into this app's own
  // storage first, then placed into the slot like any other photo.
  function openSlotFileBrowser(pageId, slotIndex) {
    slotFileTarget = { pageId, slotIndex };
    setStatus('#slotUploadStatus', '', false);
    $('#slotFileInput').click();
  }

  // ---------------- Photo picker modal ----------------

  function openPicker(pageId, slotIndex) {
    pickerTarget = { pageId, slotIndex };
    const page = appState.pages.find((p) => p.id === pageId);
    const slot = page.slots[slotIndex];
    $('#pickerRemoveBtn').style.display = slot.photoId ? 'inline-block' : 'none';
    $('#pickerSearch').value = '';
    setStatus('#pickerUploadStatus', '', false);
    $('#pickerModal').classList.add('active');
    renderPickerGrid();
  }

  function closePicker() {
    pickerTarget = null;
    $('#pickerModal').classList.remove('active');
  }

  function renderPickerGrid() {
    const search = $('#pickerSearch').value;
    const filtered = filterPhotos(appState.photos, { search });
    renderPhotoGrid($('#pickerGrid'), filtered, {
      draggable: false,
      onSelect: async (photo) => {
        if (!pickerTarget) return;
        await assignSlot(pickerTarget.pageId, pickerTarget.slotIndex, { photoId: photo.id });
        closePicker();
      }
    });
  }

  function openLightbox(photoId) {
    $('#lightboxImg').src = `/api/preview/${photoId}`;
    $('#lightbox').classList.add('active');
  }

  // ---------------- Crop editor ----------------
  // Lets the user pick exactly which rectangle of a photo shows in its slot:
  // drag the rectangle to reposition it, use the zoom slider to resize it.
  // The rectangle's aspect ratio is locked to match the slot's own shape so
  // the result never looks stretched.

  let cropState = null; // { pageId, slotIndex, slotAR, imgW, imgH, cx, cy, zoom }
  let cropDragging = false;
  let cropDragStart = null;

  function computeBaseCropSize(slotAR, imgW, imgH) {
    const imgAR = imgW / imgH;
    if (imgAR > slotAR) {
      return { w: (imgH * slotAR) / imgW, h: 1 };
    }
    return { w: 1, h: (imgW / slotAR) / imgH };
  }

  function currentCropRectFraction() {
    const base = computeBaseCropSize(cropState.slotAR, cropState.imgW, cropState.imgH);
    const w = base.w / cropState.zoom;
    const h = base.h / cropState.zoom;
    const cx = Math.min(1 - w / 2, Math.max(w / 2, cropState.cx));
    const cy = Math.min(1 - h / 2, Math.max(h / 2, cropState.cy));
    cropState.cx = cx;
    cropState.cy = cy;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  function updateCropRectVisual() {
    const img = $('#cropImage');
    const frac = currentCropRectFraction();
    const w = img.offsetWidth;
    const h = img.offsetHeight;
    const rectEl = $('#cropRect');
    rectEl.style.left = `${frac.x * w}px`;
    rectEl.style.top = `${frac.y * h}px`;
    rectEl.style.width = `${frac.w * w}px`;
    rectEl.style.height = `${frac.h * h}px`;
  }

  function openCropEditor(pageId, slotIndex) {
    const page = appState.pages.find((p) => p.id === pageId);
    const slot = page && page.slots[slotIndex];
    if (!slot || !slot.photoId) return;
    const slotEl = document.querySelector(`.page-grid .slot[data-slot-index="${slotIndex}"]`);
    const bounds = slotEl.getBoundingClientRect();
    const slotAR = bounds.width / bounds.height;

    cropState = { pageId, slotIndex, slotAR, imgW: 0, imgH: 0, cx: 0.5, cy: 0.5, zoom: 1 };

    const img = $('#cropImage');
    img.onload = () => {
      cropState.imgW = img.naturalWidth;
      cropState.imgH = img.naturalHeight;
      $('#cropZoom').value = 1;
      updateCropRectVisual();
    };
    img.src = `/api/preview/${slot.photoId}`;
    $('#cropModal').classList.add('active');
  }

  function closeCropEditor() {
    $('#cropModal').classList.remove('active');
    cropState = null;
  }

  function initCropEditor() {
    $('#cropRect').addEventListener('mousedown', (e) => {
      if (!cropState) return;
      cropDragging = true;
      cropDragStart = { x: e.clientX, y: e.clientY, cx: cropState.cx, cy: cropState.cy };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!cropDragging || !cropState) return;
      const img = $('#cropImage');
      const dxFrac = (e.clientX - cropDragStart.x) / img.offsetWidth;
      const dyFrac = (e.clientY - cropDragStart.y) / img.offsetHeight;
      cropState.cx = cropDragStart.cx + dxFrac;
      cropState.cy = cropDragStart.cy + dyFrac;
      updateCropRectVisual();
    });
    window.addEventListener('mouseup', () => { cropDragging = false; });

    $('#cropZoom').addEventListener('input', (e) => {
      if (!cropState) return;
      cropState.zoom = parseFloat(e.target.value);
      updateCropRectVisual();
    });

    $('#cropCancelBtn').addEventListener('click', closeCropEditor);
    $('#cropClose').addEventListener('click', closeCropEditor);
    $('#cropModal').addEventListener('click', (e) => {
      if (e.target === $('#cropModal')) closeCropEditor();
    });
    $('#cropDoneBtn').addEventListener('click', async () => {
      if (!cropState) return;
      const crop = currentCropRectFraction();
      const { pageId, slotIndex } = cropState;
      await assignSlot(pageId, slotIndex, { crop });
      closeCropEditor();
    });
  }

  // ---------------- Export tab ----------------

  function initExportTab() {
    $('#exportPhotographerBtn').addEventListener('click', async () => {
      const baseFolder = $('#destFolderInput').value.trim();
      setStatus('#exportPhotographerStatus', 'Exporting...', false);
      try {
        const data = await api('POST', '/api/export/photographer', { baseFolder });
        setStatus(
          '#exportPhotographerStatus',
          `Done! ${data.photosUsed} photos across ${data.pagesExported} pages exported to ${data.destRoot}`,
          false,
          true
        );
        if (data.exportRecord) appState.exports.unshift(data.exportRecord);
        renderExportsList();
      } catch (err) {
        setStatus('#exportPhotographerStatus', err.message, true);
      }
    });

    $('#exportPdfBtn').addEventListener('click', async () => {
      setStatus('#exportPdfStatus', 'Generating PDF...', false);
      try {
        const data = await api('POST', '/api/export/pdf');
        setStatus('#exportPdfStatus', 'PDF ready, downloading...', false, true);
        window.location = data.downloadUrl;
      } catch (err) {
        setStatus('#exportPdfStatus', err.message, true);
      }
    });

    $('#exportsList').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-delete-export]');
      if (!btn) return;
      const id = btn.dataset.deleteExport;
      const record = appState.exports.find((ex) => ex.id === id);
      const confirmed = window.confirm(
        `Delete the exported folder "${record ? record.folderName : id}" from disk? This only removes that export copy, not your original photos.`
      );
      if (!confirmed) return;
      try {
        await api('DELETE', `/api/exports/${id}`);
        appState.exports = appState.exports.filter((ex) => ex.id !== id);
        renderExportsList();
      } catch (err) {
        flashError(err.message);
      }
    });
  }

  function defaultDestFolder() {
    return appState.sourceFolder || '';
  }

  function renderExportsList() {
    const container = $('#exportsList');
    if (!appState.exports || appState.exports.length === 0) {
      container.innerHTML = '<p class="exports-list-empty">No exports yet.</p>';
      return;
    }
    container.innerHTML = appState.exports.map((ex) => `
      <div class="exports-list-item">
        <div>
          <div>${escapeHtml(ex.folderName)}</div>
          <div class="export-meta">${new Date(ex.createdAt).toLocaleString()} &middot; ${ex.photosUsed} photos across ${ex.pagesExported} pages</div>
        </div>
        <button class="danger" data-delete-export="${ex.id}">Delete</button>
      </div>
    `).join('');
  }

  function renderExportTab() {
    const used = usedPhotoIds();
    $('#exportSummary').textContent =
      `${used.size} of ${appState.photos.length} photos used across ${appState.pages.length} pages.`;
    if (!$('#destFolderInput').value.trim()) {
      $('#destFolderInput').value = defaultDestFolder();
    }
    renderExportsList();
  }

  // ---------------- Init ----------------

  // Dropping a folder/file from the desktop anywhere on the page (e.g. someone
  // dragging their photos folder onto the Setup field, mistaking it for an
  // upload target) would otherwise make the browser navigate away to open
  // it. Block that everywhere except our own in-app photo-card -> slot drops,
  // which already call preventDefault on the specific slot element.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  async function init() {
    initTabs();
    initSetup();
    initLibraryTab();
    initEditorTab();
    initCropEditor();
    initExportTab();

    try {
      appState = await api('GET', '/api/state');
    } catch (err) {
      console.error('Failed to load state', err);
    }
    if (!appState.exports) appState.exports = [];
    if (!appState.pageSize) appState.pageSize = { widthIn: 11, heightIn: 8.5 };

    $('#sourceFolderInput').value = appState.sourceFolder || '';
    $('#destFolderInput').value = defaultDestFolder();
    if (appState.pages.length) currentPageIndex = 0;

    renderLibraryTab();
    renderEditorTab();
    renderExportTab();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
