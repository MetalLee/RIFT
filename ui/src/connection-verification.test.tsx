import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ConnectionVerificationDetails} from './ConnectionVerificationDetails.js';
it('separates normal conversation from missing tool execution',()=>{
  const html=renderToStaticMarkup(<ConnectionVerificationDetails evidence={{method:'conversation-and-tool',conversation:true,toolCalls:0,reply:'你好',stopReason:'completed',cleanupConfirmed:true,error:'本次未调用工具'}}/>);
  expect(html).toContain('已完成');expect(html).toContain('工具执行');expect(html).toContain('0');expect(html).toContain('你好');expect(html).not.toContain('API 不可用');
});
