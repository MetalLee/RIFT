import { test } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTailnetProxy } from './rift-tailnet-proxy.mjs';

test('tailnet adapter restricts routes and origins while retaining browser authentication', async()=>{
  const seen=[];
  const backend=http.createServer((req,res)=>{seen.push({url:req.url,headers:req.headers});res.setHeader('Set-Cookie','rift_ui_47831=example; HttpOnly; SameSite=Strict; Path=/ui-api/v1');res.end('ok');});
  await new Promise(r=>backend.listen(0,'127.0.0.1',r));
  const upstream=`http://127.0.0.1:${backend.address().port}`;
  const origin='https://example.test.ts.net';
  const proxy=createTailnetProxy({origin,upstream});
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const request=(url,headers={})=>new Promise((resolve,reject)=>{
    http.get({hostname:'127.0.0.1',port:proxy.address().port,path:url,headers:{host:'example.test.ts.net',...headers}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,headers:res.headers}));}).on('error',reject);
  });
  try {
    for (const url of ['/v1/doctor','/v1/ui/bootstrap','/ui-api/../v1/doctor','/fonts/stitch/%2e%2e/secret','//evil.invalid/']) assert.equal((await request(url)).status,404);
    assert.equal((await request('/',{host:'evil.invalid'})).status,403);
    assert.equal((await request('/ui-api/v1/session',{origin:'https://evil.invalid'})).status,403);
    assert.equal((await request('/',{'tailscale-funnel-request':'?1'})).status,403);
    assert.equal(seen.length,0);
    const reply=await request('/ui-api/v1/session',{origin,'sec-fetch-site':'same-origin','x-csrf-token':'csrf',cookie:'session=value',authorization:'Bearer must-not-forward'});
    assert.equal(reply.status,200); assert.match(reply.headers['set-cookie'][0],/; Secure$/);
    assert.equal(seen[0].headers.origin,upstream);
    assert.equal(seen[0].headers['sec-fetch-site'],'same-origin');
    assert.equal(seen[0].headers['x-csrf-token'],'csrf');
    assert.equal(seen[0].headers.cookie,'session=value');
    assert.equal(seen[0].headers.authorization,undefined);
    assert.equal((await request('/fonts/stitch/material-symbols.woff2')).status,200);
  } finally { proxy.closeAllConnections();backend.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>backend.close(r))]); }
});
