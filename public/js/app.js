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
        renderHistoryList();
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
        renderHistoryList();
      } catch (err) {
        setStatus('#setupStatus', err.message, true);
      }
    });

    $('#clearLibraryBtn').addEventListener('click', async () => {
      const confirmed = window.confirm(
        'This clears every photo and page this app has cataloged so you can start over. ' +
        'Your real photo files are never touched, and a restore point is saved first. Continue?'
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
        renderHistoryList();
      } catch (err) {
        setStatus('#clearLibraryStatus', err.message, true);
      }
    });

    $('#historyList').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-restore-id]');
      if (!btn) return;
      const id = btn.dataset.restoreId;
      const confirmed = window.confirm(
        'Restore this version? Your current state will be saved as its own restore point first, so this can be undone too.'
      );
      if (!confirmed) return;
      try {
        const data = await api('POST', `/api/history/${id}/restore`);
        appState = data.state;
        currentPageIndex = 0;
        $('#sourceFolderInput').value = appState.sourceFolder || '';
        renderLibraryTab();
        renderEditorTab();
        renderExportTab();
        renderHistoryList();
        flashSaved();
      } catch (err) {
        flashError(err.message);
      }
    });

    renderHistoryList();

    $('#oneDriveSaveClientIdBtn').addEventListener('click', async () => {
      const clientId = $('#oneDriveClientIdInput').value.trim();
      try {
        await api('POST', '/api/onedrive/config', { clientId });
        setStatus('#oneDriveStatus', 'Client ID saved.', false, true);
        renderOneDriveStatus();
      } catch (err) {
        setStatus('#oneDriveStatus', err.message, true);
      }
    });

    $('#oneDriveConnectBtn').addEventListener('click', () => {
      window.location.href = '/auth/onedrive/login';
    });

    $('#oneDriveDisconnectBtn').addEventListener('click', async () => {
      try {
        await api('POST', '/api/onedrive/logout');
        setStatus('#oneDriveStatus', 'Disconnected.', false, true);
        renderOneDriveStatus();
      } catch (err) {
        setStatus('#oneDriveStatus', err.message, true);
      }
    });

    renderOneDriveStatus();
  }

  async function renderOneDriveStatus() {
    try {
      const data = await api('GET', '/api/onedrive/status');
      $('#oneDriveClientIdInput').value = appState.oneDrive && appState.oneDrive.clientId ? appState.oneDrive.clientId : '';
      $('#oneDriveConnectBtn').hidden = data.connected;
      $('#oneDriveConnectBtn').disabled = !data.configured;
      $('#oneDriveDisconnectBtn').hidden = !data.connected;
      if (data.connected) {
        setStatus('#oneDriveStatus', `Connected as ${data.account}.`, false, true);
      } else if (data.configured) {
        setStatus('#oneDriveStatus', 'Client ID saved. Click "Connect OneDrive" to sign in.', false);
      } else {
        setStatus('#oneDriveStatus', 'Not set up yet.', false);
      }
    } catch (err) {
      setStatus('#oneDriveStatus', 'Could not check OneDrive status.', true);
    }
  }

  async function renderHistoryList() {
    const container = $('#historyList');
    try {
      const data = await api('GET', '/api/history');
      if (!data.snapshots || data.snapshots.length === 0) {
        container.innerHTML = '<p class="exports-list-empty">No restore points yet.</p>';
        return;
      }
      container.innerHTML = data.snapshots.map((s) => `
        <div class="exports-list-item history-list-item">
          <div>
            <div>${new Date(s.createdAt).toLocaleString()}</div>
            <div class="export-meta">${s.photoCount} photos, ${s.pageCount} pages${s.sourceFolder ? ' &middot; ' + escapeHtml(s.sourceFolder) : ''}</div>
          </div>
          <button data-restore-id="${s.id}">Restore</button>
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = '<p class="exports-list-empty">Could not load version history.</p>';
    }
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

    $('#layoutGapToggle').addEventListener('change', async (e) => {
      const layoutGap = e.target.checked;
      try {
        const data = await api('POST', '/api/layout-gap', { layoutGap });
        appState.layoutGap = data.layoutGap;
        flashSaved();
      } catch (err) {
        flashError(err.message);
      }
      renderEditorCanvas();
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
    $('#layoutGapToggle').checked = appState.layoutGap !== false;
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

  // Row layout for photo counts that don't use the adjustable-split grid
  // (1-4): each entry lists how many photos sit in each row, left to right,
  // top to bottom, all cells within a row equal width and all rows equal
  // height. Must match LAYOUT_ROWS in server/pages.js exactly.
  const LAYOUT_ROWS = {
    5: [3, 2],
    6: [3, 3],
    7: [4, 3],
    8: [4, 4]
  };

  // A photo dragged out of another browser tab (e.g. onedrive.com) never
  // gives our JS the actual file -- only a URL. Chromium-based browsers
  // carry that as a "DownloadURL" entry formatted "mime:filename:url"
  // (the same mechanism sites use to let you drag a file to your Desktop);
  // text/uri-list and an <img> tag in text/html are fallbacks other sources
  // may use instead. Returns { url, filename } or null if this wasn't an
  // external image drag at all.
  function extractExternalImageDrag(dt) {
    const downloadUrl = dt.getData('DownloadURL');
    if (downloadUrl) {
      const firstColon = downloadUrl.indexOf(':');
      const secondColon = downloadUrl.indexOf(':', firstColon + 1);
      if (firstColon !== -1 && secondColon !== -1) {
        const url = downloadUrl.slice(secondColon + 1);
        const filename = downloadUrl.slice(firstColon + 1, secondColon);
        if (/^https?:\/\//i.test(url)) return { url, filename };
      }
    }
    const uriList = dt.getData('text/uri-list');
    if (uriList) {
      const line = uriList.split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
      if (line && /^https?:\/\//i.test(line)) return { url: line, filename: null };
    }
    const html = dt.getData('text/html');
    if (html) {
      const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (match && /^https?:\/\//i.test(match[1])) return { url: match[1], filename: null };
    }
    const plain = dt.getData('text/plain');
    if (plain && /^https?:\/\//i.test(plain.trim())) return { url: plain.trim(), filename: null };
    return null;
  }

  async function importFileIntoSlot(pageId, slotIndex, file, slotEl) {
    const prevHtml = slotEl.innerHTML;
    slotEl.innerHTML = '<span class="add-photo-btn">Adding photo&hellip;</span>';
    const formData = new FormData();
    formData.append('photos', file);
    try {
      const data = await api('POST', '/api/upload', formData);
      appState.photos.push(...data.added);
      if (data.added[0]) {
        await assignSlot(pageId, slotIndex, { photoId: data.added[0].id });
      } else {
        slotEl.innerHTML = prevHtml;
      }
    } catch (err) {
      slotEl.innerHTML = prevHtml;
      flashError(`Couldn't add that photo: ${err.message}`);
    }
  }

  async function importUrlIntoSlot(pageId, slotIndex, { url, filename }, slotEl) {
    const prevHtml = slotEl.innerHTML;
    slotEl.innerHTML = '<span class="add-photo-btn">Downloading from OneDrive&hellip;</span>';
    try {
      const data = await api('POST', '/api/import-url', { url, filename, pageId, slotIndex });
      appState.photos.push(data.photo);
      if (data.page) {
        const pageIdx = appState.pages.findIndex((p) => p.id === pageId);
        if (pageIdx !== -1) appState.pages[pageIdx] = data.page;
      }
      renderLibraryTab();
      renderEditorLibrary();
      renderEditorCanvas();
      flashSaved();
    } catch (err) {
      slotEl.innerHTML = prevHtml;
      flashError(`Couldn't import that photo: ${err.message}`);
    }
  }

  function buildSlotElement(page, slot, idx) {
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

      // A drag from File Explorer (or any source that hands over a real
      // file) arrives here -- upload it directly, no server round-trip for
      // a URL needed. (OneDrive's own web UI does NOT do this: it only
      // shares internal item references meaningful to other Microsoft 365
      // apps, not an actual file or URL, so dragging straight from
      // onedrive.com can't be supported this way -- see hint text above.)
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        await importFileIntoSlot(page.id, idx, e.dataTransfer.files[0], slotEl);
        return;
      }

      const photoId = e.dataTransfer.getData('text/plain');
      if (photoId && appState.photos.some((p) => p.id === photoId)) {
        await assignSlot(page.id, idx, { photoId });
        return;
      }
      const external = extractExternalImageDrag(e.dataTransfer);
      if (external) await importUrlIntoSlot(page.id, idx, external, slotEl);
    });

    return slotEl;
  }

  function buildRowsContainer(page, slotElements) {
    const rows = LAYOUT_ROWS[page.layout];
    const gapPx = appState.layoutGap ? 10 : 0;
    const outer = document.createElement('div');
    outer.className = 'page-rows';
    outer.style.gap = `${gapPx}px`;
    let idx = 0;
    rows.forEach((count) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'page-row';
      rowEl.style.gap = `${gapPx}px`;
      for (let c = 0; c < count; c++) {
        rowEl.appendChild(slotElements[idx]);
        idx++;
      }
      outer.appendChild(rowEl);
    });
    return outer;
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

    const slotElements = page.slots.map((slot, idx) => buildSlotElement(page, slot, idx));

    stage.innerHTML = '';
    if (LAYOUT_ROWS[page.layout]) {
      stage.appendChild(buildRowsContainer(page, slotElements));
    } else {
      const grid = document.createElement('div');
      grid.className = `page-grid layout-${page.layout}`;
      applyGridTemplate(grid, page);
      slotElements.forEach((el) => grid.appendChild(el));
      stage.appendChild(grid);
      renderSplitDividers(grid, page);
    }
  }

  function applyGridTemplate(grid, page) {
    const gapPx = appState.layoutGap ? 10 : 0;
    grid.style.gap = `${gapPx}px`;
    const s = page.splits;
    if (!s) {
      grid.style.gridTemplateColumns = '1fr';
      grid.style.gridTemplateRows = '1fr';
      return;
    }
    grid.style.gridTemplateColumns = `${s.primary}fr ${1 - s.primary}fr`;
    grid.style.gridTemplateRows = s.secondary !== undefined ? `${s.secondary}fr ${1 - s.secondary}fr` : '1fr';
  }

  function renderSplitDividers(grid, page) {
    if (!page.splits) return;
    const gapPx = appState.layoutGap ? 10 : 0;
    const rect = grid.getBoundingClientRect();

    const vertical = document.createElement('div');
    vertical.className = 'split-divider vertical';
    const leftPx = (rect.width - gapPx) * page.splits.primary + gapPx / 2;
    vertical.style.left = `${(leftPx / rect.width) * 100}%`;
    grid.appendChild(vertical);
    wireDividerDrag(vertical, grid, page, 'primary');

    if (page.splits.secondary !== undefined) {
      const horizontal = document.createElement('div');
      horizontal.className = 'split-divider horizontal';
      const topPx = (rect.height - gapPx) * page.splits.secondary + gapPx / 2;
      horizontal.style.top = `${(topPx / rect.height) * 100}%`;
      if (page.layout === 3) {
        const rightColLeftPx = (rect.width - gapPx) * page.splits.primary + gapPx;
        horizontal.style.left = `${(rightColLeftPx / rect.width) * 100}%`;
        horizontal.style.right = 'auto';
        horizontal.style.width = `${100 - (rightColLeftPx / rect.width) * 100}%`;
      }
      grid.appendChild(horizontal);
      wireDividerDrag(horizontal, grid, page, 'secondary');
    }
  }

  function wireDividerDrag(el, grid, page, axis) {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      el.classList.add('active');
      const rect = grid.getBoundingClientRect();
      const gapPx = appState.layoutGap ? 10 : 0;

      const onMove = (moveEvent) => {
        let frac;
        if (axis === 'primary') {
          frac = (moveEvent.clientX - rect.left - gapPx / 2) / (rect.width - gapPx);
        } else {
          frac = (moveEvent.clientY - rect.top - gapPx / 2) / (rect.height - gapPx);
        }
        frac = Math.min(0.85, Math.max(0.15, frac));
        page.splits[axis] = frac;
        renderEditorCanvas();
      };
      const onUp = async () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        try {
          await api('PUT', `/api/pages/${page.id}/splits`, { [axis]: page.splits[axis] });
          flashSaved();
        } catch (err) {
          flashError(err.message);
        }
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  let railDragSourceIdx = null;

  function renderPageRail() {
    const rail = $('#pageRail');
    rail.innerHTML = appState.pages.map((page, idx) => {
      const filled = page.slots.some((s) => s.photoId);
      const total = page.slots.length;
      const filledCount = page.slots.filter((s) => s.photoId).length;
      return `<div class="rail-page ${idx === currentPageIndex ? 'current' : ''} ${filled ? 'filled' : ''}" data-idx="${idx}" draggable="true">
        <span>${filledCount}/${total}</span>
        <span class="rail-label">Pg ${idx + 1}</span>
      </div>`;
    }).join('');

    rail.querySelectorAll('.rail-page').forEach((el) => {
      el.addEventListener('click', () => {
        if (railDragSourceIdx !== null) return; // ignore the click a drag gesture ends with
        currentPageIndex = parseInt(el.dataset.idx, 10);
        renderEditorCanvas();
        renderPageRail();
      });

      el.addEventListener('dragstart', (e) => {
        railDragSourceIdx = parseInt(el.dataset.idx, 10);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(railDragSourceIdx));
      });

      el.addEventListener('dragover', (e) => {
        if (railDragSourceIdx === null) return;
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const insertAfter = e.clientX - rect.left > rect.width / 2;
        rail.querySelectorAll('.rail-page').forEach((p) => p.classList.remove('drop-before', 'drop-after'));
        el.classList.add(insertAfter ? 'drop-after' : 'drop-before');
      });

      el.addEventListener('drop', async (e) => {
        e.preventDefault();
        const targetIdx = parseInt(el.dataset.idx, 10);
        const rect = el.getBoundingClientRect();
        const insertAfter = e.clientX - rect.left > rect.width / 2;
        el.classList.remove('drop-before', 'drop-after');
        if (railDragSourceIdx === null || railDragSourceIdx === targetIdx) return;
        await reorderPages(railDragSourceIdx, targetIdx, insertAfter);
      });

      el.addEventListener('dragend', () => {
        railDragSourceIdx = null;
        rail.querySelectorAll('.rail-page').forEach((p) => p.classList.remove('drop-before', 'drop-after'));
      });
    });
  }

  async function reorderPages(sourceIdx, targetIdx, insertAfter) {
    const currentPageId = appState.pages[currentPageIndex] ? appState.pages[currentPageIndex].id : null;
    const ids = appState.pages.map((p) => p.id);
    const [movedId] = ids.splice(sourceIdx, 1);
    let insertAt = targetIdx;
    if (sourceIdx < targetIdx) insertAt -= 1;
    if (insertAfter) insertAt += 1;
    ids.splice(insertAt, 0, movedId);

    try {
      const data = await api('POST', '/api/pages/reorder', { order: ids });
      appState.pages = data.pages;
      flashSaved();
    } catch (err) {
      flashError(err.message);
    }
    if (currentPageId) {
      const newIdx = appState.pages.findIndex((p) => p.id === currentPageId);
      if (newIdx !== -1) currentPageIndex = newIdx;
    }
    renderEditorCanvas();
    renderPageRail();
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

  // ---------------- OneDrive browser modal ----------------
  // OneDrive's own web page can't be dragged from directly (see the comment
  // on the slot drop handler above), so this is a real in-app file browser
  // that talks to Microsoft Graph once you've connected your account on the
  // Setup tab: navigate folders, pick photos, download the originals.

  let oneDriveState = null; // { crumbs: [{id, name}], selected: Set<id>, items: [], target: {pageId, slotIndex} | null }

  async function openOneDriveBrowser(pageId, slotIndex) {
    let status;
    try {
      status = await api('GET', '/api/onedrive/status');
    } catch (err) {
      window.alert('Could not check OneDrive status. Is the app still running?');
      return;
    }
    if (!status.connected) {
      window.alert('Connect OneDrive first: go to the Setup tab, save your Client ID, and click "Connect OneDrive".');
      return;
    }
    oneDriveState = {
      crumbs: [{ id: null, name: 'OneDrive' }],
      selected: new Set(),
      items: [],
      target: pageId !== undefined && pageId !== null ? { pageId, slotIndex } : null
    };
    $('#oneDriveModal').classList.add('active');
    await loadOneDriveFolder(null);
  }

  function closeOneDriveModal() {
    $('#oneDriveModal').classList.remove('active');
    oneDriveState = null;
  }

  async function loadOneDriveFolder(folderId) {
    setStatus('#oneDriveModalStatus', 'Loading...', false);
    $('#oneDriveGrid').innerHTML = '';
    try {
      const query = folderId ? `?id=${encodeURIComponent(folderId)}` : '';
      const data = await api('GET', `/api/onedrive/browse${query}`);
      oneDriveState.items = data.items;
      setStatus('#oneDriveModalStatus', '', false);
      renderOneDriveGrid();
    } catch (err) {
      setStatus('#oneDriveModalStatus', err.message, true);
    }
    renderOneDriveBreadcrumbs();
  }

  function renderOneDriveBreadcrumbs() {
    const el = $('#oneDriveBreadcrumbs');
    el.innerHTML = oneDriveState.crumbs.map((c, i) => {
      const isLast = i === oneDriveState.crumbs.length - 1;
      const sep = i > 0 ? '<span class="crumb-sep">/</span>' : '';
      return `${sep}<button data-crumb-idx="${i}" ${isLast ? 'disabled' : ''}>${escapeHtml(c.name)}</button>`;
    }).join('');
    el.querySelectorAll('button[data-crumb-idx]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.crumbIdx, 10);
        oneDriveState.crumbs = oneDriveState.crumbs.slice(0, idx + 1);
        oneDriveState.selected.clear();
        updateOneDriveSelectedCount();
        await loadOneDriveFolder(oneDriveState.crumbs[idx].id);
      });
    });
  }

  function renderOneDriveGrid() {
    const grid = $('#oneDriveGrid');
    grid.innerHTML = oneDriveState.items.map((item) => {
      if (item.isFolder) {
        return `<div class="photo-card onedrive-tile folder" data-id="${item.id}" data-name="${escapeHtml(item.name)}">
          <span>&#128193;</span>
          <span class="folder-name">${escapeHtml(item.name)}</span>
        </div>`;
      }
      const selected = oneDriveState.selected.has(item.id);
      return `<div class="photo-card onedrive-tile photo ${selected ? 'selected' : ''}" data-id="${item.id}">
        <img src="/api/onedrive/thumb/${item.id}" alt="${escapeHtml(item.name)}" loading="lazy" />
        <span class="select-check">&#10003;</span>
      </div>`;
    }).join('');

    grid.querySelectorAll('.onedrive-tile.folder').forEach((tile) => {
      tile.addEventListener('click', async () => {
        oneDriveState.crumbs.push({ id: tile.dataset.id, name: tile.dataset.name });
        await loadOneDriveFolder(tile.dataset.id);
      });
    });
    grid.querySelectorAll('.onedrive-tile.photo').forEach((tile) => {
      tile.addEventListener('click', () => {
        const id = tile.dataset.id;
        if (oneDriveState.selected.has(id)) {
          oneDriveState.selected.delete(id);
          tile.classList.remove('selected');
        } else {
          oneDriveState.selected.add(id);
          tile.classList.add('selected');
        }
        updateOneDriveSelectedCount();
      });
    });
    updateOneDriveSelectedCount();
  }

  function updateOneDriveSelectedCount() {
    const n = oneDriveState.selected.size;
    $('#oneDriveSelectedCount').textContent = n === 0 ? 'No photos selected' : `${n} photo${n === 1 ? '' : 's'} selected`;
  }

  async function importSelectedOneDrivePhotos() {
    if (!oneDriveState || oneDriveState.selected.size === 0) return;
    const itemIds = Array.from(oneDriveState.selected);
    setStatus('#oneDriveModalStatus', `Adding ${itemIds.length} photo(s)...`, false);
    try {
      const body = { itemIds };
      if (oneDriveState.target) {
        body.pageId = oneDriveState.target.pageId;
        body.slotIndex = oneDriveState.target.slotIndex;
      }
      const data = await api('POST', '/api/onedrive/import', body);
      appState.photos.push(...data.added);
      if (data.page) {
        const pageIdx = appState.pages.findIndex((p) => p.id === data.page.id);
        if (pageIdx !== -1) appState.pages[pageIdx] = data.page;
      }
      renderLibraryTab();
      renderEditorLibrary();
      renderEditorCanvas();
      flashSaved();
      closeOneDriveModal();
    } catch (err) {
      setStatus('#oneDriveModalStatus', err.message, true);
    }
  }

  function initOneDriveModal() {
    $('#oneDriveModalClose').addEventListener('click', closeOneDriveModal);
    $('#oneDriveModal').addEventListener('click', (e) => {
      if (e.target === $('#oneDriveModal')) closeOneDriveModal();
    });
    $('#oneDriveImportBtn').addEventListener('click', importSelectedOneDrivePhotos);
    $('#libraryOneDriveBtn').addEventListener('click', () => openOneDriveBrowser());
    $('#pickerOneDriveBtn').addEventListener('click', () => {
      if (!pickerTarget) return;
      const { pageId, slotIndex } = pickerTarget;
      closePicker();
      openOneDriveBrowser(pageId, slotIndex);
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
    const slotEl = document.querySelector(`#pageStage .slot[data-slot-index="${slotIndex}"]`);
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
    initOneDriveModal();

    try {
      appState = await api('GET', '/api/state');
    } catch (err) {
      console.error('Failed to load state', err);
    }
    if (!appState.exports) appState.exports = [];
    if (!appState.pageSize) appState.pageSize = { widthIn: 11, heightIn: 8.5 };
    if (appState.layoutGap === undefined) appState.layoutGap = true;
    if (!appState.oneDrive) appState.oneDrive = { clientId: null };

    $('#sourceFolderInput').value = appState.sourceFolder || '';
    $('#destFolderInput').value = defaultDestFolder();
    if (appState.pages.length) currentPageIndex = 0;

    renderLibraryTab();
    renderEditorTab();
    renderExportTab();
    renderOneDriveStatus();
    handleOneDriveRedirect();
  }

  // After Microsoft redirects back from sign-in, the URL carries
  // ?onedrive=connected (or =error&msg=...) -- show the result and strip
  // those params so a page refresh doesn't re-trigger this message.
  function handleOneDriveRedirect() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('onedrive')) return;
    if (params.get('onedrive') === 'connected') {
      setStatus('#oneDriveStatus', 'Connected!', false, true);
    } else if (params.get('onedrive') === 'error') {
      setStatus('#oneDriveStatus', params.get('msg') || 'OneDrive sign-in failed.', true);
    }
    window.history.replaceState({}, '', window.location.pathname);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
