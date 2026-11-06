const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 400, height: 800 } });
  const errs = []; p.on('pageerror', e => { if (!/tailwind/.test(e.message)) errs.push(e.message); });
  await p.route(/^https?:/, r => r.abort());
  const base = { tags: [], isIncognito: false, isFavorite: false, note: '', dateAdded: 1, updatedAt: 1, folder: 'No Folder' };
  const seed = [{ id: 'a1', name: 'Alpha', url: 'https://alpha.com/' }, { id: 'a2', name: 'Secret', url: 'https://secret.com/', isHidden: true }, { id: 'a3', name: 'Gamma', url: 'https://gamma.com/' }].map(x => Object.assign({}, base, x));
  await p.addInitScript(s => { if (!localStorage.getItem('reaper_bookmarks')) localStorage.setItem('reaper_bookmarks', JSON.stringify(s)); }, seed);
  await p.goto('file://' + path.resolve(process.env.F||'src/index.html')); await p.waitForTimeout(400);
  const txt = () => p.locator('#bookmarkContainer').innerText();
  const r = {};
  r.mainHidesSecret = !(await txt()).includes('Secret');
  await p.fill('#searchInput', 'secret').catch(() => {}); r.searchHides = !(await txt()).includes('Secret'); await p.fill('#searchInput', '').catch(() => {});
  const tap3 = async () => { for (let i = 0; i < 3; i++) await p.dispatchEvent('#logoBtn','click'); await p.waitForTimeout(200); };
  const dlgInput = async v => { await p.fill('#dialogModal input', v); await p.click('#dialogModal button:has-text("Next"), #dialogModal button:has-text("Set PIN"), #dialogModal button:has-text("Unlock")'); await p.waitForTimeout(300); };
  await tap3();                       // no PIN yet -> create
  await dlgInput('1234'); await dlgInput('1234');
  await p.waitForTimeout(300);
  r.afterCreate = (await txt()).includes('Secret') ? 'vault open' : 'not open';
  r.bannerVisible = await p.evaluate(()=>!document.getElementById('vaultBanner').classList.contains('hidden'));
  await p.screenshot({ path: 'vault.png' });
  await tap3(); r.lockedAgain = !(await txt()).includes('Secret') && !(await p.evaluate(()=>!document.getElementById('vaultBanner').classList.contains('hidden')));
  await tap3(); await dlgInput('0000'); r.wrongPinStays = !(await txt()).includes('Secret');
  await p.waitForTimeout(500);
  const stored = await p.evaluate(() => localStorage.getItem('reaper_pin')); r.pinNotPlain = !stored.includes('1234');
  console.log(JSON.stringify(r, null, 1), 'ERRORS', errs); await b.close();
})();
