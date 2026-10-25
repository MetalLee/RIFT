export const pages = ['chat', 'workspaces', 'agents', 'skills', 'repositories', 'tasks', 'settings', 'activity'] as const;
export type Page = typeof pages[number];
export interface Route { workspaceId: string; page: Page }
export function parseRoute(hash: string): Route {
  const [, segment, encodedId, page] = hash.replace(/^#/, '').split('/');
  let workspaceId = '';
  try { workspaceId = segment === 'workspace' ? decodeURIComponent(encodedId ?? '') : ''; } catch { /* A malformed link returns to the directory. */ }
  return { workspaceId, page: pages.includes(page as Page) ? page as Page : 'chat' };
}
export function routeHref(workspaceId: string, page: Page): string { return `#/workspace/${encodeURIComponent(workspaceId)}/${page}`; }
export function draftKey(workspaceId: string, conversationId?: string): string { return `rift:draft:${encodeURIComponent(workspaceId)}${conversationId ? `:${encodeURIComponent(conversationId)}` : ''}`; }
export function readDraft(workspaceId: string, conversationId?: string): string {
  try { return sessionStorage.getItem(draftKey(workspaceId, conversationId)) ?? ''; } catch { return ''; }
}
export function saveDraft(workspaceId: string, text: string, conversationId?: string): boolean {
  try { sessionStorage.setItem(draftKey(workspaceId, conversationId), text); return true; } catch { return false; }
}

/** Switches abort prior work and also reject late responses from non-cooperative transports. */
export class LatestRequest {
  private generation = 0;
  private controller: AbortController | null = null;
  begin() {
    this.controller?.abort();
    const generation = ++this.generation;
    const controller = this.controller = new AbortController();
    return { signal: controller.signal, current: () => generation === this.generation && !controller.signal.aborted };
  }
  cancel() { this.generation++; this.controller?.abort(); }
}
