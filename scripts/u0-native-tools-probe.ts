import http from 'node:http';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import '@deepseek-ai/dsh-subprocess';
import { NativeCodexRuntime, nativeCodexPackage } from '../src/agent/native-codex.js';
import { createImageTool, prepareDshToolResult, renderDshToolResult } from '../src/agent/image-tool.js';
import { publicError } from '../src/api/security.js';

const model = process.argv[2] ?? 'gpt-6.1-sol';
if (!['gpt-6.1-sol', 'gpt-6-astra'].includes(model)) throw new Error('Unsupported probe model.');
const evidenceRoot = path.resolve('.runtime-evidence');
await mkdir(evidenceRoot, { recursive: true });
const temporary = await mkdtemp(path.join(evidenceRoot, 'u0-native-'));
const requests: { tools: unknown; model: unknown; toolKeys?: string[]; codeTools?: string[] }[] = [];
let invocationCount = 0;
let httpCount = 0;
let imageRequests=0;
const toolOutputs:unknown[]=[];
await writeFile(path.join(temporary,'probe.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8AARGDiPwMAHfAD/aAzCYkAAAAASUVORK5CYII=','base64'));
const server = http.createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const additional = (body.input ?? []).filter((item: any) => item.type === 'additional_tools').flatMap((item: any) => item.tools ?? []);
    const described = JSON.stringify(body.input ?? []);
    requests.push({ tools: body.tools ?? additional, model: body.model, toolKeys: Object.keys(body), codeTools: [...new Set((described.match(/tools\.[A-Za-z_][A-Za-z_0-9]*/g) ?? []))] as string[] });
    if(JSON.stringify(body.input??[]).includes('data:image/'))imageRequests++;
    toolOutputs.push((body.input??[]).filter((item:any)=>item.type==='function_call_output'));
    httpCount++;
    const item = httpCount === 1
      ? { type: 'function_call', id: 'fc_probe', call_id: 'call_probe', name: 'rift_probe', arguments: '{}' }
      : httpCount===2 ? {type:'function_call',id:'fc_image',call_id:'call_image',name:'view_image',arguments:JSON.stringify({path:path.join(temporary,'probe.png')})}
      : httpCount===3 ? {type:'function_call',id:'fc_scoped_image',call_id:'call_scoped_image',name:'rift_view_image',arguments:JSON.stringify({path:'probe.png'})}
      : { type: 'message', id: 'msg_probe', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'RIFT_NATIVE_TOOL_PROBE_OK', annotations: [] }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (type: string, value: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    send('response.created', { response: { id: `r_${httpCount}`, status: 'in_progress', output: [] } });
    send('response.output_item.added', { output_index: 0, item });
    send('response.output_item.done', { output_index: 0, item });
    send('response.completed', { response: { id: `r_${httpCount}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  } catch { res.writeHead(500); res.end(); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as import('node:net').AddressInfo).port;
process.env.DSH_HOME = path.join(temporary, 'dsh');
process.env.RIFT_HOME = path.join(temporary, 'rift');
process.env.RIFT_PORT = '0';
initializeProfileFromDefault('u0-native', 'sdk-minimal', process.env.DSH_HOME);
const report: Record<string, unknown> = { date: new Date().toISOString(), model, mode: 'real native Codex app-server with controlled local Responses server; zero external model calls', payload: nativeCodexPackage().version };
const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv('u0-native'), profile: 'u0-native', patchFiles: [path.resolve('profiles/rift.patch.yml')], args: [] });
let handle: Awaited<ReturnType<NativeCodexRuntime['start']>> | undefined;
try {
  const storedImage=await prepareDshToolResult(ctx,await createImageTool([temporary]).execute({path:'probe.png'},new AbortController().signal));
  report.dshImageAttachment=renderDshToolResult(storedImage).map(block=>block.type);
  const runtime = new NativeCodexRuntime({ spawn: spec => ctx.subprocess.spawn(spec), modelProvider: { id: 'rift_probe', config: { name: 'RIFT local protocol probe', base_url: `http://127.0.0.1:${port}/v1`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0, stream_idle_timeout_ms: 10000 } } });
  handle = await runtime.start({ workspaceId: 'u0', agentId: 'lead', turnId: 'probe', cwd: temporary, model, instructions: 'Call rift_probe and report its result.', messages: [{ role: 'user', content: 'Call rift_probe.' }], signal: AbortSignal.timeout(45000), tools: [{ name: 'rift_probe', description: 'A local no-effect boundary probe.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, async execute() { invocationCount++; return { acknowledged: true }; } }] });
  report.result = await handle.result;
  await handle.dispose();
  handle = undefined;
  const toolNames = (tools: any[]): string[] => tools.flatMap(tool => tool.type === 'namespace' ? tool.tools.map((child: any) => `${tool.name}.${child.name}`) : [tool.name ?? tool.type]);
  report.advertisedTools = requests.map(request => toolNames(request.tools as any[]));
  report.codeTools = requests.map(request => request.codeTools);
  report.invocationCount = invocationCount;
  report.httpCount = httpCount;
  report.imageRequests=imageRequests;
  report.toolOutputTypes=toolOutputs.map(batch=>(batch as any[]).map(item=>({callId:item.call_id,types:Array.isArray(item.output)?item.output.map((block:any)=>block.type):['text']})));
  report.boundaryPassed = requests.length > 0 && requests.every(request => { const names = toolNames(request.tools as any[]); return names.includes('rift_probe') && names.every(name => ['rift_probe', 'rift_view_image', 'view_image', 'request_user_input'].includes(name)); });
  report.deniedNativeSurface = 'request_user_input is native interaction only; its server request is rejected by the RIFT gateway. Host-scoped view_image and rift_view_image are allowed; no shell, other native filesystem, MCP, plugins, or delegation tools are advertised.';
  report.status = report.boundaryPassed && imageRequests >= 2 && invocationCount === 1 && (report.result as { text: string }).text.includes('RIFT_NATIVE_TOOL_PROBE_OK') ? 'pass' : 'fail';
  report.cleanup = 'confirmed';
} catch (error) { report.status = 'fail'; report.error = publicError(error); report.requests = requests; }
finally {
  if (handle) { try { await handle.dispose(); report.cleanup = 'confirmed'; } catch { report.cleanup = 'unknown'; } }
  await shutdown.shutdown(0);
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await writeFile(path.resolve('docs/evidence/u0-native-tools-probe-' + model + '.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'pass') process.exitCode = 1;
}


