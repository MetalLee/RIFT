import {beforeEach,describe,it,expect,vi} from 'vitest';
import {request,createServer} from 'node:http';
import {connect} from 'node:net';
const mocks=vi.hoisted(()=>({lookup:vi.fn(),upstreamPort:0}));
vi.mock('node:dns/promises',()=>({lookup:mocks.lookup}));
// Route standard destination ports to an ephemeral local test server without
// requiring privileged ports. The real proxy, DNS policy and sockets still run.
vi.mock('node:http',async original=>{
 const actual=await original<typeof import('node:http')>();
 return {...actual,request:(options:any,...args:any[])=>actual.request(mocks.upstreamPort&&options.hostname==='127.0.0.1'&&options.port===80?{...options,port:mocks.upstreamPort}:options,...args)};
});
vi.mock('node:net',async original=>{
 const actual=await original<typeof import('node:net')>();
 return {...actual,connect:(options:any,...args:any[])=>actual.connect(mocks.upstreamPort&&options.host==='127.0.0.1'&&options.port===443?{...options,port:mocks.upstreamPort}:options,...args)};
});
import {httpDestination,startSandboxEgress} from '../../src/agent/sandbox-egress.js';
beforeEach(()=>{vi.resetAllMocks();mocks.upstreamPort=0;mocks.lookup.mockResolvedValue([{address:'185.199.108.133',family:4}]);});
async function tunnel(directory:string,target:string) {
 return new Promise<string>((resolve,reject)=>{
  const socket=connect(directory+'/proxy.sock',()=>socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));let text='';
  socket.on('data',data=>{text+=data;if(text.includes('200 Connection Established'))socket.end();});socket.on('end',()=>resolve(text));socket.on('error',reject);
 });
}
describe('sandbox Host HTTP(S) egress gateway',()=>{
 it('pins the resolved IPv4 destination without filtering mixed public and private DNS answers',async()=>{
  expect(await httpDestination('registry.npmjs.org',443)).toBe('185.199.108.133');
  expect(mocks.lookup).toHaveBeenCalledWith('registry.npmjs.org',{all:true,family:4});
  mocks.lookup.mockResolvedValue([{address:'10.0.0.1',family:4},{address:'185.199.108.133',family:4}]);
  expect(await httpDestination('example.com',443)).toBe('10.0.0.1');
 });
 it.each(['127.0.0.1','10.0.0.1','172.31.0.189','192.168.0.1','169.254.169.254','100.64.0.1'])('allows resolved private/Host address %s',async address=>{
  mocks.lookup.mockResolvedValue([{address,family:4}]);expect(await httpDestination('example.com',443)).toBe(address);
 });
 it.each([22,47831,8443,2375,5432])('retains the HTTP(S) port boundary: %s',async port=>{
  await expect(httpDestination('example.com',port)).rejects.toMatchObject({code:'NETWORK_DESTINATION'});expect(mocks.lookup).not.toHaveBeenCalled();
 });
 it('reports DNS failures separately from access denials',async()=>{
  mocks.lookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'),{code:'ENOTFOUND'}));
  const proxy=await startSandboxEgress();try{
   const response=await tunnel(proxy.directory,'missing.example:443');
   expect(response).toContain('502 Bad Gateway');expect(response).toContain('error=dns_error');
  }finally{await proxy.close();}
 });
 it('allows private HTTP and CONNECT through the real Unix capability',async()=>{
  mocks.lookup.mockResolvedValue([{address:'127.0.0.1',family:4}]);
  const upstream=createServer((_req,res)=>res.end('INTERNAL_OK'));
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));mocks.upstreamPort=(upstream.address() as {port:number}).port;
  const proxy=await startSandboxEgress();try{
   const response=await new Promise<{status:number;body:string}>((resolve,reject)=>{
    const req=request({socketPath:proxy.directory+'/proxy.sock',path:'http://internal.example/',method:'GET'},res=>{let body='';res.on('data',data=>body+=data);res.on('end',()=>resolve({status:res.statusCode!,body}));});req.on('error',reject);req.end();
   });expect(response).toEqual({status:200,body:'INTERNAL_OK'});
   expect(await tunnel(proxy.directory,'internal.example:443')).toContain('200 Connection Established');
   const denied=await tunnel(proxy.directory,'internal.example:8443');expect(denied).toContain('403 Forbidden');
   const [headers,body]=denied.split('\r\n\r\n');expect(headers).toContain(`Content-Length: ${Buffer.byteLength(body!)}`);
  }finally{await proxy.close();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
 });
});
