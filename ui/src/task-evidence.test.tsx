import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EvidenceContent, TaskEvidence } from './TaskEvidence';
import { adaptTaskEvidence, readTaskEvidence } from './task-evidence';

const check={id:'check',commandId:'test:ui',candidateHead:'candidate-a',exitCode:0,stdout:'ok <script>unsafe()</script>',stderr:'',startedAt:'2026-10-28T01:00:00Z',finishedAt:'2026-10-28T01:01:00Z',truncated:false};
const review={schemaVersion:1,taskId:'task',runId:'review-run',verdict:'approve',reviewedCommit:'candidate-a',findings:[]};
const legacy=()=>({taskId:'task',acceptedCommit:null as string|null,integrations:[{id:'integration',status:'checking',candidateHead:'candidate-a',checks:[{...check}],review:{...review},evidenceUnavailable:false}]});
const render=(value:unknown)=>renderToStaticMarkup(<EvidenceContent state={{status:'loaded',evidence:adaptTaskEvidence(value,'task')}} onRetry={()=>{}}/>);

describe('task evidence compatibility and conservative display',()=>{
  it('does not present legacy exit zero, approval, or an accepted historical commit as current Host success',()=>{
    const fixture=legacy();fixture.acceptedCommit='old-head';
    const html=render(fixture);
    for(const label of ['candidate-a','当前候选绑定未知','Host 来源未确认','非当前验收结论','复审上下文：未记录','旧记录未提供'])expect(html).toContain(label);
    expect(html).not.toContain('>检查通过<');expect(html).not.toContain('<script>');
  });
  it('marks mismatched checks and review as inapplicable even when they report success',()=>{
    const fixture=legacy();fixture.integrations[0]!.candidateHead='candidate-b';
    const html=render(fixture);
    expect(html).toContain('候选不匹配');expect(html).toContain('不适用于此候选');expect(html).not.toContain('>检查通过<');
  });
  it('handles missing files, empty evidence, and partial legacy records without inventing a pass',()=>{
    expect(render({taskId:'task',integrations:[]})).toContain('证据未就绪');
    const html=render({taskId:'task',integrations:[{id:'old',checks:[{}],review:{...review,taskId:'foreign'}}]});
    expect(html).toContain('记录不完整');expect(html).toContain('没有可用的实际检查记录');expect(html).toContain('没有可用的独立审核报告');
    expect(html).not.toContain('>检查通过<');
  });
  it('rejects foreign or malformed responses',()=>{
    for(const value of [null,{}, {taskId:'other',integrations:[]},{taskId:'task',integrations:null}])expect(()=>adaptTaskEvidence(value,'task')).toThrow('不匹配或格式不可用');
  });
  it('renders loading and recoverable errors with accessible semantics, without simultaneous loading on failure',()=>{
    const loading=renderToStaticMarkup(<TaskEvidence workspaceId="ws" taskId="task" revision="1"/>);
    expect(loading).toContain('aria-busy="true"');expect(loading).toContain('role="status"');expect(loading).toContain('正在读取证据');
    const error=renderToStaticMarkup(<EvidenceContent state={{status:'error',error:'证据服务不可用'}} onRetry={()=>{}}/>);
    expect(error).toContain('role="alert"');expect(error).toContain('重试读取证据');expect(error).not.toContain('正在读取证据');
  });
  it('shows failure exit codes, full candidate ids, and truncated-output warnings',()=>{
    const fixture=legacy();fixture.integrations[0]!.checks[0]!.exitCode=1;fixture.integrations[0]!.checks[0]!.truncated=true;
    const html=render(fixture);expect(html).toContain('记录失败');expect(html).toContain('输出已截断');expect(html).toContain('<summary>');
  });
});

it('reads the real evidence route with safe path encoding, same-origin auth, no cache and cancellation',async()=>{
  const taskId='task/a#b';
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({taskId,integrations:[]})));
  const controller=new AbortController();vi.stubGlobal('fetch',fetch);
  try {
    expect(await readTaskEvidence('ws/a',taskId,controller.signal)).toMatchObject({taskId,integrations:[]});
    expect(fetch).toHaveBeenCalledWith('/ui-api/v1/workspaces/ws%2Fa/tasks/task%2Fa%23b/evidence',expect.objectContaining({signal:controller.signal,credentials:'same-origin',cache:'no-store'}));
  } finally {vi.unstubAllGlobals();}
});
it('propagates HTTP, transport and task identity failures instead of treating them as empty success',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('{}',{status:503})).mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(new Response(JSON.stringify({taskId:'foreign',integrations:[]}))));
  try {
    await expect(readTaskEvidence('ws','task',new AbortController().signal)).rejects.toMatchObject({status:503});
    await expect(readTaskEvidence('ws','task',new AbortController().signal)).rejects.toThrow('offline');
    await expect(readTaskEvidence('ws','task',new AbortController().signal)).rejects.toThrow('不匹配');
  } finally {vi.unstubAllGlobals();}
});

it('discards a late response after cancellation even if a transport ignores AbortSignal',async()=>{
  let resolve!:(response:Response)=>void;
  vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>new Promise<Response>(done=>{resolve=done;})));
  const controller=new AbortController();
  try {
    const pending=readTaskEvidence('ws','task',controller.signal);controller.abort();
    resolve(new Response(JSON.stringify({taskId:'task',integrations:[]})));
    await expect(pending).rejects.toMatchObject({name:'AbortError'});
  } finally {vi.unstubAllGlobals();}
});
