import { describe, expect, it } from 'vitest';
import { SafeChatStream } from '../../src/chat/safe-stream.js';
import { redact, registerCredentialRedaction } from '../../src/api/security.js';

describe('language-independent incremental redaction', () => {
  it.each(['我先检查仓库，然后分析原因。接下来验证工具进度。', 'I will inspect the repository, then verify progress.', '先检查 API，再验证 stream 输出。🚀完成'])('publishes %s before message completion at every chunk width', text => {
    for (const width of [1,2,5,13]) {
      const stream = new SafeChatStream(); let visible = '';
      for (let i=0;i<text.length;i+=width) {
        visible += stream.push(text.slice(i,i+width));
        expect(visible).not.toMatch(/[\uD800-\uDBFF]$/u);
        expect(text.startsWith(visible)).toBe(true);
        if (i >= 5) expect(visible.length).toBeGreaterThan(0);
      }
      expect(stream.finish()).toBe(text);
      expect(visible.length).toBeGreaterThan(text.length/2);
    }
  });

  it.each(['Bearer hidden-credential-value ', '{"password":"hidden-alpha \\" hidden-omega"}', "api_key='hidden-alpha\nhidden-omega'", 'sk-hidden-secret-credential-value '])('never leaks sensitive values sent one character at a time: %s', value => {
    const stream = new SafeChatStream(); let visible = '';
    for (const character of `中文说明。${value}。继续输出。`) {
      visible += stream.push(character);
      expect(visible).not.toContain('hidden');
    }
    expect(stream.finish()).toBe(redact(`中文说明。${value}。继续输出。`,256000));
    expect(stream.finish().startsWith(visible)).toBe(true);
  });

  it('holds only a matching literal prefix, even for secrets containing whitespace', () => {
    const secret = 'registered multi\nline credential 9876';
    registerCredentialRedaction('STREAM_TEST_LITERAL',secret);
    const stream = new SafeChatStream(); let visible = stream.push('我先检查。');
    expect(visible).toBe('我先检查。');
    for (const character of secret) visible += stream.push(character);
    visible += stream.push('，完成。');
    expect(visible).toBe('我先检查。[REDACTED]，完成。');
  });
});


it('keeps UTF-8 truncation and an interrupted UTF-16 pair well formed',()=>{
  expect(redact('中🚀文',5)).toBe('中\n[TRUNCATED]');
  const stream=new SafeChatStream();
  expect(stream.push('开始\uD83D')).toBe('开始');
  expect(stream.finish()).toBe('开始');
  expect(stream.push('\uDE80')).toBe('🚀');
  expect(stream.finish()).toBe('开始🚀');
});
