import { Children, isValidElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

// 模型输出常见的非标准写法在解析前统一整理：HTML 换行标签、Windows 换行、表格前缺少空行。
export function normalizeMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; out.push(line); continue; }
    if (fenced) { out.push(line); continue; }
    const isRow = /^\s*\|/.test(line);
    // 单元格内的 <br> 用分隔符代替（换行会切断表格行）；其他位置直接换行。
    line = line.replace(/<br\s*\/?>/gi, isRow ? '；' : '\n');
    // 表格紧跟正文时补一个空行，否则 GFM 可能把首行当成段落的一部分。
    if (isRow && i > 0 && out.length && out[out.length - 1].trim() && !/^\s*\|/.test(out[out.length - 1]) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) out.push('');
    out.push(line);
  }
  return out.join('\n');
}

const sameOrigin = (href: string) => /^(#|\/#)/.test(href);
const cellText = (children: ReactNode): string => Children.toArray(children).map(c => typeof c === 'string' || typeof c === 'number' ? String(c) : isValidElement<{ children?: ReactNode }>(c) ? cellText(c.props.children) : '').join('');

export function Markdown({ text }: { text: string }) {
  return <div className="chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} skipHtml components={{
    a: ({ href, children }) => !href ? <span>{children}</span> : sameOrigin(href) ? <a href={href}>{children}</a> : /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : '[图片]'}</span>,
    table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>,
    // 日期、金额、编号等短值不折行；长说明按标点折行，超出部分由外层横向滚动承接。
    td: ({ node: _node, children, ...props }) => <td {...props} className={cellText(children).trim().length <= 16 ? 'nowrap' : undefined}>{children}</td>,
  }}>{normalizeMarkdown(text)}</ReactMarkdown></div>;
}
