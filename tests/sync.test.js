/* Sync tests against in-memory mock servers (these check OUR logic; real services are not contacted). */
const assert = require('assert');
const WF = require('../src/core.js');
const Sync = require('../src/sync.js');

let clock = Date.now() - 5e6;
const tick = () => ++clock;
const bm = (id, name, url, extra) => Object.assign({ id, name, url: WF.normalizeUrl(url), folder: 'No Folder', tags: [], isIncognito: false, isFavorite: false, note: '', dateAdded: tick(), updatedAt: tick() }, extra || {});
const J = (o, status, headers) => new Response(JSON.stringify(o), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });

// ---------------- mock servers ----------------
const servers = {
  firebase: { docs: new Map(), valid: 'tok', password: 'pw123456', calls: 0, refreshed: 0 },
  supabase: { rows: new Map(), valid: 'sbtok', password: 'pw123456' },
  webdav: { file: null, etag: 0, beforePut: null }
};
globalThis.fetch = async (url, init) => {
  init = init || {};
  const u = new URL(url), h = Object.assign({}, init.headers), body = init.body ? init.body : null;
  const auth = h.Authorization || '';
  // ---- Firebase ----
  if (u.host === 'identitytoolkit.googleapis.com') {
    const b = JSON.parse(body); const S = servers.firebase;
    if (b.password !== S.password) return J({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }, 400);
    return J({ localId: 'U1', idToken: S.valid, refreshToken: 'REF', expiresIn: '3600' });
  }
  if (u.host === 'securetoken.googleapis.com') { servers.firebase.refreshed++; servers.firebase.valid = 'tok' + servers.firebase.refreshed; return J({ id_token: servers.firebase.valid, refresh_token: 'REF', expires_in: '3600', user_id: 'U1' }); }
  if (u.host === 'firestore.googleapis.com') {
    const S = servers.firebase; S.calls++;
    if (auth !== 'Bearer ' + S.valid) return J({ error: { message: 'expired' } }, 401);
    const prefix = 'projects/proj/databases/(default)/documents/';
    if (u.pathname.endsWith(':commit')) {
      JSON.parse(body).writes.forEach(w => { if (w.update) S.docs.set(w.update.name.slice(prefix.length), w.update.fields); else if (w.delete) S.docs.delete(w.delete.slice(prefix.length)); });
      return J({});
    }
    const col = decodeURIComponent(u.pathname.split('/documents/')[1]) + '/';
    const names = [...S.docs.keys()].filter(k => k.startsWith(col) && !k.slice(col.length).includes('/')).sort();
    const start = Number(u.searchParams.get('pageToken') || 0), size = Number(u.searchParams.get('pageSize'));
    const page = names.slice(start, start + size).map(k => ({ name: prefix + k, fields: S.docs.get(k) }));
    return J(page.length ? { documents: page, nextPageToken: start + size < names.length ? String(start + size) : undefined } : {});
  }
  // ---- Supabase ----
  if (u.host === 'sb.test') {
    const S = servers.supabase;
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password') {
      const b = JSON.parse(body); if (b.password !== S.password) return J({ error_description: 'Invalid login credentials' }, 400);
      return J({ access_token: S.valid, refresh_token: 'SBREF', expires_in: 3600, user: { id: 'SBU1' } });
    }
    if (u.pathname === '/auth/v1/token') { S.valid = 'sbtok2'; return J({ access_token: S.valid, refresh_token: 'SBREF', expires_in: 3600, user: { id: 'SBU1' } }); }
    if (h.apikey !== 'ANON') return J({ message: 'no apikey' }, 401);
    if (auth !== 'Bearer ' + S.valid) return J({ message: 'JWT expired' }, 401);
    if (u.pathname === '/rest/v1/bookmarks' && (init.method || 'GET') === 'GET') {
      const rows = [...S.rows.values()].sort((a, b) => a.id.localeCompare(b.id));
      const off = Number(u.searchParams.get('offset')), lim = Number(u.searchParams.get('limit'));
      return J(rows.slice(off, off + lim));
    }
    if (u.pathname === '/rest/v1/bookmarks' && init.method === 'POST') {
      assert.ok(/merge-duplicates/.test(h.Prefer)); assert.strictEqual(u.searchParams.get('on_conflict'), 'user_id,id');
      JSON.parse(body).forEach(r => { assert.strictEqual(r.user_id, 'SBU1'); S.rows.set(r.id, Object.assign(S.rows.get(r.id) || {}, r)); });
      return new Response(null, { status: 201 });
    }
  }
  // ---- WebDAV ----
  if (u.host === 'dav.test') {
    const S = servers.webdav;
    if (auth !== 'Basic ' + Buffer.from('me:secret').toString('base64')) return new Response('no', { status: 401 });
    if (init.method === 'GET') return S.file == null ? new Response('', { status: 404 }) : new Response(S.file, { status: 200, headers: { ETag: '"' + S.etag + '"' } });
    if (init.method === 'PUT') {
      if (S.beforePut) { const f = S.beforePut; S.beforePut = null; f(); }
      if (h['If-None-Match'] === '*' && S.file != null) return new Response('', { status: 412 });
      if (h['If-Match'] && h['If-Match'] !== '"' + S.etag + '"') return new Response('', { status: 412 });
      S.file = body; S.etag++; return new Response(null, { status: 204 });
    }
  }
  throw new TypeError('unmocked ' + url);
};

