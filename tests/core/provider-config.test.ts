import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { RiftHostService } from '../../src/api/host-service.js';

afterEach(()=>vi.unstubAllEnvs());
function modelExpression(provider:'claude'|'codex'):string {
  const profile=readFileSync(new URL('../../profiles/rift.patch.yml',import.meta.url),'utf8').replaceAll('\r\n','\n');
  const section=profile.split(`    - id: rift-${provider}\n`)[1]?.split('    - id: ')[0];
  const block=section?.match(/^        model: !!js >-\n((?:^          .*\n?)+)/m)?.[1];
  if(!block)throw new Error(`Missing model configuration for ${provider}`);
  return block.split(/\r?\n/).map(line=>line.replace(/^          /,'')).join('\n').trim();
}

describe('explicit provider models and evidence-based doctor',()=>{
  it('pins Opus 5.5 and rejects empty or unrequested Claude model names',()=>{
    const expression=modelExpression('claude');
    for(const env of [{},{RIFT_CLAUDE_MODEL:'claude-opus-5-5'}])expect(runInNewContext(expression,{process:{env}})).toBe('claude-opus-5-5');
    for(const value of ['', 'opus', 'claude-sonnet-5-5'])expect(()=>runInNewContext(expression,{process:{env:{RIFT_CLAUDE_MODEL:value}}})).toThrow('RIFT_CLAUDE_MODEL must be claude-opus-5-5.');
  });

  it('preserves both explicit Codex model choices without silently accepting another model',()=>{
    const expression=modelExpression('codex');
    expect(runInNewContext(expression,{process:{env:{}}})).toBe('gpt-6.1-sol');
    for(const model of ['gpt-6.1-sol','gpt-6-astra'])expect(runInNewContext(expression,{process:{env:{RIFT_CODEX_MODEL:model}}})).toBe(model);
    expect(()=>runInNewContext(expression,{process:{env:{RIFT_CODEX_MODEL:''}}})).toThrow();
  });

  it('reports key presence without claiming authenticated access or exposing a credential value',async()=>{
    const temporary=await mkdtemp(path.join(tmpdir(),'rift-doctor-config-'));
    const ctx={subagents:{list:()=>['claude-code-dev','codex-review'],getProvider:()=>({capabilities:{}})}} as unknown as Context;
    const host=new RiftHostService(ctx,{home:temporary,port:0,leadProvider:'test',leadModel:'test',checks:[]});
    try {
      vi.stubEnv('ANTHROPIC_API_KEY',undefined);vi.stubEnv('DEEPSEEK_API_KEY',undefined);
      const absent=host.doctor();
      expect(absent.configuration.environmentPresence).toEqual({deepseekApiKey:false,anthropicApiKey:false});
      expect(absent.authentication.claude).toBe('not-verified');
      vi.stubEnv('ANTHROPIC_API_KEY','synthetic-claude-secret-for-redaction-test');vi.stubEnv('DEEPSEEK_API_KEY','synthetic-deepseek-secret-for-redaction-test');
      const present=host.doctor();
      expect(present.configuration.environmentPresence).toEqual({deepseekApiKey:true,anthropicApiKey:true});
      expect(present.authentication).toEqual(absent.authentication);
      expect(JSON.stringify(present)).not.toContain('synthetic-');
      expect(JSON.stringify(present)).not.toContain('POC is skipped');
      expect(present.providers.map(provider=>provider.name)).toEqual(['claude-code-dev','codex-review']);
    }finally{await host.close();await rm(temporary,{recursive:true,force:true});}
  });
});
