import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RIFT_PLAYWRIGHT_MODULE || 'playwright');
const home = process.env.RIFT_HOME || 'D:\\RiftUI';
const launch = JSON.parse(execFileSync(process.execPath,['dist/cli/main.js','ui','--home',home,'--json'],{encoding:'utf8'}));
const browser = await chromium.launch({channel:'msedge',headless:true});
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const failed = [], errors = [];
  page.on('response',response=>{if(response.status()>=400)failed.push({url:response.url(),status:response.status()});});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(launch.url);
  await page.locator('.workspace-layout').waitFor();
  await page.evaluate(()=>document.fonts.ready);
  await page.waitForLoadState('networkidle');
  const assets=await page.evaluate(async()=>({
    iconFontLoaded:(await document.fonts.load('18px "Material Symbols Outlined"','grid_view')).length>0,
    fontFaces:[...document.fonts].filter(f=>f.status==='loaded').map(f=>f.family),
    images:[...document.images].map(i=>({src:i.getAttribute('src'),complete:i.complete,width:i.naturalWidth})),
  }));
  assert.equal(assets.iconFontLoaded,true,'Production Host must serve the icon font');
  assert.ok(assets.images.every(i=>i.complete&&i.width>0),'All production images must decode');
  assert.deepEqual(failed,[]); assert.deepEqual(errors,[]);
  await mkdir('docs/evidence/stitch-alignment',{recursive:true});
  await page.screenshot({path:'docs/evidence/stitch-alignment/host-assets-fixed.png',animations:'disabled'});
  const report={mode:'Actual production Host, authenticated browser, no API mocks or business writes',assets,failed,errors};
  await writeFile('docs/evidence/stitch-alignment/host-assets-report.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { await browser.close(); }
