const emojiFile = /[\w-]{8,40}\.webp/.source;
const emojiTokenPattern = `\\[e:(${emojiFile})\\]`;

export const EMOJI_TOKEN = new RegExp(emojiTokenPattern, 'g');
export const EMOJI_TOKEN_ONE = new RegExp(`^${emojiTokenPattern}$`);

export const emojiToken = (file: string) => `[e:${file}]`;
export const emojiSrc = (file: string) => `/uploads/${file}`;

// 纯文本里的提及、话题和链接不会吞掉以 `[` 开头的表情。
export function plainEmojiFiles(text: string) {
  const files = new Set<string>();
  for (const match of text.matchAll(EMOJI_TOKEN)) files.add(match[1]);
  return [...files];
}

/** 纯文本只有 1～3 个表情时放大显示。 */
export function onlyEmoji(text: string) {
  const matches = text.match(EMOJI_TOKEN);
  return matches && matches.length <= 3 && !text.replace(EMOJI_TOKEN, '').trim() ? matches.length : 0;
}

/** 只让不会构成缩进代码、定义或链接的纯表情帖走轻量渲染。 */
export function isPostSticker(text: string) {
  return !/^[ \t]|[\r\n]/.test(text) && onlyEmoji(text) > 0;
}

export const PLAIN_TEXT_TOKEN = new RegExp(
  String.raw`(\[e:${emojiFile}\]|@[A-Za-z0-9_]{3,20}|#[^\s#@，。！？、；：,.!?;:()（）「」[\]]{1,20}|https?:\/\/[^\s[]+)`,
  'g',
);
