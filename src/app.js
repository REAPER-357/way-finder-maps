'use strict';
/* Blue Jay Bookmarks UI. Pure logic lives in core.js, networking in sync.js. */
const { NOFOLDER, INCOG, FAV, safeUrl, normalizeUrl, getDomain, folderOf, isUnfiled, newId, validId, cleanFolder } = WF;

// ---------- Storage (all wrapped: storage can fail or be corrupted) ----------
function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); return true; } catch (e) { return false; } }

function makeDefaults() {
  const now = Date.now();
  return [
    { id: 'default-1', name: 'GitHub', url: 'https://github.com/', folder: 'Development', tags: ['Code', 'Work'], isIncognito: false, isFavorite: true, note: 'Code repository platform', dateAdded: now - 100000, updatedAt: now - 100000 },
    { id: 'default-2', name: 'Google Flights', url: 'https://google.com/travel/flights', folder: 'Travel', tags: ['Vacation', 'Flight'], isIncognito: true, isFavorite: false, note: 'Check ticket prices', dateAdded: now - 50000, updatedAt: now - 50000 },
    { id: 'default-3', name: 'MDN Web Docs', url: 'https://developer.mozilla.org/', folder: 'Development', tags: ['Docs', 'Reference'], isIncognito: false, isFavorite: false, note: 'Javascript reference guide', dateAdded: now, updatedAt: now }
  ];
}
function loadBookmarks() {
  try {
    const data = JSON.parse(lsGet('reaper_bookmarks'));
    if (!Array.isArray(data)) return null;
    const seen = new Set(), out = [];
    data.forEach(b => {
      if (!b || !b.name || !b.url) return;
      const id = validId(b.id) && !seen.has(b.id) ? b.id : newId();
      seen.add(id);
      out.push({
        id, name: String(b.name), url: normalizeUrl(b.url) || String(b.url), folder: cleanFolder(b.folder),
        tags: WF.cleanTags(b.tags), isIncognito: !!b.isIncognito, isHidden: !!b.isHidden, isFavorite: !!b.isFavorite, note: b.note ? String(b.note) : '',
        dateAdded: Number(b.dateAdded) || Date.now(), updatedAt: Number(b.updatedAt) || Number(b.dateAdded) || Date.now()
      });
    });
    return out;
  } catch (e) { return null; }
}
function loadTombstones() {
  const out = {};
  try {
    const t = JSON.parse(lsGet('reaper_tombstones'));
    if (t && typeof t === 'object' && !Array.isArray(t)) Object.keys(t).forEach(id => { const at = Number(t[id]); if (validId(id) && at > 0) out[id] = at; });
  } catch (e) {}
  return out;
}
function loadOpenFolders() {
  try { const a = JSON.parse(lsGet('reaper_open_folders')); if (Array.isArray(a)) return new Set(a.map(String)); } catch (e) {}
  return new Set();
}

// ---------- State ----------
let bookmarks = loadBookmarks() || makeDefaults();
let tombstones = loadTombstones();
let viewMode = lsGet('reaper_viewmode') === 'tile' ? 'tile' : 'list';
let currentSort = 'date-desc';
let selectedFolderFilter = 'ALL';
let searchQuery = '';
let toastTimer;
let openFolders = loadOpenFolders();
let selected = new Set();
let visibleItems = [];
let undoSnapshot = null;
let syncCfg = Sync.load();
let vaultOpen = false; // hidden vault unlocked (this session only, never saved)
function pool() { return bookmarks.filter(b => !!b.isHidden === vaultOpen); }
let syncTimer = null;
let syncBusy = false;

// ---------- Helpers ----------
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function touch(b) { b.updatedAt = Math.max(Date.now(), (b.updatedAt || 0) + 1); }
function plugin(name) {
  const C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return null;
  return (C.Plugins && C.Plugins[name]) || null;
}
function persist(noSync) {
  const ok = lsSet('reaper_bookmarks', JSON.stringify(bookmarks));
  lsSet('reaper_tombstones', JSON.stringify(tombstones));
  if (!ok) showToast('Could not save to device storage (is it full?). Export a backup.');
  if (!noSync) scheduleAutoSync(8000);
}
function persistAndRender() { persist(); renderApp(); }
function saveOpenFolders() { lsSet('reaper_open_folders', JSON.stringify([...openFolders])); }
function snapshot() { undoSnapshot = JSON.stringify({ b: bookmarks, t: tombstones }); }
// Deleting records a tombstone so the delete reaches your other devices
function removeByIds(ids) {
  ids = new Set(ids);
  const now = Date.now();
  bookmarks.forEach(b => { if (ids.has(b.id)) tombstones[b.id] = Math.max(now, (b.updatedAt || 0) + 1); });
  bookmarks = bookmarks.filter(b => !ids.has(b.id));
  ids.forEach(id => selected.delete(id));
}
function fallbackIcon(name) {
  const letter = (String(name || '?').trim()[0] || '?').toUpperCase();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="#16a34a"/><text x="16" y="22.5" font-size="18" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">' + escapeHtml(letter) + '</text></svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function showToast(message, withUndo) {
  const toast = document.getElementById('toast');
  document.getElementById('toastMessage').textContent = message;
  document.getElementById('toastUndo').classList.toggle('hidden', !withUndo);
  toast.classList.remove('translate-y-20', 'opacity-0', 'pointer-events-none');
  toast.classList.add('translate-y-0', 'opacity-100');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('translate-y-0', 'opacity-100');
    toast.classList.add('translate-y-20', 'opacity-0', 'pointer-events-none');
  }, withUndo ? 8000 : 3500);
}
function undoLast() {
  if (!undoSnapshot) return;
  let s;
  try { s = JSON.parse(undoSnapshot); } catch (e) { return; }
  undoSnapshot = null;
  const current = new Set(bookmarks.map(b => b.id));
  bookmarks = s.b; tombstones = s.t || {};
  // anything brought back must outrank a delete that other devices may already know about
  bookmarks.forEach(b => { if (!current.has(b.id)) { touch(b); delete tombstones[b.id]; } });
  persistAndRender();
  if (modalOpen('dupModal')) renderDups();
  showToast('Undone');
}

// ---------- Modals & in-app dialogs ----------
function showModal(id) { const m = document.getElementById(id); m.classList.remove('hidden'); m.classList.add('flex'); }
function hideModal(id) { const m = document.getElementById(id); m.classList.remove('flex'); m.classList.add('hidden'); }
function modalOpen(id) { return !document.getElementById(id).classList.contains('hidden'); }
function closeModal() { hideModal('bookmarkModal'); }
function openSettingsModal() { showModal('settingsModal'); }
function closeSettingsModal() { hideModal('settingsModal'); }
function closeDupModal() { hideModal('dupModal'); }
function closeSyncModal() { hideModal('syncModal'); }

let dialogResolve = null, dialogHasInput = false;
function showDialog(opts) {
  return new Promise(resolve => {
    if (dialogResolve) { const prev = dialogResolve; dialogResolve = null; prev(null); }
    document.getElementById('dlgTitle').textContent = opts.title || '';
    document.getElementById('dlgMsg').textContent = opts.message || '';
    const inp = document.getElementById('dlgInput');
    dialogHasInput = !!opts.input;
    inp.classList.toggle('hidden', !opts.input);
    inp.type = opts.input && opts.input.password ? 'password' : 'text';
    inp.setAttribute('inputmode', opts.input && opts.input.password ? 'numeric' : 'text');
    inp.autocomplete = 'off';
    if (opts.input) inp.value = opts.input.value || '';
    const box = document.getElementById('dlgButtons');
    box.innerHTML = '';
    const styles = {
      primary: 'bg-green-600 hover:bg-green-700 text-white',
      danger: 'bg-red-600 hover:bg-red-700 text-white',
      neutral: 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'
    };
    opts.buttons.forEach(b => {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = b.label;
      el.className = 'px-4 py-2 rounded-xl text-sm font-medium transition ' + styles[b.kind || 'neutral'];
      el.addEventListener('click', () => closeDialog(b.value));
      box.appendChild(el);
    });
    dialogResolve = resolve;
    showModal('dialogModal');
    setTimeout(() => { const f = opts.input ? inp : box.lastElementChild; if (f) { f.focus(); if (opts.input) inp.select(); } }, 30);
  });
}
function closeDialog(value) {
  hideModal('dialogModal');
  const r = dialogResolve;
  dialogResolve = null;
  if (!r) return;
  if (dialogHasInput && value === 'ok') value = document.getElementById('dlgInput').value;
  r(value);
}
function confirmDialog(title, message, o) {
  o = o || {};
  return showDialog({ title, message, buttons: [{ label: 'Cancel', value: false }, { label: o.okLabel || 'OK', value: true, kind: o.danger ? 'danger' : 'primary' }] }).then(v => v === true);
}
function promptDialog(title, message, value, okLabel) {
  return showDialog({ title, message, input: { value: value || '' }, buttons: [{ label: 'Cancel', value: null }, { label: okLabel || 'OK', value: 'ok', kind: 'primary' }] });
}
function choiceDialog(title, message, buttons) { return showDialog({ title, message, buttons }); }

