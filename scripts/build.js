// Builds ./www: compiled Tailwind CSS, app files and the local SVG icons. No CDN is used at runtime.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.join(__dirname, '..'), www = path.join(root, 'www');
const rm = p => fs.rmSync(p, { recursive: true, force: true });
rm(www); fs.mkdirSync(www, { recursive: true });

// 1. Tailwind -> www/app.css
cp.execFileSync(process.execPath, [require.resolve('tailwindcss/lib/cli.js'), '-c', 'tailwind.config.js', '-i', 'src/input.css', '-o', 'www/app.css', '--minify'], { cwd: root, stdio: 'inherit' });

// 2. Icons: assets/icons/*.svg -> www/assets/icons/ (Lucide filenames; overwrite the placeholders with your own)
if (fs.existsSync(path.join(root, 'assets/icons'))) fs.cpSync(path.join(root, 'assets/icons'), path.join(www, 'assets/icons'), { recursive: true });

// 3. App files
for (const f of ['core.js', 'sync.js', 'app.js']) fs.copyFileSync(path.join(root, 'src', f), path.join(www, f));
for (const f of fs.existsSync(path.join(root, 'assets')) ? fs.readdirSync(path.join(root, 'assets')) : []) { const src = path.join(root, 'assets', f); if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(www, f)); }

// 4. HTML: swap the DEV block for local files
let html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const re = /<!--DEV:START-->[\s\S]*?<!--DEV:END-->/;
if (!re.test(html)) throw new Error('DEV block not found');
html = html.replace(re, '<link rel="stylesheet" href="app.css">');
if (/cdn\.tailwindcss|cdnjs|googleapis|fonts\.gstatic/.test(html)) throw new Error('CDN reference left in HTML');
fs.writeFileSync(path.join(www, 'index.html'), html);
// every icon the CSS asks for must exist
const missing = [...new Set([...html.matchAll(/assets\/icons\/([a-z0-9-]+)\.svg/g)].map(m => m[1]))].filter(n => !fs.existsSync(path.join(www, 'assets/icons', n + '.svg')));
if (missing.length) throw new Error('Missing icon files in assets/icons: ' + missing.join(', '));
console.log('Built www/ OK');
