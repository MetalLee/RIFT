import type { ApiErrorBody } from '@rift/protocol';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RiftError } from '../contracts/index.js';

/** The executable and transport regression tests use this same management client. */
export async function managementRequest(home:string,method:string,route:string,body?:unknown,key:string=randomUUID()):Promise<any> {
  const endpoint=JSON.parse(await readFile(path.join(home,'endpoint.json'),'utf8')) as {url:string};
  const url=new URL(endpoint.url);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new RiftError('INVALID_ENDPOINT','Management endpoint must be HTTP loopback.');
  const token=(await readFile(path.join(home,'management.token'),'utf8')).trim();
  // Verification owns up to 60s of work + 5s of cleanup; allow 5s for transport.
  const timeout=method==='POST'&&/^\/v1\/connections\/[^/]+\/verify$/.test(route)?70000:35000;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try {
    const response=await fetch(`${url.origin}${route}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(method!=='GET'?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal});
    const value=await response.json() as Partial<ApiErrorBody>;
    if(!response.ok)throw new RiftError(value.error?.code??'HTTP_ERROR',value.error?.message??`HTTP ${response.status}`);
    return value;
  } catch(error) {
    if(controller.signal.aborted)throw new RiftError('REQUEST_TIMEOUT',method==='GET'?'Request timed out.':`Request timed out; outcome is unknown and Host work may continue. Inspect state; query the receipt using the SAME --key ${JSON.stringify(key)} and original input. OUTCOME_UNKNOWN means keep waiting, not retry with a new key.`);
    throw error;
  } finally { clearTimeout(timer); }
}