// Closes the top-most thing on screen; used by Esc and the Android back button
function closeTopLayer() {
  if (modalOpen('dialogModal')) { closeDialog(null); return true; }
  const ids = ['dupModal', 'syncModal', 'settingsModal', 'bookmarkModal'];
  for (let i = 0; i < ids.length; i++) if (modalOpen(ids[i])) { hideModal(ids[i]); return true; }
  if (selected.size) { clearSelection(); return true; }
  const s = document.getElementById('searchInput');
  if (s.value) { s.value = ''; handleSearch(); return true; }
  if (selectedFolderFilter !== 'ALL') { selectedFolderFilter = 'ALL'; renderApp(); return true; }
  if (vaultOpen) { lockVault(); return true; }
  return false;
}

// ---------- Files (export / share / pick) ----------
async function saveTextFile(filename, text, mime) {
  const FS = plugin('Filesystem'), SH = plugin('Share');
  if (FS && SH) {
    try {
      const r = await FS.writeFile({ path: filename, data: text, directory: 'CACHE', encoding: 'utf8' });
      await SH.share({ title: filename, url: r.uri, dialogTitle: 'Save or send ' + filename });
      return true;
    } catch (e) {
      if (/cancel/i.test(String((e && e.message) || e))) return false;
      /* otherwise fall through to the browser download */
    }
  }
  const blob = new Blob([text], { type: mime || 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
function pickFile() {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json'; inp.style.display = 'none';
    document.body.appendChild(inp);
    let done = false;
    const finish = v => { if (done) return; done = true; inp.remove(); resolve(v); };
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      if (!f) return finish(null);
      const r = new FileReader();
      r.onload = () => finish({ name: f.name, text: String(r.result || '') });
      r.onerror = () => finish(null);
      r.readAsText(f, 'UTF-8');
    });
    inp.addEventListener('cancel', () => finish(null));
    inp.click();
  });
}

// ---------- Init ----------
function init() {
  const saved = lsGet('reaper_theme');
  const isDark = saved === 'dark' || (!saved && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
  updateThemeUI(isDark);
  setViewMode(viewMode, false);
  renderApp();
  updateSyncButton();

  document.getElementById('folderBar').addEventListener('click', e => {
    const b = e.target.closest('[data-folder]');
    if (b) { selectedFolderFilter = b.dataset.folder; renderApp(); }
  });

  const container = document.getElementById('bookmarkContainer');
  container.addEventListener('click', e => {
    if (e.target.closest('input[type="checkbox"]')) return; // handled by 'change'
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const a = b.dataset.action;
    if (a === 'edit') openModal(b.dataset.id);
    else if (a === 'delete') deleteBookmark(b.dataset.id);
    else if (a === 'add') openModal();
    else if (a === 'fav') toggleFavourite(b.dataset.id);
    else if (a === 'toggle-folder') toggleFolder(b.dataset.folder);
    else if (a === 'rename-folder') renameFolder(b.dataset.folder);
    else if (a === 'remove-folder') removeFolder(b.dataset.folder);
  });
  container.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.select) {
      t.checked ? selected.add(t.dataset.select) : selected.delete(t.dataset.select);
      renderBookmarksList();
    } else if (t.dataset.selectFolder !== undefined) {
      const name = t.dataset.selectFolder;
      visibleItems.filter(b => !isUnfiled(b) && folderOf(b) === name).forEach(b => t.checked ? selected.add(b.id) : selected.delete(b.id));
      renderBookmarksList();
    }
  });

  document.getElementById('dupBody').addEventListener('change', e => {
    const id = e.target.dataset.dup;
    if (!id) return;
    e.target.checked ? dupSel.add(id) : dupSel.delete(id);
    updateDupCount();
  });

  ['bookmarkModal', 'settingsModal', 'dupModal', 'syncModal', 'dialogModal'].forEach(id => {
    document.getElementById(id).addEventListener('mousedown', e => {
      if (e.target.id !== id) return;
      if (id === 'dialogModal') closeDialog(null); else hideModal(id);
    });
  });
  document.getElementById('dlgInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); closeDialog('ok'); } });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeTopLayer(); return; }
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
      e.preventDefault();
      document.getElementById('searchInput').focus();
    }
  });

  // Favicon missing (offline or blocked): show a coloured letter instead
  document.addEventListener('error', e => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.dataset && t.dataset.fb !== undefined && !t.dataset.done) { t.dataset.done = '1'; t.src = fallbackIcon(t.dataset.fb); }
  }, true);

  // Links open in the phone's browser, not inside the app
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href][target="_blank"]');
    if (!a || !/^https?:/i.test(a.href)) return;
    const B = plugin('Browser');
    if (B && B.open) { e.preventDefault(); B.open({ url: a.href }); }
  }, true);

  // Android back button: close the top layer first, leave the app last
  const AppP = plugin('App');
  if (AppP && AppP.addListener) AppP.addListener('backButton', () => { if (!closeTopLayer()) AppP.exitApp(); });

  // Auto sync triggers
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') lockVault();
    if (document.visibilityState === 'visible' && Date.now() - (syncCfg.lastSync || 0) > 60000) scheduleAutoSync(500);
  });
  window.addEventListener('online', () => scheduleAutoSync(1000));
  scheduleAutoSync(1500);
}

function renderApp() {
  if (selectedFolderFilter === INCOG) {
    if (!pool().some(b => b.isIncognito)) selectedFolderFilter = 'ALL';
  } else if (selectedFolderFilter === FAV) {
    if (!pool().some(b => b.isFavorite)) selectedFolderFilter = 'ALL';
  } else if (selectedFolderFilter !== 'ALL' && !pool().some(b => folderOf(b) === selectedFolderFilter)) {
    selectedFolderFilter = 'ALL';
  }
  renderFoldersBar();
  renderBookmarksList();
  updateFolderSuggestions();
}

// ---------- Folder bar ----------
function renderFoldersBar() {
  const folders = [...new Set(pool().map(folderOf))];
  const incogCount = pool().filter(b => b.isIncognito).length;
  const favCount = pool().filter(b => b.isFavorite).length;
  const chips = [{ key: 'ALL', label: 'ALL', icon: 'ic-layers', count: pool().length }];
  if (favCount) chips.push({ key: FAV, label: 'Favourites', icon: 'ic-star', count: favCount });
  if (incogCount) chips.push({ key: INCOG, label: 'Incognito', icon: 'ic-venetian-mask', count: incogCount });
  folders.forEach(f => chips.push({ key: f, label: f, icon: 'ic-folder', count: pool().filter(b => folderOf(b) === f).length }));

  document.getElementById('folderBar').innerHTML = chips.map(c => {
    const active = selectedFolderFilter === c.key;
    return `<button data-folder="${escapeHtml(c.key)}" class="whitespace-nowrap px-4 py-2 rounded-xl text-sm font-medium transition flex items-center space-x-2 shadow-sm ${
      active ? 'bg-green-600 text-white shadow-green-500/20'
             : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'}">
      <i class="ic ${c.icon}"></i><span>${escapeHtml(c.label)}</span>
      <span class="text-xs px-1.5 py-0.5 rounded-full ${active ? 'bg-green-700 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}">${c.count}</span>
    </button>`;
  }).join('');
}

