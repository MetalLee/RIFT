import { timingSafeEqual } from 'node:crypto';
import { RiftError } from '../contracts/index.js';

export function redact(value: string, maxBytes = 128 * 1024): string {
  let safe = value.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,}"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-|sk-ant-)[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
  for (const [name, secret] of Object.entries(process.env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && secret && secret.length >= 8) safe = safe.split(secret).join('[REDACTED]');
  }
  const bytes = Buffer.from(safe);
  return bytes.length > maxBytes ? bytes.subarray(0, maxBytes).toString('utf8') + '\n[TRUNCATED]' : safe;
}

export function tokenMatches(received: string | undefined, expected: string): boolean {
  if (!received?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(received.slice(7));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function publicError(error: unknown): { code: string; message: string } {
  return error instanceof RiftError
    ? { code: error.code, message: redact(error.message, 4096) }
    : { code: 'INVALID_REQUEST', message: redact(error instanceof Error ? error.message : 'Request failed', 4096) };
}
