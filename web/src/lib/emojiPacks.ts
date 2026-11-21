import { useSyncExternalStore } from 'react';
import { REACTIONS } from './api';

export type EmojiPack = {
  id: string;
  name: string;
  description: string;
  emoji: readonly string[];
};

// ID 用于保存安装记录；更改文案和表情不需要更换 ID。
export const EMOJI_PACKS: readonly EmojiPack[] = [
  {
    id: 'moods', name: '心情日记', description: '开心、无语、委屈和大笑，统统写在脸上。',
    emoji: ['😀', '😂', '🥹', '🙃', '😅', '😆', '😉', '😊', '😋', '😛', '😜', '🤭', '🤫', '😏', '🙄', '😬', '😔', '😤', '😳', '🥺', '😵', '😴', '🤤', '😶'],
  },
  {
    id: 'campus', name: '校园生活', description: '课堂、考试和放学后的小故事。',
    emoji: ['🎓', '🏫', '📚', '📸', '✏️', '📝', '📖', '📓', '📌', '🎒', '🔬', '🧪', '🔭', '🎨', '🎤', '🎧', '⏰', '💡', '📱', '💻'],
  },
  {
    id: 'animals', name: '动物伙伴', description: '毛茸茸的朋友和水里游的小家伙。',
    emoji: ['🐱', '🐶', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐸', '🐵', '🐣', '🐧', '🦉', '🦋', '🐝', '🐢', '🐙', '🐬', '🦀', '🐠'],
  },
  {
    id: 'food', name: '美食补给', description: '从校门口的奶茶到深夜的一碗面。',
    emoji: ['🍜', '🧋', '🍕', '🍔', '🍟', '🌭', '🍗', '🥪', '🍚', '🍱', '🍣', '🥟', '🍲', '🥐', '🍰', '🍩', '🍪', '🍦', '🍉', '🥭', '🍇', '☕'],
  },
  {
    id: 'celebrate', name: '节日气氛', description: '给生日、祝福和庆祝加一点亮色。',
    emoji: ['🎊', '🎂', '🎈', '🎁', '🎆', '🎇', '✨', '💝', '💖', '💌', '🥳', '🪩', '🎄', '⛄', '🧧', '🏮', '🧨', '🎐', '🎀', '🌹'],
  },
  {
    id: 'outdoors', name: '自然与出游', description: '晴天、晚霞、小花，还有说走就走的旅行。',
    emoji: ['🌈', '☀️', '🌤️', '⛈️', '❄️', '🌙', '⭐', '🌿', '🍀', '🍂', '🌸', '🌻', '🌴', '🏔️', '🌊', '🏕️', '🚲', '🚆', '✈️', '🗺️'],
  },
  {
    id: 'games', name: '运动与游戏', description: '打球、开黑，或者一起为队友加油。',
    emoji: ['⚽', '🏀', '🏐', '🏸', '🏓', '🥏', '🎾', '⚾', '🥊', '🛹', '🛼', '🏅', '🎯', '🎮', '🕹️', '🎲', '♟️', '🧩'],
  },
];

// 随应用分发的 Twemoji 子集只有固定回应；其他表情直接用原生 Unicode 字形。
export const BUNDLED_EMOJI: ReadonlySet<string> = new Set(REACTIONS);

const STORAGE_KEY = 'txq_emoji_packs';

function decode(raw: string | null): string[] {
  try {
    const ids: unknown = JSON.parse(raw ?? 'null');
    // 保留不认识的 ID，仍可在「管理」里移除以后下架的包。
    if (Array.isArray(ids)) return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  } catch {
    /* 忽略损坏的本机数据 */
  }
  return [];
}

function load() {
  try {
    return decode(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

let installedIds = load();
const listeners = new Set<() => void>();

function publish(ids: string[]) {
  installedIds = ids;
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key === null || event.key === STORAGE_KEY) publish(load());
}

window.addEventListener('storage', onStorage);
import.meta.hot?.dispose(() => window.removeEventListener('storage', onStorage));

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useInstalledEmojiPacks(): readonly string[] {
  return useSyncExternalStore(subscribe, () => installedIds);
}

export function setEmojiPackInstalled(id: string, installed: boolean) {
  if (installedIds.includes(id) === installed) return true;
  const ids = installed ? [...installedIds, id] : installedIds.filter((value) => value !== id);
  publish(ids);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    return true;
  } catch {
    return false;
  }
}
