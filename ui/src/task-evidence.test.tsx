import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EvidenceContent, TaskEvidence } from './TaskEvidence';
import { adaptTaskEvidence, readTaskEvidence } from './task-evidence';

const check={id:'check',commandId:'test:ui',candidateHead:'candidate-a',exitCode:0,stdout:'ok <script>unsafe()</script>',stderr:'',startedAt:'2026-10-28T01:00:00Z',finishedAt:'2026-10-28T01:01:00Z',truncated:false};
const review={schemaVersion:1,taskId:'task',runId:'review-run',verdict:'approve',reviewedCommit:'candidate-a',findings:[]};
const legacy=()=>({taskId:'task',acceptedCommit:null as string|null,integrations:[{id:'integration',status:'checking',candidateHead:'candidate-a',checks:[{...check}],review:{...review},evidenceUnavailable:false}]});
const render=(value:unknown)=>renderToStaticMarkup(<EvidenceContent state={{status:'loaded',evidence:adaptTaskEvidence(value,'task','ws')}} onRetry={()=>{}}/>);

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
    for(const value of [null,{}, {taskId:'other',integrations:[]},{taskId:'task',integrations:null}])expect(()=>adaptTaskEvidence(value,'task','ws')).toThrow('不匹配或格式不可用');
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

// Mirrors the Lead-confirmed GET extension; this fixture is not a live Host result.
const hostFixture = () => ({
  ...legacy(), currentCandidate: {integrationId:'integration',candidateHead:'candidate-a',sourceHead:'source-a',taskAttempt:2},
  integrations: [{...legacy().integrations[0]!,
    readiness: {status:'ready',requiredCheckIds:['test:ui'],missingCheckIds:[] as string[],blockers:[] as {classification:string;commandId:string;reason:string}[]},
    checks: [{...check,host:{schemaVersion:1,executionSource:'host',workspaceId:'ws',repositoryId:'repo',repositoryFingerprint:'repo-fingerprint',taskId:'task',attempt:2,
      integrationId:'integration',candidateHead:'candidate-a',command:{executable:'pnpm',args:['test:ui'],timeoutMs:120000},configurationFingerprint:'config-fingerprint',environmentFingerprint:'env-fingerprint',
      exitStatus:'passed',logSha256:'a'.repeat(64),summary:'真实执行摘要 <script>unsafe()</script>'}}],
  }],
});

