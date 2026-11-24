/**
 * 自定义表情：正文里写成 [e:文件名]，文件在 /uploads/ 下（服务器压成 160px 的 WebP）。
 * 只认这个格式的文件名，渲染时一律指向本站 /uploads/，不会加载外部图片。
 */
import { EMOJI_TOKEN } from '../../../server/src/emoji-tokens';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CustomEmoji } from './api';

export { emojiSrc, emojiToken } from '../../../server/src/emoji-tokens';

/** 预览、推送等纯文字场景：表情显示成 [表情] */
export const emojiText = (s: string) => s.replace(EMOJI_TOKEN, '[表情]');

export const MAX_EMOJI_UPLOAD = 8 * 1024 * 1024;
export const EMOJI_TYPES = 'image/png,image/jpeg,image/webp,image/gif';

export function useMyEmojis(enabled = true) {
  return useQuery({
    queryKey: ['my-emojis'],
    queryFn: () => api<{ items: CustomEmoji[]; limit: number }>('/me/emojis'),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useEmojiActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['my-emojis'] });
  return {
    upload: async (file: File) => {
      if (file.size > MAX_EMOJI_UPLOAD) throw new Error('图片太大了（最大 8 MB）');
      const form = new FormData();
      form.append('file', file);
      const e = await api<CustomEmoji>('/me/emojis', { form });
      await refresh();
      return e;
    },
    /** 把别人发的表情收藏一份到自己的表情里 */
    collect: async (file: string) => {
      const e = await api<CustomEmoji>('/me/emojis/collect', { body: { file } });
      await refresh();
      return e;
    },
    remove: async (id: number) => {
      await api(`/me/emojis/${id}`, { method: 'DELETE' });
      await refresh();
    },
  };
}