// ---------------- device simulator ----------------
function device(provider, seed) {
  const cfg = Sync.defaults(); cfg.provider = provider;
  Object.assign(cfg.firebase, { apiKey: 'KEY', projectId: 'proj' });
  Object.assign(cfg.supabase, { url: 'https://sb.test', anonKey: 'ANON' });
  Object.assign(cfg.webdav, { url: 'https://dav.test/dav/bookmarks.json', username: 'me', password: 'secret' });
  const d = { cfg, bookmarks: seed || [], tombstones: {}, applied: 0, fileText: null };
  d.ctx = { config: () => cfg, saveConfig() {}, getState: () => ({ bookmarks: d.bookmarks, tombstones: d.tombstones }), apply(m) { d.bookmarks = m.bookmarks; d.tombstones = m.tombstones; d.applied++; } };
  d.sync = () => Sync.run(d.ctx);
  d.del = id => { const b = d.bookmarks.find(x => x.id === id); d.tombstones[id] = Math.max(tick(), b.updatedAt + 1); d.bookmarks = d.bookmarks.filter(x => x.id !== id); };
  d.edit = (id, patch) => { const b = d.bookmarks.find(x => x.id === id); Object.assign(b, patch, { updatedAt: tick() }); };
  return d;
}
const view = d => JSON.stringify(d.bookmarks.map(b => [b.id, b.name, b.folder, b.isFavorite, b.tags]).sort());
let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('ok  -', name); } catch (e) { console.log('FAIL-', name, '\n   ', e.stack.split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; } }

async function twoDevices(provider, signIn) {
  const A = device(provider, [bm('a1', 'Alpha', 'https://alpha.com'), bm('a2', 'Beta', 'https://beta.com'), bm('a3', 'Gamma', 'https://gamma.com')]);
  const B = device(provider);
  if (signIn) { await Sync.signIn(A.cfg, { save() {} }, 'me@x.com', 'pw123456', false); await Sync.signIn(B.cfg, { save() {} }, 'me@x.com', 'pw123456', false); }
  const r1 = await A.sync(); assert.strictEqual(r1.pushed.bookmarks, 3, 'A uploads 3');
  const r2 = await B.sync(); assert.strictEqual(r2.pulled.added, 3, 'B downloads 3'); assert.strictEqual(view(A), view(B));
  // B edits one, deletes one, adds one
  B.edit('a1', { name: 'Alpha edited', folder: 'Dev', isFavorite: true, tags: ['x'] }); B.del('a2'); B.bookmarks.push(bm('b9', 'New on B', 'https://new.com'));
  const r3 = await B.sync(); assert.strictEqual(r3.pushed.bookmarks, 2); assert.strictEqual(r3.pushed.tombstones, 1);
  const r4 = await A.sync(); assert.deepStrictEqual(r4.pulled, { added: 1, updated: 1, removed: 1 });
  assert.strictEqual(view(A), view(B), 'A and B identical after sync');
  // a no-op sync pushes nothing
  const r5 = await A.sync(); assert.deepStrictEqual(r5.pushed, { bookmarks: 0, tombstones: 0 });
  // A edits something B deleted a moment ago: edit made AFTER the delete wins
  A.bookmarks.push(bm('c1', 'Created on A', 'https://c1.com')); await A.sync(); await B.sync(); B.del('c1'); await B.sync();
  A.edit('c1', { note: 'still wanted' }); await A.sync(); await B.sync();
  assert.ok(B.bookmarks.find(b => b.id === 'c1'), 'edit after delete revives');
  assert.strictEqual(view(A), view(B));
  return { A, B };
}

