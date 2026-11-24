/**
 * 表情包（图片）：商场里装、表情面板里用，发出去和自己的表情一样是 [e:文件名]。
 * 装了哪些存在服务器上，换手机也在。和本机安装的 Emoji 表情包（emojiPacks.ts）是两回事。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type InstalledPack, type StickerPack } from './api';

export const STICKER_KEY = ['sticker-packs'] as const;

export function useInstalledStickerPacks(enabled = true) {
  return useQuery({
    queryKey: [...STICKER_KEY, 'installed'],
    queryFn: () => api<{ items: InstalledPack[]; limit: number }>('/me/emoji-packs'),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useStickerCatalog(enabled = true) {
  return useQuery({
    queryKey: [...STICKER_KEY, 'catalog'],
    queryFn: () => api<{ items: StickerPack[] }>('/emoji-packs'),
    enabled,
    staleTime: 60_000,
  });
}

export function useStickerPack(id: number) {
  return useQuery({
    queryKey: [...STICKER_KEY, 'pack', id],
    queryFn: () => api<StickerPack>(`/emoji-packs/${id}`),
    enabled: id > 0,
  });
}

export function useMadeStickerPacks() {
  return useQuery({
    queryKey: [...STICKER_KEY, 'mine'],
    queryFn: () => api<{ items: StickerPack[]; limit: number; maxItems: number; minItems: number }>('/me/made-emoji-packs'),
  });
}

export function useStickerActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: STICKER_KEY });
  return {
    refresh,
    setInstalled: async (id: number, on: boolean) => {
      await api(`/me/emoji-packs/${id}/install`, { method: on ? 'POST' : 'DELETE', body: on ? {} : undefined });
      await refresh();
    },
  };
}

/** 按分组排好：没分组的放最后 */
export function groupItems<T extends { group: string }>(items: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(item.group);
    if (list) list.push(item);
    else groups.set(item.group, [item]);
  }
  const named = [...groups].filter(([g]) => g);
  const rest = groups.get('');
  return rest ? [...named, ['', rest] as [string, T[]]] : named;
}
