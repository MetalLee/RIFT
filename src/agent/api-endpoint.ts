/** Adapters append their own operation path. Accept the common full endpoint
 * pasted from provider examples while preserving custom gateway prefixes. */
export function normalizeApiEndpoint(endpoint:string,protocol:string):string {
  const url=new URL(endpoint),pathname=url.pathname.replace(/\/+$/,'');
  const suffix=protocol==='openai-completions'?'/chat/completions':protocol==='openai-responses'?'/responses':protocol==='anthropic-messages'?'/v1/messages':undefined;
  if(!suffix||!pathname.endsWith(suffix))return endpoint;
  url.pathname=pathname.slice(0,-suffix.length)||'/';
  return url.toString().replace(/\/$/,'');
}
