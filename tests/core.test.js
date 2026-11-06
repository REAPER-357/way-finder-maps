const assert = require('assert');
const WF = require('../src/core.js');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok  -', name); } catch (e) { console.log('FAIL-', name, '\n   ', e.message); process.exitCode = 1; } };
const bm = (id, name, url, extra) => Object.assign({ id, name, url, folder: 'No Folder', tags: [], isIncognito: false, isFavorite: false, note: '', dateAdded: 1000, updatedAt: 1000 }, extra || {});

t('normalizeUrl', () => {
  assert.strictEqual(WF.normalizeUrl('example.com'), 'https://example.com/');
  assert.strictEqual(WF.normalizeUrl('localhost:3000/x'), 'https://localhost:3000/x');
  assert.strictEqual(WF.normalizeUrl('javascript:alert(1)'), '');
  assert.strictEqual(WF.normalizeUrl('file:///etc/passwd'), '');
  assert.strictEqual(WF.normalizeUrl('ftp://x.com'), '');
});
t('urlKey exact ignores scheme/www/slash/hash but not path/query', () => {
  assert.strictEqual(WF.urlKey('http://www.a.com/p/?q=1#z', 'exact'), WF.urlKey('https://a.com/p?q=1', 'exact'));
  assert.notStrictEqual(WF.urlKey('https://a.com/p', 'exact'), WF.urlKey('https://a.com/p2', 'exact'));
});
t('editDistance', () => {
  assert.strictEqual(WF.editDistanceWithin('kitten', 'sitting', 5), 3);
  assert.strictEqual(WF.editDistanceWithin('abc', 'abc', 0), 0);
  assert.ok(WF.editDistanceWithin('abcdef', 'xyz', 2) > 2);
});

t('duplicate finder: exact', () => {
  const g = WF.findDuplicateGroups([bm('1', 'A', 'https://a.com/x'), bm('2', 'A2', 'http://www.a.com/x/#top'), bm('3', 'B', 'https://a.com/y')], 'exact');
  assert.strictEqual(g.length, 1); assert.strictEqual(g[0].items.length, 2);
});
t('duplicate finder: domain mode finds one-letter differences, hides exact copies', () => {
  const list = [
    bm('1', 'Docs', 'https://example.com/docs'),
    bm('2', 'Docs typo', 'https://example.com/doc'),            // 1 char away
    bm('3', 'Other', 'https://example.com/totally/different/page/here'),
    bm('4', 'Same', 'https://github.com/a/b'),
    bm('5', 'Same copy', 'https://www.github.com/a/b/'),         // exact copy only -> not in domain mode
    bm('6', 'Elsewhere', 'https://other.org/x')
  ];
  const strict = WF.findDuplicateGroups(list, 'domain', 'strict');
  assert.strictEqual(strict.length, 1, 'one group');
  assert.deepStrictEqual(strict[0].items.map(b => b.id).sort(), ['1', '2']);
  assert.strictEqual(strict[0].key, 'example.com');
  const loose = WF.findDuplicateGroups(list, 'domain', 'loose');
  assert.strictEqual(loose.length, 1);
  assert.deepStrictEqual(loose[0].items.map(b => b.id).sort(), ['1', '2', '3']); // whole site, but no github exact copies
  const exact = WF.findDuplicateGroups(list, 'exact');
  assert.deepStrictEqual(exact[0].items.map(b => b.id).sort(), ['4', '5']);
});
t('duplicate finder: keeper prefers favourite, then filed, then oldest', () => {
  const g = WF.findDuplicateGroups([bm('1', 'A', 'https://a.com/x', { dateAdded: 1 }), bm('2', 'A', 'https://a.com/x', { dateAdded: 5, folder: 'Dev' }), bm('3', 'A', 'https://a.com/x', { dateAdded: 9, isFavorite: true })], 'exact');
  assert.strictEqual(g[0].items[0].id, '3');
  const g2 = WF.findDuplicateGroups([bm('1', 'A', 'https://a.com/x', { dateAdded: 1 }), bm('2', 'A', 'https://a.com/x', { dateAdded: 5, folder: 'Dev' })], 'exact');
  assert.strictEqual(g2[0].items[0].id, '2');
});

