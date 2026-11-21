import type { AvatarDecoration } from './api';

/**
 * 头像光环。颜色写死在 identity.css 里，不跟随看的人自己选的强调色——
 * 同一个人的光环在所有人眼里应该是同一种颜色。
 */
export const DECORATIONS: readonly { id: AvatarDecoration; name: string; description: string }[] = [
  { id: '', name: '无装扮', description: '干干净净，只显示头像。' },
  { id: 'halo', name: '蓝色光环', description: '一圈清爽的天蓝色。' },
  { id: 'aurora', name: '极光', description: '青绿色描边，透出一点紫色的光。' },
  { id: 'rose', name: '玫瑰光环', description: '温柔的玫瑰粉。' },
];
