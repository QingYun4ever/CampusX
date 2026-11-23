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
import { CustomEmojiImg } from './CustomEmoji';
import { EMOJI_TOKEN, emojiSrc } from '../lib/customEmoji';

/**
 * 表情先换成占位符（私用区字符 + 序号）再交给 Markdown 解析：
 * 文件名里有 _ 和 -，直接解析可能被当成斜体，表情就碎了
 */
const PH = /\uE000(\d+)\uE001/g;
const PH_ONE = /^\uE000(\d+)\uE001$/;
const TOKEN = /(\uE000\d+\uE001|@[A-Za-z0-9_]{3,20}|#[^\s#@，。！？、；：,.!?;:()（）「」[\]\uE000]{1,30})/g;

function protectEmojis(text: string) {
  const files: string[] = [];
  return { text: text.replace(EMOJI_TOKEN, (_, file: string) => `\uE000${files.push(file) - 1}\uE001`), files };
}

type MdNode = { type: string; value?: string; url?: string; alt?: string; children?: MdNode[]; data?: Record<string, unknown> };
const SKIP = new Set(['link', 'linkReference', 'inlineCode', 'code', 'inlineMath', 'math', 'definition']);

/** 把文本里的 @提及、#话题 和表情占位符换成链接 / 图片节点；代码、公式、链接里的占位符还原成原文 */
function remarkMentions(files: string[] = []) {
  const restore = (s: string) => s.replace(PH, (_, i: string) => `[e:${files[Number(i)] ?? ''}]`);
  const restoreAll = (node: MdNode) => {
    if (typeof node.value === 'string') node.value = restore(node.value);
    if (typeof node.url === 'string') node.url = restore(node.url);
    if (typeof node.alt === 'string') node.alt = restore(node.alt);
    node.children?.forEach(restoreAll);
  };
  const walk = (node: MdNode) => {
    if (SKIP.has(node.type)) return restoreAll(node);
    if (typeof node.alt === 'string') node.alt = restore(node.alt);
    if (!node.children) return;
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
        const ph = PH_ONE.exec(part);
        if (ph) {
          const file = files[Number(ph[1])];
          if (!file) return;
          // 只有这里生成的图片节点带 data-emoji，用户自己写的 ![](…) 仍然显示成链接
          return out.push({ type: 'image', url: emojiSrc(file), alt: '[表情]', data: { hProperties: { dataEmoji: file } } });
        }
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
  img: ({ src, alt, node }) =>
    typeof node?.properties?.dataEmoji === 'string' ? (
      <CustomEmojiImg file={node.properties.dataEmoji} />
    ) : typeof src === 'string' && src ? (
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
  const safe = protectEmojis(displayMath(text));
  return (
    <div className="content md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, [remarkMath, { singleDollarTextMath: true }], [remarkMentions, safe.files]]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: 'ignore', maxSize: 20, maxExpand: 200 }]]}
        components={components}
      >
        {safe.text}
      </ReactMarkdown>
    </div>
  );
}
