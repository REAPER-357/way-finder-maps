const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 400, height: 800 } });
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  await p.route(/^https?:/, r => r.abort());
  const seed = [
    { id: 'a1', name: 'Alpha', url: 'https://alpha.com/', folder: 'Dev' },
    { id: 'a2', name: 'Alpha2', url: 'https://alpha.com/x', folder: 'Dev' },
    { id: 'b1', name: 'Beta', url: 'https://beta.org/docs', folder: 'No Folder' },
    { id: 'b2', name: 'Beta typo', url: 'https://beta.org/doc', folder: 'No Folder' }
  ].map(x => Object.assign({ tags: [], isIncognito: false, isFavorite: false, note: '', dateAdded: 1, updatedAt: 1 }, x));
  await p.addInitScript(s => { if (!localStorage.getItem('reaper_bookmarks')) localStorage.setItem('reaper_bookmarks', JSON.stringify(s)); }, seed);
  await p.goto('file://' + path.resolve('src/index.html'));
  await p.waitForTimeout(500);
  const out = {};
  out.rows0 = await p.locator('#bookmarkContainer').innerText();
  // expand Dev folder
  await p.locator('#bookmarkContainer >> text=Dev').first().click();
  out.afterExpand = (await p.locator('#bookmarkContainer').innerText()).includes('Alpha2');
  // dup modal
  await p.locator('[onclick*="Dup"], [title*="uplicate"]').first().click().catch(e => out.dupClickErr = e.message);
  await p.waitForTimeout(300);
  await p.click('#dupDomainBtn').catch(e => out.domErr = e.message);
  out.dupBody = (await p.locator('#dupBody').innerText().catch(() => '')).slice(0, 300);
  await p.screenshot({ path: process.argv[2] || 'shot.png' });
  console.log(JSON.stringify(out, null, 1)); console.log('ERRORS:', errs);
  await b.close();
})();
