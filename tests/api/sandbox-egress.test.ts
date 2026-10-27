import {beforeEach,describe,it,expect,vi} from 'vitest';
import {request} from 'node:http';
import {connect} from 'node:net';
const mocks=vi.hoisted(()=>({lookup:vi.fn()}));
vi.mock('node:dns/promises',()=>({lookup:mocks.lookup}));
import {publicDestination,startSandboxEgress} from '../../src/agent/sandbox-egress.js';
beforeEach(()=>{vi.resetAllMocks();mocks.lookup.mockResolvedValue([{address:'185.199.108.133',family:4}]);});
describe('sandbox public egress gateway',()=>{
 it('pins a public IPv4 result and validates all DNS answers',async()=>{expect(await publicDestination('registry.npmjs.org',443)).toBe('185.199.108.133');expect(mocks.lookup).toHaveBeenCalledWith('registry.npmjs.org',{all:true,family:4});mocks.lookup.mockResolvedValue([{address:'185.199.108.133',family:4},{address:'10.0.0.1',family:4}]);await expect(publicDestination('registry.npmjs.org',443)).rejects.toMatchObject({code:'NETWORK_DESTINATION'});});
 it.each(['127.0.0.1','10.0.0.1','172.16.0.1','192.168.0.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','::ffff:127.0.0.1'])('rejects resolved private address %s',async(address)=>{mocks.lookup.mockResolvedValue([{address,family:4}]);await expect(publicDestination('example.com',443)).rejects.toMatchObject({code:'NETWORK_DESTINATION'});});
 it.each([22,47831,8443,2375,5432])('does not expose non-HTTP services on port %s',async(port)=>{await expect(publicDestination('example.com',port)).rejects.toMatchObject({code:'NETWORK_DESTINATION'});expect(mocks.lookup).not.toHaveBeenCalled();});
 it('rejects private HTTP and CONNECT through the real Unix capability',async()=>{
  mocks.lookup.mockResolvedValue([{address:'127.0.0.1',family:4}]);const proxy=await startSandboxEgress();try{
   const status=await new Promise<number>((resolve,reject)=>{const req=request({socketPath:proxy.directory+'/proxy.sock',path:'http://localhost/',method:'GET'},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.end();});expect(status).toBe(403);
   const response=await new Promise<string>((resolve,reject)=>{const socket=connect(proxy.directory+'/proxy.sock',()=>socket.write('CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n'));let text='';socket.on('data',data=>text+=data);socket.on('end',()=>resolve(text));socket.on('error',reject);});expect(response).toContain('403 Forbidden');
  }finally{await proxy.close();}
 });
});