// ---------- Bookmark list ----------
function renderBookmarksList() {
  const container = document.getElementById('bookmarkContainer');
  const q = searchQuery.toLowerCase();

  const filtered = pool().filter(bm => {
    if (selectedFolderFilter === INCOG) { if (!bm.isIncognito) return false; }
    else if (selectedFolderFilter === FAV) { if (!bm.isFavorite) return false; }
    else if (selectedFolderFilter !== 'ALL' && folderOf(bm) !== selectedFolderFilter) return false;
    if (!q) return true;
    const hay = [bm.name, getDomain(bm.url), (bm.tags || []).join(' '), bm.note, folderOf(bm), bm.isIncognito ? 'incognito' : '', bm.isFavorite ? 'favourite favorite' : '']
      .join(' ').toLowerCase();
    return hay.includes(q);
  });
  filtered.sort((a, b) => {
    if (currentSort === 'date-desc') return b.dateAdded - a.dateAdded;
    if (currentSort === 'date-asc') return a.dateAdded - b.dateAdded;
    if (currentSort === 'alpha-asc') return a.name.localeCompare(b.name);
    return b.name.localeCompare(a.name);
  });
  visibleItems = filtered;

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="bg-white dark:bg-gray-800 rounded-2xl p-12 text-center border border-gray-200 dark:border-gray-700 shadow-sm flex flex-col items-center justify-center">
        <div class="w-16 h-16 bg-gray-100 dark:bg-gray-700 rounded-full flex items-center justify-center text-gray-400 mb-4 text-2xl"><i class="ic ic-bookmark"></i></div>
        <h3 class="text-lg font-bold mb-1">No bookmarks found</h3>
        <p class="text-sm text-gray-500 dark:text-gray-400 max-w-sm mb-6">Try adjusting your search or folder filter, or create a new bookmark.</p>
        <button data-action="add" class="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-xl text-sm font-medium shadow-sm transition">Add Bookmark</button>
      </div>`;
    updateSelectionBar();
    return;
  }

  if (viewMode === 'list') {
    const force = !!q || selectedFolderFilter !== 'ALL'; // folders open while searching/filtering
    container.innerHTML = renderTree(filtered, force);
    container.querySelectorAll('input[data-select-folder]').forEach(cb => {
      const ids = filtered.filter(b => !isUnfiled(b) && folderOf(b) === cb.dataset.selectFolder).map(b => b.id);
      const n = ids.filter(id => selected.has(id)).length;
      cb.checked = n > 0 && n === ids.length;
      cb.indeterminate = n > 0 && n < ids.length;
    });
  } else {
    const header = (name, count) => `
      <div class="flex items-center space-x-2 text-sm font-bold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 pb-2">
        <i class="ic ic-folder-open text-green-600"></i><span>${escapeHtml(name)}</span>
        <span class="text-xs bg-gray-200 dark:bg-gray-700 px-2 py-0.5 rounded-full text-gray-600 dark:text-gray-300">${count}</span>
      </div>`;
    const grouped = {};
    filtered.forEach(bm => { const k = isUnfiled(bm) ? NOFOLDER : folderOf(bm); (grouped[k] = grouped[k] || []).push(bm); });
    container.innerHTML = Object.keys(grouped).map(f =>
      `<div class="space-y-3">${header(f, grouped[f].length)}${renderTiles(grouped[f])}</div>`).join('');
  }
  updateSelectionBar();
}

function favicon(bm, cls) {
  const d = encodeURIComponent(getDomain(bm.url));
  return `<img src="https://www.google.com/s2/favicons?domain=${d}&sz=32" alt="" loading="lazy" referrerpolicy="no-referrer" data-fb="${escapeHtml(bm.name)}" class="${cls}">`;
}
const incogBadge = '<span class="bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 text-xs px-2 py-0.5 rounded-full font-medium flex items-center space-x-1 flex-shrink-0"><i class="ic ic-venetian-mask text-[10px]"></i><span>Incognito</span></span>';
const tagChip = t => `<span class="bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-[10px] px-2 py-0.5 rounded-md font-medium">#${escapeHtml(t)}</span>`;
const btn = (action, id, icon, hover, pad, title) =>
  `<button data-action="${action}" data-id="${escapeHtml(id)}" class="${pad} rounded-lg bg-gray-100 dark:bg-gray-700 ${hover} text-gray-600 dark:text-gray-300 transition" title="${title}" aria-label="${title}"><i class="ic ${icon} text-xs"></i></button>`;
const editHover = 'hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:text-blue-600';
const delHover = 'hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-600';
function starBtn(bm, pad) {
  const on = !!bm.isFavorite;
  return `<button data-action="fav" data-id="${escapeHtml(bm.id)}" class="${pad} rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-amber-50 dark:hover:bg-amber-900/30 transition ${on ? 'text-amber-500' : 'text-gray-400 dark:text-gray-400'}" title="${on ? 'Remove from favourites' : 'Add to favourites'}" aria-label="${on ? 'Remove from favourites' : 'Add to favourites'}"><i class="ic ic-${on ? 'star-filled' : 'star'} text-xs"></i></button>`;
}

// ---------- Tree view ----------
function rowHtml(bm, nested) {
  const href = escapeHtml(safeUrl(bm.url));
  const sel = selected.has(bm.id);
  const tip = [bm.note, (bm.tags || []).map(t => '#' + t).join(' ')].filter(Boolean).join(' - ');
  return `
  <div class="flex items-center gap-3 py-2 pr-3 ${nested ? 'pl-10' : 'pl-3'} ${sel ? 'bg-green-50 dark:bg-green-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'} transition"${tip ? ` title="${escapeHtml(tip)}"` : ''}>
    <input type="checkbox" data-select="${escapeHtml(bm.id)}" ${sel ? 'checked' : ''} class="w-4 h-4 accent-green-600 cursor-pointer flex-shrink-0" aria-label="Select ${escapeHtml(bm.name)}">
    ${favicon(bm, 'w-5 h-5 rounded bg-gray-100 dark:bg-gray-700 flex-shrink-0')}
    <div class="flex-1 min-w-0 flex items-baseline gap-2">
      <a href="${href}" target="_blank" rel="noopener noreferrer" class="font-medium text-sm truncate hover:text-green-600 dark:hover:text-green-400 transition">${escapeHtml(bm.name)}</a>
      ${bm.isIncognito ? '<i class="ic ic-venetian-mask text-purple-500 text-xs flex-shrink-0" title="Incognito only"></i>' : ''}
      <span class="hidden md:inline text-xs text-gray-400 truncate">${escapeHtml(getDomain(bm.url))}</span>
    </div>
    <div class="flex items-center gap-1 flex-shrink-0">
      ${starBtn(bm, 'p-2')}
      <a href="${href}" target="_blank" rel="noopener noreferrer" class="p-2 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-green-50 dark:hover:bg-green-900/30 hover:text-green-600 text-gray-600 dark:text-gray-300 transition" title="Open link" aria-label="Open link"><i class="ic ic-external-link text-xs"></i></a>
      ${btn('edit', bm.id, 'ic-pencil', editHover, 'p-2', 'Edit')}
      ${btn('delete', bm.id, 'ic-trash-2', delHover, 'p-2', 'Delete')}
    </div>
  </div>`;
}

function renderTree(items, force) {
  const folders = {}, loose = [];
  items.forEach(b => {
    if (isUnfiled(b)) loose.push(b);
    else { const k = folderOf(b); (folders[k] = folders[k] || []).push(b); }
  });
  const names = Object.keys(folders).sort((a, b) => a.localeCompare(b));

  let html = '';
  names.forEach(n => {
    const list = folders[n];
    const open = force || openFolders.has(n);
    const fbtn = (action, icon, title, hover) => `<button data-action="${action}" data-folder="${escapeHtml(n)}" class="p-1.5 rounded-lg text-gray-400 dark:text-gray-400 ${hover} transition" title="${title}" aria-label="${title}"><i class="ic ${icon} text-[11px]"></i></button>`;
    html += `<div>
      <div data-action="toggle-folder" data-folder="${escapeHtml(n)}" class="flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none bg-gray-50 dark:bg-gray-800/80 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition">
        <input type="checkbox" data-select-folder="${escapeHtml(n)}" class="w-4 h-4 accent-green-600 cursor-pointer flex-shrink-0" aria-label="Select all in ${escapeHtml(n)}">
        <i class="ic ic-chevron-right text-[10px] text-gray-400 w-3 transition-transform ${open ? 'rotate-90' : ''}"></i>
        <i class="ic ${open ? 'ic-folder-open' : 'ic-folder'} text-green-600 w-5 text-center"></i>
        <span class="font-semibold text-sm truncate flex-1 min-w-0">${escapeHtml(n)}</span>
        ${fbtn('rename-folder', 'ic-pencil', 'Rename folder', 'hover:text-blue-600')}
        ${fbtn('remove-folder', 'ic-trash-2', 'Remove folder', 'hover:text-red-600')}
        <span class="text-xs bg-gray-200 dark:bg-gray-700 px-2 py-0.5 rounded-full text-gray-600 dark:text-gray-300">${list.length}</span>
      </div>
      ${open ? `<div class="divide-y divide-gray-100 dark:divide-gray-700 border-t border-gray-100 dark:border-gray-700">${list.map(b => rowHtml(b, true)).join('')}</div>` : ''}
    </div>`;
  });

  if (loose.length) {
    if (names.length) html += `<div class="px-3 py-1.5 text-[11px] uppercase tracking-wider font-semibold text-gray-400 bg-gray-50 dark:bg-gray-800/80"><i class="ic ic-bookmark mr-1"></i>No folder</div>`;
    html += loose.map(b => rowHtml(b, false)).join('');
  }
  return `<div class="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">${html}</div>`;
}

function toggleFolder(name) {
  openFolders.has(name) ? openFolders.delete(name) : openFolders.add(name);
  saveOpenFolders();
  renderBookmarksList();
}
function expandAll() { pool().forEach(b => { if (!isUnfiled(b)) openFolders.add(folderOf(b)); }); saveOpenFolders(); renderBookmarksList(); }
function collapseAll() { openFolders.clear(); saveOpenFolders(); renderBookmarksList(); }

async function renameFolder(name) {
  const val = await promptDialog('Rename folder', 'New name for "' + name + '"', name, 'Rename');
  if (val === null) return;
  let nn = String(val).trim().slice(0, 100);
  if (!nn || nn === name) return;
  if (nn.toLowerCase() === NOFOLDER.toLowerCase() || nn === INCOG || nn === FAV) { showToast('That name is reserved'); return; }
  const existing = pool().map(folderOf).find(f => f.toLowerCase() === nn.toLowerCase() && f !== name);
  if (existing) {
    const ok = await confirmDialog('Merge folders', '"' + existing + '" already exists. Merge "' + name + '" into it?', { okLabel: 'Merge' });
    if (!ok) return;
    nn = existing;
  }
  snapshot();
  pool().forEach(b => { if (folderOf(b) === name) { b.folder = nn; touch(b); } });
  if (openFolders.has(name)) { openFolders.delete(name); openFolders.add(nn); saveOpenFolders(); }
  if (selectedFolderFilter === name) selectedFolderFilter = nn;
  persistAndRender();
  showToast('Folder renamed to "' + nn + '"', true);
}
async function removeFolder(name) {
  const members = pool().filter(b => folderOf(b) === name);
  const choice = await choiceDialog('Remove folder', '"' + name + '" has ' + members.length + ' bookmark' + (members.length === 1 ? '' : 's') + '. What should happen to ' + (members.length === 1 ? 'it' : 'them') + '?', [
    { label: 'Cancel', value: null },
    { label: 'Delete them too', value: 'delete', kind: 'danger' },
    { label: 'Move to No Folder', value: 'move', kind: 'primary' }
  ]);
  if (!choice) return;
  snapshot();
  if (choice === 'move') members.forEach(b => { b.folder = NOFOLDER; touch(b); });
  else removeByIds(members.map(b => b.id));
  openFolders.delete(name); saveOpenFolders();
  persistAndRender();
  showToast(choice === 'move' ? 'Folder removed, bookmarks kept' : 'Folder and bookmarks deleted', true);
}

// ---------- Tile view ----------
function renderTiles(items) {
  return `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
    ${items.map(bm => {
      const href = escapeHtml(safeUrl(bm.url));
      const sel = selected.has(bm.id);
      return `
      <div class="bg-white dark:bg-gray-800 rounded-2xl border ${sel ? 'border-green-500 ring-1 ring-green-500' : 'border-gray-200 dark:border-gray-700'} p-5 shadow-sm hover:shadow-md transition flex flex-col justify-between group">
        <div>
          <div class="flex items-start justify-between mb-3">
            <div class="flex items-center space-x-3 min-w-0">
              <input type="checkbox" data-select="${escapeHtml(bm.id)}" ${sel ? 'checked' : ''} class="w-4 h-4 accent-green-600 cursor-pointer flex-shrink-0" aria-label="Select ${escapeHtml(bm.name)}">
              ${favicon(bm, 'w-9 h-9 rounded-xl bg-gray-100 dark:bg-gray-700 p-1.5 flex-shrink-0')}
              <div class="min-w-0">
                <a href="${href}" target="_blank" rel="noopener noreferrer" class="font-bold text-sm truncate block hover:text-green-600 dark:hover:text-green-400 transition">${escapeHtml(bm.name)}</a>
                <span class="text-xs text-gray-400 truncate block">${escapeHtml(getDomain(bm.url))}</span>
              </div>
            </div>
          </div>
          ${bm.note ? `<p class="text-xs text-gray-500 dark:text-gray-400 mb-3 line-clamp-2"><i class="ic ic-sticky-note mr-1 text-gray-400"></i>${escapeHtml(bm.note)}</p>` : ''}
          <div class="flex items-center space-x-1.5 flex-wrap gap-y-1 mb-4">
            ${bm.isIncognito ? incogBadge : ''}${(bm.tags || []).map(tagChip).join('')}
          </div>
        </div>
        <div class="flex items-center justify-between pt-3 border-t border-gray-100 dark:border-gray-700">
          <a href="${href}" target="_blank" rel="noopener noreferrer" class="text-xs font-semibold text-green-600 dark:text-green-400 hover:underline flex items-center space-x-1">
            <span>Visit Link</span><i class="ic ic-external-link text-[10px]"></i>
          </a>
          <div class="flex items-center space-x-1">
            ${starBtn(bm, 'p-1.5')}
            ${btn('edit', bm.id, 'ic-pencil', editHover, 'p-1.5', 'Edit')}
            ${btn('delete', bm.id, 'ic-trash-2', delHover, 'p-1.5', 'Delete')}
          </div>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

// ---------- Search / sort / view ----------
function handleSearch() { searchQuery = document.getElementById('searchInput').value.trim(); renderBookmarksList(); }
function handleSort() { currentSort = document.getElementById('sortSelect').value; renderBookmarksList(); }
function setViewMode(mode, reRender) {
  if (reRender === undefined) reRender = true;
  viewMode = mode;
  lsSet('reaper_viewmode', mode);
  const base = 'px-3 py-1.5 rounded-lg text-sm font-medium transition flex items-center space-x-1 ';
  const on = 'bg-white dark:bg-gray-800 shadow-sm text-green-600';
  const off = 'text-gray-500 dark:text-gray-400';
  document.getElementById('listViewBtn').className = base + (mode === 'list' ? on : off);
  document.getElementById('tileViewBtn').className = base + (mode === 'tile' ? on : off);
  document.getElementById('treeTools').classList.toggle('hidden', mode !== 'list');
  if (reRender) renderBookmarksList();
}

// ---------- Selection & bulk actions ----------
function updateSelectionBar() {
  const ids = new Set(bookmarks.map(b => b.id));
  selected.forEach(id => { if (!ids.has(id)) selected.delete(id); });
  const bar = document.getElementById('selectionBar');
  document.getElementById('selCount').textContent = selected.size;
  bar.classList.toggle('hidden', selected.size === 0);
  bar.classList.toggle('flex', selected.size > 0);
}
function clearSelection() { selected.clear(); renderBookmarksList(); }
function toggleSelectAllVisible() {
  const allSel = visibleItems.length > 0 && visibleItems.every(b => selected.has(b.id));
  visibleItems.forEach(b => allSel ? selected.delete(b.id) : selected.add(b.id));
  renderBookmarksList();
}
function bulkMove() {
  if (!selected.size) return;
  const input = document.getElementById('moveFolder');
  const wanted = cleanFolder(input.value);
  const existing = pool().map(folderOf).find(f => f.toLowerCase() === wanted.toLowerCase());
  const target = existing || wanted;
  snapshot();
  const n = selected.size;
  bookmarks.forEach(b => { if (selected.has(b.id)) { b.folder = target; touch(b); } });
  if (target !== NOFOLDER) { openFolders.add(target); saveOpenFolders(); }
  selected.clear();
  input.value = '';
  persistAndRender();
  showToast('Moved ' + n + ' bookmark' + (n === 1 ? '' : 's') + ' to "' + target + '"', true);
}
function bulkFavourite() {
  if (!selected.size) return;
  snapshot();
  const chosen = bookmarks.filter(b => selected.has(b.id));
  const makeFav = !chosen.every(b => b.isFavorite);
  chosen.forEach(b => { b.isFavorite = makeFav; touch(b); });
  persistAndRender();
  showToast(makeFav ? 'Added to favourites' : 'Removed from favourites', true);
}
async function bulkDelete() {
  if (!selected.size) return;
  const n = selected.size;
  if (!(await confirmDialog('Delete bookmarks', 'Delete ' + n + ' selected bookmark' + (n === 1 ? '' : 's') + '?', { okLabel: 'Delete', danger: true }))) return;
  snapshot();
  removeByIds([...selected]);
  persistAndRender();
  showToast('Deleted ' + n + ' bookmark' + (n === 1 ? '' : 's'), true);
}
function toggleFavourite(id) {
  const bm = bookmarks.find(b => b.id === id);
  if (!bm) return;
  bm.isFavorite = !bm.isFavorite;
  touch(bm);
  persistAndRender();
}

// ---------- Add / Edit ----------
function openModal(id) {
  document.getElementById('bookmarkForm').reset();
  document.getElementById('bookmarkId').value = '';
  document.getElementById('bmFolder').value = NOFOLDER;
  document.getElementById('bmHidden').checked = vaultOpen;
  document.getElementById('modalTitle').textContent = 'Add New Bookmark';
  if (id) {
    const bm = bookmarks.find(b => b.id === id);
    if (bm) {
      document.getElementById('modalTitle').textContent = 'Edit Bookmark';
      document.getElementById('bookmarkId').value = bm.id;
      document.getElementById('bmName').value = bm.name;
      document.getElementById('bmUrl').value = bm.url;
      document.getElementById('bmFolder').value = folderOf(bm);
      document.getElementById('bmTags').value = (bm.tags || []).join(', ');
      document.getElementById('bmIncognito').checked = !!bm.isIncognito;
      document.getElementById('bmFavorite').checked = !!bm.isFavorite;
      document.getElementById('bmHidden').checked = !!bm.isHidden;
      document.getElementById('bmNote').value = bm.note || '';
    }
  }
  showModal('bookmarkModal');
  setTimeout(() => document.getElementById('bmName').focus(), 30);
}

async function saveBookmark(e) {
  e.preventDefault();
  const id = document.getElementById('bookmarkId').value;
  const name = document.getElementById('bmName').value.trim();
  const url = normalizeUrl(document.getElementById('bmUrl').value);
  const folderRaw = cleanFolder(document.getElementById('bmFolder').value);
  const folder = pool().map(folderOf).find(f => f.toLowerCase() === folderRaw.toLowerCase()) || folderRaw;
  const tags = WF.cleanTags(document.getElementById('bmTags').value.split(','));
  const isIncognito = document.getElementById('bmIncognito').checked;
  const isFavorite = document.getElementById('bmFavorite').checked;
  const isHidden = document.getElementById('bmHidden').checked;
  const note = document.getElementById('bmNote').value.trim();

  if (!name) return;
  if (!url) { showToast('Please enter a valid http(s) URL'); return; }
  if (isHidden && !vaultOpen && !(await ensurePin())) return;

  const key = WF.urlKey(url, 'exact');
  const dup = pool().find(b => WF.urlKey(b.url, 'exact') === key && b.id !== id);
  if (dup && !(await confirmDialog('Already saved', '"' + dup.name + '" already uses this URL. Save anyway?', { okLabel: 'Save anyway' }))) return;

  const now = Date.now();
  if (id) {
    const i = bookmarks.findIndex(b => b.id === id);
    if (i !== -1) { bookmarks[i] = Object.assign({}, bookmarks[i], { name, url, folder, tags, isIncognito, isHidden, isFavorite, note }); touch(bookmarks[i]); }
    showToast('Bookmark updated successfully');
  } else {
    bookmarks.unshift({ id: newId(), name, url, folder, tags, isIncognito, isHidden, isFavorite, note, dateAdded: now, updatedAt: now });
    showToast('Bookmark added successfully');
  }
  if (folder !== NOFOLDER) { openFolders.add(folder); saveOpenFolders(); }
  persistAndRender();
  closeModal();
  if (isHidden !== vaultOpen) showToast(isHidden ? 'Saved to the hidden vault' : 'Moved out of the hidden vault');
}

async function deleteBookmark(id) {
  const bm = bookmarks.find(b => b.id === id);
  if (!bm) return;
  if (!(await confirmDialog('Delete bookmark', 'Delete "' + bm.name + '"?', { okLabel: 'Delete', danger: true }))) return;
  snapshot();
  removeByIds([id]);
  persistAndRender();
  showToast('Bookmark deleted', true);
}
async function deleteAll() {
  if (!bookmarks.length) return;
  if (!(await confirmDialog('Delete everything', 'Delete ALL ' + bookmarks.length + ' bookmarks? If sync is on, the deletion will reach your other devices too.', { okLabel: 'Delete all', danger: true }))) return;
  snapshot();
  removeByIds(bookmarks.map(b => b.id));
  persistAndRender();
  closeSettingsModal();
  showToast('All bookmarks deleted', true);
}
function updateFolderSuggestions() {
  const folders = [...new Set(pool().map(folderOf))];
  document.getElementById('folderSuggestions').innerHTML = folders.map(f => `<option value="${escapeHtml(f)}">`).join('');
}


// ---------- Hidden vault ----------
// The PIN only gates the screen. Hidden bookmarks are NOT encrypted: they are still in the export file,
// the device storage and your sync server. Forgetting the PIN cannot be recovered (clear app data resets it).
const PIN_KEY = 'reaper_pin', PIN_FAIL_KEY = 'reaper_pin_fail';
function bytesToHex(buf) { return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function pinHash(pin, saltHex) {
  const enc = new TextEncoder().encode('wayfinder:' + saltHex + ':' + pin);
  if (window.crypto && crypto.subtle) {
    try {
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
      const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
      return 'p' + bytesToHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
    } catch (e) {}
  }
  let h = 5381; // fallback where WebCrypto is unavailable
  for (let i = 0; i < enc.length; i++) h = ((h * 33) ^ enc[i]) >>> 0;
  return 'f' + h.toString(16);
}
function readPinRecord() { try { const r = JSON.parse(lsGet(PIN_KEY)); return r && r.salt && r.hash ? r : null; } catch (e) { return null; } }
async function savePin(pin) {
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  lsSet(PIN_KEY, JSON.stringify({ salt, hash: await pinHash(pin, salt) }));
}
async function checkPin(pin) { const r = readPinRecord(); return !!r && (await pinHash(pin, r.salt)) === r.hash; }
function validPin(p) { return typeof p === 'string' && /^\d{4,12}$/.test(p); }

// Asks for a new PIN twice. Returns the PIN or null.
async function askNewPin(title) {
  const a = await showDialog({ title, message: 'Choose a PIN of 4 to 12 digits. There is no recovery if you forget it.', input: { value: '', password: true }, buttons: [{ label: 'Cancel', value: null }, { label: 'Next', value: 'ok', kind: 'primary' }] });
  if (a === null) return null;
  if (!validPin(a)) { showToast('PIN must be 4 to 12 digits'); return null; }
  const b = await showDialog({ title: 'Confirm PIN', message: 'Enter the same PIN again.', input: { value: '', password: true }, buttons: [{ label: 'Cancel', value: null }, { label: 'Set PIN', value: 'ok', kind: 'primary' }] });
  if (b === null) return null;
  if (a !== b) { showToast('PINs did not match'); return null; }
  return a;
}
// Makes sure a PIN exists (creating one the first time). Returns true when ready.
async function ensurePin() {
  if (readPinRecord()) return true;
  const pin = await askNewPin('Create a PIN for hidden bookmarks');
  if (!pin) return false;
  await savePin(pin);
  showToast('PIN set');
  return true;
}
function failState() { try { return JSON.parse(lsGet(PIN_FAIL_KEY)) || { n: 0, until: 0 }; } catch (e) { return { n: 0, until: 0 }; } }
async function unlockVault() {
  if (vaultOpen) return;
  if (!readPinRecord()) {
    if (!(await ensurePin())) return;
    enterVault();
    return;
  }
  const f = failState();
  if (f.until > Date.now()) { showToast('Too many tries. Wait ' + Math.ceil((f.until - Date.now()) / 1000) + ' seconds.'); return; }
  const pin = await showDialog({ title: 'Enter PIN', message: '', input: { value: '', password: true }, buttons: [{ label: 'Cancel', value: null }, { label: 'Unlock', value: 'ok', kind: 'primary' }] });
  if (pin === null) return;
  if (await checkPin(String(pin))) { lsSet(PIN_FAIL_KEY, JSON.stringify({ n: 0, until: 0 })); enterVault(); return; }
  const n = (f.n || 0) + 1;
  const wait = n >= 5 ? Math.min(30 * Math.pow(2, n - 5), 3600) * 1000 : 0; // 30s, 60s, 120s ... after 5 misses
  lsSet(PIN_FAIL_KEY, JSON.stringify({ n, until: wait ? Date.now() + wait : 0 }));
  showToast(wait ? 'Wrong PIN. Locked for ' + Math.round(wait / 1000) + ' seconds.' : 'Wrong PIN');
}
function enterVault() {
  vaultOpen = true; selected.clear(); selectedFolderFilter = 'ALL';
  document.getElementById('searchInput').value = ''; searchQuery = '';
  renderApp(); updateVaultUI();
}
function lockVault() {
  if (!vaultOpen) return;
  vaultOpen = false; selected.clear(); selectedFolderFilter = 'ALL'; undoSnapshot = null;
  document.getElementById('searchInput').value = ''; searchQuery = '';
  ['bookmarkModal', 'dupModal'].forEach(hideModal);
  if (modalOpen('dialogModal')) closeDialog(null);
  renderApp(); updateVaultUI();
}
async function changePin() {
  if (!vaultOpen) return;
  const cur = await showDialog({ title: 'Current PIN', message: '', input: { value: '', password: true }, buttons: [{ label: 'Cancel', value: null }, { label: 'Next', value: 'ok', kind: 'primary' }] });
  if (cur === null) return;
  if (!(await checkPin(String(cur)))) { showToast('Wrong PIN'); return; }
  const pin = await askNewPin('New PIN');
  if (!pin) return;
  await savePin(pin);
  showToast('PIN changed');
}
function updateVaultUI() {
  document.getElementById('vaultBanner').classList.toggle('hidden', !vaultOpen);
  document.getElementById('vaultBanner').classList.toggle('flex', vaultOpen);
  document.getElementById('bulkHideLabel').textContent = vaultOpen ? 'Unhide' : 'Hide';
  document.getElementById('bulkHideIcon').className = 'ic mr-1 ' + (vaultOpen ? 'ic-eye' : 'ic-eye-off');
}
async function bulkHide() {
  if (!selected.size) return;
  if (!vaultOpen && !(await ensurePin())) return;
  snapshot();
  const n = selected.size;
  bookmarks.forEach(b => { if (selected.has(b.id)) { b.isHidden = !vaultOpen; touch(b); } });
  selected.clear();
  persistAndRender();
  showToast(vaultOpen ? 'Unhidden ' + n : 'Moved ' + n + ' to the hidden vault', true);
}
// Tap the logo 3 times quickly
let logoTaps = [];
function logoTap() {
  const now = Date.now();
  logoTaps = logoTaps.filter(t => now - t < 1500); logoTaps.push(now);
  if (logoTaps.length >= 3) { logoTaps = []; vaultOpen ? lockVault() : unlockVault(); }
}

// ---------- Duplicate finder ----------
let dupMode = 'exact';
let dupLevel = 'normal';
let dupSel = new Set();

function openDupModal() { dupSel.clear(); showModal('dupModal'); renderDups(); }
function setDupMode(mode) { dupMode = mode; dupSel.clear(); renderDups(); }
function setDupLevel() { dupLevel = document.getElementById('dupLevel').value; dupSel.clear(); renderDups(); }
function updateDupCount() { document.getElementById('dupSelCount').textContent = dupSel.size; }

function renderDups() {
  const base = 'px-3 py-1.5 rounded-lg text-sm font-medium transition ';
  const on = 'bg-white dark:bg-gray-800 shadow-sm text-green-600';
  const off = 'text-gray-500 dark:text-gray-400';
  document.getElementById('dupExactBtn').className = base + (dupMode === 'exact' ? on : off);
  document.getElementById('dupDomainBtn').className = base + (dupMode === 'domain' ? on : off);
  document.getElementById('dupLevel').classList.toggle('hidden', dupMode !== 'domain');
  document.getElementById('dupHelp').textContent = dupMode === 'exact'
    ? 'Exact copies: the same page saved more than once. http/https, "www.", a trailing slash and #anchors are ignored; the path and ?query must match.'
    : 'Same site, slight differences: links to the same place that differ by a character or two (a typo, a trailing letter, a different page number). Exact copies are not listed here, use "Exact copies" for those.';

  const ids = new Set(bookmarks.map(b => b.id));
  dupSel.forEach(id => { if (!ids.has(id)) dupSel.delete(id); });

  const groups = WF.findDuplicateGroups(pool(), dupMode, dupLevel);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  document.getElementById('dupSummary').textContent = groups.length ? groups.length + ' group' + (groups.length === 1 ? '' : 's') + ', ' + total + ' bookmarks' : '';

  const body = document.getElementById('dupBody');
  if (!groups.length) {
    body.innerHTML = `<div class="text-center py-10 text-gray-500 dark:text-gray-400">
      <div class="w-14 h-14 mx-auto mb-3 bg-green-50 dark:bg-green-900/30 text-green-600 rounded-full flex items-center justify-center text-xl"><i class="ic ic-check"></i></div>
      <p class="font-semibold">Nothing found</p>
      <p class="text-xs mt-1">${dupMode === 'exact' ? 'No page is saved twice.' : 'No near-identical links found at this level. Try a looser level.'}</p></div>`;
  } else {
    const chip = (text, cls) => `<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded ${cls}">${text}</span>`;
    body.innerHTML = groups.map(g => `
      <div class="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
        <div class="px-3 py-2 bg-gray-50 dark:bg-gray-900 text-xs font-semibold text-gray-600 dark:text-gray-300 flex items-center justify-between gap-2">
          <span class="truncate">${escapeHtml(g.key)}</span><span class="flex-shrink-0">${g.items.length} items</span>
        </div>
        <div class="divide-y divide-gray-100 dark:divide-gray-700">
          ${g.items.map(b => {
            const r = g.rel[b.id] || {};
            let tag = '';
            if (r.keep) tag = chip('suggested keep', 'text-green-600 bg-green-50 dark:bg-green-900/30');
            else if (r.exact) tag = chip('exact copy', 'text-gray-600 bg-gray-100 dark:bg-gray-700 dark:text-gray-300');
            else if (dupMode === 'domain') tag = chip(r.dist <= 3 ? 'differs by ' + r.dist + ' character' + (r.dist === 1 ? '' : 's') : 'different page', 'text-amber-700 bg-amber-50 dark:bg-amber-900/30 dark:text-amber-400');
            return `
            <label class="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50">
              <input type="checkbox" data-dup="${escapeHtml(b.id)}" ${dupSel.has(b.id) ? 'checked' : ''} class="w-4 h-4 accent-red-600 flex-shrink-0">
              ${favicon(b, 'w-5 h-5 rounded bg-gray-100 dark:bg-gray-700 flex-shrink-0')}
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium truncate">${escapeHtml(b.name)} ${b.isFavorite ? '<i class="ic ic-star text-amber-500 text-xs"></i>' : ''} ${tag}</div>
                <div class="text-xs text-gray-400 truncate">${escapeHtml(b.url)}</div>
              </div>
              <span class="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0 hidden sm:inline"><i class="ic ic-folder mr-1"></i>${escapeHtml(folderOf(b))}</span>
            </label>`;
          }).join('')}
        </div>
      </div>`).join('');
  }
  document.getElementById('dupBody').dataset.mode = dupMode;
  updateDupCount();
}

function autoSelectDups() {
  dupSel.clear();
  WF.findDuplicateGroups(pool(), dupMode, dupLevel).forEach(g => {
    g.items.forEach(b => {
      const r = g.rel[b.id];
      if (r.keep) return;
      if (dupMode === 'exact' || r.exact || r.dist <= 3) dupSel.add(b.id); // never auto-pick "different page" matches
    });
  });
  renderDups();
}

async function deleteSelectedDups() {
  if (!dupSel.size) { showToast('Nothing selected'); return; }
  const groups = WF.findDuplicateGroups(pool(), dupMode, dupLevel);
  const wiped = groups.filter(g => g.items.every(b => dupSel.has(b.id))).length;
  let msg = 'Delete ' + dupSel.size + ' selected bookmark' + (dupSel.size === 1 ? '' : 's') + '?';
  if (wiped) msg += '\n\nWarning: ' + wiped + ' group' + (wiped === 1 ? ' has' : 's have') + ' every item selected, so no copy will be kept.';
  if (!(await confirmDialog('Delete duplicates', msg, { okLabel: 'Delete', danger: true }))) return;

  snapshot();
  if (document.getElementById('dupMerge').checked) {
    groups.forEach(g => {
      const kept = g.items.find(b => !dupSel.has(b.id));
      if (!kept) return;
      let changed = false;
      g.items.filter(b => dupSel.has(b.id)).forEach(d => {
        const have = new Set((kept.tags || []).map(t => t.toLowerCase()));
        (d.tags || []).forEach(t => { if (!have.has(t.toLowerCase())) { kept.tags = (kept.tags || []).concat(t); have.add(t.toLowerCase()); changed = true; } });
        if (d.isFavorite && !kept.isFavorite) { kept.isFavorite = true; changed = true; }
        if (d.isIncognito && !kept.isIncognito) { kept.isIncognito = true; changed = true; }
        if (!kept.note && d.note) { kept.note = d.note; changed = true; }
        if (isUnfiled(kept) && !isUnfiled(d)) { kept.folder = d.folder; changed = true; }
        if (d.dateAdded < kept.dateAdded) { kept.dateAdded = d.dateAdded; changed = true; }
      });
      if (changed) touch(kept);
    });
  }
  const n = dupSel.size;
  removeByIds([...dupSel]);
  dupSel.clear();
  persistAndRender();
  renderDups();
  showToast('Deleted ' + n + ' duplicate' + (n === 1 ? '' : 's'), true);
}

// ---------- Settings ----------
function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  lsSet('reaper_theme', isDark ? 'dark' : 'light');
  updateThemeUI(isDark);
}
function updateThemeUI(isDark) {
  document.getElementById('themeIcon').className = isDark ? 'ic ic-moon text-blue-400' : 'ic ic-sun text-amber-500';
  document.getElementById('themeText').textContent = isDark ? 'Dark' : 'Light';
}

// ---------- Export / Import ----------
async function exportData() {
  const payload = WF.buildSnapshot({ bookmarks, tombstones });
  const ok = await saveTextFile('bluejay_bookmarks_' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(payload, null, 2), 'application/json');
  if (ok) showToast('Bookmarks exported');
}

function importData(e) {
  const input = e.target;
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { showToast('File too large (max 20 MB)'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const text = String(ev.target.result || '');
      const looksHtml = /\.html?$/i.test(file.name) || /^\s*(<!doctype\s+netscape|<dl[\s>])/i.test(text.slice(0, 500));
      let list;
      if (looksHtml) {
        list = WF.parseNetscapeHtml(text);
        if (!list.length) { showToast('No bookmarks found in that file'); input.value = ''; return; }
      } else {
        const parsed = JSON.parse(text);
        list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.bookmarks) ? parsed.bookmarks : null);
        if (!list) { showToast('Invalid file format'); input.value = ''; return; }
      }
      const before = JSON.stringify({ b: bookmarks, t: tombstones });
      const { result, stats } = WF.mergeImport(bookmarks, list, Date.now(), tombstones);
      lsSet('reaper_bookmarks_backup', before); // persistent safety copy
      undoSnapshot = before;                    // quick undo
      bookmarks = result;
      result.forEach(b => { if (tombstones[b.id] && tombstones[b.id] < (b.updatedAt || 0)) delete tombstones[b.id]; });
      persistAndRender();
      closeSettingsModal();
      showToast('Import: ' + stats.added + ' added, ' + stats.merged + ' updated, ' + stats.unchanged + ' already there' + (stats.invalid ? ', ' + stats.invalid + ' skipped' : ''), true);
    } catch (err) {
      showToast('Could not read that file');
    }
    input.value = '';
  };
  reader.onerror = () => { showToast('Could not read file'); input.value = ''; };
  reader.readAsText(file, 'UTF-8');
}

