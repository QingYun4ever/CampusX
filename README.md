# 同学圈

给高中同学用的交流平台：贴吧式的「吧」+ 推特式的时间线。Web、Android、iOS 共用同一套代码。

- **账号**：分步注册（邀请码 → 昵称 → 用户名 → 密码 → 图形验证码），**只能凭邀请码注册**；忘记密码由管理员生成临时密码
- **时间线**：「全部 / 关注」两个 tab，发帖、回复（楼中楼）、点赞、转发、@提及、最多 4 张图片
- **Markdown + LaTeX**：标题、列表、任务清单、表格、代码块、引用；`$行内公式$`、`$$块级公式$$`（KaTeX）。发帖框可以预览。不渲染原始 HTML，外链图片只显示成链接
- **标签**：正文里的 `#话题` 自动成为标签，也可以在发帖框里单独加（最多 5 个）；`/t/标签` 是标签页，侧栏有热门标签
- **表情回应**：和 GitHub 一样的 8 种表情（👍 👎 😄 🎉 😕 ❤️ 🚀 👀），每人每种一次
- **蓝标认证**：管理员在后台手动给同学加蓝标，可以写认证说明
- **AI 内容审核**：开启后每条新帖先只对作者本人可见，AI 审核文字和图片通过后才公开；没通过的帖子作者自己照常看得到，别人看不到，也不会产生通知。支持 Claude 或任何 OpenAI 兼容接口（通义千问、智谱、DeepSeek 等）
- **吧**：按班级或兴趣分区，任何人都能建吧；吧内支持「最新回复（顶帖）/ 最新发布」排序，回复带楼层号
- **个人主页**：头像、背景图、简介、班级、届别、关注 / 粉丝
- **通知**：点赞、回复、转发、关注、@ 我
- **管理后台**（独立页面 `/admin`）：数据概览；审核模型配置、审核记录、人工通过 / 拦截；生成 / 删除邀请码；设置管理员、蓝标认证、重置密码；删除任何帖子
- **界面**：类 X 布局，左侧栏可收起，个人主页 / 设置 / 管理后台都在左下角头像菜单里（手机端点底栏头像）；浅色 / 深色 / 跟随系统；背景可选预设渐变或自己调两种颜色和方向；强调色可选或自定义

## 技术栈

| | |
|---|---|
| 后端 | Node.js ≥ 22.18（直接运行 TypeScript）· Fastify 5 · SQLite（`node:sqlite`，无需安装数据库） |
| 前端 | React 19 · Vite · TanStack Query · lucide 图标 · 纯 CSS |
| App | Capacitor 8（把 Web 打包成 Android / iOS 原生 App） |

```
server/        后端 API
  src/db.ts      表结构（首次启动自动建表，并建 4 个默认的吧）
  src/routes/    auth / posts / users / boards / misc（上传、通知、管理）
  data/          数据库和上传的图片（运行后生成，记得备份）
web/           前端
  src/pages/     各页面
  src/components/
  android/ ios/  原生工程（Capacitor 生成）
```

## 本地开发

```bash
npm install
npm run dev          # 后端 :3000 + 前端 :5173
```

第一次启动时后端日志会打印一个**初始邀请码**，打开 http://localhost:5173/register 用它注册，第一个账号自动成为管理员。之后在「管理」页面生成邀请码发到班级群（会复制带注册链接的邀请文案）。

也可以用命令行生成：

```bash
npm run invite -- --uses 50 --note "高三(2)班" --days 30
```

## AI 内容审核

在 管理后台 → 内容审核 → 设置 里配置，「试一试」可以先用一段文字测试，不会影响帖子。

- **Claude**：默认模型 `claude-opus-5-5`。密钥填在后台，或者设置环境变量 `ANTHROPIC_API_KEY`
- **OpenAI 兼容接口**：填模型名、接口地址（到 `/v1` 为止）和密钥。审核图片需要支持视觉的模型
- 接口出错会重试 3 次，之后按设置处理：「先不公开，等管理员处理」或「直接公开」
- 每条帖子调用一次模型，会产生费用；图片越多越贵。后台记录里能看到每次用了多少 tokens

## 部署（一台云服务器即可）

```bash
npm install
npm run build        # 构建前端到 web/dist
npm start            # 后端同时托管前端页面，监听 3000
```

建议放在 Nginx / Caddy 后面并开启 HTTPS，例如 Caddy：

```
forum.example.com {
  reverse_proxy localhost:3000
}
```

| 环境变量 | 说明 |
|---|---|
| `PORT` / `HOST` | 监听端口 / 地址，默认 `3000` / `0.0.0.0` |
| `DATA_DIR` | 数据库和图片目录，默认 `server/data` |
| `TRUST_PROXY=1` | 在反向代理后面时设置，限流才能拿到真实 IP |
| `CORS_ORIGINS` | 允许跨域的来源（逗号分隔），默认已包含 App 的 WebView 来源 |

需要长期运行可以用 `pm2 start npm --name forum -- start` 或 systemd。**定期备份 `server/data/` 目录**（`forum.db*` 和 `uploads/`）。

> 在中国大陆的服务器上用域名对外提供服务需要先完成 ICP 备案。

## 打包原生 App

App 里的页面不在你的域名下，所以要告诉它后端地址：

```bash
cd web
echo "VITE_API_BASE=https://forum.example.com" > .env.app.local
npm run app:sync      # 用 app 模式构建并同步到 android/ ios/
npm run app:android   # 用 Android Studio 打开，运行或打包 APK
npm run app:ios       # 用 Xcode 打开（需要 macOS）
```

- 发布前把 `web/capacitor.config.ts` 里的 `appId`（目前是 `com.tongxuequan.app`）改成你自己的，发布后不能再改
- 用模拟器连本机后端调试时可以填 `http://10.0.2.2:3000`（Android 模拟器访问宿主机的地址），但正式包必须用 HTTPS
- App 图标和启动图可以用 `@capacitor/assets` 生成

## 安全说明

- 密码使用 scrypt 加盐哈希；登录态是随机 token，服务端只保存其 SHA-256，修改密码会让其他设备全部下线
- 验证码一次性使用、5 分钟过期；登录 / 注册接口按 IP 限流
- 上传只接受 JPG / PNG / WebP / GIF，并校验文件头；不接受 SVG
- 除登录、注册、验证码外，所有接口和页面都要求登录

`CAPTCHA_DEBUG=1` 会让验证码接口返回明文，只用于自动化测试，并且在 `NODE_ENV=production`（`npm start`）下不会生效。

## 后续可以加的功能

- 私信 / 群聊（WebSocket）
- 帖子置顶、精华、举报
- 图片压缩和缩略图（如 `sharp`）
- 推送通知（`@capacitor/push-notifications`）
- 手机号 / 邮箱找回密码（需要短信或 SMTP 服务）
