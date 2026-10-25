import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RIFT_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.RIFT_UI_URL || 'http://127.0.0.1:5173';
const out = path.resolve('docs/evidence/stitch-alignment/reference');
await mkdir(out, { recursive: true });
const tailwindResponse = await fetch('https://cdn.tailwindcss.com');
if (!tailwindResponse.ok) throw new Error(`Tailwind reference runtime: ${tailwindResponse.status}`);
const tailwind = await tailwindResponse.text();
const fontCss = (await readFile('ui/src/fonts.css','utf8')).replaceAll('/fonts/stitch/',`${origin}/fonts/stitch/`);
const browser = await chromium.launch({channel:'msedge',headless:true});
const page = await browser.newPage({viewport:{width:1280,height:1024},deviceScaleFactor:1});
let referenceHtml = '';
await page.route(`${origin}/__stitch-reference*`,route=>route.fulfill({contentType:'text/html',body:referenceHtml}));
await page.route('https://cdn.tailwindcss.com/**',route=>route.fulfill({contentType:'text/javascript',body:tailwind}));
await page.route('https://lh3.googleusercontent.com/**',async route=>route.fulfill({contentType:'image/jpeg',body:await readFile('ui/public/assets/workspace-studio-stitch.jpg')}));
await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:fontCss}));
const results = [];
for (let n=1;n<=8;n++) {
  const id = `UI-${String(n).padStart(2,'0')}`;
  let html = await readFile(`docs/stitch-reference/${id}.html`,'utf8');
  // Only the exported Tailwind configuration is needed for a static comparison.
  // Do not run prototype demo handlers or make their example actions live.
  html = html.replace(/<script(?![^>]*(?:src=|id="tailwind-config"))[^>]*>[\s\S]*?<\/script>/g,'');
  referenceHtml = html;
  await page.goto(`${origin}/__stitch-reference?id=${id}`,{waitUntil:'networkidle'});
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:path.join(out,`${id}-1280.png`)});
  results.push({id,geometry:await page.evaluate(()=>[...document.querySelectorAll('main, main > *, .agent-card')].slice(0,12).map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,className:e.className,x:r.x,y:r.y,width:r.width,height:r.height,padding:s.padding,gap:s.gap};}))});
}
await writeFile(path.join(out,'geometry.json'),JSON.stringify(results,null,2));
await browser.close();
console.log('Rendered all eight current Stitch HTML exports at 1280px.');