async function restoreBackup() {
  const raw = lsGet('reaper_bookmarks_backup');
  if (!raw) { showToast('No backup available yet'); return; }
  if (!(await confirmDialog('Restore backup', 'Replace your current bookmarks with the backup taken before the last import?', { okLabel: 'Restore', danger: true }))) return;
  try {
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : data.b;
    if (!Array.isArray(list)) throw new Error('bad');
    snapshot();
    const restored = list.map(WF.cloneBookmark);
    bookmarks = restored;
    tombstones = Array.isArray(data) ? tombstones : Object.assign({}, data.t || {});
    bookmarks.forEach(b => { touch(b); delete tombstones[b.id]; }); // your explicit choice should win in sync
    persistAndRender();
    closeSettingsModal();
    showToast('Backup restored', true);
  } catch (err) { showToast('Backup is unreadable'); }
}

// ---------- Sync ----------
const syncCtx = {
  config: () => syncCfg,
  saveConfig: () => Sync.save(syncCfg),
  getState: () => ({ bookmarks, tombstones }),
  apply(merged) { bookmarks = merged.bookmarks; tombstones = merged.tombstones; persist(true); renderApp(); if (modalOpen('dupModal')) renderDups(); },
  pickFile,
  saveFile: (name, text) => saveTextFile(name, text, 'application/json')
};
function saveSyncCfg() { Sync.save(syncCfg); }

