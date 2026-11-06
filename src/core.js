/* Blue Jay core: pure logic with no DOM access (except the optional HTML import parser).
 * Works in the browser (window.WF) and in Node (module.exports) so it can be unit-tested. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WF = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NOFOLDER = 'No Folder';
  const INCOG = '__INCOGNITO__';
  const FAV = '__FAVOURITES__';
  const TOMBSTONE_TTL = 180 * 24 * 3600 * 1000; // forget deletions after ~6 months

  // ---------- URLs ----------
  function safeUrl(u) {
    try { const x = new URL(u); return ['http:', 'https:'].includes(x.protocol) ? x.href : '#'; }
    catch (e) { return '#'; }
  }
  function normalizeUrl(raw) {
    raw = String(raw == null ? '' : raw).trim();
    if (!raw) return '';
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    const dangerous = /^(javascript|data|mailto|tel|file|blob|about|vbscript|intent|content):/i.test(raw);
    if (!hasScheme && !dangerous) raw = 'https://' + raw;
    return safeUrl(raw) === '#' ? '' : new URL(raw).href;
  }
  function getDomain(url) { try { return new URL(url).hostname; } catch (e) { return String(url); } }
  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
    catch (e) { return String(url).toLowerCase(); }
  }
  // exact  = same page (ignores http/https, "www.", trailing slash and #hash)
  // domain = same site (hostname without "www.")
  function urlKey(url, mode) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      if (mode === 'domain') return host;
      return host + (u.port ? ':' + u.port : '') + u.pathname.replace(/\/+$/, '') + u.search;
    } catch (e) { return String(url).trim().toLowerCase(); }
  }
  // path + query only, lower-cased, used to compare pages on the same site
  function pathKey(url) {
    try {
      const u = new URL(url);
      return (u.pathname.replace(/\/+$/, '').replace(/\/index\.(html?|php|aspx?)$/i, '') + u.search).toLowerCase();
    } catch (e) { return String(url).toLowerCase(); }
  }

  // ---------- Ids / folders / records ----------
  function validId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) && id !== '__proto__' && id !== 'constructor' && id !== 'prototype';
  }
  function newId() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function folderOf(b) { const f = String((b && b.folder) || '').trim(); return f || NOFOLDER; }
  function isUnfiled(b) { return folderOf(b).toLowerCase() === NOFOLDER.toLowerCase(); }
  function cleanFolder(f) {
    f = String(f == null ? '' : f).trim().slice(0, 100);
    if (!f || f.toLowerCase() === NOFOLDER.toLowerCase() || f === INCOG || f === FAV) return NOFOLDER;
    return f;
  }
  function cleanTags(t) {
    return (Array.isArray(t) ? t : []).map(x => String(x).trim().slice(0, 50)).filter(Boolean).slice(0, 30);
  }
  // Turns untrusted data (import file, remote server) into a clean record, or null if unusable.
  function sanitizeRecord(raw, now) {
    if (!raw || typeof raw !== 'object') return null;
    const url = normalizeUrl(raw.url);
    const name = String(raw.name == null ? '' : raw.name).trim().slice(0, 300);
    if (!url || !name) return null;
    return {
      id: validId(raw.id) ? raw.id : null,
      name, url,
      folder: cleanFolder(raw.folder),
      tags: cleanTags(raw.tags),
      isIncognito: !!raw.isIncognito,
      isHidden: !!raw.isHidden,
      isFavorite: !!(raw.isFavorite || raw.isFavourite),
      note: raw.note ? String(raw.note).slice(0, 2000) : '',
      dateAdded: Number(raw.dateAdded) > 0 ? Number(raw.dateAdded) : (now || 0),
      updatedAt: Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : null
    };
  }
  // Records coming from a sync server must carry a valid id.
  function sanitizeRemote(raw) {
    const r = sanitizeRecord(raw, 0);
    if (!r || !r.id) return null;
    r.updatedAt = r.updatedAt || r.dateAdded || 1;
    if (!r.dateAdded) r.dateAdded = r.updatedAt;
    return r;
  }
  function cloneBookmark(b) { return Object.assign({}, b, { tags: (b.tags || []).slice() }); }

  function canonFields(b) {
    return [b.name, b.url, b.folder, (b.tags || []).join('\u0001'), !!b.isIncognito, !!b.isHidden, !!b.isFavorite, b.note || '', Number(b.dateAdded) || 0];
  }
  function recordEqual(a, b) {
    return (a.updatedAt || 0) === (b.updatedAt || 0) && JSON.stringify(canonFields(a)) === JSON.stringify(canonFields(b));
  }

  // ---------- Edit distance (banded, stops early) ----------
  function editDistanceWithin(a, b, max) {
    a = String(a).slice(0, 200); b = String(b).slice(0, 200);
    if (a === b) return 0;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    let prev = new Array(lb + 1), cur = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
      cur[0] = i;
      let rowMin = cur[0];
      for (let j = 1; j <= lb; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      const t = prev; prev = cur; cur = t;
    }
    return prev[lb];
  }

  // ---------- Duplicate finder ----------
  function keepScore(b) { return (b.isFavorite ? 4 : 0) + (isUnfiled(b) ? 0 : 2); }
  function orderForKeep(items) {
    return items.slice().sort((a, b) => keepScore(b) - keepScore(a) || (a.dateAdded || 0) - (b.dateAdded || 0));
  }
  /* mode 'exact'  : identical pages (same URL ignoring http/https, www, trailing slash, #hash)
   * mode 'domain' : same site, but NOT identical: pages that differ by a few characters
   *                 level 'strict' = up to 1 char, 'normal' = up to 3, 'loose' = any page on the site
   * returns [{ key, items:[keeper first, ...], rel:{ [id]: {keep, exact, dist} } }] */
  function findDuplicateGroups(bookmarks, mode, level) {
    const groups = [];
    if (mode === 'exact') {
      const map = new Map();
      bookmarks.forEach(b => {
        const k = urlKey(b.url, 'exact');
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(b);
      });
      map.forEach((items, k) => {
        if (items.length < 2) return;
        const o = orderForKeep(items), rel = {};
        o.forEach((b, i) => { rel[b.id] = { keep: i === 0, exact: true, dist: 0 }; });
        groups.push({ key: k, items: o, rel });
      });
    } else {
      const T = level === 'strict' ? 1 : level === 'loose' ? Infinity : 3;
      const byHost = new Map();
      bookmarks.forEach(b => {
        const h = hostOf(b.url);
        if (!byHost.has(h)) byHost.set(h, []);
        byHost.get(h).push(b);
      });
      byHost.forEach((list, host) => {
        const n = list.length;
        if (n < 2) return;
        const parent = list.map((_, i) => i);
        const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
        const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
        const keys = list.map(b => urlKey(b.url, 'exact'));
        const paths = list.map(b => pathKey(b.url));
        const names = list.map(b => String(b.name || '').trim().toLowerCase());
        const nt = Math.min(T, 2);
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            if (find(i) === find(j)) continue;
            if (keys[i] === keys[j] || T === Infinity) { union(i, j); continue; }
            if (editDistanceWithin(paths[i], paths[j], T) <= T) { union(i, j); continue; }
            // similar names on the same site count too, as long as the pages are not wildly different
            if (names[i].length >= 4 && names[j].length >= 4 &&
                editDistanceWithin(names[i], names[j], nt) <= nt &&
                editDistanceWithin(paths[i], paths[j], T * 4) <= T * 4) union(i, j);
          }
        }
        const clusters = new Map();
        list.forEach((b, i) => { const r = find(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(b); });
        clusters.forEach(items => {
          if (items.length < 2) return;
          // a cluster of pure exact copies belongs to the "exact" mode, not here
          if (new Set(items.map(b => urlKey(b.url, 'exact'))).size < 2) return;
          const o = orderForKeep(items), rel = {};
          const keeperKey = urlKey(o[0].url, 'exact'), keeperPath = pathKey(o[0].url);
          o.forEach((b, i) => {
            rel[b.id] = {
              keep: i === 0,
              exact: i > 0 && urlKey(b.url, 'exact') === keeperKey,
              dist: i === 0 ? 0 : editDistanceWithin(pathKey(b.url), keeperPath, Infinity)
            };
          });
          groups.push({ key: host, items: o, rel });
        });
      });
    }
    groups.sort((a, b) => a.key.localeCompare(b.key) || String(a.items[0].name).localeCompare(String(b.items[0].name)));
    return groups;
  }

  // ---------- Safe import merge ----------
  /* Nothing existing is overwritten or deleted.
   * - same page already present  -> only empty fields are filled in
   * - new page                   -> added (keeps its id when possible, so devices stay in step)
   * - unusable rows              -> skipped
   * `tombstones` (optional) lets an imported item come back if you had deleted it earlier. */
  function mergeImport(existing, list, now, tombstones) {
    now = now || Date.now();
    const working = existing.map(cloneBookmark);
    const byKey = new Map();
    const usedIds = new Set();
    working.forEach(b => { usedIds.add(b.id); const k = urlKey(b.url, 'exact'); if (!byKey.has(k)) byKey.set(k, b); });
    const folderCase = new Map();
    working.forEach(b => { if (!isUnfiled(b)) folderCase.set(folderOf(b).toLowerCase(), folderOf(b)); });

    const stats = { added: 0, merged: 0, unchanged: 0, invalid: 0 };
    const fresh = [];
    (Array.isArray(list) ? list : []).forEach(raw => {
      const rec = sanitizeRecord(raw, now);
      if (!rec) { stats.invalid++; return; }
      if (rec.folder !== NOFOLDER) {
        const low = rec.folder.toLowerCase();
        if (folderCase.has(low)) rec.folder = folderCase.get(low); else folderCase.set(low, rec.folder);
      }
      const key = urlKey(rec.url, 'exact');
      const ex = byKey.get(key);
      if (ex) {
        let changed = false;
        if (isUnfiled(ex) && rec.folder !== NOFOLDER) { ex.folder = rec.folder; changed = true; }
        const have = new Set((ex.tags || []).map(t => t.toLowerCase()));
        rec.tags.forEach(t => { if (!have.has(t.toLowerCase())) { ex.tags.push(t); have.add(t.toLowerCase()); changed = true; } });
        if (!ex.note && rec.note) { ex.note = rec.note; changed = true; }
        if (rec.isFavorite && !ex.isFavorite) { ex.isFavorite = true; changed = true; }
        if (rec.isIncognito && !ex.isIncognito) { ex.isIncognito = true; changed = true; }
        if (rec.isHidden && !ex.isHidden) { ex.isHidden = true; changed = true; } // privacy only ever tightens
        if (rec.dateAdded < ex.dateAdded) { ex.dateAdded = rec.dateAdded; changed = true; }
        if (changed) { ex.updatedAt = Math.max(now, (ex.updatedAt || 0) + 1); stats.merged++; } else stats.unchanged++;
      } else {
        let id = rec.id;
        if (!id || usedIds.has(id)) { id = newId(); while (usedIds.has(id)) id = newId(); }
        usedIds.add(id);
        let updatedAt = rec.updatedAt || now;
        if (tombstones && tombstones[id] >= updatedAt) updatedAt = Math.max(now, tombstones[id] + 1); // explicit restore
        const item = { id, name: rec.name, url: rec.url, folder: rec.folder, tags: rec.tags, isIncognito: rec.isIncognito, isHidden: rec.isHidden, isFavorite: rec.isFavorite, note: rec.note, dateAdded: rec.dateAdded, updatedAt };
        byKey.set(key, item); // also de-duplicates inside the file itself
        fresh.push(item);
        stats.added++;
      }
    });
    return { result: fresh.concat(working), stats };
  }

  // ---------- Sync merge (last edit wins per bookmark; deletes travel as tombstones) ----------
  function pick(a, b) {
    const ua = a.updatedAt || 0, ub = b.updatedAt || 0;
    if (ua !== ub) return ub > ua ? b : a;
    return JSON.stringify(canonFields(b)) > JSON.stringify(canonFields(a)) ? b : a; // deterministic tie-break
  }
  function mergeStates(L, R, now) {
    now = now || Date.now();
    const tomb = Object.assign({}, L.tombstones || {});
    Object.keys(R.tombstones || {}).forEach(id => {
      const at = Number(R.tombstones[id]) || 0;
      if (!(tomb[id] >= at)) tomb[id] = at;
    });
    const map = new Map();
    (L.bookmarks || []).forEach(b => map.set(b.id, b));
    (R.bookmarks || []).forEach(r => { const l = map.get(r.id); map.set(r.id, l ? pick(l, r) : r); });
    Object.keys(tomb).forEach(id => {
      const b = map.get(id);
      if (!b) return;
      if ((b.updatedAt || 0) <= tomb[id]) map.delete(id); // deleted after its last edit
      else delete tomb[id];                               // edited after the delete: it lives
    });
    Object.keys(tomb).forEach(id => { if (now - tomb[id] > TOMBSTONE_TTL) delete tomb[id]; });
    return { bookmarks: Array.from(map.values()), tombstones: tomb };
  }
  // What the remote side is missing or has out of date
  function diffForPush(merged, remote) {
    const rmap = new Map((remote.bookmarks || []).map(b => [b.id, b]));
    const changed = merged.bookmarks.filter(b => { const r = rmap.get(b.id); return !r || !recordEqual(r, b); });
    const rt = remote.tombstones || {};
    const tombs = Object.keys(merged.tombstones).filter(id => !(rt[id] >= merged.tombstones[id])).map(id => ({ id, at: merged.tombstones[id] }));
    return { changed, tombstones: tombs };
  }
  function diffStats(before, after) {
    const bm = new Map(before.map(b => [b.id, b]));
    const am = new Map(after.map(b => [b.id, b]));
    let added = 0, updated = 0, removed = 0;
    am.forEach((b, id) => { const o = bm.get(id); if (!o) added++; else if (!recordEqual(o, b)) updated++; });
    bm.forEach((b, id) => { if (!am.has(id)) removed++; });
    return { added, updated, removed };
  }

  // ---------- Files ----------
  function buildSnapshot(state) {
    return { app: 'wayfinder', version: 2, exportedAt: Date.now(), bookmarks: state.bookmarks, tombstones: state.tombstones || {} };
  }
  function parseSnapshot(text) {
    text = String(text == null ? '' : text).trim();
    if (!text) return { bookmarks: [], tombstones: {}, dropped: 0 };
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : (j && Array.isArray(j.bookmarks) ? j.bookmarks : null);
    if (!list) throw new Error('This is not a Blue Jay bookmarks file');
    let dropped = 0;
    const seen = new Set(), bookmarks = [];
    list.forEach(raw => {
      const r = sanitizeRemote(raw);
      if (!r || seen.has(r.id)) { dropped++; return; }
      seen.add(r.id); bookmarks.push(r);
    });
    const tombstones = {};
    if (j && j.tombstones && typeof j.tombstones === 'object' && !Array.isArray(j.tombstones)) {
      Object.keys(j.tombstones).forEach(id => { const at = Number(j.tombstones[id]); if (validId(id) && at > 0) tombstones[id] = at; });
    }
    return { bookmarks, tombstones, dropped };
  }

  // Browser bookmark export (Chrome, Edge, Firefox, Safari: "Netscape bookmark file" HTML)
  const ROOT_FOLDERS = new Set(['bookmarks bar', 'bookmarks toolbar', 'bookmarks menu', 'other bookmarks', 'other favorites', 'other favourites',
    'favorites bar', 'favourites bar', 'favorites', 'favourites', 'mobile bookmarks', 'bookmarks', 'reading list']);
  function toMillis(v) {
    let t = Number(v);
    if (!(t > 0)) return 0;
    if (t > 1e14) t = t / 1000;      // microseconds
    else if (t < 1e11) t = t * 1000; // seconds
    return Math.round(t);
  }
  function parseNetscapeHtml(html, DP) {
    DP = DP || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!DP) throw new Error('No HTML parser available');
    const doc = new DP().parseFromString(String(html), 'text/html');
    const top = doc.querySelector('dl');
    if (!top) return [];
    const out = [], used = new Set();
    const kids = (el, tag) => Array.from(el.children).filter(c => c.tagName === tag);
    function childDl(dt) {
      const inside = kids(dt, 'DL')[0];
      if (inside) return inside;
      let n = dt.nextElementSibling;
      while (n && n.tagName === 'P') n = n.nextElementSibling;
      return n && n.tagName === 'DL' && !used.has(n) ? n : null;
    }
    function walk(dl, path, depth) {
      used.add(dl);
      Array.from(dl.children).forEach(el => {
        if (el.tagName !== 'DT') return;
        const h3 = kids(el, 'H3')[0], a = kids(el, 'A')[0];
        if (h3) {
          const name = (h3.textContent || '').trim();
          const sub = childDl(el);
          const isRoot = depth === 0 && ROOT_FOLDERS.has(name.toLowerCase());
          if (sub) walk(sub, isRoot || !name ? path : path.concat(name), depth + 1);
        } else if (a) {
          out.push({
            name: (a.textContent || '').trim() || a.getAttribute('href') || '',
            url: a.getAttribute('href') || '',
            folder: path.join(' / '),
            tags: (a.getAttribute('tags') || '').split(',').map(s => s.trim()).filter(Boolean),
            dateAdded: toMillis(a.getAttribute('add_date'))
          });
        }
      });
    }
    walk(top, [], 0);
    return out;
  }

  return {
    NOFOLDER, INCOG, FAV, TOMBSTONE_TTL,
    safeUrl, normalizeUrl, getDomain, hostOf, urlKey, pathKey,
    validId, newId, folderOf, isUnfiled, cleanFolder, cleanTags, sanitizeRecord, sanitizeRemote, cloneBookmark,
    recordEqual, editDistanceWithin, findDuplicateGroups, mergeImport, mergeStates, diffForPush, diffStats,
    buildSnapshot, parseSnapshot, parseNetscapeHtml
  };
});