t('import merge: adds new, fills gaps, never overwrites, rejects bad rows, inner duplicates', () => {
  const existing = [bm('a', 'GitHub', 'https://github.com/', { tags: ['x'], note: 'mine' })];
  const before = JSON.stringify(existing);
  const { result, stats } = WF.mergeImport(existing, [
    { name: 'GH again', url: 'http://www.github.com', folder: 'Dev', tags: ['x', 'Code'], isFavorite: true, note: 'theirs' },
    { name: 'New', url: 'example.com/a#top', folder: 'dev' },
    { name: 'New again', url: 'https://example.com/a/' },
    { name: 'bad', url: 'javascript:alert(1)' }, null, 5
  ], 5000);
  assert.strictEqual(JSON.stringify(existing), before, 'input untouched');
  assert.deepStrictEqual(stats, { added: 1, merged: 1, unchanged: 1, invalid: 3 });
  const gh = result.find(b => b.id === 'a');
  assert.strictEqual(gh.note, 'mine'); assert.strictEqual(gh.folder, 'Dev'); assert.deepStrictEqual(gh.tags, ['x', 'Code']); assert.ok(gh.isFavorite); assert.ok(gh.updatedAt >= 5000);
  assert.strictEqual(result.length, 2);
});
t('import merge: incoming id kept; id collision gets a fresh id; deleted item can be restored', () => {
  const existing = [bm('1', 'One', 'https://one.com')];
  const { result } = WF.mergeImport(existing, [{ id: '1', name: 'Clash', url: 'https://two.com' }, { id: 'zzz', name: 'Keep id', url: 'https://three.com', updatedAt: 50 }], 9000, { zzz: 100 });
  const clash = result.find(b => b.url === 'https://two.com/'), kept = result.find(b => b.url === 'https://three.com/');
  assert.notStrictEqual(clash.id, '1'); assert.strictEqual(kept.id, 'zzz');
  assert.ok(kept.updatedAt > 100, 'restored beats tombstone');
});

t('sync merge: newest edit wins, deletes propagate, edit-after-delete revives', () => {
  const A = { bookmarks: [bm('1', 'A', 'https://a.com', { updatedAt: 100 }), bm('2', 'B', 'https://b.com', { updatedAt: 100 })], tombstones: {} };
  const B = { bookmarks: [bm('1', 'A edited', 'https://a.com', { updatedAt: 200 }), bm('3', 'C', 'https://c.com', { updatedAt: 150 })], tombstones: { 2: 120 } };
  const m = WF.mergeStates(A, B, 300);
  assert.deepStrictEqual(m.bookmarks.map(b => b.id).sort(), ['1', '3']);
  assert.strictEqual(m.bookmarks.find(b => b.id === '1').name, 'A edited');
  assert.strictEqual(m.tombstones['2'], 120);
  const m2 = WF.mergeStates({ bookmarks: [bm('2', 'B revived', 'https://b.com', { updatedAt: 500 })], tombstones: {} }, { bookmarks: [], tombstones: { 2: 120 } }, 600);
  assert.strictEqual(m2.bookmarks.length, 1); assert.strictEqual(m2.tombstones['2'], undefined);
});
t('sync merge: converges whichever side merges first (random fuzz)', () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let round = 0; round < 200; round++) {
    const mk = () => ({ bookmarks: [], tombstones: {} });
    const A = mk(), B = mk();
    for (let i = 0; i < 6; i++) {
      [A, B].forEach(S => {
        const r = rnd();
        if (r < 0.5) S.bookmarks.push(bm(String(i), 'n' + Math.floor(rnd() * 3), 'https://x' + i + '.com', { updatedAt: 1 + Math.floor(rnd() * 20), folder: rnd() < .5 ? 'F' : 'No Folder' }));
        else if (r < 0.7) S.tombstones[String(i)] = 1 + Math.floor(rnd() * 20);
      });
    }
    const ab = WF.mergeStates(A, B, 100), ba = WF.mergeStates(B, A, 100);
    const norm = s => JSON.stringify({ b: s.bookmarks.map(x => [x.id, x.name, x.folder, x.updatedAt]).sort(), t: Object.entries(s.tombstones).sort() });
    assert.strictEqual(norm(ab), norm(ba), 'round ' + round);
  }
});
t('diffForPush sends only what the remote lacks', () => {
  const merged = { bookmarks: [bm('1', 'A', 'https://a.com', { updatedAt: 5 }), bm('2', 'B', 'https://b.com', { updatedAt: 9 })], tombstones: { 7: 50 } };
  const remote = { bookmarks: [bm('1', 'A', 'https://a.com', { updatedAt: 5 })], tombstones: {} };
  const d = WF.diffForPush(merged, remote);
  assert.deepStrictEqual(d.changed.map(b => b.id), ['2']); assert.deepStrictEqual(d.tombstones, [{ id: '7', at: 50 }]);
});
t('parseSnapshot: arrays, objects, junk ids, hostile tombstones', () => {
  const s = WF.parseSnapshot(JSON.stringify({ bookmarks: [{ id: 'ok', name: 'x', url: 'https://x.com' }, { id: 'a/b', name: 'x', url: 'https://y.com' }, { name: 'noid', url: 'https://z.com' }], tombstones: { good: 5, '__proto__': 9, 'bad id': 3 } }));
  assert.strictEqual(s.bookmarks.length, 1); assert.strictEqual(s.dropped, 2);
  assert.deepStrictEqual(Object.keys(s.tombstones), ['good']);
  assert.deepStrictEqual(WF.parseSnapshot('').bookmarks, []);
  assert.throws(() => WF.parseSnapshot('{"x":1}'));
});
console.log(n + ' passed');
