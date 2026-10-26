import { redact, redactionTailLength } from '../api/security.js';
/** A draft contains only an immutable, already-redacted prefix. Raw input stays private. */
export class SafeChatStream {
  private raw = '';
  private published = '';
  private boundaries: number[] = [];
  private publishedBoundary = 0;
  push(chunk: string): string {
    if (this.raw.length + chunk.length > 256_000) throw new Error('CHAT_TEXT_LIMIT');
    const offset=this.raw.length;
    for(let index=0;index<chunk.length;index++)if(/\s/u.test(chunk[index]!))this.boundaries.push(offset+index+1);
    this.raw += chunk;
    // A token may be arbitrarily long (Bearer/sk-/JSON values). Never cut it.
    const cutoff = this.raw.length - redactionTailLength();
    if (cutoff <= 0) return '';
    let low=0,high=this.boundaries.length;
    while(low<high){const middle=(low+high)>>>1;if(this.boundaries[middle]!<=cutoff)low=middle+1;else high=middle;}
    let index=low-1,boundary=this.boundaries[index]??0;
    if(boundary<=this.publishedBoundary)return '';
    const complete = redact(this.raw, 1_048_576);
    while (boundary > 0) {
      const candidate = redact(this.raw.slice(0,boundary),1_048_576);
      // A registered credential can include whitespace. Move before it if it
      // crosses this boundary; a still-incomplete literal fits in the tail.
      if (complete.startsWith(candidate)) {
        if (!candidate.startsWith(this.published) || Buffer.byteLength(candidate) > 240_000) return '';
        const delta = candidate.slice(this.published.length); this.published = candidate; this.publishedBoundary=boundary; return delta;
      }
      boundary=this.boundaries[--index]??0;
      if(boundary<=this.publishedBoundary)return '';
    }
    return '';
  }
  finish(): string { return redact(this.raw,256_000); }
}
