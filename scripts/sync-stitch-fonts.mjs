import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Pin the font files used by the exported Stitch HTML so the UI works offline.
const root = path.resolve('ui/public/fonts/stitch');
await mkdir(root, { recursive: true });
const families = [
  'Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400',
  'Plus+Jakarta+Sans:wght@400;500;600',
  'JetBrains+Mono:wght@400;500',
  'Noto+Sans+SC:wght@400..600',
];
const response = await fetch(`https://fonts.googleapis.com/css2?${families.map(f => `family=${f}`).join('&')}&display=swap`, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
});
if (!response.ok) throw new Error(`Font CSS: ${response.status}`);
let css = await response.text();
const urls = [...new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]))];
let cursor = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (cursor < urls.length) {
    const index = cursor++;
    const url = urls[index];
    const file = `font-${index}${new URL(url).pathname.endsWith('.woff2') ? '.woff2' : '.ttf'}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Font download: ${r.status}`);
    await writeFile(path.join(root, file), Buffer.from(await r.arrayBuffer()));
    css = css.split(url).join(`/fonts/stitch/${file}`);
  }
}));
await writeFile('ui/src/fonts.css', css);
const baseIconNames = 'add,arrow_forward,arrow_upward,auto_awesome,chat_bubble,check,chevron_right,close,code,content_copy,description,done_all,edit_square,folder,grid_view,help,hub,keyboard_arrow_down,menu,more_horiz,neurology,person,refresh,search,smart_toy,source_environment,sync,task_alt,terminal,tune,unfold_more,verified_user'.split(',');
const referenceIcons = [];
for(let n=1;n<=8;n++) {
 const html = await readFile(`docs/stitch-reference/UI-${String(n).padStart(2,'0')}.html`,'utf8');
 referenceIcons.push(...[...html.matchAll(/<span[^>]*class="[^"]*material-symbols-outlined[^"]*"[^>]*>\s*([a-z_0-9]+)\s*<\/span>/g)].map(m=>m[1]));
}
const iconNames = [...new Set([...baseIconNames,...referenceIcons])].sort().join(',');
const iconCssResponse = await fetch(`https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&icon_names=${iconNames}&display=block`, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
});
if (!iconCssResponse.ok) throw new Error(`Icon CSS: ${iconCssResponse.status}`);
let iconCss = await iconCssResponse.text();
const iconUrl = /url\((https:[^)]+)\)/.exec(iconCss)?.[1];
if (!iconUrl) throw new Error('Missing Material Symbols font URL');
const iconResponse = await fetch(iconUrl);
if (!iconResponse.ok) throw new Error(`Icon font: ${iconResponse.status}`);
await writeFile(path.join(root, 'material-symbols.woff2'), Buffer.from(await iconResponse.arrayBuffer()));
iconCss = iconCss.replaceAll(iconUrl, '/fonts/stitch/material-symbols.woff2');
await writeFile('ui/src/fonts.css', css + '\n' + iconCss);
for (const family of ['newsreader', 'plusjakartasans', 'jetbrainsmono', 'notosanssc']) {
  const license = await fetch(`https://raw.githubusercontent.com/google/fonts/main/ofl/${family}/OFL.txt`);
  if (!license.ok) throw new Error(`Font license ${family}: ${license.status}`);
  await writeFile(path.join(root, `${family}-OFL.txt`), await license.text());
}
const iconLicense = await fetch('https://raw.githubusercontent.com/google/material-design-icons/master/LICENSE');
if (!iconLicense.ok) throw new Error(`Icon license: ${iconLicense.status}`);
await writeFile(path.join(root, 'material-symbols-LICENSE.txt'), await iconLicense.text());
console.log(`Saved ${urls.length} local font files.`);
