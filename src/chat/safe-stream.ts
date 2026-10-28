import { credentialRedactionLiterals, redact } from '../api/security.js';

/** Publish a stable redacted prefix, retaining ambiguous credential syntax.
 * Boundaries are lexical, never language/whitespace based. Raw text stays private. */
export class SafeChatStream {
  private raw = '';
  private published = '';

  push(chunk: string): string {
    if (this.raw.length + chunk.length > 256_000) throw new Error('CHAT_TEXT_LIMIT');
    this.raw += chunk;
    let cutoff = this.raw.length;
    const hold = (offset: number) => { cutoff = Math.min(cutoff, offset); };
    const markers = ['api_key', 'api-key', 'apikey', 'token', 'password', 'secret', 'authorization', 'Bearer', 'sk-'];
    // Future deltas can complete a literal credential or a credential introducer.
    for (const [literal, insensitive] of [...credentialRedactionLiterals().map(value => [value, false] as const), ...markers.map(value => [value, true] as const)]) {
      const source = insensitive ? this.raw.toLowerCase() : this.raw;
      const target = insensitive ? literal.toLowerCase() : literal;
      for (let size = Math.min(target.length, source.length); size > 0; size--) {
        if (source.endsWith(target.slice(0, size))) { hold(source.length - size); break; }
      }
    }
    // Keep keys, separators and incomplete values together, including escaped quotes.
    const keys = /(?:api[_-]?key|token|password|secret|authorization)["']?\s*(?::|=|$)\s*/gi;
    for (const match of this.raw.matchAll(keys)) {
      const rest = this.raw.slice(match.index! + match[0].length);
      if (!/[:=]/.test(match[0]) || !rest) { hold(match.index!); continue; }
      if (rest[0] === '"' || rest[0] === "'") {
        let closed = false;
        for (let index = 1; index < rest.length; index++) {
          if (rest[index] === '\\') { index++; continue; }
          if (rest[index] === rest[0]) { closed = true; break; }
        }
        if (!closed) hold(match.index!);
      } else if (!/[\s,}"']/.test(rest)) hold(match.index!);
    }
    for (const match of this.raw.matchAll(/Bearer\s+[^\s"']*$/gi)) hold(match.index!);
    for (const match of this.raw.matchAll(/\bsk-[A-Za-z0-9_-]*$/g)) hold(match.index!);
    // Deltas can split a UTF-16 surrogate pair. Never serialize its first half.
    if (/[\uD800-\uDBFF]$/.test(this.raw)) hold(this.raw.length - 1);
    const candidate = redact(this.raw.slice(0, cutoff), 1_048_576);
    const complete = redact(this.raw, 1_048_576);
    if (!candidate.startsWith(this.published) || !complete.startsWith(candidate) || Buffer.byteLength(candidate) > 240_000) return '';
    const delta = candidate.slice(this.published.length);
    this.published = candidate;
    return delta;
  }

  /** Full settled text; consumers append only the unpublished suffix. */
  finish(): string { return redact(this.raw.replace(/[\uD800-\uDBFF]$/, ''), 256_000); }
}