function openSyncModal() { updateSyncUI(); showModal('syncModal'); }

function fillInputs() {
  const set = (id, v) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = v || ''; };
  set('fbApiKey', syncCfg.firebase.apiKey); set('fbProjectId', syncCfg.firebase.projectId); set('fbEmail', syncCfg.firebase.email);
  set('sbUrl', syncCfg.supabase.url); set('sbKey', syncCfg.supabase.anonKey); set('sbEmail', syncCfg.supabase.email);
  set('davUrl', syncCfg.webdav.url); set('davUser', syncCfg.webdav.username); set('davPass', syncCfg.webdav.password);
}
function readSyncInputs() {
  const v = id => document.getElementById(id).value.trim();
  const p = syncCfg.provider;
  if (p === 'firebase') {
    const key = v('fbApiKey'), pid = v('fbProjectId');
    if (key !== syncCfg.firebase.apiKey || pid !== syncCfg.firebase.projectId) Sync.signOut(syncCfg); // different project: old login is useless
    syncCfg.firebase.apiKey = key; syncCfg.firebase.projectId = pid;
  } else if (p === 'supabase') {
    const url = v('sbUrl').replace(/\/+$/, ''), key = v('sbKey');
    if (url !== syncCfg.supabase.url || key !== syncCfg.supabase.anonKey) Sync.signOut(syncCfg);
    syncCfg.supabase.url = url; syncCfg.supabase.anonKey = key;
  } else if (p === 'webdav') {
    syncCfg.webdav.url = v('davUrl'); syncCfg.webdav.username = v('davUser'); syncCfg.webdav.password = document.getElementById('davPass').value;
  }
}
function onSyncInputChange() { readSyncInputs(); saveSyncCfg(); updateSyncUI(); scheduleAutoSync(2000); }

