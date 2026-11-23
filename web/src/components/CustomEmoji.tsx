import { emojiSrc } from '../lib/customEmoji';
import { MediaImage } from './MediaImage';

/** 正文里的自定义表情（[e:文件名]） */
export function CustomEmojiImg({ file }: { file: string }) {
  return <MediaImage className="cemoji" src={emojiSrc(file)} alt="[表情]" title="表情" loading="lazy" decoding="async" draggable={false} />;
}
