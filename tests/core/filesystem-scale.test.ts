import {describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({lstat:vi.fn(),readdir:vi.fn()}));
vi.mock('node:fs/promises',async()=>({...await vi.importActual('node:fs/promises'),lstat:mocks.lstat,readdir:mocks.readdir,realpath:async(p:string)=>p,mkdir:async()=>{}}));
vi.mock('../../src/agent/sandbox-egress.js',()=>({sandboxEgress:async()=>({directory:'/test-egress'})}));
import {sandboxCommand} from '../../src/agent/filesystem-sandbox.js';
describe('workspace preparation scale',()=>{
 it('does not turn more than 500000 authorized entries into a whole-workspace permission denial',async()=>{
  const entries=Array.from({length:500001},(_,i)=>({name:'link-'+i}));
  mocks.readdir.mockImplementation(async(p:string)=>p==='/workspace'?entries:[]);
  mocks.lstat.mockImplementation(async(p:string)=>({isSymbolicLink:()=>p.startsWith('/workspace/link-'),isFile:()=>false,isDirectory:()=>true,nlink:1}));
  const argv=await sandboxCommand(['/workspace'],'/workspace','true',[],{home:'/fixture-home'});
  expect(argv).toContain('/workspace');expect(mocks.lstat.mock.calls.filter(([p])=>p.startsWith('/workspace/link-'))).toHaveLength(500001);
 },30000);
});