function onSyncProviderChange() {
  readSyncInputs();
  syncCfg.provider = document.getElementById('syncProvider').value;
  saveSyncCfg();
  updateSyncUI();
  updateSyncButton();
  scheduleAutoSync(1500);
}
function onSyncAutoChange() {
  syncCfg.auto = document.getElementById('syncAuto').checked;
  saveSyncCfg();
  if (syncCfg.auto) scheduleAutoSync(1000); else clearTimeout(syncTimer);
}

function updateSyncUI() {
  const p = syncCfg.provider;
  document.getElementById('syncProvider').value = p;
  ['off', 'file', 'firebase', 'supabase', 'webdav'].forEach(k => document.getElementById('syncPanel-' + k).classList.toggle('hidden', k !== p));
  fillInputs();

  const desktopFile = Sync.hasFileAccessApi();
  document.getElementById('syncFileDesktop').classList.toggle('hidden', !desktopFile);
  document.getElementById('syncFileName').textContent = syncCfg.file.name ? 'Linked: ' + syncCfg.file.name : 'No file linked yet';
  document.getElementById('syncFileHelp').textContent = desktopFile
    ? 'Pick a .json file inside a folder your cloud app keeps in sync (Google Drive for desktop, Dropbox, Syncthing, OneDrive). Sync reads it, merges, and writes it back. It runs when you press Sync now.'
    : 'On this device, Sync asks you to pick the sync file, merges it with your bookmarks, then lets you save the merged file back (choose the same file to replace it). Keep the file in Drive, Dropbox or a Syncthing folder so your other devices see it. To start, press Export in Settings and save the file there.';

  const signedIn = (p === 'firebase' || p === 'supabase') && Sync.isReady(syncCfg);
  document.querySelectorAll('.sync-account').forEach(el => el.classList.toggle('hidden', signedIn));
  const line = document.getElementById('syncAccountLine');
  line.classList.toggle('hidden', !signedIn);
  if (signedIn) line.textContent = 'Signed in as ' + (p === 'firebase' ? syncCfg.firebase.email : syncCfg.supabase.email);

  document.getElementById('syncCommon').classList.toggle('hidden', p === 'off');
  document.getElementById('syncAutoRow').classList.toggle('hidden', p === 'file');
  document.getElementById('syncAuto').checked = !!syncCfg.auto;
  const nowBtn = document.getElementById('syncNowBtn');
  nowBtn.disabled = syncBusy;
  nowBtn.classList.toggle('opacity-60', syncBusy);

  const st = document.getElementById('syncStatus');
  if (syncBusy) { st.textContent = 'Syncing...'; st.className = 'text-xs text-gray-500 dark:text-gray-400 break-words'; }
  else if (syncCfg.lastError) { st.textContent = 'Last attempt failed: ' + syncCfg.lastError; st.className = 'text-xs text-red-600 dark:text-red-400 break-words'; }
  else if (syncCfg.lastSync) { st.textContent = 'Last synced ' + new Date(syncCfg.lastSync).toLocaleString(); st.className = 'text-xs text-gray-500 dark:text-gray-400 break-words'; }
  else { st.textContent = Sync.isReady(syncCfg) ? 'Ready. Press Sync now.' : (p === 'webdav' ? 'Fill in the address and login, then press Sync now.' : (p === 'file' ? '' : 'Fill in the two fields and sign in.')); st.className = 'text-xs text-gray-500 dark:text-gray-400 break-words'; }
}

