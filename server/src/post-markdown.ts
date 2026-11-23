import type { Nodes, Root } from 'mdast';
import type { Extension as MdastExtension } from 'mdast-util-from-markdown';
import { codes } from 'micromark-util-symbol';
import type { Construct, Extension as MicromarkExtension, State } from 'micromark-util-types';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified, type Plugin } from 'unified';
import { EMOJI_TOKEN, emojiSrc, isPostSticker, plainEmojiFiles } from './emoji-tokens.ts';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    siteEmoji: 'siteEmoji';
    siteDisplayMath: 'siteDisplayMath';
  }
}

declare module 'mdast' {
  interface ImageData {
    emojiFile?: string;
  }
}

const DISPLAY_MATH = /^\$\$([^\r\n]+?)\$\$[ \t]*$/;

// Match standalone $$…$$ in the flow parser, not in code blocks or other literal text.
const remarkStandaloneMath: Plugin<[], Root> = function () {
  const syntax: MicromarkExtension = { flow: { [codes.dollarSign]: {
    tokenize(effects, ok, nok) {
      const context = this;
      const body: State = (code) => {
        if (code === null || code <= codes.carriageReturnLineFeed) {
          const token = effects.exit('siteDisplayMath');
          return (DISPLAY_MATH.test(context.sliceSerialize(token)) ? ok : nok)(code);
        }
        effects.consume(code);
        return body;
      };
      return (code) => {
        effects.enter('siteDisplayMath');
        effects.consume(code);
        return (next) => next === codes.dollarSign ? body(next) : nok(next);
      };
    },
  } } };
  const mdast: MdastExtension = {
    enter: {
      siteDisplayMath(token) {
        const value = DISPLAY_MATH.exec(this.sliceSerialize(token))![1].trim();
        this.enter({ type: 'math', value, meta: null, data: { hName: 'pre', hChildren: [{
          type: 'element', tagName: 'code', properties: { className: ['language-math', 'math-display'] },
          children: [{ type: 'text', value }],
        }] } }, token);
      },
    },
    exit: { siteDisplayMath(token) { this.exit(token); } },
  };
  (this.data().micromarkExtensions ??= []).push(syntax);
  (this.data().fromMarkdownExtensions ??= []).push(mdast);
};

const markdownProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkStandaloneMath);
const markdown = markdownProcessor().freeze();
const LITERALS = {
  link: true, linkReference: true, image: true, imageReference: true, definition: true,
  footnoteReference: true, footnoteDefinition: true, inlineCode: true, code: true, inlineMath: true, math: true, html: true,
} satisfies Partial<Record<Nodes['type'], true>>;

const remarkEmoji: Plugin<[ReadonlyMap<number, string>], Root> = function (files) {
  const emoji: Construct = {
    tokenize(effects, ok, nok) {
      const offset = this.now().offset;
      return (code) => {
        const bang = code === codes.exclamationMark;
        const file = files.get(offset + Number(bang));
        if (!file) return nok(code);
        let remaining = file.length + '[e:]'.length;
        const body: State = (next) => {
          effects.consume(next);
          if (--remaining) return body;
          effects.exit('siteEmoji');
          return ok;
        };
        const start: State = (next) => {
          effects.enter('siteEmoji');
          return body(next);
        };
        if (!bang) return start(code);
        // An actual image label was excluded in the first parse; a lone `!` is punctuation.
        effects.enter('data');
        effects.consume(code);
        effects.exit('data');
        return start;
      };
    },
  };
  const syntax: MicromarkExtension = { text: { [codes.leftSquareBracket]: emoji, [codes.exclamationMark]: emoji } };
  const mdast: MdastExtension = {
    enter: {
      siteEmoji(token) {
        const file = files.get(token.start.offset)!;
        const data = { emojiFile: file, hProperties: { dataEmoji: file } };
        this.enter({ type: 'image', url: emojiSrc(file), alt: '[表情]', data }, token);
      },
    },
    exit: { siteEmoji(token) { this.exit(token); } },
  };
  (this.data().micromarkExtensions ??= []).push(syntax);
  (this.data().fromMarkdownExtensions ??= []).push(mdast);
};

function parsePostMarkdown(source: string): Root {
  // micromark drops an initial BOM before assigning offsets.
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source;
  const tree = markdown.parse(text);
  const files = new Map<number, string>();
  for (const match of text.matchAll(EMOJI_TOKEN)) {
    const offset = match.index;
    let previous = offset;
    while (text[previous - 1] === '\\') previous--;
    if ((offset - previous) % 2 === 0) files.set(offset, match[1]);
  }
  if (!files.size) return tree;
  // Let standard Markdown claim labels, URLs and literal ranges before enabling native emoji.
  // In prose micromark then consumes the whole token, without parsing underscores as emphasis.
  const entries = files.entries();
  let candidate = entries.next();
  function excludeLiterals(node: Nodes) {
    if (Object.hasOwn(LITERALS, node.type)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        while (!candidate.done && candidate.value[0] < end) {
          const [offset, file] = candidate.value;
          if (offset + file.length + '[e:]'.length > start) files.delete(offset);
          candidate = entries.next();
        }
      }
    } else if ('children' in node) {
      node.children.forEach(excludeLiterals);
    }
  }
  excludeLiterals(tree);
  return files.size ? markdownProcessor().use(remarkEmoji, files).parse(text) : tree;
}

/** React Markdown and the server use the same parser, including its GFM and math settings. */
export const remarkPostMarkdown: Plugin<[], Root> = function () {
  this.parser = parsePostMarkdown;
};

export function postEmojiFiles(text: string) {
  if (!text.includes('[e:')) return [];
  if (isPostSticker(text)) return plainEmojiFiles(text);
  const files = new Set<string>();
  function collect(node: Nodes) {
    if (node.type === 'image' && node.data?.emojiFile) files.add(node.data.emojiFile);
    else if ('children' in node) node.children.forEach(collect);
  }
  collect(parsePostMarkdown(text));
  return [...files];
}
