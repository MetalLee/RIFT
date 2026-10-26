/** HTTP tailnet IPs expose getRandomValues, but not randomUUID/Clipboard API. */
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const previous = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea');
  field.value = text; field.className = 'sr-only'; field.setAttribute('readonly','');
  document.body.appendChild(field);
  try { field.select(); if (!document.execCommand('copy')) throw new Error('Clipboard unavailable'); }
  finally { field.remove(); previous?.focus({preventScroll:true}); }
}
