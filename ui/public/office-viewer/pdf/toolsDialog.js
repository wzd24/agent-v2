'use strict';

(function (global) {
  // Sliders = utilities / page tools
  const TOOLS_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M2 3.5h7.2a1.75 1.75 0 0 0 3.4 0H14v-1h-1.4a1.75 1.75 0 0 0-3.4 0H2v1zm9.1-.5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zM2 8.5h1.4a1.75 1.75 0 0 0 3.4 0H14v-1H6.8a1.75 1.75 0 0 0-3.4 0H2v1zm3.1-.5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zM2 13.5h4.2a1.75 1.75 0 0 0 3.4 0H14v-1h-4.4a1.75 1.75 0 0 0-3.4 0H2v1zm5.9-.5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5z"/></svg>';
  // Tray / share-out style export
  const EXPORT_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M8.75 2.19V9.5h-1.5V2.19L5.03 4.41 3.97 3.35 8 0l4.03 3.35-1.06 1.06-2.22-2.22z"/><path d="M2.5 7.75v5.5c0 .69.56 1.25 1.25 1.25h8.5c.69 0 1.25-.56 1.25-1.25v-5.5h-1.5v5.5h-8.5v-5.5h-1.5z"/></svg>';

  let mergeUris = [];
  let mergeNames = [];
  let includeCurrent = true;
  let pageCount = 1;
  let fileName = '';
  let busy = false;
  let initialized = false;
  /** @type {'tools' | 'export' | null} */
  let activeDialog = null;

  function isProUser() {
    return document.body.classList.contains('is-pro');
  }

  function $(id) {
    return document.getElementById(id);
  }

  function dialogIds() {
    return ['pdf-tools-dialog', 'pdf-export-dialog'];
  }

  function getOverlay(kind) {
    return $(kind === 'export' ? 'pdf-export-dialog' : 'pdf-tools-dialog');
  }

  function setStatus(text) {
    const toolsStatus = $('pdfToolsStatus');
    const exportStatus = $('pdfExportStatus');
    if (activeDialog === 'export') {
      if (exportStatus) {
        exportStatus.textContent = text || '';
      }
      return;
    }
    if (toolsStatus) {
      toolsStatus.textContent = text || '';
    }
  }

  function setBusy(next) {
    busy = next;
    for (const id of dialogIds()) {
      const overlay = $(id);
      const dialog = overlay?.querySelector('.office-pdf-tools-dialog');
      dialog?.classList.toggle('is-busy', next && !overlay.hidden);
      for (const btn of overlay?.querySelectorAll('button[data-pdf-tool-action]') || []) {
        btn.disabled = next || (!isProUser() && btn.dataset.requirePro !== '0');
      }
    }
  }

  function applyProLock() {
    const locked = !isProUser();
    for (const id of dialogIds()) {
      const overlay = $(id);
      const dialog = overlay?.querySelector('.office-pdf-tools-dialog');
      if (!dialog) {
        continue;
      }
      dialog.classList.toggle('is-locked', locked);
      for (const btn of dialog.querySelectorAll('button[data-pdf-tool-action]')) {
        const requirePro = btn.dataset.requirePro !== '0';
        btn.disabled = busy || (locked && requirePro);
      }
    }
    const toolsUpgrade = $('pdfToolsUpgrade');
    const exportUpgrade = $('pdfExportUpgrade');
    if (toolsUpgrade) {
      toolsUpgrade.hidden = !locked;
    }
    if (exportUpgrade) {
      exportUpgrade.hidden = !locked;
    }
  }

  function syncMergeList() {
    const list = $('pdfToolsMergeList');
    if (!list) {
      return;
    }
    while (list.firstChild) {
      list.removeChild(list.firstChild);
    }
    if (includeCurrent && fileName) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = `${fileName} (current)`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        includeCurrent = false;
        syncMergeList();
      });
      li.appendChild(name);
      li.appendChild(remove);
      list.appendChild(li);
    }
    for (let i = 0; i < mergeUris.length; i++) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = mergeNames[i] || mergeUris[i];
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      const index = i;
      remove.addEventListener('click', () => {
        mergeUris.splice(index, 1);
        mergeNames.splice(index, 1);
        syncMergeList();
      });
      li.appendChild(name);
      li.appendChild(remove);
      list.appendChild(li);
    }
  }

  function defaultPages() {
    const current = window.PDFViewerApplication?.page || 1;
    return String(current);
  }

  function allPages() {
    return pageCount > 1 ? `1-${pageCount}` : '1';
  }

  function metaText() {
    return fileName
      ? `${fileName} · ${pageCount} page${pageCount === 1 ? '' : 's'}`
      : `${pageCount} page${pageCount === 1 ? '' : 's'}`;
  }

  function fillDefaults() {
    const pagesInputs = document.querySelectorAll('[data-pdf-pages]');
    for (const input of pagesInputs) {
      if (!input.value) {
        input.value = input.dataset.defaultAll === '1' ? allPages() : defaultPages();
      }
    }
    const orderInput = $('pdfToolsOrder');
    if (orderInput && !orderInput.value) {
      const order = [];
      for (let i = 1; i <= pageCount; i++) {
        order.push(String(i));
      }
      orderInput.value = order.join(',');
    }
    const toolsMeta = $('pdfToolsMeta');
    const exportMeta = $('pdfExportMeta');
    const text = metaText();
    if (toolsMeta) {
      toolsMeta.textContent = text;
    }
    if (exportMeta) {
      exportMeta.textContent = text;
    }
    syncMergeList();
  }

  function switchToolsTab(tabId) {
    const overlay = $('pdf-tools-dialog');
    if (!overlay) {
      return;
    }
    for (const tab of overlay.querySelectorAll('.office-pdf-tools-tab')) {
      tab.classList.toggle('active', tab.dataset.tab === tabId);
    }
    for (const panel of overlay.querySelectorAll('.office-pdf-tools-panel')) {
      panel.hidden = panel.dataset.panel !== tabId;
    }
  }

  function prepareDialogState() {
    pageCount = window.PDFViewerApplication?.pagesCount || pageCount || 1;
    for (const input of document.querySelectorAll('[data-pdf-pages]')) {
      input.value = '';
    }
    const orderInput = $('pdfToolsOrder');
    if (orderInput) {
      orderInput.value = '';
    }
    fillDefaults();
    applyProLock();
    setStatus('');
  }

  function closeAllDialogs() {
    for (const id of dialogIds()) {
      const overlay = $(id);
      if (overlay) {
        overlay.hidden = true;
      }
    }
    activeDialog = null;
    setBusy(false);
    const toolsStatus = $('pdfToolsStatus');
    const exportStatus = $('pdfExportStatus');
    if (toolsStatus) {
      toolsStatus.textContent = '';
    }
    if (exportStatus) {
      exportStatus.textContent = '';
    }
  }

  function openToolsDialog() {
    closeAllDialogs();
    includeCurrent = true;
    mergeUris = [];
    mergeNames = [];
    prepareDialogState();
    switchToolsTab('pages');
    const overlay = getOverlay('tools');
    if (!overlay) {
      return;
    }
    activeDialog = 'tools';
    overlay.hidden = false;
    window.vscodeEvent?.emit('pdfTool.getInfo');
  }

  function openExportDialog() {
    closeAllDialogs();
    prepareDialogState();
    const overlay = getOverlay('export');
    if (!overlay) {
      return;
    }
    activeDialog = 'export';
    overlay.hidden = false;
    window.vscodeEvent?.emit('pdfTool.getInfo');
  }

  function runAction(action, extra = {}) {
    if (!isProUser()) {
      window.vscodeEvent?.emit('openProPanel');
      return;
    }
    setBusy(true);
    setStatus('Working…');
    window.vscodeEvent?.emit('pdfTool.run', { action, ...extra });
  }

  function readPages(id) {
    return ($(id)?.value || '').trim();
  }

  async function exportImages() {
    if (!isProUser()) {
      window.vscodeEvent?.emit('openProPanel');
      return;
    }
    const pdfDocument = window.PDFViewerApplication?.pdfDocument;
    if (!pdfDocument) {
      setStatus('PDF is not loaded');
      return;
    }
    const format = ($('pdfToolsImageFormat')?.value || 'png') === 'jpg' ? 'jpg' : 'png';
    const pagesSpec = readPages('pdfToolsExportPages') || allPages();
    let indexes;
    try {
      indexes = parsePageRangesClient(pagesSpec, pdfDocument.numPages);
    } catch (error) {
      setStatus(error.message || String(error));
      return;
    }
    setBusy(true);
    setStatus(`Rendering ${indexes.length} page(s)…`);
    try {
      const images = [];
      const baseName = (fileName || 'page').replace(/\.pdf$/i, '');
      for (const index of indexes) {
        const page = await pdfDocument.getPage(index + 1);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
        const quality = format === 'jpg' ? 0.92 : undefined;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
        if (!blob) {
          throw new Error('Failed to encode image');
        }
        const buffer = new Uint8Array(await blob.arrayBuffer());
        images.push({
          name: `${baseName}-p${index + 1}.${format}`,
          data: Array.from(buffer),
        });
      }
      window.vscodeEvent?.emit('pdfTool.saveImages', { format, images });
    } catch (error) {
      setBusy(false);
      setStatus(error.message || String(error));
    }
  }

  function parsePageRangesClient(spec, count) {
    const trimmed = (spec || '').trim();
    if (!trimmed) {
      throw new Error('Page range is empty');
    }
    const indexes = new Set();
    for (const part of trimmed.split(',')) {
      const token = part.trim();
      if (!token) {
        continue;
      }
      const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(token);
      if (rangeMatch) {
        let start = parseInt(rangeMatch[1], 10);
        let end = parseInt(rangeMatch[2], 10);
        if (start > end) {
          const tmp = start;
          start = end;
          end = tmp;
        }
        for (let page = start; page <= end; page++) {
          if (page < 1 || page > count) {
            throw new Error(`Page ${page} is out of range (1–${count})`);
          }
          indexes.add(page - 1);
        }
        continue;
      }
      if (!/^\d+$/.test(token)) {
        throw new Error(`Invalid page range: "${token}"`);
      }
      const page = parseInt(token, 10);
      if (page < 1 || page > count) {
        throw new Error(`Page ${page} is out of range (1–${count})`);
      }
      indexes.add(page - 1);
    }
    if (!indexes.size) {
      throw new Error('No pages selected');
    }
    return Array.from(indexes).sort((a, b) => a - b);
  }

  function watermarkPayload() {
    const preset = $('pdfToolsWatermarkPreset')?.value || 'CONFIDENTIAL';
    let text = preset;
    if (preset === 'custom') {
      text = ($('pdfToolsWatermarkCustom')?.value || '').trim();
    } else if (preset === 'DATE') {
      text = new Date().toISOString().slice(0, 10);
    } else if (preset === 'USER') {
      text = 'USER';
    }
    const opacity = parseFloat($('pdfToolsWatermarkOpacity')?.value || '0.25');
    return {
      watermarkText: text,
      watermarkOpacity: Number.isFinite(opacity) ? opacity : 0.25,
      pageNumberFormat: $('pdfToolsPageFormat')?.value || '{n}/{total}',
      pageNumberPosition: $('pdfToolsPagePosition')?.value || 'bottom-center',
    };
  }

  function bindOverlayChrome(overlayId, closeId, upgradeId) {
    const overlay = $(overlayId);
    if (!overlay) {
      return;
    }
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        closeAllDialogs();
      }
    });
    $(closeId)?.addEventListener('click', closeAllDialogs);
    $(upgradeId)?.addEventListener('click', () => {
      window.vscodeEvent?.emit('openProPanel');
    });
  }

  function bindActions() {
    bindOverlayChrome('pdf-tools-dialog', 'pdfToolsClose', 'pdfToolsUpgrade');
    bindOverlayChrome('pdf-export-dialog', 'pdfExportClose', 'pdfExportUpgrade');

    const toolsOverlay = $('pdf-tools-dialog');
    for (const tab of toolsOverlay?.querySelectorAll('.office-pdf-tools-tab') || []) {
      tab.addEventListener('click', () => switchToolsTab(tab.dataset.tab));
    }

    $('pdfToolsAddPdfs')?.addEventListener('click', () => {
      if (!isProUser()) {
        window.vscodeEvent?.emit('openProPanel');
        return;
      }
      window.vscodeEvent?.emit('pdfTool.pickPdfs');
    });

    $('pdfToolsMerge')?.addEventListener('click', () => {
      runAction('merge', {
        mergeUris,
        excludeCurrent: !includeCurrent,
      });
    });

    $('pdfToolsSplitRange')?.addEventListener('click', () => {
      runAction('splitRange', { pages: readPages('pdfToolsSplitPages') });
    });

    $('pdfToolsSplitEach')?.addEventListener('click', () => {
      runAction('splitEachPage');
    });

    $('pdfToolsReorder')?.addEventListener('click', () => {
      runAction('reorderPages', { order: ($('pdfToolsOrder')?.value || '').trim() });
    });

    $('pdfToolsDelete')?.addEventListener('click', () => {
      runAction('deletePages', { pages: readPages('pdfToolsDeletePages') });
    });

    $('pdfToolsRotate')?.addEventListener('click', () => {
      const degrees = parseInt($('pdfToolsRotateDegrees')?.value || '90', 10);
      runAction('rotatePages', {
        pages: readPages('pdfToolsRotatePages'),
        degrees,
      });
    });

    $('pdfToolsExtract')?.addEventListener('click', () => {
      runAction('extractPages', { pages: readPages('pdfToolsExportPages') });
    });

    $('pdfToolsExportImages')?.addEventListener('click', () => {
      void exportImages();
    });

    $('pdfToolsWatermarkOnly')?.addEventListener('click', () => {
      runAction('watermark', watermarkPayload());
    });

    $('pdfToolsPageNumbersOnly')?.addEventListener('click', () => {
      runAction('pageNumbers', watermarkPayload());
    });

    $('pdfToolsWatermarkAndPages')?.addEventListener('click', () => {
      runAction('watermarkAndPageNumbers', watermarkPayload());
    });

    $('pdfToolsWatermarkPreset')?.addEventListener('change', () => {
      const custom = $('pdfToolsWatermarkCustom');
      if (custom) {
        custom.hidden = $('pdfToolsWatermarkPreset')?.value !== 'custom';
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') {
        return;
      }
      const toolsOpen = $('pdf-tools-dialog') && !$('pdf-tools-dialog').hidden;
      const exportOpen = $('pdf-export-dialog') && !$('pdf-export-dialog').hidden;
      if (toolsOpen || exportOpen) {
        closeAllDialogs();
      }
    });
  }

  function bindMessages() {
    window.vscodeEvent?.on('pdfTool.info', (info) => {
      if (info?.pageCount) {
        pageCount = info.pageCount;
      }
      if (info?.fileName) {
        fileName = info.fileName;
      }
      if (typeof info?.isPro === 'boolean') {
        document.body.classList.toggle('is-pro', info.isPro);
      }
      if (typeof info?.isProCancelled === 'boolean') {
        document.body.classList.toggle('is-pro-cancelled', info.isProCancelled);
      }
      fillDefaults();
      applyProLock();
      if (info?.error) {
        setStatus(info.error);
      }
    });

    window.vscodeEvent?.on('pdfTool.pickedPdfs', (payload) => {
      const uris = payload?.uris || [];
      const names = payload?.names || [];
      for (let i = 0; i < uris.length; i++) {
        if (mergeUris.includes(uris[i])) {
          continue;
        }
        mergeUris.push(uris[i]);
        mergeNames.push(names[i] || uris[i]);
      }
      syncMergeList();
    });

    window.vscodeEvent?.on('pdfTool.result', (result) => {
      setBusy(false);
      if (result?.cancelled) {
        setStatus('Cancelled');
        return;
      }
      if (result?.needPro) {
        applyProLock();
        setStatus('Pro license required');
        return;
      }
      if (result?.ok) {
        setStatus('Done');
        closeAllDialogs();
        return;
      }
      setStatus(result?.error || 'Failed');
    });
  }

  function setupToolbarButton(id, icon, title, onClick) {
    const btn = $(id);
    if (!btn) {
      return;
    }
    btn.innerHTML = icon;
    btn.title = title;
    btn.setAttribute('aria-label', title.replace(/ \(Pro\)$/, ''));
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      onClick();
    });
  }

  function setupPdfTools() {
    if (initialized) {
      return;
    }
    initialized = true;
    setupToolbarButton('pdfExportToggle', EXPORT_ICON, 'PDF Export (Pro)', openExportDialog);
    setupToolbarButton('pdfToolsToggle', TOOLS_ICON, 'PDF Tools (Pro)', openToolsDialog);
    bindActions();
    bindMessages();
    applyProLock();
  }

  global.setupPdfTools = setupPdfTools;
  global.refreshPdfToolsProState = applyProLock;
}(window));
