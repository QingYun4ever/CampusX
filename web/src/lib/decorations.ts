import type { AvatarDecoration } from './api';

/**
 * 头像光环和头像框（带图形、动画）。颜色写死在 identity.css 里，不跟随看的人自己选的强调色——
 * 同一个人的光环在所有人眼里应该是同一种颜色。
 */
export const DECORATIONS: readonly { id: AvatarDecoration; name: string; description: string; frame?: boolean }[] = [
  { id: '', name: '无装扮', description: '干干净净，只显示头像。' },
  { id: 'halo', name: '蓝色光环', description: '一圈清爽的天蓝色，一道亮光沿着圈走。' },
  { id: 'aurora', name: '极光', description: '青绿和紫色的光带缓缓流动。' },
  { id: 'rose', name: '玫瑰光环', description: '温柔的玫瑰粉，微微发光。' },
  { id: 'prism', name: '流光', description: '七彩光带绕着头像慢慢转。', frame: true },
  { id: 'neon', name: '霓虹', description: '青色和品红的双层灯管，一呼一吸。', frame: true },
  { id: 'stars', name: '星芒', description: '金色细环，几颗小星星忽明忽暗。', frame: true },
  { id: 'sakura', name: '樱花', description: '两朵樱花，花瓣时不时飘下来。', frame: true },
  { id: 'neko', name: '猫耳', description: '头顶多一对橘猫耳朵，偶尔会动一下。', frame: true },
  { id: 'snow', name: '初雪', description: '冰蓝色的环，雪花慢慢旋转。', frame: true },
  { id: 'maple', name: '枫叶', description: '两片红枫，时不时落下一片。', frame: true },
  { id: 'bubble', name: '泡泡', description: '透明的小泡泡一个个往上冒。', frame: true },
  { id: 'orbit', name: '星轨', description: '一颗小行星绕着头像转，转到后面会被挡住。', frame: true },
  { id: 'hearts', name: '心动', description: '光圈像心跳一样跳动，小爱心往上飘。', frame: true },
  { id: 'flame', name: '火焰', description: '一圈跳动的火苗。', frame: true },
  { id: 'thunder', name: '雷电', description: '蓝紫色的电光，闪电时不时劈一下。', frame: true },
  { id: 'crown', name: '皇冠', description: '头顶一顶金色小皇冠，闪着光。', frame: true },
];
