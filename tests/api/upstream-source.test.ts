import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const mocks=vi.hoisted(()=>({lookup:vi.fn(),request:vi.fn()}));
vi.mock('node:dns/promises',()=>({lookup:mocks.lookup}));
vi.mock('node:https',()=>({request:mocks.request}));
import { githubSourceUrl, publicSourceAddress, readGithubSource } from '../../src/api/upstream-source.js';
const input={url:'https://github.com/example/skill',maxBytes:65536};
function respond(status:number,body:Buffer|string){
 mocks.request.mockImplementation((_url,options,cb)=>{
  const req=new EventEmitter() as EventEmitter & {end:()=>void;destroy:(e:Error)=>void};
  req.end=()=>queueMicrotask(()=>{const response=new PassThrough() as PassThrough & {statusCode:number};response.statusCode=status;cb(response);if(!response.destroyed)response.end(body);});
  req.destroy=(error)=>{queueMicrotask(()=>req.emit('error',error));};
  return req;
 });
}
beforeEach(()=>{vi.resetAllMocks();mocks.lookup.mockResolvedValue([{address:'185.199.108.133',family:4}]);respond(200,'# Installation\nRead first.');});
describe('public upstream documentation transport',()=>{
 it('normalizes repository, blob and raw file URLs',()=>{
  expect(githubSourceUrl(input.url).href).toBe('https://raw.githubusercontent.com/example/skill/HEAD/README.md');
  expect(githubSourceUrl('https://github.com/example/skill/blob/main/docs/install.md').href).toBe('https://raw.githubusercontent.com/example/skill/main/docs/install.md');
  expect(githubSourceUrl('https://raw.githubusercontent.com/example/skill/v1/SKILL.md').pathname).toBe('/example/skill/v1/SKILL.md');
 });
 it.each(['http://github.com/a/b','https://user:pass@github.com/a/b','https://github.com/a/b?q=1','https://github.com/a/b#part','https://github.com.evil.test/a/b','https://127.0.0.1/a/b','file:///etc/passwd','https://github.com/a/b/tree/main','https://github.com/a/b/blob/main/a%2fb'])('rejects unsupported URL %s',(url)=>expect(()=>githubSourceUrl(url)).toThrow());
 it.each(['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','0.0.0.0','100.64.1.1','192.0.0.1','198.18.0.1','198.51.100.2','203.0.113.2','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1'])('rejects non-public address %s',(ip)=>expect(publicSourceAddress(ip)).toBe(false));
 it('pins validated DNS and returns bounded UTF-8 content with digest and untrusted marker',async()=>{
  const result=await readGithubSource(input);expect(result).toMatchObject({content:'# Installation\nRead first.',trust:'external-untrusted',bytes:26});expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  const [url,options]=mocks.request.mock.calls[0]!;expect(url.hostname).toBe('raw.githubusercontent.com');expect(options.agent).toBe(false);expect(options.headers).not.toHaveProperty('Authorization');
  const callback=vi.fn();options.lookup('ignored',{all:true},callback);expect(callback).toHaveBeenCalledWith(null,[{address:'185.199.108.133',family:4}]);
 });
 it('rejects mixed public/private DNS before opening a connection',async()=>{
  mocks.lookup.mockResolvedValue([{address:'185.199.108.133',family:4},{address:'127.0.0.1',family:4}]);await expect(readGithubSource(input)).rejects.toMatchObject({code:'SOURCE_ADDRESS'});expect(mocks.request).not.toHaveBeenCalled();
 });
 it('does not follow redirects or return authenticated/error responses',async()=>{respond(302,'');await expect(readGithubSource(input)).rejects.toMatchObject({code:'SOURCE_HTTP'});expect(mocks.request).toHaveBeenCalledTimes(1);});
 it('bounds response size',async()=>{await expect(readGithubSource({...input,maxBytes:4})).rejects.toMatchObject({code:'SOURCE_SIZE_LIMIT'});});
 it.each([Buffer.from([0]),Buffer.from([255])])('rejects binary or invalid UTF-8',async(body)=>{respond(200,body);await expect(readGithubSource(input)).rejects.toMatchObject({code:'SOURCE_ENCODING'});});
 it('bounds size before network access',async()=>{await expect(readGithubSource({...input,maxBytes:131073})).rejects.toMatchObject({code:'SOURCE_SIZE_LIMIT'});expect(mocks.lookup).not.toHaveBeenCalled();});
});