describe('Host evidence projection and current-candidate safety',()=>{
  it('maps the confirmed GET shape to exact source, attempt and candidate without implying approval or acceptance',()=>{
    const fixture=hostFixture(),view=adaptTaskEvidence(fixture,'task','ws');
    expect(view.currentCandidate).toEqual(fixture.currentCandidate);
    expect(view.integrations[0]).toMatchObject({isCurrent:true,readyConfirmed:true,checks:[{bindingMatches:true,currentHost:true,passed:true}]});
    const html=render(fixture);
    for(const label of ['当前 Host 检查通过','审核前证据就绪：检查就绪','Host 指定的当前候选','source-a','任务尝试：2','Host 执行附件','repo-fingerprint','config-fingerprint','env-fingerprint','日志 SHA-256','不代表审核批准、任务验收或允许发布'])expect(html).toContain(label);
    expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('命令（仅展示）');expect(html).not.toContain('补证');
  });
  it.each(['workspaceId','taskId','integrationId','candidateHead','attempt'] as const)('does not count a foreign Host %s as a current passing result',key=>{
    const fixture=hostFixture();Object.assign(fixture.integrations[0]!.checks[0]!.host,{[key]:key==='attempt'?1:'foreign'});
    const view=adaptTaskEvidence(fixture,'task','ws');
    expect(view.integrations[0]?.checks[0]?.currentHost).toBe(false);expect(view.integrations[0]?.readyConfirmed).toBe(false);
    const html=render(fixture);expect(html).not.toContain('当前 Host 检查通过');expect(html).toContain('审核前证据就绪：未知');
  });
  it.each([null,undefined,{}, {integrationId:'integration',candidateHead:'candidate-a',sourceHead:'source-a',taskAttempt:0}])('never infers current from history when currentCandidate is missing or malformed (%j)',current=>{
    const fixture={...hostFixture(),currentCandidate:current};
    const view=adaptTaskEvidence(fixture,'task','ws');expect(view.currentCandidate).toBeNull();expect(view.integrations[0]?.readyConfirmed).toBe(false);
    const html=render(fixture);expect(html).toContain('当前候选绑定未知');expect(html).not.toContain('当前 Host 检查通过');
  });
  it('uses explicit Host identity, not array position or most recent timestamps',()=>{
    const fixture=hostFixture(),historical=hostFixture().integrations[0]!;
    historical.id='old';historical.candidateHead='old-head';historical.checks[0]!.candidateHead='old-head';historical.checks[0]!.finishedAt='2099-01-01';
    fixture.integrations.push(historical);
    const one=adaptTaskEvidence(fixture,'task','ws');fixture.integrations.reverse();const two=adaptTaskEvidence(fixture,'task','ws');
    expect(one.integrations.find(item=>item.isCurrent)?.id).toBe('integration');expect(two.integrations.find(item=>item.isCurrent)?.id).toBe('integration');
    expect(two.integrations.filter(item=>item.readyConfirmed)).toHaveLength(1);
  });
  it('does not bind an ambiguous duplicate or missing integration, even if the heads match',()=>{
    const fixture=hostFixture();fixture.integrations.push(hostFixture().integrations[0]!);
    expect(adaptTaskEvidence(fixture,'task','ws').integrations.some(item=>item.isCurrent)).toBe(false);
    expect(render(fixture)).toContain('没有唯一匹配的集成记录');expect(render(fixture)).not.toContain('当前 Host 检查通过');
    fixture.integrations=[];expect(render(fixture)).toContain('没有唯一匹配的集成记录');
  });
  it.each([
    {executionSource:'agent'}, {schemaVersion:2}, {logSha256:'bad-hash'}, {command:{executable:'pnpm',args:[null],timeoutMs:1000}}, {environmentFingerprint:null}, {attempt:null}, {exitStatus:'unknown'}, {exitStatus:null}, {exitStatus:''},
  ])('does not upgrade malformed or non-Host provenance to Host success (%j)',patch=>{
    const fixture=hostFixture();Object.assign(fixture.integrations[0]!.checks[0]!.host,patch);
    const html=render(fixture);expect(html).toContain('Host 来源未确认');expect(html).not.toContain('当前 Host 检查通过');
    expect(adaptTaskEvidence(fixture,'task','ws').integrations[0]?.readyConfirmed).toBe(false);
  });
  it.each([['failed','执行失败'],['environment_unavailable','环境不可用'],['timed_out','执行超时'],['skipped','已跳过'],['cancelled','已取消']])('does not interpret %s and exit zero as passed',(exitStatus,label)=>{
    const fixture=hostFixture();fixture.integrations[0]!.checks[0]!.host.exitStatus=exitStatus;
    const integration=adaptTaskEvidence(fixture,'task','ws').integrations[0];
    expect(integration).toMatchObject({readyConfirmed:false,checks:[{bindingMatches:true,currentHost:true,passed:false,host:{exitStatus}}]});
    const html=render(fixture);expect(html).toContain(`当前 Host ${label}`);expect(html).toContain(`执行结果：${label}`);
    expect(html).not.toContain('当前 Host 检查通过');expect(html).not.toContain('审核前证据就绪：检查就绪');
  });
  it('rejects inconsistent passed/exit-code records and incomplete evidence files as ready',()=>{
    const fixture=hostFixture();fixture.integrations[0]!.checks[0]!.exitCode=1;
    expect(render(fixture)).toContain('状态不一致');expect(render(fixture)).not.toContain('当前 Host 检查通过');
    expect(adaptTaskEvidence(fixture,'task','ws').integrations[0]?.readyConfirmed).toBe(false);
    fixture.integrations[0]!.checks[0]!.exitCode=0;fixture.integrations[0]!.evidenceUnavailable=true;
    expect(adaptTaskEvidence(fixture,'task','ws').integrations[0]?.readyConfirmed).toBe(false);
    fixture.integrations[0]!.evidenceUnavailable=false;fixture.integrations[0]!.checks=[];
    expect(adaptTaskEvidence(fixture,'task','ws').integrations[0]?.readyConfirmed).toBe(false);
  });
  it.each([
    ['ready','检查就绪'],['waiting_evidence','等待必需证据'],['failed','检查失败'],['environment_unavailable','检查环境不可用'],
  ])('renders readiness %s separately from independent review',(status,label)=>{
    const fixture=hostFixture();fixture.integrations[0]!.readiness.status=status;
    const html=render(fixture);expect(html).toContain(`审核前证据就绪：${label}`);expect(html).toContain('批准记录（非当前验收结论）');
  });
  it('distinguishes missing evidence, code defects, unavailable environments and non-blocking optional advice',()=>{
    const fixture=hostFixture(),readiness=fixture.integrations[0]!.readiness;
    readiness.status='waiting_evidence';readiness.requiredCheckIds.push('test:protocol');readiness.missingCheckIds.push('test:protocol');
    readiness.blockers=['code_defect','evidence_missing','environment_unavailable','optional'].map(classification=>({classification,commandId:'test:protocol',reason:`${classification} 的实际原因`}));
    const html=render(fixture);
    for(const label of ['缺失必需项：test:protocol','代码缺陷 · 阻断','缺失证据 · 阻断','环境不可用 · 阻断','可选建议 · 不阻断','evidence_missing 的实际原因'])expect(html).toContain(label);
    expect(adaptTaskEvidence(fixture,'task','ws').integrations[0]?.readyConfirmed).toBe(false);
    readiness.status='ready';readiness.requiredCheckIds=['test:ui'];readiness.missingCheckIds=[];readiness.blockers=[{classification:'optional',commandId:'lint',reason:'可稍后处理'}];
    expect(adaptTaskEvidence(fixture,'task','ws').integrations[0]?.readyConfirmed).toBe(true);expect(render(fixture)).toContain('可选建议 · 不阻断');
  });
  it.each([
    {missingCheckIds:['test:ui']}, {requiredCheckIds:['not-run']}, {blockers:[{classification:'code_defect',commandId:'test:ui',reason:'失败'}]},
  ])('does not trust a contradictory ready report (%j)',patch=>{
    const fixture=hostFixture();Object.assign(fixture.integrations[0]!.readiness,patch);
    expect(adaptTaskEvidence(fixture,'task','ws').integrations[0]?.readyConfirmed).toBe(false);expect(render(fixture)).toContain('审核前证据就绪：未知');
  });
  it.each([null,{}, {status:'ready'}, {status:'new-status',requiredCheckIds:[],missingCheckIds:[],blockers:[]}, {status:'ready',requiredCheckIds:[],missingCheckIds:[],blockers:[{classification:'unknown',commandId:'test:ui',reason:'不能丢弃'}]}])('keeps unavailable readiness unknown (%j)',readiness=>{
    const fixture={...hostFixture(),integrations:[{...hostFixture().integrations[0],readiness}]};
    const view=adaptTaskEvidence(fixture,'task','ws');expect(view.integrations[0]?.readiness).toBeNull();expect(view.integrations[0]?.readyConfirmed).toBe(false);
    expect(render(fixture)).toContain('审核前证据就绪：未知');
  });
  it('adapts the extended data on the actual GET client path',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(hostFixture()))));
    try {const view=await readTaskEvidence('ws','task',new AbortController().signal);expect(view.integrations[0]?.readyConfirmed).toBe(true);}
    finally {vi.unstubAllGlobals();}
  });
});

