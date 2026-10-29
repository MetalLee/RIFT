import { invariant, RiftError, type DevelopmentResult, type ReviewResult } from '../contracts/index.js';
export function parseResult(text:string,expected:{taskId:string;runId:string;purpose:string}):DevelopmentResult|ReviewResult {
  invariant(text.length<=1_048_576,'RESULT_TOO_LARGE','Provider output exceeds the one MiB business result limit.');
  const raw=text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
  let value:Record<string,unknown>; try { value=JSON.parse(raw) as Record<string,unknown>; } catch { throw new RiftError('INVALID_RESULT','Expected one JSON result object.'); }
  invariant(value && typeof value==='object'&&!Array.isArray(value) && value.schemaVersion===1 && value.taskId===expected.taskId && value.runId===expected.runId,'INVALID_RESULT','Result schema, task ID or run ID does not match the reserved execution.');
  if(expected.purpose==='review') {
    invariant(Object.keys(value).every(key=>['schemaVersion','taskId','runId','verdict','reviewedCommit','findings'].includes(key)),'INVALID_RESULT','Unexpected review result fields.');
    invariant(['approve','changes_requested','blocked'].includes(String(value.verdict)) && typeof value.reviewedCommit==='string' && /^[0-9a-f]{40,64}$/.test(value.reviewedCommit) && Array.isArray(value.findings),'INVALID_RESULT','Review verdict, commit or findings is invalid.');
    invariant(value.findings.every((finding:unknown)=>{ if(!finding||typeof finding!=='object')return false; const f=finding as Record<string,unknown>; return ['critical','high','medium','low'].includes(String(f.severity))&&typeof f.file==='string'&&Number.isInteger(f.line)&&Number(f.line)>0&&typeof f.reason==='string'&&typeof f.suggestion==='string';}),'INVALID_RESULT','Review findings require a valid severity, file, positive line, reason and suggestion.');
    invariant(value.verdict!=='approve'||!value.findings.some((finding:unknown)=>['critical','high'].includes(String((finding as Record<string,unknown>).severity))),'INVALID_RESULT','Approval cannot contain critical or high findings.');
    return value as unknown as ReviewResult;
  }
  invariant(Object.keys(value).every(key=>['schemaVersion','taskId','runId','outcome','summary','changedPaths','checksClaimed','blockingReasons'].includes(key)),'INVALID_RESULT','Unexpected development result fields.');
  invariant(['completed','blocked'].includes(String(value.outcome)) && typeof value.summary==='string' && ['changedPaths','checksClaimed','blockingReasons'].every(key=>Array.isArray(value[key])&&(value[key] as unknown[]).every(item=>typeof item==='string')),'INVALID_RESULT','Development result is invalid.');
  return value as unknown as DevelopmentResult;
}

/** An operator may remove a wrapper, never invent or merge provider results. */
export function parseSupplement(text:string,output:string,expected:{taskId:string;runId:string;purpose:string}):DevelopmentResult {
  let value:unknown;
  try { value=JSON.parse(text); } catch { throw new RiftError('INVALID_RESULT','Supplement must be one bare JSON object.'); }
  const result=parseResult(JSON.stringify(value),expected) as DevelopmentResult;
  const start=output.indexOf(text);
  invariant(start>=0&&output.indexOf(text,start+text.length)===-1&&!/[{}\[\]]/.test(output.slice(0,start)+output.slice(start+text.length)),
    'RESULT_SOURCE_MISMATCH','Supplement must be the unique unchanged JSON object in the original output; ambiguous output is not recoverable.');
  return result;
}
