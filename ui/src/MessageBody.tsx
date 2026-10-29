import { copyText } from './browser-platform';
import { Button } from './components/ui/button';
import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
function CodeBlock({ language, content }: { language: string; content: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="message-code"><div><span>{language || 'CODE'}</span><Button variant="ghost" className="text-button" onClick={async () => { try { await copyText(content); setCopied(true); } catch { setCopied(false); } }}>{copied ? '已复制' : '复制代码'}</Button></div><pre><code>{content}</code></pre></div>;
}
/** Render Markdown without raw HTML, using the same editorial hierarchy as Stitch. */
export const MessageBody = memo(function MessageBody({ text, mention }: { text: string; mention?: string }) {
  return <div className="message-content">{mention&&<><span className="message-mention">@{mention}</span>{' '}</>}<ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    pre({ children }) { return <>{children}</>; },
    code({ className, children }) {
      const content = String(children);
      const language = /language-(\S+)/.exec(className ?? '')?.[1];
      return language || content.includes('\n') ? <CodeBlock language={language ?? ''} content={content.replace(/\n$/, '')}/> : <code>{children}</code>;
    },
    a({ href, children }) { return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>; },
  }}>{text}</ReactMarkdown></div>;
});
