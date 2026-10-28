import type { AgentTurn, ApiErrorBody, BrowserAgent, ChatPage, CompiledSkills, ErrorCode, LibrarySkill, SkillImportPreview, UiBinding, UiRun, UiSession, UiWorkspaceDetail, UiWorkspaceList, WorkspaceSseEvents, WorktreeRemovalTarget } from '@rift/protocol';
// @ts-expect-error Internal services are not part of the wire contract.
import type { SkillService } from '@rift/protocol';
// @ts-expect-error Credential-bearing binding snapshots are not public DTOs.
import type { ProviderBinding } from '@rift/protocol';
// @ts-expect-error Package subpaths cannot bypass the explicit entry point.
import type { Task } from '@rift/protocol/dist/workspace.js';

const session: UiSession = { csrfToken: 'test-only', expiresAt: 'later' };
const error: ApiErrorBody = { error: { code: 'FUTURE_HOST_ERROR', message: 'Refresh and retry' } };
const event: WorkspaceSseEvents['resync_required'] = {};
type Assert<T extends true> = T;
type NoBindingSecrets = Assert<'credentialRefs' extends keyof UiBinding ? false : true>;
type NoRunSnapshot = Assert<'providerSnapshot' extends keyof UiRun ? false : true>;
type NoListBytes = Assert<'contentBase64' extends keyof LibrarySkill['versions'][number]['resources'][number] ? false : true>;
type NoPreviewBytes = Assert<'contentBase64' extends keyof SkillImportPreview['resources'][number] ? false : true>;
type EffectiveBytes = Assert<'contentBase64' extends keyof CompiledSkills['resources'][number] ? true : false>;
export type Consumer = [AgentTurn, BrowserAgent, ChatPage, ErrorCode, UiWorkspaceDetail, UiWorkspaceList, WorktreeRemovalTarget];
void [session, error, event];

const referencedConnection: import('@rift/protocol').ApiConnectionCreate = {
  name: 'Host reference', protocol: 'openai-completions', endpoint: 'https://example.invalid/v1', model: 'test', credentialRef: 'HOST_AUTH',
};
// @ts-expect-error The Host requires exactly one authentication source.
const missingAuthentication: import('@rift/protocol').ApiConnectionCreate = { name: 'Missing', protocol: 'openai-completions', endpoint: 'https://example.invalid', model: 'test' };
// @ts-expect-error A key and reference are mutually exclusive, not a fallback chain.
const ambiguousAuthentication: import('@rift/protocol').ApiConnectionCreate = { ...referencedConnection, apiKey: 'fake-test-only' };
void [referencedConnection, missingAuthentication, ambiguousAuthentication];
