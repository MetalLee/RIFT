import { randomId } from './browser-platform';
import { useRef } from 'react';
import { isDefinitiveRejection, mutate } from './api';
/** Keep a failed/uncertain command's key until its same input is acknowledged. */
export function useMutation(csrf: string) {
  const keys = useRef(new Map<string, string>());
  return async <T,>(path: string, body: unknown, method = 'POST'): Promise<T> => {
    const fingerprint = JSON.stringify([method, path, body]);
    let key = keys.current.get(fingerprint);
    if (!key) { key = randomId(); keys.current.set(fingerprint, key); }
    try { const result = await mutate<T>(path, csrf, body, method, key); keys.current.delete(fingerprint); return result; }
    catch (error) { if (isDefinitiveRejection(error)) keys.current.delete(fingerprint); throw error; }
  };
}