(async () => {
  await t('Firebase: sign-in errors are readable', async () => {
    const d = device('firebase');
    await assert.rejects(Sync.signIn(d.cfg, { save() {} }, 'a@b.c', 'wrong', false), /Wrong email or password/);
  });
  await t('Firebase: two devices, edits, deletes, revive', async () => { await twoDevices('firebase', true); });
  await t('Firebase: expired token is refreshed automatically', async () => {
    const A = device('firebase', [bm('e1', 'E', 'https://e.com')]); await Sync.signIn(A.cfg, { save() {} }, 'x@y.z', 'pw123456', false);
    servers.firebase.valid = 'rotated-on-server'; const before = servers.firebase.refreshed;
    await A.sync(); assert.ok(servers.firebase.refreshed > before);
  });
  await t('Firebase: pagination (650 bookmarks)', async () => {
    servers.firebase.docs.clear();
    const A = device('firebase', Array.from({ length: 650 }, (_, i) => bm('p' + i, 'N' + i, 'https://site' + i + '.com'))); const B = device('firebase');
    await Sync.signIn(A.cfg, { save() {} }, 'x@y.z', 'pw123456', false); await Sync.signIn(B.cfg, { save() {} }, 'x@y.z', 'pw123456', false);
    await A.sync(); const r = await B.sync(); assert.strictEqual(r.pulled.added, 650);
  });
  await t('Supabase: two devices, edits, deletes, revive', async () => { await twoDevices('supabase', true); });
  await t('Supabase: expired token is refreshed automatically', async () => {
    const A = device('supabase', [bm('s1', 'S', 'https://s.com')]); await Sync.signIn(A.cfg, { save() {} }, 'x@y.z', 'pw123456', false);
    servers.supabase.valid = 'server-rotated'; await A.sync();
  });
  await t('WebDAV: two devices, edits, deletes, revive', async () => { await twoDevices('webdav', false); });
  await t('WebDAV: concurrent change between pull and push is merged, not overwritten', async () => {
    servers.webdav.file = null;
    const A = device('webdav', [bm('w1', 'W1', 'https://w1.com')]); const B = device('webdav', [bm('w2', 'W2', 'https://w2.com')]);
    await A.sync();
    // B pulls, then (before B writes) A changes the file again
    servers.webdav.beforePut = () => { A.bookmarks.push(bm('w3', 'W3 slipped in', 'https://w3.com')); servers.webdav.file = JSON.stringify(WF.buildSnapshot({ bookmarks: A.bookmarks.concat([]), tombstones: {} })); servers.webdav.etag++; };
    await B.sync(); await A.sync();
    const ids = d => d.bookmarks.map(b => b.id).sort().join();
    assert.strictEqual(ids(B), 'w1,w2,w3'); assert.strictEqual(ids(A), 'w1,w2,w3');
  });
  await t('WebDAV: wrong password and corrupt remote file are safe', async () => {
    const d = device('webdav', [bm('z', 'Z', 'https://z.com')]); d.cfg.webdav.password = 'nope';
    await assert.rejects(d.sync(), /rejected the username or password/);
    d.cfg.webdav.password = 'secret'; servers.webdav.file = '{"not":"ours"}';
    await assert.rejects(d.sync(), /not a valid Blue Jay file/);
    assert.strictEqual(servers.webdav.file, '{"not":"ours"}', 'remote file untouched');
    assert.strictEqual(d.bookmarks.length, 1, 'local data untouched');
  });
  await t('Offline: network failure leaves local data alone', async () => {
    const real = globalThis.fetch; globalThis.fetch = async () => { throw new TypeError('offline'); };
    const d = device('webdav', [bm('o', 'O', 'https://o.com')]);
    await assert.rejects(d.sync(), /Can't reach the server/); globalThis.fetch = real; assert.strictEqual(d.bookmarks.length, 1);
  });
  await t('Shared file (phone flow: pick, merge, save back)', async () => {
    const shared = { text: JSON.stringify(WF.buildSnapshot({ bookmarks: [bm('f1', 'F1', 'https://f1.com')], tombstones: {} })) };
    const mk = seed => { const d = device('file', seed); d.ctx.pickFile = async () => ({ name: 'x.json', text: shared.text }); d.ctx.saveFile = async (n, text) => { shared.text = text; return true; }; return d; };
    const A = mk([bm('f2', 'F2', 'https://f2.com')]), B = mk([]);
    await A.sync(); await B.sync();
    assert.deepStrictEqual(A.bookmarks.map(b => b.id).sort(), ['f1', 'f2']); assert.deepStrictEqual(B.bookmarks.map(b => b.id).sort(), ['f1', 'f2']);
    B.del('f1'); await B.sync(); await A.sync(); assert.deepStrictEqual(A.bookmarks.map(b => b.id), ['f2']);
    const C = mk([]); C.ctx.pickFile = async () => null; assert.deepStrictEqual(await C.sync(), { cancelled: true });
  });
  console.log(passed + ' sync tests passed');
})();
