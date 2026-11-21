# 校墙

给高中同学用的交流平台：贴吧式的「吧」+ 推特式的时间线。Web、Android、iOS 共用同一套代码。

- **账号**：分步注册（邀请码 → 昵称 → 用户名 → 密码 → 图形验证码），**只能凭邀请码注册**；忘记密码由管理员生成临时密码
- **时间线**：「全部 / 关注」两个 tab，发帖、回复（楼中楼）、点赞、转发、@提及、最多 4 张图片
- **Markdown + LaTeX**：标题、列表、任务清单、表格、代码块、引用；`$行内公式$`、`$$块级公式$$`（KaTeX）。发帖框可以预览。不渲染原始 HTML，外链图片只显示成链接
- **标签**：正文里的 `#话题` 自动成为标签，也可以在发帖框里单独加（最多 5 个）；`/t/标签` 是标签页，侧栏有热门标签
- **表情回应**：Telegram 式，52 个表情（Twemoji 图片，各平台一致），每人每帖一个，人少时显示头像，长按 / 右键看谁回应了
- **浏览数**：每人每帖算一次，作者自己不算
- **私信**：Telegram 式一对一聊天，已读双勾、在线状态、撤回
- **蓝标认证**：管理员在后台手动给同学加蓝标，可以写认证说明
- **AI 内容审核**：开启后每条新帖先只对作者本人可见，AI 审核文字和图片通过后才公开；没通过的帖子作者自己照常看得到，别人看不到，也不会产生通知。支持 Claude 或任何 OpenAI 兼容接口（通义千问、智谱、DeepSeek 等）
- **吧**：按班级或兴趣分区，任何人都能建吧，建吧的人是吧主，可以任命最多 10 位吧务；吧公告、最多 3 条置顶；吧内支持「最新回复（顶帖）/ 最新发布」排序，回复带楼层号
- **个人主页**：头像、背景图、简介、班级、届别、关注 / 粉丝
- **通知**：点赞、回复、转发、关注、@ 我、表情回应
- **更新日志**：`/changelog`，入口在左栏底部和设置页底部
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

推荐用 Docker：数据都在一个卷里，升级、迁移、备份都简单。不想装 Docker 的话看后面的「直接用 Node 运行」。

### Docker 部署

**0. 准备**

- 一台 Linux 服务器（1 核 1G 就够用），装好 Docker：`curl -fsSL https://get.docker.com | sh`（国内服务器可以用 `--mirror Aliyun`）
- 一个域名，A 记录解析到服务器 IP；防火墙 / 安全组放行 80 和 443 端口
- 在中国大陆的服务器上用域名对外提供服务需要先完成 ICP 备案

**1. 拿到代码并配置**

```bash
git clone https://github.com/QingYun4ever/CampusX.git xiaoqiang
cd xiaoqiang
cp .env.example .env
nano .env            # 把 DOMAIN 改成你的域名
```

**2. 构建并启动**

```bash
docker compose --profile https up -d --build
```

这会启动两个容器：`app`（校墙本体）和 `caddy`（自动申请、续期 HTTPS 证书）。第一次构建大约需要几分钟。

如果服务器上已经有 Nginx / Caddy / 宝塔，就不要加 `--profile https`，只运行 `docker compose up -d --build`，再把你的反向代理指向 `127.0.0.1:3000`。Nginx 示例：

```nginx
server {
  server_name forum.example.com;
  client_max_body_size 10m;          # 上传图片最大 8MB
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  # listen 443 ssl; 证书配置略（可以用 certbot --nginx 自动配置）
}
```

**3. 注册管理员**

```bash
docker compose logs app | grep 初始邀请码
```

打开 `https://你的域名/register`，用日志里的初始邀请码注册，第一个账号自动成为管理员。之后在管理后台生成邀请码发给同学，也可以用命令行：

```bash
docker compose exec app node --disable-warning=ExperimentalWarning server/src/cli/invite.ts --uses 50 --note "高三(2)班" --days 30
```

**4. 日常维护**

| 做什么 | 命令 |
|---|---|
| 看运行状态 | `docker compose ps`（`app` 显示 `healthy` 就是正常） |
| 看日志 | `docker compose logs -f app` |
| 更新到新版本 | `git pull && docker compose --profile https up -d --build` |
| 重启 | `docker compose restart app` |
| 停止 | `docker compose --profile https down`（数据保留在卷里，不会丢） |

**5. 备份**

数据库和图片都在 Docker 卷 `data` 里（容器内的 `/data`）。备份命令不用停网站：

```bash
# 1. 在线备份数据库到 /data/backups（默认保留最近 14 份）
docker compose exec app node --disable-warning=ExperimentalWarning server/src/cli/backup.ts
# 2. 把数据库备份和图片拷到宿主机
mkdir -p ~/xiaoqiang-backup
docker compose cp app:/data/backups ~/xiaoqiang-backup/
docker compose cp app:/data/uploads ~/xiaoqiang-backup/
```

建议用 `crontab -e` 每天自动做一次，并把 `~/xiaoqiang-backup` 同步到别的机器或对象存储。

恢复（会覆盖现在的数据，先停掉 app）：

```bash
docker compose stop app
docker compose run --rm --no-deps -v ~/xiaoqiang-backup:/backup --entrypoint sh app -c \
  "cp /backup/backups/forum-XXXXXXXX-XXXXXX.db /data/forum.db && rm -f /data/forum.db-wal /data/forum.db-shm && cp -r /backup/uploads/. /data/uploads/"
docker compose start app
```

**换服务器**：在新服务器上按第 1、2 步部署，然后按上面的「恢复」步骤导入备份即可。

### 直接用 Node 运行

需要 Node.js 22.18 或更高版本。

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

需要长期运行可以用 `pm2 start npm --name forum -- start` 或 systemd。备份用 `npm run backup`，并复制 `server/data/uploads/`。

### 环境变量

| 环境变量 | 说明 |
|---|---|
| `PORT` / `HOST` | 监听端口 / 地址，默认 `3000` / `0.0.0.0` |
| `DATA_DIR` | 数据库和图片目录，默认 `server/data`（Docker 里是 `/data`） |
| `TRUST_PROXY=1` | 在反向代理后面时设置，限流才能拿到真实 IP（docker-compose 里默认开启） |
| `CORS_ORIGINS` | 允许跨域的来源（逗号分隔），默认已包含 App 的 WebView 来源 |
| `ANTHROPIC_API_KEY` | 可选，用 Claude 做 AI 审核时的密钥（也可以在后台填） |
| `DOMAIN` | 只用于 docker-compose 自带的 Caddy，你的域名 |
| `APP_PORT` | 只用于 docker-compose，app 映射到本机的端口，默认 `3000` |

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

## 第三方素材

表情图片来自 [Twemoji](https://github.com/jdecked/twemoji)（`web/public/emoji/`），图形以 [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) 授权，© Twitter, Inc. 及其他贡献者。

## 后续可以加的功能

- 群聊；私信改用 WebSocket 推送（目前是轮询）
- 帖子精华、举报
- 图片压缩和缩略图（如 `sharp`）
- 推送通知（`@capacitor/push-notifications`）
- 手机号 / 邮箱找回密码（需要短信或 SMTP 服务）
