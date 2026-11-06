/* Blue Jay sync: one merge engine, four ways to reach another device.
 *   file      - a JSON file you keep in a synced folder (Drive, Syncthing, Dropbox ...)
 *   firebase  - Google Firestore (your own free Firebase project)
 *   supabase  - Supabase (your own free project)
 *   webdav    - your own server: WebDAV / Nextcloud / anything that accepts GET + PUT
 * Every provider only has to pull() the remote state and push() what is missing there. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.Sync = factory(root.WF);
})(typeof self !== 'undefined' ? self : this, function (WF) {
  'use strict';

  const CONFIG_KEY = 'reaper_sync';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  function defaults() {
    return {
      provider: 'off', auto: true, lastSync: 0, lastError: '',
      file: { name: '' },
      firebase: { apiKey: '', projectId: '', email: '', uid: '', refreshToken: '', idToken: '', idExp: 0 },
      supabase: { url: '', anonKey: '', email: '', userId: '', accessToken: '', refreshToken: '', expiresAt: 0 },
      webdav: { url: '', username: '', password: '' }
    };
  }
  function load() {
    const d = defaults();
    try {
      const s = JSON.parse(store.get(CONFIG_KEY));
      if (s && typeof s === 'object') {
        Object.keys(d).forEach(k => {
          if (s[k] === undefined) return;
          if (d[k] && typeof d[k] === 'object') Object.assign(d[k], s[k]); else d[k] = s[k];
        });
      }
    } catch (e) {}
    return d;
  }
  function save(cfg) { store.set(CONFIG_KEY, JSON.stringify(cfg)); }

  function err(msg, code) { const e = new Error(msg); e.code = code || 'ERROR'; return e; }
  async function request(url, init) {
    try { return await fetch(url, init); }
    catch (e) { throw err("Can't reach the server. Check your internet connection.", 'NETWORK'); }
  }
  async function jsonOf(r) { try { return await r.json(); } catch (e) { return null; } }
  function b64(s) {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  // =====================================================================
  // Firebase (Firestore REST + Identity Toolkit)
  // =====================================================================
  const FB_AUTH_ERRORS = {
    EMAIL_EXISTS: 'That email already has an account. Use Sign in instead.',
    EMAIL_NOT_FOUND: 'No account with that email. Use Create account first.',
    INVALID_PASSWORD: 'Wrong password.',
    INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
    USER_DISABLED: 'That account has been disabled.',
    OPERATION_NOT_ALLOWED: 'Email/password sign-in is switched off in your Firebase project (Authentication, Sign-in method).',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a few minutes and try again.',
    API_KEY_INVALID: 'The API key is not valid for this Firebase project.',
    INVALID_EMAIL: 'That email address is not valid.'
  };
  function fbAuthError(j) {
    const m = (j && j.error && j.error.message) || '';
    const key = Object.keys(FB_AUTH_ERRORS).find(k => m.indexOf(k) === 0 || m.indexOf(k) !== -1);
    if (key) return err(FB_AUTH_ERRORS[key], 'AUTH');
    if (/WEAK_PASSWORD/.test(m)) return err('Password is too weak (use at least 6 characters).', 'AUTH');
    return err(m || 'Sign-in failed.', 'AUTH');
  }
  function fbError(r, j) {
    const m = (j && j.error && j.error.message) || ('HTTP ' + r.status);
    if (r.status === 401) return err('Sign-in expired. Open Sync and sign in again.', 'AUTH');
    if (r.status === 403) return err('Firestore refused access. Check the security rules in your Firebase project (see README).', 'AUTH');
    if (r.status === 404 || /database.*not.*exist|NOT_FOUND/i.test(m)) return err('Firestore database not found. Create a Firestore database in your Firebase project.', 'CONFIG');
    return err('Firebase error: ' + m);
  }
  const fsStr = s => ({ stringValue: String(s == null ? '' : s) });
  const fsInt = n => ({ integerValue: String(Math.trunc(Number(n) || 0)) });
  function fbEncode(b) {
    return {
      name: fsStr(b.name), url: fsStr(b.url), folder: fsStr(b.folder), note: fsStr(b.note),
      tags: { arrayValue: { values: (b.tags || []).map(fsStr) } },
      isIncognito: { booleanValue: !!b.isIncognito }, isHidden: { booleanValue: !!b.isHidden }, isFavorite: { booleanValue: !!b.isFavorite },
      dateAdded: fsInt(b.dateAdded), updatedAt: fsInt(b.updatedAt)
    };
  }
  function fbDecode(d) {
    const f = d.fields || {};
    const s = k => (f[k] && f[k].stringValue != null ? f[k].stringValue : '');
    const n = k => (f[k] ? Number(f[k].integerValue != null ? f[k].integerValue : (f[k].doubleValue || 0)) : 0);
    return {
      id: decodeURIComponent(String(d.name).split('/').pop()),
      name: s('name'), url: s('url'), folder: s('folder'), note: s('note'),
      tags: ((f.tags && f.tags.arrayValue && f.tags.arrayValue.values) || []).map(v => v.stringValue || ''),
      isIncognito: !!(f.isIncognito && f.isIncognito.booleanValue), isHidden: !!(f.isHidden && f.isHidden.booleanValue), isFavorite: !!(f.isFavorite && f.isFavorite.booleanValue),
      dateAdded: n('dateAdded'), updatedAt: n('updatedAt')
    };
  }
  function firebaseProvider(cfg, hooks) {
    const c = cfg.firebase;
    const ready = () => c.apiKey && c.projectId;
    const base = () => 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(c.projectId) + '/databases/(default)/documents';
    const docRoot = () => 'projects/' + c.projectId + '/databases/(default)/documents/users/' + c.uid;

    async function idToken(force) {
      if (!force && c.idToken && c.idExp > Date.now() + 60000) return c.idToken;
      if (!c.refreshToken) throw err('Not signed in. Open Sync and sign in.', 'AUTH');
      const r = await request('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(c.apiKey), {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(c.refreshToken)
      });
      const j = await jsonOf(r);
      if (!r.ok) throw err('Sign-in expired. Open Sync and sign in again.', 'AUTH');
      c.idToken = j.id_token; c.refreshToken = j.refresh_token || c.refreshToken;
      c.idExp = Date.now() + Number(j.expires_in || 3600) * 1000; c.uid = j.user_id || c.uid;
      hooks.save();
      return c.idToken;
    }
    async function authed(url, init) {
      init = Object.assign({}, init);
      for (let i = 0; i < 2; i++) {
        init.headers = Object.assign({}, init.headers, { Authorization: 'Bearer ' + await idToken(i === 1) });
        const r = await request(url, init);
        if (r.status !== 401 || i === 1) return r;
      }
    }
    async function list(name) {
      const docs = [];
      let page = '';
      do {
        const url = base() + '/users/' + encodeURIComponent(c.uid) + '/' + name + '?pageSize=300' + (page ? '&pageToken=' + encodeURIComponent(page) : '');
        const r = await authed(url);
        const j = await jsonOf(r);
        if (!r.ok) throw fbError(r, j);
        ((j && j.documents) || []).forEach(d => docs.push(d));
        page = (j && j.nextPageToken) || '';
      } while (page);
      return docs;
    }
    async function commit(writes) {
      for (let i = 0; i < writes.length; i += 400) {
        const r = await authed(base() + ':commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writes: writes.slice(i, i + 400) }) });
        if (!r.ok) throw fbError(r, await jsonOf(r));
      }
    }
    return {
      async signIn(email, password, create) {
        if (!ready()) throw err('Enter your Firebase API key and Project ID first.', 'CONFIG');
        const ep = create ? 'accounts:signUp' : 'accounts:signInWithPassword';
        const r = await request('https://identitytoolkit.googleapis.com/v1/' + ep + '?key=' + encodeURIComponent(c.apiKey), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true })
        });
        const j = await jsonOf(r);
        if (!r.ok) throw fbAuthError(j);
        c.email = email; c.uid = j.localId; c.idToken = j.idToken; c.refreshToken = j.refreshToken;
        c.idExp = Date.now() + Number(j.expiresIn || 3600) * 1000;
        hooks.save();
      },
      async pull() {
        if (!ready()) throw err('Firebase is not set up yet. Open Sync settings.', 'CONFIG');
        if (!c.uid || !c.refreshToken) throw err('Not signed in. Open Sync and sign in.', 'AUTH');
        const docs = await list('bookmarks'), tdocs = await list('tombstones');
        let dropped = 0;
        const bookmarks = [];
        docs.forEach(d => { const r = WF.sanitizeRemote(fbDecode(d)); if (r) bookmarks.push(r); else dropped++; });
        const tombstones = {};
        tdocs.forEach(d => {
          const id = decodeURIComponent(String(d.name).split('/').pop());
          const at = Number(d.fields && d.fields.at && d.fields.at.integerValue);
          if (WF.validId(id) && at > 0) tombstones[id] = at;
        });
        return { bookmarks, tombstones, token: null, dropped };
      },
      async push(p) {
        const writes = [];
        p.changed.forEach(b => writes.push({ update: { name: docRoot() + '/bookmarks/' + b.id, fields: fbEncode(b) } }));
        p.tombstones.forEach(t => {
          writes.push({ delete: docRoot() + '/bookmarks/' + t.id });
          writes.push({ update: { name: docRoot() + '/tombstones/' + t.id, fields: { at: fsInt(t.at) } } });
        });
        await commit(writes);
      }
    };
  }

  // =====================================================================
  // Supabase (PostgREST + GoTrue)
  // =====================================================================
  function sbError(r, j, what) {
    const m = (j && (j.message || j.msg || j.error_description || j.error)) || ('HTTP ' + r.status);
    if (/relation .*bookmarks.* does not exist|PGRST205|Could not find the table/i.test(m + ' ' + ((j && j.code) || ''))) return err('The "bookmarks" table was not found. Run the SQL setup from the README in your Supabase project.', 'CONFIG');
    if (r.status === 401 || /JWT/i.test(m)) return err(what === 'auth' ? m : 'Sign-in expired. Open Sync and sign in again.', 'AUTH');
    if (r.status === 403 || (j && j.code === '42501')) return err('Supabase refused access. Check the row-level-security policy from the README.', 'AUTH');
    if (/invalid login credentials/i.test(m)) return err('Wrong email or password.', 'AUTH');
    if (/already registered/i.test(m)) return err('That email already has an account. Use Sign in instead.', 'AUTH');
    return err(what === 'auth' ? m : 'Supabase error: ' + m);
  }
  function sbRow(userId, b) {
    return {
      user_id: userId, id: b.id, name: b.name, url: b.url, folder: b.folder, tags: b.tags || [],
      is_incognito: !!b.isIncognito, is_hidden: !!b.isHidden, is_favorite: !!b.isFavorite, note: b.note || '',
      date_added: Number(b.dateAdded) || 0, updated_at: Number(b.updatedAt) || 0, deleted: false
    };
  }
  function supabaseProvider(cfg, hooks) {
    const c = cfg.supabase;
    const ready = () => c.url && c.anonKey;
    const root = () => c.url.replace(/\/+$/, '');
    function takeSession(j) {
      c.accessToken = j.access_token; c.refreshToken = j.refresh_token || c.refreshToken;
      c.expiresAt = Date.now() + Number(j.expires_in || 3600) * 1000;
      if (j.user && j.user.id) c.userId = j.user.id;
      hooks.save();
    }
    async function token(force) {
      if (!force && c.accessToken && c.expiresAt > Date.now() + 60000) return c.accessToken;
      if (!c.refreshToken) throw err('Not signed in. Open Sync and sign in.', 'AUTH');
      const r = await request(root() + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: { apikey: c.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: c.refreshToken })
      });
      const j = await jsonOf(r);
      if (!r.ok || !j || !j.access_token) throw err('Sign-in expired. Open Sync and sign in again.', 'AUTH');
      takeSession(j);
      return c.accessToken;
    }
    async function authed(path, init) {
      init = Object.assign({}, init);
      for (let i = 0; i < 2; i++) {
        init.headers = Object.assign({ apikey: c.anonKey }, init.headers, { Authorization: 'Bearer ' + await token(i === 1) });
        const r = await request(root() + path, init);
        if (r.status !== 401 || i === 1) return r;
      }
    }
    return {
      async signIn(email, password, create) {
        if (!ready()) throw err('Enter your Supabase project URL and anon key first.', 'CONFIG');
        const path = create ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password';
        const r = await request(root() + path, { method: 'POST', headers: { apikey: c.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
        const j = await jsonOf(r);
        if (!r.ok) throw sbError(r, j, 'auth');
        if (!j || !j.access_token) throw err('Account created. Check your email to confirm it, then press Sign in.', 'AUTH');
        c.email = email;
        takeSession(j);
      },
      async pull() {
        if (!ready()) throw err('Supabase is not set up yet. Open Sync settings.', 'CONFIG');
        if (!c.refreshToken) throw err('Not signed in. Open Sync and sign in.', 'AUTH');
        const bookmarks = [], tombstones = {};
        let dropped = 0;
        for (let off = 0; ; off += 1000) {
          const r = await authed('/rest/v1/bookmarks?select=*&order=id.asc&limit=1000&offset=' + off, { headers: { Accept: 'application/json' } });
          const rows = await jsonOf(r);
          if (!r.ok) throw sbError(r, rows);
          if (!Array.isArray(rows)) throw err('Unexpected answer from Supabase.');
          rows.forEach(row => {
            if (row.deleted) { const at = Number(row.updated_at); if (WF.validId(row.id) && at > 0) tombstones[row.id] = at; return; }
            const rec = WF.sanitizeRemote({
              id: row.id, name: row.name, url: row.url, folder: row.folder, tags: row.tags, isIncognito: row.is_incognito, isHidden: row.is_hidden,
              isFavorite: row.is_favorite, note: row.note, dateAdded: Number(row.date_added), updatedAt: Number(row.updated_at)
            });
            if (rec) bookmarks.push(rec); else dropped++;
          });
          if (rows.length < 1000) break;
        }
        if (!c.userId) { /* user id is needed for writes; it is also in the access token */
          try { c.userId = JSON.parse(atob(c.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub || ''; hooks.save(); } catch (e) {}
        }
        return { bookmarks, tombstones, token: null, dropped };
      },
      async push(p) {
        const rows = p.changed.map(b => sbRow(c.userId, b));
        p.tombstones.forEach(t => rows.push({
          user_id: c.userId, id: t.id, name: '', url: '', folder: WF.NOFOLDER, tags: [], is_incognito: false, is_hidden: false, is_favorite: false,
          note: '', date_added: 0, updated_at: t.at, deleted: true
        }));
        for (let i = 0; i < rows.length; i += 500) {
          const r = await authed('/rest/v1/bookmarks?on_conflict=user_id,id', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(rows.slice(i, i + 500))
          });
          if (!r.ok) throw sbError(r, await jsonOf(r));
        }
      }
    };
  }

  // =====================================================================
  // WebDAV / Nextcloud / any server that answers GET and PUT for one file
  // =====================================================================
  function webdavProvider(cfg) {
    const c = cfg.webdav;
    const headers = extra => Object.assign({ Authorization: 'Basic ' + b64(c.username + ':' + c.password) }, extra);
    return {
      async pull() {
        if (!c.url || !c.username) throw err('Enter the file address and your username first.', 'CONFIG');
        const r = await request(c.url, { method: 'GET', headers: headers({ 'Cache-Control': 'no-cache' }) });
        if (r.status === 404) return { bookmarks: [], tombstones: {}, token: 'NEW', dropped: 0 };
        if (r.status === 401 || r.status === 403) throw err('The server rejected the username or password.', 'AUTH');
        if (!r.ok) throw err('Server answered HTTP ' + r.status + '.');
        let snap;
        try { snap = WF.parseSnapshot(await r.text()); }
        catch (e) { throw err('The file on the server is not a valid Blue Jay file, so it was left alone.'); }
        return { bookmarks: snap.bookmarks, tombstones: snap.tombstones, token: r.headers.get('etag') || '', dropped: snap.dropped };
      },
      async push(p) {
        const h = { 'Content-Type': 'application/json' };
        if (p.token === 'NEW') h['If-None-Match'] = '*'; else if (p.token) h['If-Match'] = p.token;
        const r = await request(c.url, { method: 'PUT', headers: headers(h), body: JSON.stringify(WF.buildSnapshot(p.full)) });
        if (r.status === 412) throw err('The file changed on the server while syncing.', 'CONFLICT');
        if (r.status === 409 || r.status === 404) throw err('The folder in the address does not exist on the server. Create it first.', 'CONFIG');
        if (r.status === 401 || r.status === 403) throw err('The server rejected the username or password.', 'AUTH');
        if (!r.ok) throw err('Server answered HTTP ' + r.status + ' when saving.');
      }
    };
  }

  // =====================================================================
  // Shared file (desktop Chrome/Edge keep the file open; phones pick it each time)
  // =====================================================================
  function hasFileAccessApi() { return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function'; }
  function idb() {
    return new Promise((res, rej) => {
      const q = indexedDB.open('wayfinder', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('kv');
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }
  async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function idbSet(k, v) { const db = await idb(); return new Promise((res, rej) => { const r = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
  async function chooseFile(create) {
    if (!hasFileAccessApi()) throw err('This device cannot keep a file linked. Sync will ask you to pick the file each time.', 'CONFIG');
    const types = [{ description: 'Blue Jay bookmarks', accept: { 'application/json': ['.json'] } }];
    const h = create ? await window.showSaveFilePicker({ suggestedName: 'bluejay-sync.json', types })
                     : (await window.showOpenFilePicker({ types, multiple: false }))[0];
    await idbSet('fileHandle', h);
    return h.name;
  }
  async function ensureWritable(h) {
    if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return;
    if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') throw err('Permission to use the sync file was denied.', 'AUTH');
  }
  function fileProvider(cfg, hooks) {
    return {
      async pull() {
        if (hasFileAccessApi()) {
          const h = await idbGet('fileHandle');
          if (!h) throw err('Choose or create the sync file first.', 'CONFIG');
          await ensureWritable(h);
          const f = await h.getFile();
          let snap;
          try { snap = WF.parseSnapshot(await f.text()); } catch (e) { throw err('The sync file is not a valid Blue Jay file, so it was left alone.'); }
          return { bookmarks: snap.bookmarks, tombstones: snap.tombstones, token: f.lastModified, dropped: snap.dropped };
        }
        const picked = await hooks.pickFile();
        if (!picked) return null; // cancelled
        let snap;
        try { snap = WF.parseSnapshot(picked.text); } catch (e) { throw err('That file is not a valid Blue Jay file, so it was left alone.'); }
        return { bookmarks: snap.bookmarks, tombstones: snap.tombstones, token: null, dropped: snap.dropped };
      },
      async push(p) {
        const text = JSON.stringify(WF.buildSnapshot(p.full), null, 2);
        if (hasFileAccessApi()) {
          const h = await idbGet('fileHandle');
          const f = await h.getFile();
          if (p.token && f.lastModified !== p.token) throw err('The sync file changed while syncing.', 'CONFLICT');
          const w = await h.createWritable();
          await w.write(text); await w.close();
          return;
        }
        const saved = await hooks.saveFile('bluejay-sync.json', text);
        if (saved === false) throw err('Merged file was not saved. Your phone keeps the merged data; run Sync again to save it.', 'CANCELLED');
      }
    };
  }

  // =====================================================================
  // Engine
  // =====================================================================
  function makeProvider(cfg, hooks) {
    switch (cfg.provider) {
      case 'firebase': return firebaseProvider(cfg, hooks);
      case 'supabase': return supabaseProvider(cfg, hooks);
      case 'webdav': return webdavProvider(cfg, hooks);
      case 'file': return fileProvider(cfg, hooks);
      default: throw err('Sync is switched off.', 'CONFIG');
    }
  }
  function isReady(cfg) {
    const f = cfg.firebase, s = cfg.supabase, w = cfg.webdav;
    switch (cfg.provider) {
      case 'firebase': return !!(f.apiKey && f.projectId && f.uid && f.refreshToken);
      case 'supabase': return !!(s.url && s.anonKey && s.refreshToken);
      case 'webdav': return !!(w.url && w.username);
      case 'file': return hasFileAccessApi() ? !!cfg.file.name : true;
      default: return false;
    }
  }
  // Providers that can run in the background without asking the user to pick a file
  function canAuto(cfg) { return ['firebase', 'supabase', 'webdav'].indexOf(cfg.provider) !== -1 && isReady(cfg); }
  function sameTombs(a, b) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => a[k] === b[k]);
  }

  let running = false;
  /* ctx: { config(), saveConfig(), getState() -> {bookmarks,tombstones}, apply(merged), pickFile(), saveFile(name,text) } */
  async function run(ctx) {
    const cfg = ctx.config();
    if (cfg.provider === 'off') return { skipped: true };
    if (running) return { skipped: true };
    running = true;
    try {
      const impl = makeProvider(cfg, { save: ctx.saveConfig, pickFile: ctx.pickFile, saveFile: ctx.saveFile });
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await impl.pull();
        if (!remote) return { cancelled: true };
        const local = ctx.getState();
        const merged = WF.mergeStates(local, remote);
        const pulled = WF.diffStats(local.bookmarks, merged.bookmarks);
        if (pulled.added || pulled.updated || pulled.removed || !sameTombs(local.tombstones, merged.tombstones)) ctx.apply(merged);
        const diff = WF.diffForPush(merged, remote);
        if (diff.changed.length || diff.tombstones.length) {
          try { await impl.push({ changed: diff.changed, tombstones: diff.tombstones, full: merged, token: remote.token }); }
          catch (e) { if (e.code === 'CONFLICT' && attempt < 2) continue; throw e; }
        }
        cfg.lastSync = Date.now(); cfg.lastError = '';
        ctx.saveConfig();
        return { pulled, pushed: { bookmarks: diff.changed.length, tombstones: diff.tombstones.length }, dropped: remote.dropped || 0 };
      }
      throw err('The server kept changing while syncing. Try again in a moment.');
    } catch (e) {
      if (e.code !== 'CANCELLED') { cfg.lastError = e.message; ctx.saveConfig(); }
      throw e;
    } finally { running = false; }
  }
  async function signIn(cfg, hooks, email, password, create) {
    if (cfg.provider !== 'firebase' && cfg.provider !== 'supabase') throw err('This sync type does not use an account.', 'CONFIG');
    await makeProvider(cfg, hooks).signIn(email, password, create);
  }
  function signOut(cfg) {
    if (cfg.provider === 'firebase') Object.assign(cfg.firebase, { uid: '', idToken: '', refreshToken: '', idExp: 0 });
    if (cfg.provider === 'supabase') Object.assign(cfg.supabase, { userId: '', accessToken: '', refreshToken: '', expiresAt: 0 });
  }

  return {
    defaults, load, save, run, signIn, signOut, isReady, canAuto, makeProvider, chooseFile, hasFileAccessApi,
    _setStorage(s) { store.get = s.get; store.set = s.set; }
  };
});
