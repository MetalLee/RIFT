import {describe,it,expect} from 'vitest';
import {isNearChatBottom,scrollChatToLatest,restoreChatAnchor} from './chat-scroll';
describe('chat viewport scroll geometry',()=>{
 it('uses the transcript viewport, not the document or fixed composer',()=>{
  const viewport={scrollHeight:3000,scrollTop:1000,clientHeight:600} as HTMLElement;
  expect(isNearChatBottom(viewport)).toBe(false);scrollChatToLatest(viewport);expect(viewport.scrollTop).toBe(3000);
  viewport.scrollTop=2400;expect(isNearChatBottom(viewport)).toBe(true);
 });
 it('preserves visible content when older pages are prepended',()=>{
  const viewport={scrollHeight:4500,scrollTop:80,clientHeight:600} as HTMLElement;
  restoreChatAnchor(viewport,3000,80);expect(viewport.scrollTop).toBe(1580);
 });
});
