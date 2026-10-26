import { expect, it, vi } from 'vitest';
import { randomId } from './browser-platform';

it('generates independent UUID v4 request identities on HTTP without randomUUID',()=>{
  const native = globalThis.crypto;
  vi.stubGlobal('crypto',{getRandomValues:native.getRandomValues.bind(native)});
  try {
    const ids = new Set(Array.from({length:100},()=>randomId()));
    expect(ids.size).toBe(100);
    for(const id of ids) expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  } finally { vi.unstubAllGlobals(); }
});
