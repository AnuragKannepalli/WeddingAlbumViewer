(() => {
  'use strict';

  let appState = { sourceFolder: null, photos: [], pages: [] };
  let currentPageIndex = 0;
  let pickerTarget = null; // { pageId, slotIndex }
  let slotFileTarget = null; // { pageId, slotIndex }
  let slotDragSource = null; // { pageId, slotIndex } -- set while dragging a filled slot to rearrange it; cleared on dragend AND the instant any drop reads it (see the slot drop handler)
  let lastEditUndo = null; // { label, run } -- the one most recent undoable edit, see recordUndo()
  let hoveredPhoto = null; // { type: 'slot', pageId, slotIndex } | { type: 'float', pageId, float } -- for the Delete key shortcut

  // Named sheet-size shortcuts shown in the preset dropdown. Keys must
  // match the <option value="..."> in index.html; anything not matching
  // one of these (or not matching its exact width/height) falls back to
  // "Custom size...".
  const PAGE_SIZE_PRESETS = {
    landscape: { widthIn: 11, heightIn: 8.5 },
    portrait: { widthIn: 8.5, heightIn: 11 },
    '14x11': { widthIn: 14, heightIn: 11 },
    '11x14': { widthIn: 11, heightIn: 14 },
    '12x12': { widthIn: 12, heightIn: 12 },
    '10x10': { widthIn: 10, heightIn: 10 },
    '8x8': { widthIn: 8, heightIn: 8 },
    'a4-landscape': { widthIn: 11.7, heightIn: 8.3 },
    'a4-portrait': { widthIn: 8.3, heightIn: 11.7 }
  };

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
        mergeActiveProjectState(data.state);
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
        mergeActiveProjectState(data.state);
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
        'This clears every photo and page in this album so you can start over (other albums are untouched). ' +
        'Your real photo files are never touched, and a restore point is saved first. Continue?'
      );
      if (!confirmed) return;
      setStatus('#clearLibraryStatus', 'Clearing...', false);
      try {
        const data = await api('POST', '/api/reset');
        mergeActiveProjectState(data.state);
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
        await api('POST', `/api/history/${id}/restore`);
        // Re-fetch rather than trust the restore response directly: a
        // snapshot can predate multi-project support, or predate whichever
        // album was active when it was taken, so re-reading /api/state is
        // what correctly re-derives the full picture (including which
        // album is now active) in every case.
        appState = await api('GET', '/api/state');
        normalizeAppState();
        showMainApp();
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
            <div class="export-meta">${s.projectCount} album${s.projectCount === 1 ? '' : 's'} &middot; ${s.photoCount} photos, ${s.pageCount} pages total</div>
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

  // Every slot/float placement of every photo, across every page -- the one
  // source of truth for "is this photo used, and where." A photoId with 2+
  // entries means the same library photo was placed in more than one spot,
  // easy to do by accident in an album with hundreds of photos to recall.
  function photoUsageMap() {
    const map = new Map(); // photoId -> [{ pageIndex, pageId, type: 'slot'|'float', slotIndex, floatId }]
    appState.pages.forEach((page, pageIndex) => {
      page.slots.forEach((slot, slotIndex) => {
        if (!slot || !slot.photoId) return;
        if (!map.has(slot.photoId)) map.set(slot.photoId, []);
        map.get(slot.photoId).push({ pageIndex, pageId: page.id, type: 'slot', slotIndex });
      });
      (page.floats || []).forEach((float) => {
        if (!float.photoId) return;
        if (!map.has(float.photoId)) map.set(float.photoId, []);
        map.get(float.photoId).push({ pageIndex, pageId: page.id, type: 'float', floatId: float.id });
      });
    });
    return map;
  }

  function usedPhotoIds() {
    return new Set(photoUsageMap().keys());
  }

  // Jumps to the next place (after this one, wrapping around) the same
  // photo is used -- repeated clicks cycle through every occurrence, not
  // just back and forth between two.
  function jumpToOtherUsage(photoId, current) {
    const locations = photoUsageMap().get(photoId) || [];
    if (locations.length < 2) return;
    const currentIdx = current
      ? locations.findIndex((l) => l.pageId === current.pageId && l.type === current.type &&
          (current.type === 'slot' ? l.slotIndex === current.slotIndex : l.floatId === current.floatId))
      : -1;
    const next = locations[(currentIdx + 1) % locations.length];
    jumpToPage(next.pageIndex + 1);
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

  function photoCardHtml(photo, { draggable, selectable, selected, usageCount }) {
    return `
      <div class="photo-card ${photo.favorite ? 'favorite' : ''} ${selectable ? 'selectable' : ''} ${selected ? 'selected' : ''}" data-id="${photo.id}" ${draggable ? 'draggable="true"' : ''}>
        ${selectable ? `<label class="select-check-overlay"><input type="checkbox" data-action="select" ${selected ? 'checked' : ''} /></label>` : ''}
        <img src="/api/thumb/${photo.id}" alt="${escapeHtml(photo.filename)}" loading="lazy" />
        <button class="fav-star" title="Toggle favorite" data-action="fav">&#9733;</button>
        ${photo.possibleDuplicate ? '<span class="dup-badge" title="Possible burst/duplicate">dup?</span>' : ''}
        ${usageCount > 1 ? `<span class="placed-badge" title="Already placed ${usageCount} times in the album">Used &times;${usageCount}</span>` : ''}
        <span class="filename-label">${escapeHtml(photo.filename)}</span>
      </div>`;
  }

  function renderPhotoGrid(container, photos, { draggable, onSelect, selectable, selection } = {}) {
    const usageMap = photoUsageMap();
    container.innerHTML = photos.map((p) => photoCardHtml(p, {
      draggable, selectable, selected: !!(selection && selection.has(p.id)),
      usageCount: (usageMap.get(p.id) || []).length
    })).join('');
    container.querySelectorAll('.photo-card').forEach((card) => {
      const id = card.dataset.id;
      const photo = appState.photos.find((p) => p.id === id);

      card.querySelector('[data-action="fav"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        await toggleFavorite(photo);
      });

      if (draggable) {
        card.addEventListener('dragstart', (e) => {
          // A drag starting fresh from the library is never a slot
          // rearrange, regardless of any leftover slotDragSource from an
          // earlier slot-to-slot drag whose dragend didn't fire (e.g. its
          // origin slot got removed from the DOM by a re-render mid-drag).
          slotDragSource = null;
          e.dataTransfer.setData('text/plain', id);
        });
      }

      if (selectable) {
        const checkbox = card.querySelector('[data-action="select"]');
        const toggle = () => {
          if (selection.has(id)) selection.delete(id); else selection.add(id);
          card.classList.toggle('selected', selection.has(id));
          checkbox.checked = selection.has(id);
          updateLibrarySelectionBar();
        };
        checkbox.addEventListener('click', (e) => {
          e.stopPropagation();
          toggle();
        });
        card.addEventListener('click', (e) => {
          // The checkbox's own click handler (above) already toggled this
          // -- including a click that lands on the <label> wrapping it,
          // which dispatches its own separate bubbling click here too --
          // so skip to avoid toggling twice (which would cancel itself out).
          if (e.target.closest('[data-action="fav"]') || e.target.closest('.select-check-overlay')) return;
          toggle();
        });
      } else if (onSelect) {
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

  let librarySelection = new Set();

  function renderLibraryTab() {
    const search = $('#librarySearch').value;
    const favOnly = $('#favOnlyToggle').checked;
    const filtered = filterPhotos(appState.photos, { search, favOnly });
    $('#libraryCount').textContent = `${filtered.length} of ${appState.photos.length} photos`;
    // Drop selected ids that are no longer in view (filtered out, or the
    // photo itself is gone), so bulk actions never act on something unseen.
    const visibleIds = new Set(filtered.map((p) => p.id));
    for (const id of librarySelection) {
      if (!visibleIds.has(id)) librarySelection.delete(id);
    }
    renderPhotoGrid($('#libraryGrid'), filtered, { draggable: false, selectable: true, selection: librarySelection });
    updateLibrarySelectionBar();
  }

  function updateLibrarySelectionBar() {
    const n = librarySelection.size;
    $('#librarySelectionBar').hidden = n === 0;
    $('#librarySelectionCount').textContent = `${n} selected`;
  }

  async function bulkSetFavorite(value) {
    const ids = Array.from(librarySelection);
    if (ids.length === 0) return;
    for (const id of ids) {
      const photo = appState.photos.find((p) => p.id === id);
      if (photo) photo.favorite = value;
    }
    try {
      await Promise.all(ids.map((id) => api('POST', '/api/favorite', { id, favorite: value })));
      flashSaved();
    } catch (err) {
      flashError(err.message);
    }
    renderLibraryTab();
    if ($('#tab-editor').classList.contains('active')) renderEditorLibrary();
  }

  async function bulkDeletePhotos() {
    const ids = Array.from(librarySelection);
    if (ids.length === 0) return;
    const confirmed = window.confirm(
      `Remove ${ids.length} photo(s) from this album's library? Any slot or floating photo using one of them will go back to empty. ` +
      'A restore point is saved first, so this can be undone from Version History on the Setup tab.'
    );
    if (!confirmed) return;
    try {
      const data = await api('POST', '/api/photos/delete', { ids });
      appState.photos = data.photos;
      appState.pages = data.pages;
      librarySelection.clear();
      flashSaved();
    } catch (err) {
      flashError(err.message);
      return;
    }
    renderLibraryTab();
    renderEditorTab();
  }

  function initLibraryTab() {
    $('#librarySearch').addEventListener('input', renderLibraryTab);
    $('#favOnlyToggle').addEventListener('change', renderLibraryTab);
    $('#selFavBtn').addEventListener('click', () => bulkSetFavorite(true));
    $('#selUnfavBtn').addEventListener('click', () => bulkSetFavorite(false));
    $('#selDeleteBtn').addEventListener('click', bulkDeletePhotos);
    $('#selClearBtn').addEventListener('click', () => {
      librarySelection.clear();
      renderLibraryTab();
    });
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

    $('#layoutPickerBtn').addEventListener('click', () => openLayoutModal());
    $('#layoutModalClose').addEventListener('click', closeLayoutModal);
    $('#layoutModal').addEventListener('click', (e) => {
      if (e.target === $('#layoutModal')) closeLayoutModal();
    });

    $('#pageMoveUp').addEventListener('click', () => movePage('up'));
    $('#pageMoveDown').addEventListener('click', () => movePage('down'));
    $('#pageDuplicateBtn').addEventListener('click', () => duplicatePage());
    $('#undoLastEditBtn').addEventListener('click', () => runLastEditUndo());
    $('#pageDeleteBtn').addEventListener('click', () => {
      const page = appState.pages[currentPageIndex];
      if (page) deletePage(page.id);
    });

    $$('#pageShapeOptions .crop-shape-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        const shape = btn.dataset.shape === 'none' ? null : btn.dataset.shape;
        applyPageStyle({ shape });
      });
    });
    $('#pageMirrorAllBtn').addEventListener('click', () => applyPageStyle({ mirrored: true }));

    $('#jumpToPageInput').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      jumpToPage(parseInt(e.target.value, 10));
    });
    $('#jumpToPageInput').addEventListener('blur', (e) => {
      if (e.target.value) jumpToPage(parseInt(e.target.value, 10));
    });

    $('#addFloatBtn').addEventListener('click', () => {
      const page = appState.pages[currentPageIndex];
      if (!page) return;
      openPicker(page.id, null, true);
    });

    wirePageStageFloatDrop();

    $('#pageSizePreset').addEventListener('change', async (e) => {
      const preset = PAGE_SIZE_PRESETS[e.target.value];
      if (preset) {
        $('#pageSizeCustomInputs').hidden = true;
        await applyPageSize(preset.widthIn, preset.heightIn);
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
      // Uploaded in small batches (rather than all in one request) so
      // there's real "N of Y" progress to show for a big selection, and
      // photos already copied show up in the grid right away instead of
      // only after everything finishes.
      const BATCH_SIZE = 5;
      const allAdded = [];
      try {
        for (let i = 0; i < files.length; i += BATCH_SIZE) {
          const batch = files.slice(i, i + BATCH_SIZE);
          const upTo = Math.min(i + BATCH_SIZE, files.length);
          setStatus('#pickerUploadStatus', `Adding photo ${i + 1}-${upTo} of ${files.length}...`, false);
          const formData = new FormData();
          for (const file of batch) formData.append('photos', file);
          const data = await api('POST', '/api/upload', formData);
          allAdded.push(...data.added);
          appState.photos.push(...data.added);
          renderPickerGrid();
          renderLibraryTab();
          renderEditorLibrary();
        }
        setStatus('#pickerUploadStatus', `Added ${allAdded.length} photo(s).`, false, true);
      } catch (err) {
        setStatus('#pickerUploadStatus', `${err.message} (${allAdded.length} of ${files.length} added before this)`, true);
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

  async function duplicatePage() {
    const page = appState.pages[currentPageIndex];
    if (!page) return;
    try {
      const data = await api('POST', `/api/pages/${page.id}/duplicate`, {});
      appState.pages = data.pages;
      currentPageIndex = appState.pages.findIndex((p) => p.id === data.newPageId);
      flashSaved();
    } catch (err) {
      flashError(err.message);
    }
    $('#pageCountInput').value = appState.pages.length;
    renderEditorCanvas();
    renderPageRail();
  }

  // Applies one shape and/or mirrored setting to every filled photo on the
  // current page in a single call -- the "whole page at once" counterpart
  // to picking a shape/mirror for one photo at a time in the Edit modal.
  async function applyPageStyle(body) {
    const page = appState.pages[currentPageIndex];
    if (!page) return;
    try {
      const data = await api('PUT', `/api/pages/${page.id}/bulk-style`, body);
      const pageIdx = appState.pages.findIndex((p) => p.id === page.id);
      if (pageIdx !== -1) appState.pages[pageIdx] = data.page;
      flashSaved();
    } catch (err) {
      flashError(err.message);
    }
    renderEditorCanvas();
  }

  function jumpToPage(pageNumber) {
    if (!appState.pages.length || isNaN(pageNumber)) return;
    const idx = Math.min(appState.pages.length, Math.max(1, pageNumber)) - 1;
    currentPageIndex = idx;
    renderEditorCanvas();
    renderPageRail();
    const target = $(`.rail-page[data-idx="${idx}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  function syncPageSizeControls() {
    const { widthIn, heightIn } = appState.pageSize || { widthIn: 11, heightIn: 8.5 };
    const matchedPreset = Object.keys(PAGE_SIZE_PRESETS).find(
      (key) => PAGE_SIZE_PRESETS[key].widthIn === widthIn && PAGE_SIZE_PRESETS[key].heightIn === heightIn
    );
    $('#pageSizePreset').value = matchedPreset || 'custom';
    $('#pageSizeCustomInputs').hidden = !!matchedPreset;
    $('#pageSizeWidth').value = widthIn;
    $('#pageSizeHeight').value = heightIn;
  }

  function renderEditorTab() {
    $('#pageCountInput').value = appState.pages.length;
    $('#layoutGapToggle').checked = appState.layoutGap !== false;
    $('#jumpToPageInput').max = appState.pages.length;
    if (appState.pages.length) $('#jumpToPageInput').value = currentPageIndex + 1;
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

  // Row layout for the simplest "equal cells" photo counts: each entry
  // lists how many photos sit in each row, left to right, top to bottom,
  // all cells within a row equal width and all rows equal height. Must
  // match LAYOUT_ROWS in server/pages.js exactly.
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

  // Structural description for the more varied layout templates: the page
  // splits in two along one axis at an adjustable ratio, and each side
  // holds a single photo, an equal stack of photos, or a small equal grid
  // -- or, for "equalCols", the whole page is just N equal columns with no
  // split. Must match LAYOUT_REGION_DEFS in server/pages.js exactly.
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

  // Every selectable layout, grouped by photo count, in picker display
  // order. Must match LAYOUT_CATALOG in server/pages.js exactly.
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

  function buildSlotElement(page, slot, idx, stage, usageMap) {
    const slotEl = document.createElement('div');
    slotEl.className = 'slot' + (slot.photoId ? ' filled' : '');
    slotEl.dataset.slotIndex = idx;

    if (slot.photoId) {
      const photo = appState.photos.find((p) => p.id === slot.photoId);
      const isFreeCrop = slot.crop && slot.crop.mode === 'free';
      const cropStyle = (slot.crop && !isFreeCrop
        ? `position:absolute; left:${(-slot.crop.x / slot.crop.w * 100).toFixed(3)}%; top:${(-slot.crop.y / slot.crop.h * 100).toFixed(3)}%; width:${(100 / slot.crop.w).toFixed(3)}%; height:${(100 / slot.crop.h).toFixed(3)}%; object-fit:fill;`
        : '') + photoTransformStyle(slot.mirrored, slot.rotation);
      const imgSrc = isFreeCrop
        ? `/api/crop-preview/${slot.photoId}?x=${slot.crop.x}&y=${slot.crop.y}&w=${slot.crop.w}&h=${slot.crop.h}`
        : `/api/thumb/${slot.photoId}`;
      const usageLocations = (usageMap && usageMap.get(slot.photoId)) || [];
      const usedElsewhere = usageLocations.length > 1;
      slotEl.innerHTML = `
        ${slot.hero ? '<span class="hero-tag">HERO</span>' : ''}
        <div class="photo-clip shape-${slot.shape || 'none'}">
          <img src="${imgSrc}" alt="${photo ? escapeHtml(photo.filename) : ''}" title="Click to view full size" style="${cropStyle}" />
        </div>
        ${usedElsewhere ? `<button class="usage-badge" title="This photo is used ${usageLocations.length} times in the album -- click to jump to the next spot">&#9888; &times;${usageLocations.length}</button>` : ''}
        <div class="slot-actions">
          <button class="slot-crop-btn" title="Edit">&#9986;</button>
          <button class="hero-toggle-btn" title="Toggle hero">${slot.hero ? '&#9733;' : '&#9734;'}</button>
          <button class="slot-library-btn" title="Pick from already-added photos">&#9638;</button>
          <button class="slot-remove-btn" title="Remove photo, then add a new one">&times;</button>
        </div>
      `;
      if (usedElsewhere) {
        slotEl.querySelector('.usage-badge').addEventListener('click', (e) => {
          e.stopPropagation();
          jumpToOtherUsage(slot.photoId, { pageId: page.id, type: 'slot', slotIndex: idx });
        });
      }
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

      // Tracks which photo the mouse is over so the Delete key (see
      // initKeyboardShortcuts) knows what to remove without needing a
      // separate click-to-select state.
      const slotHoverTarget = { type: 'slot', pageId: page.id, slotIndex: idx };
      slotEl.addEventListener('mouseenter', () => { hoveredPhoto = slotHoverTarget; });
      slotEl.addEventListener('mouseleave', () => {
        if (hoveredPhoto === slotHoverTarget) hoveredPhoto = null;
      });

      // Without this, dragging a filled slot's <img> falls back to the
      // browser's native "drag this image out" behavior (since <img>
      // elements are draggable by default), which our drop handler then
      // misreads as an external image link and re-downloads/imports as a
      // brand-new duplicate photo -- not a rearrange. Explicitly owning the
      // drag makes it carry our own photoId instead, like a library card.
      slotEl.draggable = true;
      slotEl.addEventListener('dragstart', (e) => {
        slotDragSource = { pageId: page.id, slotIndex: idx };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', slot.photoId);
      });
      slotEl.addEventListener('dragend', () => { slotDragSource = null; });
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
      // A slot always fully handles its own drop -- stop it from also
      // bubbling up to the page-stage's drop handler (which would otherwise
      // additionally add the same photo as a floating photo).
      e.stopPropagation();
      slotEl.classList.remove('drag-over');

      // Check for a recognized in-app photo FIRST, before even looking at
      // dataTransfer.files. Dragging a filled slot's own <img> (or a
      // library card's <img>) is purely an in-page drag, but some browsers
      // (Chrome at least) ALSO populate dataTransfer.files with a synthetic
      // image file for that gesture, the same way they would for a real
      // drop from outside the browser -- so files.length > 0 alone can't
      // tell a genuine external file apart from this. A real external drop
      // never carries a text/plain payload matching one of our own photo
      // ids, so checking that first is unambiguous either way.
      const photoId = e.dataTransfer.getData('text/plain');
      const isKnownPhoto = photoId && appState.photos.some((p) => p.id === photoId);

      if (!isKnownPhoto && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        // A drag from File Explorer (or any source that hands over a real
        // file) arrives here -- upload it directly, no server round-trip
        // for a URL needed. (OneDrive's own web UI does NOT do this: it
        // only shares internal item references meaningful to other
        // Microsoft 365 apps, not an actual file or URL, so dragging
        // straight from onedrive.com can't be supported this way -- see
        // hint text above.)
        await importFileIntoSlot(page.id, idx, e.dataTransfer.files[0], slotEl);
        return;
      }

      if (isKnownPhoto) {
        // slotDragSource is consumed (cleared) the instant it's read here,
        // not only later on dragend -- so even if dragend never fires on
        // its origin slot (e.g. that element got removed from the DOM by a
        // re-render before the drag concluded), a stale value can only
        // ever affect this one drop, never linger to misinterpret a later,
        // unrelated one.
        const slotSource = slotDragSource;
        slotDragSource = null;
        if (slotSource && slotSource.pageId === page.id && slotSource.slotIndex !== idx) {
          // Dragged from another slot on this same page -- rearrange (swap
          // whichever photo is already here, if any, back into the source
          // slot) rather than just overwriting this one.
          await swapSlots(page.id, slotSource.slotIndex, idx);
        } else {
          await assignSlot(page.id, idx, { photoId });
        }
        return;
      }
      const external = extractExternalImageDrag(e.dataTransfer);
      if (external) await importUrlIntoSlot(page.id, idx, external, slotEl);
    });

    appendResizeHandles(slotEl);
    wireSlotResize(slotEl, stage, page, idx);

    return slotEl;
  }

  // Shared by slots and floats: the CSS transform for a photo's mirror/
  // rotation state, composed so mirroring happens first (in the photo's own
  // space) and rotation second -- matching the order server/pdfExporter.js
  // uses for the PDF export, so the preview and the printed result agree.
  function photoTransformStyle(mirrored, rotation) {
    const parts = [];
    if (rotation) parts.push(`rotate(${rotation}deg)`);
    if (mirrored) parts.push('scaleX(-1)');
    return parts.length ? ` transform:${parts.join(' ')};` : '';
  }

  // Shared by both floating photos and free-form slot resizing: 8 drag
  // handles (4 corners + 4 edge midpoints) around a box, so any side can be
  // pulled to resize it, not just the bottom-right corner.
  const RESIZE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  function appendResizeHandles(el) {
    RESIZE_DIRS.forEach((dir) => {
      const h = document.createElement('div');
      h.className = `resize-handle resize-${dir}`;
      h.dataset.dir = dir;
      h.title = 'Drag to resize';
      // A click with no movement in between still fires a 'click' after the
      // mousedown/mouseup below -- stop it from bubbling to the slot/tile's
      // own click handler (e.g. a slot opens the lightbox on click).
      h.addEventListener('click', (e) => e.stopPropagation());
      el.appendChild(h);
    });
  }

  // Free (non-aspect-locked) resize of a rect {x,y,w,h} from whichever
  // edge(s) `dir` names, clamped to stay within the [0,1] content box --
  // used for slots, where the photo inside just letterboxes/covers to fit
  // whatever box shape you drag out, unlike a floating photo's fixed frame.
  function resizeRectFree(start, dir, dxFrac, dyFrac, minSize) {
    let { x, y, w, h } = start;
    if (dir.includes('e')) w = Math.max(minSize, start.w + dxFrac);
    if (dir.includes('w')) { w = Math.max(minSize, start.w - dxFrac); x = start.x + start.w - w; }
    if (dir.includes('s')) h = Math.max(minSize, start.h + dyFrac);
    if (dir.includes('n')) { h = Math.max(minSize, start.h - dyFrac); y = start.y + start.h - h; }
    x = Math.max(0, Math.min(x, 1 - w));
    y = Math.max(0, Math.min(y, 1 - h));
    w = Math.min(w, 1 - x);
    h = Math.min(h, 1 - y);
    return { x, y, w, h };
  }

  // Aspect-locked resize of a rect {x,y,w,h} from whichever edge/corner
  // `dir` names, keeping w/h at `aspectWPerH` throughout -- used for
  // floating photos, which (per their existing single-handle resize) never
  // stretch the photo out of its own proportions. The edge/corner opposite
  // the one being dragged stays anchored in place; for a pure edge handle
  // (no coupled corner), the perpendicular axis stays centered instead.
  function computeAspectResize(start, dir, dxFrac, dyFrac, aspectWPerH, minSize) {
    let w = start.w;
    let h = start.h;
    if (dir === 'n' || dir === 's') {
      h = dir === 's' ? start.h + dyFrac : start.h - dyFrac;
      h = Math.max(minSize, h);
      w = h * aspectWPerH;
    } else {
      w = dir.includes('e') ? start.w + dxFrac : start.w - dxFrac;
      w = Math.max(minSize, w);
      h = w / aspectWPerH;
    }
    if (h < minSize) { h = minSize; w = h * aspectWPerH; }

    const cx = start.x + start.w / 2;
    const cy = start.y + start.h / 2;
    let x = dir.includes('w') ? start.x + start.w - w : dir.includes('e') ? start.x : cx - w / 2;
    let y = dir.includes('n') ? start.y + start.h - h : dir.includes('s') ? start.y : cy - h / 2;
    return { x, y, w, h };
  }

  // Once any slot on a page has a stored `rect`, the whole page renders from
  // those fractions (of the content box) instead of the named-template grid
  // -- every slot must have a rect by that point (seeded all at once, see
  // wireSlotResize), so a missing one here just falls back to the full box.
  function buildCustomRectContainer(page, slotElements) {
    const outer = document.createElement('div');
    outer.className = 'page-custom-rects';
    page.slots.forEach((slot, i) => {
      const el = slotElements[i];
      const rect = slot.rect || { x: 0, y: 0, w: 1, h: 1 };
      el.style.left = `${rect.x * 100}%`;
      el.style.top = `${rect.y * 100}%`;
      el.style.width = `${rect.w * 100}%`;
      el.style.height = `${rect.h * 100}%`;
      outer.appendChild(el);
    });
    return outer;
  }

  // Reads each currently-rendered slot's on-screen box (under whichever
  // named-template layout is active right now) as a fraction of the overall
  // layout container, so a free-form resize can seed every slot's starting
  // rect without jumping -- works for any layout shape (grid/rows/region)
  // since it just looks for .slot elements wherever they ended up.
  function measureCurrentSlotRects(stage) {
    const layoutBox = stage.querySelector('.page-grid, .page-rows, .page-region-split, .page-equal-cols');
    if (!layoutBox) return null;
    const boxRect = layoutBox.getBoundingClientRect();
    if (!boxRect.width || !boxRect.height) return null;
    const rects = [];
    layoutBox.querySelectorAll('.slot').forEach((el) => {
      const idx = parseInt(el.dataset.slotIndex, 10);
      const r = el.getBoundingClientRect();
      rects[idx] = {
        x: (r.left - boxRect.left) / boxRect.width,
        y: (r.top - boxRect.top) / boxRect.height,
        w: r.width / boxRect.width,
        h: r.height / boxRect.height
      };
    });
    return rects;
  }

  // After resizing `movedIdx`'s rect (from any side, not just its bottom-
  // right corner), shrinks any other slot it now overlaps just enough to
  // clear the overlap -- pulling in whichever of the neighbor's edges faces
  // the moved slot (decided by comparing centers, since the moved slot can
  // now have encroached from any direction, not just grown right/down).
  // Neighbors further away are left untouched, so a shrink never cascades
  // and the vacated space is simply left as empty page -- matches floats,
  // which likewise never resize each other.
  function resolveSlotOverlaps(page, movedIdx) {
    const MIN = 0.05;
    const moved = page.slots[movedIdx].rect;
    const movedCx = moved.x + moved.w / 2;
    const movedCy = moved.y + moved.h / 2;
    page.slots.forEach((s, i) => {
      if (i === movedIdx || !s.rect) return;
      const other = s.rect;
      const overlapX = Math.min(moved.x + moved.w, other.x + other.w) - Math.max(moved.x, other.x);
      const overlapY = Math.min(moved.y + moved.h, other.y + other.h) - Math.max(moved.y, other.y);
      if (overlapX <= 0 || overlapY <= 0) return;
      const otherCx = other.x + other.w / 2;
      const otherCy = other.y + other.h / 2;
      if (overlapX <= overlapY) {
        if (otherCx >= movedCx) {
          const newX = moved.x + moved.w;
          other.w = Math.max(MIN, other.x + other.w - newX);
          other.x = newX;
        } else {
          other.w = Math.max(MIN, moved.x - other.x);
        }
      } else if (otherCy >= movedCy) {
        const newY = moved.y + moved.h;
        other.h = Math.max(MIN, other.y + other.h - newY);
        other.y = newY;
      } else {
        other.h = Math.max(MIN, moved.y - other.y);
      }
    });
  }

  // Lets a slot grow (or shrink) past its template-assigned box from any of
  // its 8 drag handles, same mechanic as a floating photo's resize handles
  // -- the first drag on a page "graduates" it out of the grid (see
  // buildCustomRectContainer), seeding every slot's current position so
  // nothing else jumps.
  function wireSlotResize(slotEl, stage, page, idx) {
    slotEl.querySelectorAll('.resize-handle').forEach((handle) => {
      const dir = handle.dataset.dir;
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Resolve the current page object fresh (not the one closed over
        // from whichever render pass created this element) -- another edit
        // made since then (a crop, a hero toggle) may have already swapped
        // appState.pages[idx] for a new object from the server.
        const livePage = appState.pages.find((p) => p.id === page.id);
        if (!livePage) return;

        if (!livePage.slots.some((s) => s.rect)) {
          const measured = measureCurrentSlotRects(stage);
          if (!measured) return;
          livePage.slots.forEach((s, i) => { s.rect = measured[i] || { x: 0, y: 0, w: 1, h: 1 }; });
          renderEditorCanvas();
        }

        const layoutBox = stage.querySelector('.page-custom-rects');
        const curSlotEl = stage.querySelector(`.slot[data-slot-index="${idx}"]`);
        if (!layoutBox || !curSlotEl) return;
        const boxRect = layoutBox.getBoundingClientRect();
        const start = { ...livePage.slots[idx].rect };
        const startX = e.clientX;
        const startY = e.clientY;
        const MIN = 0.06;

        const onMove = (moveEvent) => {
          const dxFrac = (moveEvent.clientX - startX) / boxRect.width;
          const dyFrac = (moveEvent.clientY - startY) / boxRect.height;
          const next = resizeRectFree(start, dir, dxFrac, dyFrac, MIN);
          livePage.slots[idx].rect = next;
          curSlotEl.style.left = `${next.x * 100}%`;
          curSlotEl.style.top = `${next.y * 100}%`;
          curSlotEl.style.width = `${next.w * 100}%`;
          curSlotEl.style.height = `${next.h * 100}%`;
        };
        const onUp = async () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          resolveSlotOverlaps(livePage, idx);
          try {
            const data = await api('PUT', `/api/pages/${livePage.id}/slots/rects`, {
              rects: livePage.slots.map((s) => s.rect || null)
            });
            const pageIdx = appState.pages.findIndex((p) => p.id === livePage.id);
            if (pageIdx !== -1) appState.pages[pageIdx] = data.page;
            flashSaved();
          } catch (err) {
            flashError(err.message);
          }
          renderEditorCanvas();
          renderPageRail();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
    });
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

  // Builds one of the LAYOUT_REGION_DEFS shapes: either a fixed row of N
  // equal columns with no divider, or two regions split along one axis at
  // an adjustable ratio (draggable, same mechanic as layouts 2-4), where
  // each region is a single slot, an equal stack, or a small equal grid.
  function buildRegionLayoutContainer(page, slotElements) {
    const def = LAYOUT_REGION_DEFS[page.layout];
    const gapPx = appState.layoutGap ? 10 : 0;

    if (def.equalCols) {
      const outer = document.createElement('div');
      outer.className = 'page-equal-cols';
      outer.style.display = 'flex';
      outer.style.gap = `${gapPx}px`;
      outer.style.width = '100%';
      outer.style.height = '100%';
      slotElements.forEach((el) => {
        el.style.flex = '1 1 0';
        el.style.minWidth = '0';
        el.style.minHeight = '0';
        outer.appendChild(el);
      });
      return outer;
    }

    const outer = document.createElement('div');
    outer.className = 'page-region-split';
    outer.style.position = 'relative';
    outer.style.display = 'flex';
    outer.style.flexDirection = def.split === 'rows' ? 'column' : 'row';
    outer.style.gap = `${gapPx}px`;
    outer.style.width = '100%';
    outer.style.height = '100%';

    const axis = def.split === 'rows' ? 'secondary' : 'primary';
    const ratio = page.splits && page.splits[axis] !== undefined ? page.splits[axis] : 0.5;

    let idx = 0;
    def.regions.forEach((region, i) => {
      const regionEl = document.createElement('div');
      regionEl.style.flex = `${i === 0 ? ratio : 1 - ratio} 0 0`;
      regionEl.style.minWidth = '0';
      regionEl.style.minHeight = '0';
      regionEl.style.display = 'flex';

      if (region.count === 1) {
        const cell = slotElements[idx];
        cell.style.flex = '1 1 0';
        cell.style.minWidth = '0';
        cell.style.minHeight = '0';
        regionEl.appendChild(cell);
        idx += 1;
      } else if (region.stack) {
        regionEl.style.flexDirection = region.stack === 'rows' ? 'column' : 'row';
        regionEl.style.gap = `${gapPx}px`;
        for (let k = 0; k < region.count; k++) {
          const cell = slotElements[idx];
          cell.style.flex = '1 1 0';
          cell.style.minWidth = '0';
          cell.style.minHeight = '0';
          regionEl.appendChild(cell);
          idx += 1;
        }
      } else if (region.grid) {
        const [gr, gc] = region.grid;
        regionEl.style.flexDirection = 'column';
        regionEl.style.gap = `${gapPx}px`;
        for (let r = 0; r < gr; r++) {
          const rowEl = document.createElement('div');
          rowEl.style.display = 'flex';
          rowEl.style.flex = '1 1 0';
          rowEl.style.gap = `${gapPx}px`;
          rowEl.style.minWidth = '0';
          rowEl.style.minHeight = '0';
          for (let c = 0; c < gc; c++) {
            const cell = slotElements[idx];
            cell.style.flex = '1 1 0';
            cell.style.minWidth = '0';
            cell.style.minHeight = '0';
            rowEl.appendChild(cell);
            idx += 1;
          }
          regionEl.appendChild(rowEl);
        }
      }
      outer.appendChild(regionEl);
    });

    return outer;
  }

  function renderRegionSplitDivider(outer, page, def, axis, ratio) {
    const gapPx = appState.layoutGap ? 10 : 0;
    const rect = outer.getBoundingClientRect();
    const divider = document.createElement('div');
    divider.className = `split-divider ${def.split === 'rows' ? 'horizontal' : 'vertical'}`;
    if (def.split === 'rows') {
      const topPx = (rect.height - gapPx) * ratio + gapPx / 2;
      divider.style.top = rect.height ? `${(topPx / rect.height) * 100}%` : '50%';
    } else {
      const leftPx = (rect.width - gapPx) * ratio + gapPx / 2;
      divider.style.left = rect.width ? `${(leftPx / rect.width) * 100}%` : '50%';
    }
    outer.appendChild(divider);
    wireDividerDrag(divider, outer, page, axis);
  }

  // Default split ratios used only for drawing the small static preview
  // icons in the layout picker (the real ratio, once a layout is actually
  // selected, comes from the page's own adjustable splits on the server --
  // see DEFAULT_SPLITS in server/pages.js, which these mirror).
  const PREVIEW_DEFAULT_SPLITS = {
    '2b': { secondary: 0.5 }, '3b': { primary: 1 / 3 }, '3c': { secondary: 0.6 },
    '4b': { primary: 2 / 3 }, '4c': { primary: 1 / 3 }, '4d': { secondary: 0.55 }, '5b': { primary: 0.45 }
  };

  // Computes 0-1 fractional rects for a layout's small preview icon, using
  // the same splitting/stacking/gridding logic as the PDF export's
  // layoutRects() in server/pdfExporter.js, just in fraction space instead
  // of page-pixel space and with default (not live) split ratios.
  function layoutPreviewRects(layoutId) {
    const gap = 0.05;
    const key = String(layoutId);

    const splitBoxFrac = (x, y, w, h, direction, ratio) => {
      if (direction === 'cols') {
        const firstW = (w - gap) * ratio;
        return [{ x, y, w: firstW, h }, { x: x + firstW + gap, y, w: w - gap - firstW, h }];
      }
      const firstH = (h - gap) * ratio;
      return [{ x, y, w, h: firstH }, { x, y: y + firstH + gap, w, h: h - gap - firstH }];
    };
    const stackRectsFrac = (box, count, direction) => {
      const rects = [];
      if (direction === 'rows') {
        const cellH = (box.h - gap * (count - 1)) / count;
        let curY = box.y;
        for (let i = 0; i < count; i++) { rects.push({ x: box.x, y: curY, w: box.w, h: cellH }); curY += cellH + gap; }
      } else {
        const cellW = (box.w - gap * (count - 1)) / count;
        let curX = box.x;
        for (let i = 0; i < count; i++) { rects.push({ x: curX, y: box.y, w: cellW, h: box.h }); curX += cellW + gap; }
      }
      return rects;
    };
    const gridRectsFrac = (box, rows, cols) => {
      const cellW = (box.w - gap * (cols - 1)) / cols;
      const cellH = (box.h - gap * (rows - 1)) / rows;
      const rects = [];
      let curY = box.y;
      for (let r = 0; r < rows; r++) {
        let curX = box.x;
        for (let c = 0; c < cols; c++) { rects.push({ x: curX, y: curY, w: cellW, h: cellH }); curX += cellW + gap; }
        curY += cellH + gap;
      }
      return rects;
    };
    const regionRectsFrac = (box, region) => {
      if (region.count === 1) return [box];
      if (region.stack) return stackRectsFrac(box, region.count, region.stack);
      if (region.grid) return gridRectsFrac(box, region.grid[0], region.grid[1]);
      return [box];
    };

    if (key === '1') return [{ x: 0, y: 0, w: 1, h: 1 }];
    if (key === '2') return splitBoxFrac(0, 0, 1, 1, 'cols', 0.5);
    if (key === '3') {
      const [big, rightBox] = splitBoxFrac(0, 0, 1, 1, 'cols', 2 / 3);
      return [big, ...stackRectsFrac(rightBox, 2, 'rows')];
    }
    if (key === '4') return gridRectsFrac({ x: 0, y: 0, w: 1, h: 1 }, 2, 2);

    const rows = LAYOUT_ROWS[key];
    if (rows) {
      const rowCount = rows.length;
      const rowH = (1 - gap * (rowCount - 1)) / rowCount;
      const rects = [];
      let curY = 0;
      for (const cols of rows) {
        const colW = (1 - gap * (cols - 1)) / cols;
        let curX = 0;
        for (let c = 0; c < cols; c++) { rects.push({ x: curX, y: curY, w: colW, h: rowH }); curX += colW + gap; }
        curY += rowH + gap;
      }
      return rects;
    }

    const def = LAYOUT_REGION_DEFS[key];
    if (def) {
      if (def.equalCols) return stackRectsFrac({ x: 0, y: 0, w: 1, h: 1 }, def.equalCols, 'cols');
      const axis = def.split === 'rows' ? 'secondary' : 'primary';
      const ds = PREVIEW_DEFAULT_SPLITS[key];
      const ratio = ds && ds[axis] !== undefined ? ds[axis] : 0.5;
      const boxes = splitBoxFrac(0, 0, 1, 1, def.split, ratio);
      return [...regionRectsFrac(boxes[0], def.regions[0]), ...regionRectsFrac(boxes[1], def.regions[1])];
    }
    return [{ x: 0, y: 0, w: 1, h: 1 }];
  }

  function renderLayoutModal() {
    const page = appState.pages[currentPageIndex];
    const container = $('#layoutCatalog');
    container.innerHTML = LAYOUT_CATALOG.map((group) => `
      <div class="layout-count-group">
        <h4>${group.count} Photo${group.count > 1 ? 's' : ''}</h4>
        <div class="layout-count-row">
          ${group.layouts.map((l) => `
            <button class="layout-option ${page && String(page.layout) === l.id ? 'active' : ''}" data-layout-id="${l.id}" title="${escapeHtml(l.label)}">
              <div class="layout-preview">${layoutPreviewRects(l.id).map((r) => `<div class="layout-preview-rect" style="left:${(r.x * 100).toFixed(2)}%; top:${(r.y * 100).toFixed(2)}%; width:${(r.w * 100).toFixed(2)}%; height:${(r.h * 100).toFixed(2)}%;"></div>`).join('')}</div>
              <span class="layout-option-label">${escapeHtml(l.label)}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.layout-option').forEach((btn) => {
      btn.addEventListener('click', () => selectLayout(btn.dataset.layoutId));
    });
  }

  function openLayoutModal() {
    if (!appState.pages[currentPageIndex]) return;
    renderLayoutModal();
    $('#layoutModal').classList.add('active');
  }

  function closeLayoutModal() {
    $('#layoutModal').classList.remove('active');
  }

  async function selectLayout(layoutId) {
    const page = appState.pages[currentPageIndex];
    if (!page) return;
    try {
      const data = await api('PUT', `/api/pages/${page.id}/layout`, { layout: layoutId });
      appState.pages[currentPageIndex] = data.page;
      flashSaved();
    } catch (err) {
      flashError(err.message);
    }
    closeLayoutModal();
    renderEditorCanvas();
    renderPageRail();
  }

  function renderEditorCanvas() {
    applyPageSizeToStage();
    const stage = $('#pageStage');
    const page = appState.pages[currentPageIndex];

    $('#layoutPickerBtnLabel').textContent = page ? layoutLabelFor(page.layout) : '';

    if (!page) {
      stage.innerHTML = '<p class="empty-hint">Set a page count above to start designing your album.</p>';
      return;
    }

    const usageMap = photoUsageMap();
    const slotElements = page.slots.map((slot, idx) => buildSlotElement(page, slot, idx, stage, usageMap));

    stage.innerHTML = '';
    if (page.slots.some((s) => s.rect)) {
      stage.appendChild(buildCustomRectContainer(page, slotElements));
    } else if (LAYOUT_ROWS[page.layout]) {
      stage.appendChild(buildRowsContainer(page, slotElements));
    } else if (LAYOUT_REGION_DEFS[page.layout]) {
      const def = LAYOUT_REGION_DEFS[page.layout];
      const container = buildRegionLayoutContainer(page, slotElements);
      stage.appendChild(container);
      // The divider's position depends on the container's rendered size, so
      // it must be added only after the container is actually in the DOM
      // (getBoundingClientRect() on a detached element is always zero).
      if (!def.equalCols) {
        const axis = def.split === 'rows' ? 'secondary' : 'primary';
        const ratio = page.splits && page.splits[axis] !== undefined ? page.splits[axis] : 0.5;
        renderRegionSplitDivider(container, page, def, axis, ratio);
      }
    } else {
      const grid = document.createElement('div');
      grid.className = `page-grid layout-${page.layout}`;
      applyGridTemplate(grid, page);
      slotElements.forEach((el) => grid.appendChild(el));
      stage.appendChild(grid);
      renderSplitDividers(grid, page);
    }
    renderFloatsLayer(stage, page, usageMap);
  }

  function layoutLabelFor(layoutId) {
    for (const group of LAYOUT_CATALOG) {
      const found = group.layouts.find((l) => l.id === String(layoutId));
      if (found) return `${group.count} photo${group.count > 1 ? 's' : ''}`;
    }
    return String(layoutId);
  }

  // Floating accent photos render as direct children of #pageStage (not the
  // grid/rows inside it) so their 0-100% left/top/width/height span the
  // whole sheet, matching how the PDF export places them -- letting them
  // reach every corner or overlap the main photo(s).
  function renderFloatsLayer(stage, page, usageMap) {
    for (const float of page.floats || []) {
      const tile = document.createElement('div');
      tile.className = 'float-tile';
      tile.dataset.floatId = float.id;
      tile.style.left = `${float.x * 100}%`;
      tile.style.top = `${float.y * 100}%`;
      tile.style.width = `${float.w * 100}%`;
      tile.style.height = `${float.h * 100}%`;
      const isFreeCrop = float.crop && float.crop.mode === 'free';
      const cropStyle = (isFreeCrop
        ? 'object-fit:contain;'
        : float.crop
          ? `position:absolute; left:${(-float.crop.x / float.crop.w * 100).toFixed(3)}%; top:${(-float.crop.y / float.crop.h * 100).toFixed(3)}%; width:${(100 / float.crop.w).toFixed(3)}%; height:${(100 / float.crop.h).toFixed(3)}%; object-fit:fill;`
          : '') + photoTransformStyle(float.mirrored, float.rotation);
      const imgSrc = isFreeCrop
        ? `/api/crop-preview/${float.photoId}?x=${float.crop.x}&y=${float.crop.y}&w=${float.crop.w}&h=${float.crop.h}`
        : `/api/thumb/${float.photoId}`;
      const usageLocations = (usageMap && usageMap.get(float.photoId)) || [];
      const usedElsewhere = usageLocations.length > 1;
      tile.innerHTML = `
        <div class="photo-clip shape-${float.shape || 'none'}">
          <img src="${imgSrc}" alt="" draggable="false" style="${cropStyle}" />
        </div>
        ${usedElsewhere ? `<button class="usage-badge" title="This photo is used ${usageLocations.length} times in the album -- click to jump to the next spot">&#9888; &times;${usageLocations.length}</button>` : ''}
        <div class="float-actions">
          <button class="float-crop-btn" title="Edit">&#9986;</button>
          <button class="float-remove-btn" title="Remove">&times;</button>
        </div>
      `;
      if (usedElsewhere) {
        tile.querySelector('.usage-badge').addEventListener('click', (e) => {
          e.stopPropagation();
          jumpToOtherUsage(float.photoId, { pageId: page.id, type: 'float', floatId: float.id });
        });
      }
      appendResizeHandles(tile);
      wireFloatDrag(tile, stage, page, float);
      wireFloatResize(tile, stage, page, float);
      wireFloatPhotoDrop(tile, page, float);

      // Same hover-tracking the Delete key relies on for slots -- see the
      // comment in buildSlotElement.
      const floatHoverTarget = { type: 'float', pageId: page.id, float };
      tile.addEventListener('mouseenter', () => { hoveredPhoto = floatHoverTarget; });
      tile.addEventListener('mouseleave', () => {
        if (hoveredPhoto === floatHoverTarget) hoveredPhoto = null;
      });
      tile.querySelector('.float-crop-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openFloatCropEditor(page.id, float.id);
      });
      tile.querySelector('.float-remove-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        removeFloat(page.id, float);
      });
      stage.appendChild(tile);
    }
  }

  // Lets you drop a photo straight onto an existing floating photo to
  // replace which photo it shows (position/size stay put) -- same sources
  // a slot already accepts: a library card, a file from File Explorer, or
  // an external image link. Existing crop is cleared since it was framed
  // for the old photo.
  function wireFloatPhotoDrop(tile, page, float) {
    tile.addEventListener('dragover', (e) => {
      e.preventDefault();
      tile.classList.add('drag-over');
    });
    tile.addEventListener('dragleave', () => tile.classList.remove('drag-over'));
    tile.addEventListener('drop', async (e) => {
      e.preventDefault();
      // This tile fully handles its own drop -- stop it from also
      // bubbling up to the page-stage's drop handler, which would
      // otherwise additionally create a brand-new floating photo.
      e.stopPropagation();
      tile.classList.remove('drag-over');

      // See the matching comment in the slot drop handler: check for a
      // recognized in-app photo before dataTransfer.files, since some
      // browsers populate files with a synthetic image for an in-page
      // <img> drag too, not just a real drop from outside the browser.
      const photoId = e.dataTransfer.getData('text/plain');
      const isKnownPhoto = photoId && appState.photos.some((p) => p.id === photoId);

      if (!isKnownPhoto && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        await importFileIntoFloat(page.id, float.id, e.dataTransfer.files[0], tile);
        return;
      }
      if (isKnownPhoto) {
        await setFloatPhoto(page.id, float.id, photoId);
        return;
      }
      const external = extractExternalImageDrag(e.dataTransfer);
      if (external) await importUrlIntoFloat(page.id, float.id, external, tile);
    });
  }

  async function setFloatPhoto(pageId, floatId, photoId) {
    // Same "keep crop/shape when replacing" toolbar checkbox as assignSlot
    // honors for slots -- see the comment there.
    const keepCrop = $('#keepCropOnReplaceToggle').checked;
    try {
      const data = await api('PUT', `/api/pages/${pageId}/floats/${floatId}`, { photoId, keepCrop });
      const pageIdx = appState.pages.findIndex((p) => p.id === pageId);
      if (pageIdx !== -1) appState.pages[pageIdx] = data.page;
      flashSaved();
    } catch (err) {
      flashError(err.message);
    }
    renderEditorCanvas();
  }

  async function importFileIntoFloat(pageId, floatId, file, tileEl) {
    const prevHtml = tileEl.innerHTML;
    tileEl.innerHTML = '<span class="add-photo-btn">Adding photo&hellip;</span>';
    const formData = new FormData();
    formData.append('photos', file);
    try {
      const data = await api('POST', '/api/upload', formData);
      appState.photos.push(...data.added);
      if (data.added[0]) {
        await setFloatPhoto(pageId, floatId, data.added[0].id);
      } else {
        tileEl.innerHTML = prevHtml;
      }
    } catch (err) {
      tileEl.innerHTML = prevHtml;
      flashError(`Couldn't add that photo: ${err.message}`);
    }
  }

  async function importUrlIntoFloat(pageId, floatId, { url, filename }, tileEl) {
    const prevHtml = tileEl.innerHTML;
    tileEl.innerHTML = '<span class="add-photo-btn">Downloading&hellip;</span>';
    try {
      const data = await api('POST', '/api/import-url', { url, filename });
      appState.photos.push(data.photo);
      await setFloatPhoto(pageId, floatId, data.photo.id);
    } catch (err) {
      tileEl.innerHTML = prevHtml;
      flashError(`Couldn't import that photo: ${err.message}`);
    }
  }

  function wireFloatDrag(tile, stage, page, float) {
    tile.addEventListener('mousedown', (e) => {
      if (e.target.closest('.float-remove-btn') || e.target.closest('.resize-handle') || e.target.closest('.float-crop-btn') || e.target.closest('.usage-badge')) return;
      e.preventDefault();
      const stageRect = stage.getBoundingClientRect();
      const startLeftFrac = float.x;
      const startTopFrac = float.y;
      const startX = e.clientX;
      const startY = e.clientY;

      const onMove = (moveEvent) => {
        const dxFrac = (moveEvent.clientX - startX) / stageRect.width;
        const dyFrac = (moveEvent.clientY - startY) / stageRect.height;
        float.x = Math.min(1 - float.w / 2, Math.max(-float.w / 2, startLeftFrac + dxFrac));
        float.y = Math.min(1 - float.h / 2, Math.max(-float.h / 2, startTopFrac + dyFrac));
        tile.style.left = `${float.x * 100}%`;
        tile.style.top = `${float.y * 100}%`;
      };
      const onUp = async () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        try {
          const data = await api('PUT', `/api/pages/${page.id}/floats/${float.id}`, { x: float.x, y: float.y });
          const pageIdx = appState.pages.findIndex((p) => p.id === page.id);
          if (pageIdx !== -1) appState.pages[pageIdx] = data.page;
          flashSaved();
        } catch (err) {
          flashError(err.message);
        }
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  function wireFloatResize(tile, stage, page, float) {
    tile.querySelectorAll('.resize-handle').forEach((handle) => {
      const dir = handle.dataset.dir;
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const stageRect = stage.getBoundingClientRect();
        const img = tile.querySelector('img');
        // Keep the photo's own aspect ratio while resizing, corrected for
        // the page's width:height ratio (a fraction of page-width and a
        // fraction of page-height aren't the same physical size unless the
        // page is square), so dragging any handle never stretches the
        // photo -- same as the single corner handle this replaces, just
        // from whichever side/corner you grab, with the opposite side
        // staying anchored in place.
        const { widthIn, heightIn } = appState.pageSize || { widthIn: 11, heightIn: 8.5 };
        const pageAspect = widthIn / heightIn;
        const imgAspect = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : (float.w * pageAspect) / float.h;
        const aspectWPerH = imgAspect / pageAspect;
        const start = { x: float.x, y: float.y, w: float.w, h: float.h };
        const startX = e.clientX;
        const startY = e.clientY;
        const MIN = 0.03;

        const onMove = (moveEvent) => {
          const dxFrac = (moveEvent.clientX - startX) / stageRect.width;
          const dyFrac = (moveEvent.clientY - startY) / stageRect.height;
          const next = computeAspectResize(start, dir, dxFrac, dyFrac, aspectWPerH, MIN);
          // A floating photo may hang partway off the page edge by design
          // (see wireFloatDrag), so position is clamped relative to its own
          // half-size, same convention as moving it, not hard-clamped to
          // [0,1] the way a slot's rect is.
          next.x = Math.min(1 - next.w / 2, Math.max(-next.w / 2, next.x));
          next.y = Math.min(1 - next.h / 2, Math.max(-next.h / 2, next.y));
          float.x = next.x;
          float.y = next.y;
          float.w = next.w;
          float.h = next.h;
          tile.style.left = `${next.x * 100}%`;
          tile.style.top = `${next.y * 100}%`;
          tile.style.width = `${next.w * 100}%`;
          tile.style.height = `${next.h * 100}%`;
        };
        const onUp = async () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          try {
            const data = await api('PUT', `/api/pages/${page.id}/floats/${float.id}`, {
              x: float.x, y: float.y, w: float.w, h: float.h
            });
            const pageIdx = appState.pages.findIndex((p) => p.id === page.id);
            if (pageIdx !== -1) appState.pages[pageIdx] = data.page;
            flashSaved();
          } catch (err) {
            flashError(err.message);
          }
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
    });
  }

  async function addFloat(pageId, photoId) {
    try {
      const data = await api('POST', `/api/pages/${pageId}/floats`, { photoId });
      const pageIdx = appState.pages.findIndex((p) => p.id === pageId);
      if (pageIdx !== -1) appState.pages[pageIdx] = data.page;
      flashSaved();
    } catch (err) {
      flashError(err.message);
    }
    renderEditorCanvas();
  }

  // Lets a photo file dragged from File Explorer (or anywhere else that
  // hands over a real file, per the same reasoning as the slot file-drop
  // above) be dropped directly onto empty page background to add it as a
  // floating photo, landing right where it was dropped rather than at the
  // usual default corner position. Drops that land on a slot are handled
  // entirely by that slot's own handler (which stops the event from
  // reaching here), so this only fires for the empty page background.
  function wirePageStageFloatDrop() {
    const stage = $('#pageStage');
    stage.addEventListener('dragover', (e) => {
      e.preventDefault();
      stage.classList.add('stage-drag-over');
    });
    stage.addEventListener('dragleave', (e) => {
      if (e.target === stage) stage.classList.remove('stage-drag-over');
    });
    stage.addEventListener('drop', async (e) => {
      e.preventDefault();
      stage.classList.remove('stage-drag-over');
      const page = appState.pages[currentPageIndex];
      if (!page) return;
      const stageRect = stage.getBoundingClientRect();
      const dropX = (e.clientX - stageRect.left) / stageRect.width;
      const dropY = (e.clientY - stageRect.top) / stageRect.height;

      // Check for a recognized in-app photo (dragged from the library or
      // out of a slot) BEFORE dataTransfer.files -- some browsers populate
      // files with a synthetic image for an in-page <img> drag too, not
      // just a real drop from outside the browser, and this handler used
      // to trust files.length alone, which meant dragging an EXISTING
      // library photo onto the background was silently uploading a brand
      // new duplicate copy of it instead of reusing the original.
      const photoId = e.dataTransfer.getData('text/plain');
      if (photoId && appState.photos.some((p) => p.id === photoId)) {
        await addFloatAtPosition(page.id, photoId, dropX, dropY);
        return;
      }
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        await importFileAsFloat(page.id, e.dataTransfer.files[0], dropX, dropY);
      }
    });
  }

  // Adds an EXISTING library photo as a new floating photo, centered on the
  // actual drop point rather than the usual default staggered corner --
  // same re-centering idea as importFileAsFloat below, just for a photo
  // that's already in the library instead of a freshly uploaded one.
  async function addFloatAtPosition(pageId, photoId, dropX, dropY) {
    try {
      const data = await api('POST', `/api/pages/${pageId}/floats`, { photoId });
      const newFloat = data.page.floats[data.page.floats.length - 1];
      const x = Math.min(1 - newFloat.w / 2, Math.max(-newFloat.w / 2, dropX - newFloat.w / 2));
      const y = Math.min(1 - newFloat.h / 2, Math.max(-newFloat.h / 2, dropY - newFloat.h / 2));
      const moveData = await api('PUT', `/api/pages/${pageId}/floats/${newFloat.id}`, { x, y });
      const pageIdx = appState.pages.findIndex((p) => p.id === pageId);
      if (pageIdx !== -1) appState.pages[pageIdx] = moveData.page;
      flashSaved();
    } catch (err) {
      flashError(err.message);
    }
    renderEditorCanvas();
  }

  async function importFileAsFloat(pageId, file, dropX, dropY) {
    const formData = new FormData();
    formData.append('photos', file);
    try {
      const data = await api('POST', '/api/upload', formData);
      appState.photos.push(...data.added);
      const newPhoto = data.added[0];
      if (newPhoto) {
        const floatData = await api('POST', `/api/pages/${pageId}/floats`, { photoId: newPhoto.id });
        const newFloat = floatData.page.floats[floatData.page.floats.length - 1];
        // Re-center the newly created float on the actual drop point instead
        // of leaving it at the usual default staggered corner position.
        const x = Math.min(1 - newFloat.w / 2, Math.max(-newFloat.w / 2, dropX - newFloat.w / 2));
        const y = Math.min(1 - newFloat.h / 2, Math.max(-newFloat.h / 2, dropY - newFloat.h / 2));
        const moveData = await api('PUT', `/api/pages/${pageId}/floats/${newFloat.id}`, { x, y });
        const pageIdx = appState.pages.findIndex((p) => p.id === pageId);
        if (pageIdx !== -1) appState.pages[pageIdx] = moveData.page;
      }
      renderLibraryTab();
      renderEditorLibrary();
      renderEditorCanvas();
      flashSaved();
    } catch (err) {
      flashError(`Couldn't add that photo: ${err.message}`);
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

  // Picks one photo to represent a page in the rail thumbnail: its hero
  // photo if it has one, else the first filled slot, else its first
  // floating photo, else none (an all-empty page just shows the plain tile).
  function representativePhotoId(page) {
    const hero = page.slots.find((s) => s.photoId && s.hero);
    if (hero) return hero.photoId;
    const filled = page.slots.find((s) => s.photoId);
    if (filled) return filled.photoId;
    if (page.floats.length) return page.floats[0].photoId;
    return null;
  }

  function renderPageRail() {
    const rail = $('#pageRail');
    $('#jumpToPageInput').max = appState.pages.length;
    if (appState.pages.length) $('#jumpToPageInput').value = currentPageIndex + 1;
    rail.innerHTML = appState.pages.map((page, idx) => {
      const filled = page.slots.some((s) => s.photoId);
      const total = page.slots.length;
      const filledCount = page.slots.filter((s) => s.photoId).length;
      const thumbId = representativePhotoId(page);
      return `<div class="rail-page ${idx === currentPageIndex ? 'current' : ''} ${filled ? 'filled' : ''}" data-idx="${idx}" data-page-id="${page.id}" draggable="true">
        ${thumbId ? `<img class="rail-thumb" src="/api/thumb/${thumbId}" alt="" loading="lazy" />` : ''}
        <button class="rail-delete-btn" title="Delete this page">&times;</button>
        <span>${filledCount}/${total}</span>
        <span class="rail-label">Pg ${idx + 1}</span>
      </div>`;
    }).join('');

    rail.querySelectorAll('.rail-page').forEach((el) => {
      el.querySelector('.rail-delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        deletePage(el.dataset.pageId);
      });

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

  async function deletePage(pageId) {
    const confirmed = window.confirm(
      "Delete this page? Its photos stay in your library, but this page's layout and any floating photos on it will be gone. A restore point is saved first, so this can be undone from Version History on the Setup tab."
    );
    if (!confirmed) return;
    try {
      const data = await api('DELETE', `/api/pages/${pageId}`);
      appState.pages = data.pages;
      if (currentPageIndex >= appState.pages.length) currentPageIndex = appState.pages.length - 1;
      if (currentPageIndex < 0) currentPageIndex = 0;
      flashSaved();
    } catch (err) {
      flashError(err.message);
    }
    $('#pageCountInput').value = appState.pages.length;
    renderEditorCanvas();
    renderPageRail();
  }

  // Records the single most recent undoable edit (one level only -- a
  // second recording always replaces the first, it never stacks). `run` is
  // called with no arguments when the user clicks "Undo Last Edit" or
  // presses Ctrl+Z; since undoing an edit is itself an edit, it records its
  // own undo in turn, so pressing the shortcut twice in a row acts like a
  // redo rather than doing nothing on the second press.
  function recordUndo(label, run) {
    lastEditUndo = { label, run };
    const btn = $('#undoLastEditBtn');
    if (btn) {
      btn.disabled = false;
      btn.title = `Undo: ${label}`;
    }
  }

  async function runLastEditUndo() {
    if (!lastEditUndo) return;
    await lastEditUndo.run();
  }

  // Esc closes whichever modal happens to be open, trying each one's own
  // close path (not just stripping the .active class) so any state that
  // close path also clears -- pickerTarget, cropState, oneDriveState --
  // doesn't linger stale for the next time that modal opens.
  function closeAnyOpenModal() {
    if (cropState) { closeCropEditor(); return true; }
    if ($('#pickerModal').classList.contains('active')) { closePicker(); return true; }
    if ($('#layoutModal').classList.contains('active')) { closeLayoutModal(); return true; }
    if ($('#oneDriveModal').classList.contains('active')) { closeOneDriveModal(); return true; }
    if ($('#lightbox').classList.contains('active')) { $('#lightbox').classList.remove('active'); return true; }
    return false;
  }

  function goToAdjacentPage(delta) {
    if (!appState.pages.length) return;
    jumpToPage(currentPageIndex + 1 + delta);
  }

  // Global shortcuts: Esc closes the open modal from anywhere; the rest
  // only act while actually typing nowhere (so they don't hijack a search
  // box or a number input) and, except undo, only on the Editor tab where
  // they're meaningful.
  function initKeyboardShortcuts() {
    document.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        closeAnyOpenModal();
        return;
      }

      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      if (typing) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        await runLastEditUndo();
        return;
      }

      const editorTab = $('#tab-editor');
      if (!editorTab || !editorTab.classList.contains('active')) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goToAdjacentPage(-1);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        goToAdjacentPage(1);
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!hoveredPhoto) return;
        e.preventDefault();
        const target = hoveredPhoto;
        hoveredPhoto = null;
        if (target.type === 'slot') {
          await assignSlot(target.pageId, target.slotIndex, { remove: true });
        } else {
          await removeFloat(target.pageId, target.float);
        }
      }
    });
  }

  // Shared by the float's own remove button and the Delete-key shortcut
  // (see initKeyboardShortcuts). Records a one-level undo that recreates
  // the float -- DELETE doesn't come back, so undoing it means a fresh id
  // from a new POST, then restoring its other fields in a follow-up PUT.
  async function removeFloat(pageId, float) {
    const removedFloat = JSON.parse(JSON.stringify(float));
    try {
      const data = await api('DELETE', `/api/pages/${pageId}/floats/${float.id}`);
      const pageIdx = appState.pages.findIndex((p) => p.id === pageId);
      if (pageIdx !== -1) appState.pages[pageIdx] = data.page;
      flashSaved();
      recordUndo('remove floating photo', async () => {
        try {
          const createData = await api('POST', `/api/pages/${pageId}/floats`, { photoId: removedFloat.photoId });
          const recreated = createData.page.floats[createData.page.floats.length - 1];
          const putData = await api('PUT', `/api/pages/${pageId}/floats/${recreated.id}`, {
            x: removedFloat.x, y: removedFloat.y, w: removedFloat.w, h: removedFloat.h,
            crop: removedFloat.crop, shape: removedFloat.shape, mirrored: removedFloat.mirrored, rotation: removedFloat.rotation
          });
          const idx = appState.pages.findIndex((p) => p.id === pageId);
          if (idx !== -1) appState.pages[idx] = putData.page;
          flashSaved();
        } catch (err) {
          flashError(err.message);
        }
        renderEditorCanvas();
      });
    } catch (err) {
      flashError(err.message);
    }
    renderEditorCanvas();
  }

  async function assignSlot(pageId, slotIndex, body) {
    // Every photo-replace in a slot (drag from library, drop from File
    // Explorer, picker, URL import) funnels through here with a `photoId`
    // in the body, so this is the one place to honor the "keep crop/shape
    // when replacing" toolbar checkbox rather than threading it through
    // every call site individually.
    if (body.photoId !== undefined && $('#keepCropOnReplaceToggle').checked) {
      body = { ...body, keepCrop: true };
    }
    // Same reasoning for one-level undo: assignSlot is the one chokepoint
    // for every slot edit (crop/shape/mirror/rotate, hero, remove, photo
    // replace), so snapshotting the slot here -- before the mutation --
    // covers all of them without wiring undo into each call site.
    const page = appState.pages.find((p) => p.id === pageId);
    const prevSlot = page ? JSON.parse(JSON.stringify(page.slots[slotIndex])) : null;
    try {
      const data = await api('PUT', `/api/pages/${pageId}/slot/${slotIndex}`, body);
      const pageIdx = appState.pages.findIndex((p) => p.id === pageId);
      if (pageIdx !== -1) appState.pages[pageIdx] = data.page;
      flashSaved();
      if (prevSlot) {
        recordUndo('slot edit', () => assignSlot(pageId, slotIndex, prevSlot.photoId
          ? { photoId: prevSlot.photoId, hero: prevSlot.hero, crop: prevSlot.crop, shape: prevSlot.shape, mirrored: prevSlot.mirrored, rotation: prevSlot.rotation, keepCrop: true }
          : { remove: true }));
      }
    } catch (err) {
      flashError(err.message);
    }
    renderEditorCanvas();
    renderPageRail();
    renderEditorLibrary();
  }

  // Pulls a photo out of its slot and turns it into a loose floating photo
  // instead -- the slot it leaves behind just goes back to "+ Add Photo"
  // (the normal `remove` behavior), it is NOT backfilled with anything, so
  // the rest of the layout doesn't shift around the way removing a photo
  // from the middle of a list might suggest.
  async function convertSlotToFloat(pageId, slotIndex, photoId, shape, mirrored, rotation, slotEl) {
    try {
      const stage = document.getElementById('pageStage');
      const stageRect = stage ? stage.getBoundingClientRect() : null;
      const slotRect = slotEl ? slotEl.getBoundingClientRect() : null;

      const floatData = await api('POST', `/api/pages/${pageId}/floats`, { photoId });
      let page = floatData.page;
      const newFloat = page.floats[page.floats.length - 1];

      if (newFloat && stageRect && slotRect && stageRect.width && stageRect.height) {
        // Center the new float where the slot used to be instead of the
        // usual staggered default corner, so the photo doesn't visually
        // jump across the page -- same idea as re-centering a float
        // dropped directly onto the stage (see importFileIntoFloat above).
        const centerXFrac = (slotRect.left + slotRect.width / 2 - stageRect.left) / stageRect.width;
        const centerYFrac = (slotRect.top + slotRect.height / 2 - stageRect.top) / stageRect.height;
        const x = Math.min(1 - newFloat.w / 2, Math.max(-newFloat.w / 2, centerXFrac - newFloat.w / 2));
        const y = Math.min(1 - newFloat.h / 2, Math.max(-newFloat.h / 2, centerYFrac - newFloat.h / 2));
        const moveData = await api('PUT', `/api/pages/${pageId}/floats/${newFloat.id}`, { x, y });
        page = moveData.page;
      }

      if (newFloat && (shape || mirrored || rotation)) {
        const shapeData = await api('PUT', `/api/pages/${pageId}/floats/${newFloat.id}`, { shape, mirrored, rotation });
        page = shapeData.page;
      }

      const slotData = await api('PUT', `/api/pages/${pageId}/slot/${slotIndex}`, { remove: true });
      page = slotData.page;

      const pageIdx = appState.pages.findIndex((p) => p.id === pageId);
      if (pageIdx !== -1) appState.pages[pageIdx] = page;
      flashSaved();
    } catch (err) {
      flashError(err.message);
    }
    renderEditorCanvas();
    renderPageRail();
  }

  // The reverse of convertSlotToFloat above: puts a floating photo back
  // into the first empty regular slot on the same page, then removes the
  // float. There's no "which slot" to preserve (a float never came from a
  // slot position in the first place, or if it did, that slot may be
  // filled with something else by now), so this just claims whichever slot
  // is free -- if none is, it says so rather than guessing which photo to
  // displace.
  async function convertFloatToSlot(pageId, floatId, photoId, shape, mirrored, rotation) {
    const page = appState.pages.find((p) => p.id === pageId);
    if (!page) return;
    const emptyIndex = page.slots.findIndex((s) => !s.photoId);
    if (emptyIndex === -1) {
      flashError("No empty slot on this page to put the photo back into -- remove a photo from a slot, or add more slots, first.");
      return;
    }
    try {
      await api('PUT', `/api/pages/${pageId}/slot/${emptyIndex}`, { photoId, shape, mirrored, rotation });
      const data = await api('DELETE', `/api/pages/${pageId}/floats/${floatId}`);
      const pageIdx = appState.pages.findIndex((p) => p.id === pageId);
      if (pageIdx !== -1) appState.pages[pageIdx] = data.page;
      flashSaved();
    } catch (err) {
      flashError(err.message);
    }
    renderEditorCanvas();
    renderPageRail();
  }

  // Rearranges two slots on the same page by swapping their entire contents
  // (photo, hero flag, and crop all move together) -- if the target slot
  // was empty this just moves the photo there; if it already held a
  // different photo, the two trade places instead of one overwriting the
  // other.
  async function swapSlots(pageId, indexA, indexB) {
    try {
      const data = await api('POST', `/api/pages/${pageId}/slots/swap`, { a: indexA, b: indexB });
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

  function openPicker(pageId, slotIndex, isFloat) {
    pickerTarget = { pageId, slotIndex, isFloat: !!isFloat };
    const page = appState.pages.find((p) => p.id === pageId);
    const slot = isFloat ? null : page.slots[slotIndex];
    $('#pickerRemoveBtn').style.display = slot && slot.photoId ? 'inline-block' : 'none';
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
        if (pickerTarget.isFloat) {
          await addFloat(pickerTarget.pageId, photo.id);
        } else {
          await assignSlot(pickerTarget.pageId, pickerTarget.slotIndex, { photoId: photo.id });
        }
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
  // Two modes:
  // - "fill" (default): the crop rectangle's aspect ratio is locked to match
  //   the slot/float's own shape, so it always fills the box with no gaps or
  //   stretching. Drag to reposition, zoom slider to resize.
  // - "free": the rectangle can be any shape, resized from any edge/corner
  //   handle independently (so you can trim from just one or two sides).
  //   Since the result may not match the box's shape, it's rendered
  //   letterboxed (centered, empty space around it) instead of stretched.

  let cropState = null; // { pageId, slotIndex, floatId, boxAR, imgW, imgH, mode, cx, cy, zoom, rect } -- slotIndex xor floatId is set
  let cropDragging = false;
  let cropDragStart = null;

  const FREE_CROP_HANDLE_EDGES = {
    tl: ['left', 'top'], t: ['top'], tr: ['top', 'right'],
    l: ['left'], r: ['right'],
    bl: ['left', 'bottom'], b: ['bottom'], br: ['right', 'bottom']
  };
  const MIN_FREE_CROP_SIZE = 0.03;

  function computeBaseCropSize(boxAR, imgW, imgH) {
    const imgAR = imgW / imgH;
    if (imgAR > boxAR) {
      return { w: (imgH * boxAR) / imgW, h: 1 };
    }
    return { w: 1, h: (imgW / boxAR) / imgH };
  }

  function computeFillRectFraction() {
    const base = computeBaseCropSize(cropState.boxAR, cropState.imgW, cropState.imgH);
    const w = base.w / cropState.zoom;
    const h = base.h / cropState.zoom;
    const cx = Math.min(1 - w / 2, Math.max(w / 2, cropState.cx));
    const cy = Math.min(1 - h / 2, Math.max(h / 2, cropState.cy));
    cropState.cx = cx;
    cropState.cy = cy;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  function currentCropRectFraction() {
    if (cropState.mode === 'free') {
      return { ...cropState.rect, mode: 'free' };
    }
    return { ...computeFillRectFraction(), mode: 'fill' };
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

  function initialCropStateFields(item) {
    const existingCrop = item.crop;
    const mode = existingCrop && existingCrop.mode === 'free' ? 'free' : 'fill';
    return {
      mode,
      cx: 0.5, cy: 0.5, zoom: 1,
      rect: mode === 'free' ? { x: existingCrop.x, y: existingCrop.y, w: existingCrop.w, h: existingCrop.h } : null,
      shape: item.shape || null,
      mirrored: !!item.mirrored,
      rotation: item.rotation || 0
    };
  }

  function setCropModeUI(mode) {
    $('#cropModal').classList.toggle('free-mode', mode === 'free');
    $$('.crop-mode-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.cropMode === mode));
  }

  // Syncs the shape swatches, mirror checkbox, and the floating/slot toggle
  // button's label to the currently-open cropState -- called whenever the
  // editor opens or one of those three changes.
  function updateCropExtraUI() {
    if (!cropState) return;
    $$('.crop-shape-option').forEach((btn) => {
      const val = btn.dataset.shape === 'none' ? null : btn.dataset.shape;
      btn.classList.toggle('active', val === (cropState.shape || null));
    });
    $('#cropMirrorToggle').checked = !!cropState.mirrored;
    $('#cropRotationLabel').textContent = `${cropState.rotation || 0}°`;
    $('#cropFloatToggleBtn').textContent = cropState.floatId !== undefined
      ? 'Put back into a regular slot'
      : 'Make this a floating photo';
  }

  function openCropEditor(pageId, slotIndex) {
    const page = appState.pages.find((p) => p.id === pageId);
    const slot = page && page.slots[slotIndex];
    if (!slot || !slot.photoId) return;
    const slotEl = document.querySelector(`#pageStage .slot[data-slot-index="${slotIndex}"]`);
    const bounds = slotEl.getBoundingClientRect();
    const boxAR = bounds.width / bounds.height;

    cropState = { pageId, slotIndex, photoId: slot.photoId, boxAR, imgW: 0, imgH: 0, ...initialCropStateFields(slot) };
    setCropModeUI(cropState.mode);
    updateCropExtraUI();
    startCropEditorFor(slot.photoId);
  }

  function openFloatCropEditor(pageId, floatId) {
    const page = appState.pages.find((p) => p.id === pageId);
    const float = page && page.floats.find((f) => f.id === floatId);
    if (!float) return;
    const floatEl = document.querySelector(`#pageStage .float-tile[data-float-id="${floatId}"]`);
    const bounds = floatEl.getBoundingClientRect();
    const boxAR = bounds.width / bounds.height;

    cropState = { pageId, floatId, photoId: float.photoId, boxAR, imgW: 0, imgH: 0, ...initialCropStateFields(float) };
    setCropModeUI(cropState.mode);
    updateCropExtraUI();
    startCropEditorFor(float.photoId);
  }

  function startCropEditorFor(photoId) {
    const img = $('#cropImage');
    img.onload = () => {
      cropState.imgW = img.naturalWidth;
      cropState.imgH = img.naturalHeight;
      $('#cropZoom').value = 1;
      updateCropRectVisual();
    };
    img.src = `/api/preview/${photoId}`;
    $('#cropModal').classList.add('active');
  }

  function closeCropEditor() {
    $('#cropModal').classList.remove('active');
    cropState = null;
  }

  // A drag started on an edge/corner handle resizes only the edges that
  // handle controls (e.g. the "r" handle only moves the right edge), so
  // trimming just one side -- or two, by using two handles -- works without
  // touching the others. The opposite edges stay exactly where they were.
  function wireFreeCropHandle(handleEl, key) {
    const edges = FREE_CROP_HANDLE_EDGES[key];
    handleEl.addEventListener('mousedown', (e) => {
      if (!cropState || cropState.mode !== 'free') return;
      e.preventDefault();
      e.stopPropagation();
      const img = $('#cropImage');
      let { x, y, w, h } = cropState.rect;
      let left = x, top = y, right = x + w, bottom = y + h;

      const onMove = (moveEvent) => {
        const imgRect = img.getBoundingClientRect();
        const mx = Math.min(1, Math.max(0, (moveEvent.clientX - imgRect.left) / imgRect.width));
        const my = Math.min(1, Math.max(0, (moveEvent.clientY - imgRect.top) / imgRect.height));
        if (edges.includes('left')) left = Math.min(mx, right - MIN_FREE_CROP_SIZE);
        if (edges.includes('right')) right = Math.max(mx, left + MIN_FREE_CROP_SIZE);
        if (edges.includes('top')) top = Math.min(my, bottom - MIN_FREE_CROP_SIZE);
        if (edges.includes('bottom')) bottom = Math.max(my, top + MIN_FREE_CROP_SIZE);
        cropState.rect = { x: left, y: top, w: right - left, h: bottom - top };
        updateCropRectVisual();
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  function initCropEditor() {
    Object.keys(FREE_CROP_HANDLE_EDGES).forEach((key) => {
      wireFreeCropHandle($(`.crop-handle-${key}`), key);
    });

    $$('.crop-mode-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.cropMode;
        if (!cropState || cropState.mode === mode) return;
        if (mode === 'free' && !cropState.rect) {
          cropState.rect = computeFillRectFraction();
        }
        cropState.mode = mode;
        setCropModeUI(mode);
        updateCropRectVisual();
      });
    });

    $('#cropRect').addEventListener('mousedown', (e) => {
      if (!cropState || e.target.closest('.crop-handle')) return;
      cropDragging = true;
      cropDragStart = cropState.mode === 'free'
        ? { x: e.clientX, y: e.clientY, rectX: cropState.rect.x, rectY: cropState.rect.y }
        : { x: e.clientX, y: e.clientY, cx: cropState.cx, cy: cropState.cy };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!cropDragging || !cropState) return;
      const img = $('#cropImage');
      const dxFrac = (e.clientX - cropDragStart.x) / img.offsetWidth;
      const dyFrac = (e.clientY - cropDragStart.y) / img.offsetHeight;
      if (cropState.mode === 'free') {
        const r = cropState.rect;
        const newX = Math.min(1 - r.w, Math.max(0, cropDragStart.rectX + dxFrac));
        const newY = Math.min(1 - r.h, Math.max(0, cropDragStart.rectY + dyFrac));
        cropState.rect = { ...r, x: newX, y: newY };
      } else {
        cropState.cx = cropDragStart.cx + dxFrac;
        cropState.cy = cropDragStart.cy + dyFrac;
      }
      updateCropRectVisual();
    });
    window.addEventListener('mouseup', () => { cropDragging = false; });

    $('#cropZoom').addEventListener('input', (e) => {
      if (!cropState) return;
      cropState.zoom = parseFloat(e.target.value);
      updateCropRectVisual();
    });

    $$('.crop-shape-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!cropState) return;
        cropState.shape = btn.dataset.shape === 'none' ? null : btn.dataset.shape;
        updateCropExtraUI();
      });
    });

    $('#cropMirrorToggle').addEventListener('change', (e) => {
      if (!cropState) return;
      cropState.mirrored = e.target.checked;
    });

    $('#cropRotateLeftBtn').addEventListener('click', () => {
      if (!cropState) return;
      cropState.rotation = (cropState.rotation + 270) % 360;
      updateCropExtraUI();
    });
    $('#cropRotateRightBtn').addEventListener('click', () => {
      if (!cropState) return;
      cropState.rotation = (cropState.rotation + 90) % 360;
      updateCropExtraUI();
    });

    // Converting to/from a floating photo changes what the photo *is*, not
    // just an attribute of it, so unlike shape/mirror/crop/rotation it
    // applies right away instead of waiting for Done -- and closes the
    // editor afterward, since the slot/float this editor was opened for no
    // longer holds this photo.
    $('#cropFloatToggleBtn').addEventListener('click', async () => {
      if (!cropState) return;
      const { pageId, slotIndex, floatId, photoId, shape, mirrored, rotation } = cropState;
      closeCropEditor();
      if (floatId !== undefined) {
        await convertFloatToSlot(pageId, floatId, photoId, shape, mirrored, rotation);
      } else {
        const slotEl = document.querySelector(`#pageStage .slot[data-slot-index="${slotIndex}"]`);
        await convertSlotToFloat(pageId, slotIndex, photoId, shape, mirrored, rotation, slotEl);
      }
    });

    $('#cropCancelBtn').addEventListener('click', closeCropEditor);
    $('#cropClose').addEventListener('click', closeCropEditor);
    $('#cropModal').addEventListener('click', (e) => {
      if (e.target === $('#cropModal')) closeCropEditor();
    });
    $('#cropDoneBtn').addEventListener('click', async () => {
      if (!cropState) return;
      const crop = currentCropRectFraction();
      const { pageId, slotIndex, floatId, shape, mirrored, rotation } = cropState;
      if (floatId !== undefined) {
        const page = appState.pages.find((p) => p.id === pageId);
        const prevFloat = page ? JSON.parse(JSON.stringify(page.floats.find((f) => f.id === floatId))) : null;
        try {
          const data = await api('PUT', `/api/pages/${pageId}/floats/${floatId}`, { crop, shape, mirrored, rotation });
          const pageIdx = appState.pages.findIndex((p) => p.id === pageId);
          if (pageIdx !== -1) appState.pages[pageIdx] = data.page;
          flashSaved();
          if (prevFloat) {
            recordUndo('float edit', () => api('PUT', `/api/pages/${pageId}/floats/${floatId}`, {
              crop: prevFloat.crop, shape: prevFloat.shape, mirrored: prevFloat.mirrored, rotation: prevFloat.rotation
            }).then((d) => {
              const idx = appState.pages.findIndex((p) => p.id === pageId);
              if (idx !== -1) appState.pages[idx] = d.page;
              flashSaved();
              renderEditorCanvas();
            }).catch((err) => flashError(err.message)));
          }
        } catch (err) {
          flashError(err.message);
        }
        renderEditorCanvas();
      } else {
        await assignSlot(pageId, slotIndex, { crop, shape, mirrored, rotation });
      }
      closeCropEditor();
    });
  }

  // ---------------- Export tab ----------------

  function initExportTab() {
    $('#exportPhotographerBtn').addEventListener('click', async () => {
      const baseFolder = $('#destFolderInput').value.trim();
      const expectedCount = usedPhotoIds().size;
      setStatus(
        '#exportPhotographerStatus',
        `Exporting ${expectedCount} photo(s) across ${appState.pages.length} page(s)... this may take a moment for a large album.`,
        false
      );
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
      setStatus('#exportPdfStatus', `Generating PDF for ${appState.pages.length} page(s)...`, false);
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
    initProjectChooser();
    initResizablePanels();
    initKeyboardShortcuts();

    try {
      appState = await api('GET', '/api/state');
    } catch (err) {
      console.error('Failed to load state', err);
    }
    normalizeAppState();

    // After Microsoft redirects back from OneDrive sign-in, go straight
    // back into whichever album was active when that sign-in was started
    // (the server still remembers it) instead of the chooser, so the
    // connection result is visible right where it was initiated.
    const params = new URLSearchParams(window.location.search);
    if (params.has('onedrive')) {
      showMainApp();
      handleOneDriveRedirect();
    } else {
      showProjectChooser();
    }
  }

  // Setup/rescan/reset return only the active project's own fields (same
  // shape server/index.js's activeProject() works with internally), not
  // the chooser-related projects/activeProjectId/oneDrive fields GET
  // /api/state additionally includes -- so merge those project fields in
  // rather than replacing appState outright, and keep this project's entry
  // in the chooser's own project list in sync with its new photo/page count.
  function mergeActiveProjectState(newProjectFields) {
    appState = { ...appState, ...newProjectFields };
    const idx = appState.projects.findIndex((p) => p.id === appState.activeProjectId);
    if (idx !== -1) {
      appState.projects[idx] = {
        ...appState.projects[idx],
        photoCount: appState.photos.length,
        pageCount: appState.pages.length
      };
    }
  }

  function normalizeAppState() {
    if (!appState.exports) appState.exports = [];
    if (!appState.pageSize) appState.pageSize = { widthIn: 11, heightIn: 8.5 };
    if (appState.layoutGap === undefined) appState.layoutGap = true;
    if (!appState.oneDrive) appState.oneDrive = { clientId: null };
    if (!appState.projects) appState.projects = [];
  }

  // ---------------- Project chooser ----------------
  // Every album ("project") has its own fully separate photo library and
  // pages -- nothing is shared between them except the OneDrive sign-in.
  // The chooser is the landing screen: pick an album to open its familiar
  // Setup/Library/Editor/Export tabs, or switch back to pick a different
  // one from the "All Albums" button in the top bar.

  function showProjectChooser() {
    $('#appHeader').hidden = true;
    $('#appMain').hidden = true;
    $('#projectChooser').hidden = false;
    document.title = 'Wedding Album Selector';
    renderProjectChooser();
  }

  function showMainApp() {
    $('#projectChooser').hidden = true;
    $('#appHeader').hidden = false;
    $('#appMain').hidden = false;
    const activeProject = appState.projects.find((p) => p.id === appState.activeProjectId);
    const albumName = activeProject ? activeProject.name : '';
    $('#currentAlbumName').textContent = albumName;
    $('#currentAlbumName').title = albumName;
    document.title = albumName ? `${albumName} - Wedding Album Selector` : 'Wedding Album Selector';
    currentPageIndex = 0;
    $('#sourceFolderInput').value = appState.sourceFolder || '';
    $('#destFolderInput').value = defaultDestFolder();
    renderLibraryTab();
    renderEditorTab();
    renderExportTab();
    renderOneDriveStatus();
  }

  async function openProject(projectId) {
    try {
      if (projectId !== appState.activeProjectId) {
        await api('POST', `/api/projects/${projectId}/activate`);
        appState = await api('GET', '/api/state');
        normalizeAppState();
      }
    } catch (err) {
      flashError(err.message);
      return;
    }
    showMainApp();
  }

  function renderProjectChooser() {
    const grid = $('#projectGrid');
    grid.innerHTML = appState.projects.map((p) => `
      <div class="project-card ${p.id === appState.activeProjectId ? 'current' : ''}" data-project-id="${p.id}">
        <h3>${escapeHtml(p.name)}</h3>
        <div class="project-meta">${p.photoCount} photo${p.photoCount === 1 ? '' : 's'} &middot; ${p.pageCount} page${p.pageCount === 1 ? '' : 's'}</div>
        <div class="project-card-actions">
          <button class="project-rename-btn" data-project-id="${p.id}">Rename</button>
          <button class="project-export-btn" data-project-id="${p.id}">Export to Edit&hellip;</button>
          ${appState.projects.length > 1 ? `<button class="project-delete-btn danger" data-project-id="${p.id}">Delete</button>` : ''}
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.project-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        openProject(card.dataset.projectId);
      });
    });
    grid.querySelectorAll('.project-export-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // A plain navigation (not fetch) so the browser handles it as a
        // normal file download, same as the PDF export already does.
        window.location = `/api/projects/${btn.dataset.projectId}/export`;
      });
    });
    grid.querySelectorAll('.project-rename-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const project = appState.projects.find((p) => p.id === btn.dataset.projectId);
        const name = window.prompt('Rename this album:', project.name);
        if (!name || !name.trim()) return;
        try {
          await api('PUT', `/api/projects/${btn.dataset.projectId}`, { name: name.trim() });
          appState = await api('GET', '/api/state');
          normalizeAppState();
          renderProjectChooser();
        } catch (err) {
          flashError(err.message);
        }
      });
    });
    grid.querySelectorAll('.project-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const project = appState.projects.find((p) => p.id === btn.dataset.projectId);
        const confirmed = window.confirm(
          `Delete "${project.name}"? This removes its ${project.pageCount} page(s) and its ${project.photoCount}-photo library entirely. A restore point is saved first, so this can be undone from Version History inside any album's Setup tab.`
        );
        if (!confirmed) return;
        try {
          await api('DELETE', `/api/projects/${btn.dataset.projectId}`);
          appState = await api('GET', '/api/state');
          normalizeAppState();
          renderProjectChooser();
        } catch (err) {
          flashError(err.message);
        }
      });
    });
  }

  // A draggable handle on one edge of a layout panel (the overall app
  // content area, the Editor tab's library sidebar, ...), letting the user
  // resize that panel by hand instead of living with a fixed CSS size.
  // Distinct from the photo resize handles above: those resize a photo's
  // box within a page; this resizes the app's own UI chrome, and remembers
  // the chosen size in this browser (localStorage) so it's not lost on
  // reload -- it's a per-install display preference, not album data, so it
  // has no business in data/state.json on the server.
  function makeResizablePanel(el, { edge, cssProp, axis, min, max, storageKey }) {
    const handle = document.createElement('div');
    handle.className = `panel-resize-handle ${edge === 'right' || edge === 'left' ? 'vertical' : 'horizontal'}`;
    handle.title = 'Drag to resize';
    if (edge === 'left') handle.style.left = '-7px';
    if (edge === 'top') handle.style.top = '-7px';
    el.appendChild(handle);

    try {
      const stored = parseFloat(localStorage.getItem(storageKey));
      if (!isNaN(stored)) el.style[cssProp] = `${Math.min(max, Math.max(min, stored))}px`;
    } catch (err) {
      // localStorage can throw in a private window or with site data
      // blocked -- the panel just keeps its default CSS size.
    }

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handle.classList.add('active');
      const startSize = el.getBoundingClientRect()[axis === 'x' ? 'width' : 'height'];
      const startPos = axis === 'x' ? e.clientX : e.clientY;
      const sign = (edge === 'left' || edge === 'top') ? -1 : 1;

      const onMove = (moveEvent) => {
        const pos = axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
        const next = Math.min(max, Math.max(min, startSize + sign * (pos - startPos)));
        el.style[cssProp] = `${next}px`;
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        handle.classList.remove('active');
        try {
          localStorage.setItem(storageKey, el.style[cssProp].replace('px', ''));
        } catch (err) {
          // Nothing to fall back to here -- the size just won't persist.
        }
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  function initResizablePanels() {
    const main = document.getElementById('appMain');
    if (main) {
      makeResizablePanel(main, {
        edge: 'right', cssProp: 'maxWidth', axis: 'x', min: 700, max: 2400,
        storageKey: 'wav-resize-main-width'
      });
    }
    const library = document.querySelector('.editor-library');
    if (library) {
      makeResizablePanel(library, {
        edge: 'right', cssProp: 'width', axis: 'x', min: 180, max: 560,
        storageKey: 'wav-resize-library-width'
      });
    }
  }

  function initProjectChooser() {
    $('#newProjectBtn').addEventListener('click', async () => {
      const name = window.prompt('Name this new album:', `Album ${appState.projects.length + 1}`);
      if (name === null) return;
      try {
        await api('POST', '/api/projects', { name: name.trim() });
        appState = await api('GET', '/api/state');
        normalizeAppState();
      } catch (err) {
        flashError(err.message);
        return;
      }
      showMainApp();
    });

    $('#switchProjectBtn').addEventListener('click', showProjectChooser);
    $('#quickUndoBtn').addEventListener('click', quickUndo);

    $('#importProjectBtn').addEventListener('click', () => $('#importProjectInput').click());
    $('#importProjectInput').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      setStatus('#importProjectStatus', 'Importing album... this can take a moment for a large one.', false);
      const formData = new FormData();
      formData.append('albumZip', file);
      try {
        const data = await api('POST', '/api/projects/import', formData);
        appState = await api('GET', '/api/state');
        normalizeAppState();
        setStatus('#importProjectStatus', `Imported ${data.photoCount} photo(s) across ${data.pageCount} page(s).`, false, true);
        renderProjectChooser();
      } catch (err) {
        setStatus('#importProjectStatus', err.message, true);
      }
    });
  }

  // A one-click shortcut to the most recent automatic restore point (the
  // same ones listed in Version History on the Setup tab). Those are only
  // taken before specific actions that could lose a lot at once (scanning
  // a new folder, rescanning, clearing the library, deleting a page or
  // photos, deleting an album) -- not after every small edit -- so this
  // can undo more than just "the last thing you did" if several ordinary
  // edits happened since that checkpoint; the confirmation names exactly
  // when it was taken so that's never a surprise.
  async function quickUndo() {
    let history;
    try {
      history = await api('GET', '/api/history');
    } catch (err) {
      flashError(err.message);
      return;
    }
    if (!history.snapshots || history.snapshots.length === 0) {
      flashError('Nothing to undo yet -- no restore point has been taken.');
      return;
    }
    const latest = history.snapshots[0];
    const confirmed = window.confirm(
      `Restore the checkpoint from ${new Date(latest.createdAt).toLocaleString()}? ` +
      'This reverts every album at once to that point (your current state is saved as its own checkpoint first, so this can be undone too).'
    );
    if (!confirmed) return;
    try {
      await api('POST', `/api/history/${latest.id}/restore`);
      appState = await api('GET', '/api/state');
      normalizeAppState();
      showMainApp();
      flashSaved();
    } catch (err) {
      flashError(err.message);
    }
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