it('ignores historical attempts when current bound evidence exists, but does not hide a conflicting current failure',()=>{
  const fixture=hostFixture(),checks=fixture.integrations[0]!.checks;
  const old=hostFixture().integrations[0]!.checks[0]!;old.id='old-check';old.host.attempt=1;old.exitCode=1;old.host.exitStatus='failed';checks.push(old);
  expect(adaptTaskEvidence(fixture,'task','ws').integrations[0]?.readyConfirmed).toBe(true);
  old.host.attempt=2;
  expect(adaptTaskEvidence(fixture,'task','ws').integrations[0]?.readyConfirmed).toBe(false);
});
it('keeps an optional failed command visible without turning configured-check readiness into a failure',()=>{
  const fixture=hostFixture(),optional=hostFixture().integrations[0]!.checks[0]!;
  optional.id='optional';optional.commandId='lint';optional.exitCode=1;optional.host.exitStatus='failed';fixture.integrations[0]!.checks.push(optional);
  fixture.integrations[0]!.readiness.blockers.push({classification:'optional',commandId:'lint',reason:'可选检查失败，不阻断'});
  expect(adaptTaskEvidence(fixture,'task','ws').integrations[0]?.readyConfirmed).toBe(true);
  const html=render(fixture);expect(html).toContain('当前 Host 执行失败');expect(html).toContain('审核前证据就绪：检查就绪');expect(html).toContain('可选建议 · 不阻断');
});


