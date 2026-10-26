import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeWorkspaceEvents } from './workspace-stream';
class Stream {
  static instances: Stream[] = [];
  listeners = new Map<string, (event: {lastEventId:string}) => void>();
  onopen?: () => void; onerror?: () => void; closed = false;
  constructor(readonly url: string) { Stream.instances.push(this); }
  addEventListener(type: string, listener: (event: {lastEventId:string}) => void) { this.listeners.set(type,listener); }
  close() { this.closed = true; }
  emit(type: string, id = '') { this.listeners.get(type)?.({lastEventId:id}); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); Stream.instances=[]; });
describe('workspace SSE recovery', () => {
  it('deduplicates replay and reconnects only after a successful snapshot, retrying failures', async () => {
    vi.useFakeTimers(); vi.stubGlobal('EventSource',Stream);
    const changed=vi.fn(), snapshot=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(300);
    const close=subscribeWorkspaceEvents('ws',5,{changed,snapshot,error:vi.fn(),expired:vi.fn()});
    const first=Stream.instances[0]!;
    first.emit('workspace','6'); first.emit('workspace','6'); first.emit('heartbeat','7'); first.emit('workspace','6');
    expect(changed).toHaveBeenCalledTimes(1);
    first.emit('resync_required'); await vi.advanceTimersByTimeAsync(0);
    expect(first.closed).toBe(true); expect(Stream.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(Stream.instances[1]?.url).toContain('after=300');
    first.emit('workspace','900'); first.emit('resync_required');
    expect(Stream.instances[1]?.closed).toBe(false);
    Stream.instances[1]!.emit('workspace','301'); expect(changed).toHaveBeenCalledTimes(2);
    close(); expect(Stream.instances[1]?.closed).toBe(true);
  });
  it('does not reopen after unmount or retry an expired snapshot session', async () => {
    vi.useFakeTimers(); vi.stubGlobal('EventSource',Stream);
    let finish!: (cursor: number) => void;
    const close=subscribeWorkspaceEvents('ws',1,{changed:vi.fn(),snapshot:()=>new Promise(resolve=>{finish=resolve;}),error:vi.fn(),expired:vi.fn()});
    Stream.instances[0]!.emit('resync_required'); close(); finish(50); await vi.advanceTimersByTimeAsync(2000);
    expect(Stream.instances).toHaveLength(1);
    const expired=vi.fn(); subscribeWorkspaceEvents('ws',1,{changed:vi.fn(),snapshot:async()=>{throw {status:401};},error:vi.fn(),expired});
    Stream.instances[1]!.emit('resync_required'); await vi.advanceTimersByTimeAsync(2000);
    expect(expired).toHaveBeenCalledOnce(); expect(Stream.instances).toHaveLength(2);
  });
});