function updateSyncButton() {
  const icon = document.getElementById('syncIcon'), dot = document.getElementById('syncDot');
  icon.className = 'ic text-lg ' + (syncBusy ? 'ic-refresh-cw ic-spin' : 'ic-cloud');
  const off = syncCfg.provider === 'off';
  dot.classList.toggle('hidden', off);
  dot.classList.remove('bg-green-500', 'bg-red-500', 'bg-gray-400');
  dot.classList.add(syncCfg.lastError ? 'bg-red-500' : (syncCfg.lastSync ? 'bg-green-500' : 'bg-gray-400'));
}

async function syncSignIn(create) {
  readSyncInputs();
  const p = syncCfg.provider;
  const emailEl = document.getElementById(p === 'firebase' ? 'fbEmail' : 'sbEmail');
  const passEl = document.getElementById(p === 'firebase' ? 'fbPassword' : 'sbPassword');
  const email = emailEl.value.trim(), pw = passEl.value;
  if (!email || !pw) { showToast('Enter your email and password'); return; }
  if (create && pw.length < 6) { showToast('Use a password of at least 6 characters'); return; }
  try {
    await Sync.signIn(syncCfg, { save: saveSyncCfg }, email, pw, create);
    passEl.value = '';
    saveSyncCfg();
    updateSyncUI();
    showToast(create ? 'Account created, signed in' : 'Signed in');
    await syncNow();
  } catch (e) {
    showToast(e.message);
    const st = document.getElementById('syncStatus');
    st.textContent = e.message; st.className = 'text-xs text-red-600 dark:text-red-400 break-words';
    document.getElementById('syncCommon').classList.remove('hidden');
  }
}