describe.each(['skipped','cancelled'])('%s Host check compatibility',exitStatus=>{
  it.each([
    {executionSource:'agent'}, {schemaVersion:2}, {workspaceId:'foreign'}, {taskId:'foreign'},
    {integrationId:'foreign'}, {candidateHead:'foreign'}, {attempt:1},
  ])('preserves provenance and current-candidate checks (%j)',patch=>{
    const fixture=hostFixture();Object.assign(fixture.integrations[0]!.checks[0]!.host,{exitStatus},patch);
    const integration=adaptTaskEvidence(fixture,'task','ws').integrations[0];
    expect(integration?.checks[0]?.currentHost).toBe(false);expect(integration?.checks[0]?.passed).toBe(false);expect(integration?.readyConfirmed).toBe(false);
    const html=render(fixture);expect(html).not.toContain('当前 Host 已跳过');expect(html).not.toContain('当前 Host 已取消');
    expect(html).not.toContain('当前 Host 检查通过');expect(html).not.toContain('审核前证据就绪：检查就绪');
  });
  it('consumes the extended status through GET while safely ignoring extra plan and timing fields',async()=>{
    const fixture=hostFixture();fixture.integrations[0]!.checks[0]!.host.exitStatus=exitStatus;
    Object.assign(fixture.integrations[0]!,{
      checkPlan:{mode:'parallel',maxConcurrency:2,resourceSlots:2,nodes:[{commandId:'test:ui',dependsOn:[],isolation:'snapshot',resourceSlots:1,status:exitStatus,reason:'未完成执行'}]},
      timings:{checksWallMs:0},
    });
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture))));
    try {
      const view=await readTaskEvidence('ws','task',new AbortController().signal);
      expect(view.integrations[0]).toMatchObject({readyConfirmed:false,checks:[{currentHost:true,passed:false,host:{exitStatus}}]});
      const html=renderToStaticMarkup(<EvidenceContent state={{status:'loaded',evidence:view}} onRetry={()=>{}}/>);
      expect(html).toContain(exitStatus==='skipped'?'当前 Host 已跳过':'当前 Host 已取消');
      expect(html).not.toContain('当前 Host 检查通过');expect(html).not.toContain('审核前证据就绪：检查就绪');
    } finally {vi.unstubAllGlobals();}
  });
});
