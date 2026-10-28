export const isNearChatBottom=(element:Pick<HTMLElement,'scrollHeight'|'scrollTop'|'clientHeight'>,distance=120)=>element.scrollHeight-element.scrollTop-element.clientHeight<=distance;
export function scrollChatToLatest(element:HTMLElement){element.scrollTop=element.scrollHeight;}
export function restoreChatAnchor(element:HTMLElement,previousHeight:number,previousTop:number){element.scrollTop=previousTop+element.scrollHeight-previousHeight;}