async function chooseSyncFile(create) {
  try {
    syncCfg.file.name = await Sync.chooseFile(create);
    saveSyncCfg();
    updateSyncUI();
    showToast('Sync file: ' + syncCfg.file.name);
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    showToast((e && e.message) || 'Could not open that file');
  }
}

async function syncNow(opts) {
  opts = opts || {};
  if (syncCfg.provider === 'off' || syncBusy) return;
  readSyncInputs();
  saveSyncCfg();
  syncBusy = true;
  updateSyncButton(); updateSyncUI();
  try {
    const r = await Sync.run(syncCtx);
    if (r.cancelled) { if (!opts.silent) showToast('Sync cancelled'); }
    else if (!r.skipped && !opts.silent) {
      const p = r.pulled, sent = r.pushed.bookmarks + r.pushed.tombstones;
      const got = p.added + p.updated + p.removed;
      showToast(got || sent ? 'Synced: ' + got + ' change' + (got === 1 ? '' : 's') + ' received, ' + sent + ' sent' : 'Everything is up to date');
    }
  } catch (e) {
    if (!opts.silent && e.code !== 'CANCELLED') showToast(e.message);
    else if (e.code === 'CANCELLED') showToast(e.message);
  } finally {
    syncBusy = false;
    updateSyncButton(); updateSyncUI();
  }
}

function scheduleAutoSync(delay) {
  clearTimeout(syncTimer);
  if (!syncCfg.auto || !Sync.canAuto(syncCfg)) return;
  syncTimer = setTimeout(() => { if (navigator.onLine !== false) syncNow({ silent: true }); }, delay || 8000);
}

async function syncDisconnect() {
  if (!(await confirmDialog('Disconnect sync', 'Stop syncing and sign out on this device? Your bookmarks stay here and on the server.', { okLabel: 'Disconnect' }))) return;
  Sync.signOut(syncCfg);
  syncCfg.webdav.password = '';
  syncCfg.provider = 'off';
  syncCfg.lastError = '';
  saveSyncCfg();
  clearTimeout(syncTimer);
  updateSyncUI(); updateSyncButton();
  showToast('Sync switched off');
}

// ---------- Boot ----------
function boot() {
  init();
  document.querySelectorAll('.sync-in').forEach(el => el.addEventListener('change', onSyncInputChange));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
