const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const chrome = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000001" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://news.example.com/" ADD_DATE="1700000100" ICON="data:image/png;base64,AAAA">News &amp; Views</A>
        <DT><H3 ADD_DATE="1700000200">Dev</H3>
        <DL><p>
            <DT><A HREF="https://github.com/" ADD_DATE="1700000300">GitHub</A>
            <DT><H3>Deep</H3>
            <DL><p>
                <DT><A HREF="https://mdn.dev/">MDN</A>
            </DL><p>
        </DL><p>
    </DL><p>
    <DT><H3>Other bookmarks</H3>
    <DL><p>
        <DT><A HREF="javascript:alert(1)">Bad</A>
        <DT><A HREF="https://other.example.org/">Other</A>
    </DL><p>
</DL><p>`;
const firefox = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
<DT><H3 ADD_DATE="1600000000000000">Bookmarks Menu</H3>
<DL><p>
<DT><A HREF="https://ff.example.com/" ADD_DATE="1600000000000000" TAGS="work, reading">Firefox one</A>
<DT><H3>Recipes</H3>
<DL><p>
<DT><A HREF="https://cook.example.com/">Cook</A>
</DL><p>
</DL><p>
</DL>`;
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.addScriptTag({ path: path.resolve('src/core.js') });
  const r = await p.evaluate(([c, f]) => ({ chrome: WF.parseNetscapeHtml(c), ff: WF.parseNetscapeHtml(f), empty: WF.parseNetscapeHtml('<p>nothing</p>') }), [chrome, firefox]);
  console.log(JSON.stringify(r, null, 1));
  const ok = r.chrome.length === 5
    && r.chrome[0].name === 'News & Views' && r.chrome[0].folder === ''
    && r.chrome.find(x => x.name === 'GitHub').folder === 'Dev'
    && r.chrome.find(x => x.name === 'MDN').folder === 'Dev / Deep'
    && r.chrome.find(x => x.name === 'Other').folder === ''
    && r.ff.length === 2 && r.ff[0].tags.join() === 'work,reading' && r.ff[0].folder === '' && r.ff[1].folder === 'Recipes'
    && r.ff[0].dateAdded === 1600000000000 && r.chrome[0].dateAdded === 1700000100000 && r.empty.length === 0;
  console.log(ok ? 'PARSER OK' : 'PARSER MISMATCH');
  await b.close(); process.exitCode = ok ? 0 : 1;
})().catch(e => { console.log('ERR', e); process.exitCode = 1; });
