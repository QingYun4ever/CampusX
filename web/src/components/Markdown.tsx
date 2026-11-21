/**
 * 帖子正文的 Markdown + LaTeX 渲染。体积较大（KaTeX），由 RichText 按需懒加载。
 * - 不渲染原始 HTML（react-markdown 默认行为），javascript: 之类的链接会被过滤
 * - 单个换行就是换行（remark-breaks），和普通发帖习惯一致
 * - $行内公式$、$$块级公式$$
 * - @用户名、#话题 仍然变成站内链接
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { ContentLink } from './ContentLink';

export const TOKEN = /(@[A-Za-z0-9_]{3,20}|#[^\s#@，。！？、；：,.!?;:()（）「」]{1,30})/g;

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };
const SKIP = new Set(['link', 'linkReference', 'inlineCode', 'code', 'inlineMath', 'math', 'definition']);

/** 把文本里的 @提及 和 #话题 换成链接节点 */
function remarkMentions() {
  const walk = (node: MdNode) => {
    if (!node.children || SKIP.has(node.type)) return;
    const out: MdNode[] = [];
    for (const child of node.children) {
      if (child.type !== 'text' || !child.value) {
        walk(child);
        out.push(child);
        continue;
      }
      child.value.split(TOKEN).forEach((part, i) => {
        if (!part) return;
        if (i % 2 === 0) return out.push({ type: 'text', value: part });
        const url = part.startsWith('@') ? `/u/${part.slice(1)}` : `/search?q=${encodeURIComponent(part)}`;
        out.push({ type: 'link', url, children: [{ type: 'text', value: part }] });
      });
    }
    node.children = out;
  };
  return (tree: MdNode) => walk(tree);
}

const components: Components = {
  a: ({ href, children }) => <ContentLink href={href}>{children}</ContentLink>,
  // 外链图片不直接加载（避免被追踪、版面被撑乱），显示成链接；帖子图片请用上传
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <ContentLink href={src} image>
        [图片{alt ? `：${alt}` : ''}]
      </ContentLink>
    ) : null,
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
  input: ({ checked }) => <input type="checkbox" checked={!!checked} readOnly disabled />,
};

/** 单独一行的 $$公式$$ 按块级公式显示（remark-math 默认把同一行的 $$ 当行内公式） */
const displayMath = (t: string) => t.replace(/^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm, (_, m) => `$$\n${m.trim()}\n$$`);

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="content md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, [remarkMath, { singleDollarTextMath: true }], remarkMentions]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: 'ignore', maxSize: 20, maxExpand: 200 }]]}
        components={components}
      >
        {displayMath(text)}
      </ReactMarkdown>
    </div>
  );
}
