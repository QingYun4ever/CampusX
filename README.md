# 校墙

给高中同学用的交流平台：贴吧式的「吧」+ 推特式的时间线。Web、Android、iOS 共用同一套代码。

- **账号**：仅凭邀请码注册，注册时需同意[用户协议](web/src/pages/Terms.tsx)（`/terms`，协议更新后老用户下次打开会被请求重新确认）；「设置 → 账户安全」可选验证邮箱、开启验证器两步验证（含一次性恢复码）。邮箱不公开，不能用于找回密码
- **时间线**：「全部 / 关注」两个 tab，发帖、回复（楼中楼）、点赞、普通转发、附评论的引用、@提及、最多 4 张图片
- **图片**：时间线显示服务器生成的缩略图（长边 1280，WebP，按需生成并缓存在 `uploads/.thumbs`），点开再加载原图；单张按原比例显示，多张按 X 的方式拼版；查看时可以左右翻页、双指 / 滚轮 / 双击缩放、拖动，手机上下滑关闭，可保存原图（App 存到相册 Pictures/校墙）。发帖时可以旋转、按比例裁剪；大照片在上传前压缩到长边 2560，服务器对超过 1.5 MB 的图片再压一次。图片文件名随机且不会被覆盖，浏览器缓存一年
- **书签**：帖子下面的书签按钮，左栏「书签」页查看，只有自己能看到
- **Markdown + LaTeX**：标题、列表、任务清单、表格、代码块、引用；`$行内公式$`、`$$块级公式$$`（KaTeX）。发帖框可以预览。不渲染原始 HTML，外链图片只显示成链接
- **标签**：正文里的 `#话题` 自动成为标签，也可以在发帖框里单独加（最多 5 个）；`/t/标签` 是标签页，侧栏有热门标签
- **表情回应**：Telegram 式，52 个表情（Twemoji 图片，各平台一致），每人每帖一个，人少时显示头像，长按 / 右键看谁回应了
- **商场**：表情包和头像装扮放在一起挑。表情包发帖、回复和私信共用，安装状态存在当前设备；装扮有 3 种光环和 6 种头像框（流光、霓虹、星芒、樱花、猫耳、初雪），所有人看到的都一样，头像框的动画只在大头像上播放
- **表情显示**：正文、私信、输入框里的表情都用 Twemoji 彩色字体，和选表情时看到的一样，不随系统变
- **浏览数**：每人每帖算一次，作者自己看也算
- **私信**：Telegram 式一对一聊天，已读双勾、在线状态、撤回；每条可发最多 4 张图片，只有双方能查看
- **蓝标认证**：管理员在后台手动给同学加蓝标，可以写认证说明
- **AI 内容审核**：开启后发帖、回复先经过 AI 审核文字和图片，通过才公开；没通过的不会发布，作者当场看到原因，并收到一条警告通知（警告次数会累计）。支持 Claude 或任何 OpenAI 兼容接口（通义千问、智谱、DeepSeek 等）
- **吧**：按班级或兴趣分区，每位同学最多建 2 个吧（管理员不限），建吧的人是吧主，可以任命最多 10 位吧务；吧公告、最多 3 条置顶；吧内支持「最新回复（顶帖）/ 最新发布」排序，回复带楼层号
- **私密吧**：吧主可逐个或按班级添加可见成员；吧主、吧务和站点管理员始终可见，私密吧的帖子不能转发或引用。吧主或站点管理员可删除吧，帖子和回复一并删除
- **个人主页**：头像、背景图、简介、班级、届别、关注 / 粉丝；可设置头像光环 / 头像框，管理员昵称和 ID 有辉光
- **通知**：点赞、回复、转发、引用、关注、@ 我、表情回应
- **App 推送**：Android App 打开推送后，私信、关注的人发帖、回复 / @ / 关注会以系统通知提醒，可以分别关闭。没有接入厂商推送，App 在后台约每 15 分钟检查一次
- **App 更新提示**：Android App 启动时检查 GitHub Releases 上的最新版，从加速镜像下载安装包（自动挑最快的线路，也可以手动换）
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
- 发帖时同步审核，最多等 25 秒：通过就公开；不通过就拒绝发布，草稿留在输入框，作者收到警告通知。被拒的帖子存档在后台，管理员可以人工改判
- 审核超时或接口出错时，帖子先只对作者可见，交给后台继续审核（重试 3 次）；仍然失败就按设置处理：「先不公开，等管理员处理」或「直接公开」
- 每条帖子调用一次模型，会产生费用；图片越多越贵。后台记录里能看到每次用了多少 tokens

## 部署（一台云服务器即可）

推荐用 Docker：数据都在一个卷里，升级、迁移、备份都简单。不想装 Docker 的话看后面的「直接用 Node 运行」。

### Docker 部署

**0. 准备**

- 一台 Linux 服务器（1 核 1G 就够用），装好 Docker：`curl -fsSL https://get.docker.com | sh`（国内服务器可以用 `--mirror Aliyun`）
- 一个域名，A 记录解析到服务器 IP；防火墙 / 安全组放行 80 和 443 端口
- 在中国大陆的服务器上用域名对外提供服务需要先完成 ICP 备案
- 如果使用私有 fork，给 VPS 配专用的只读部署密钥，不要把个人 GitHub 私钥拷到服务器

**1. 拿到代码并配置**

```bash
git clone https://github.com/QingYun4ever/CampusX.git xiaoqiang
cd xiaoqiang
cp .env.example .env
nano .env            # 可选配置 SMTP 等，不需要设置域名
```

**2. 构建并启动**

```bash
docker compose up -d --build
```

Compose 只启动校墙，默认开放 `127.0.0.1:3000` 给宿主机。用你自己的 Nginx 配置 HTTPS 并指向该地址；不要对外开放 3000。Nginx 示例：

```nginx
server {
  server_name forum.example.com;
  client_max_body_size 36m;          # 私信每条最多 4 张图，每张不超过 8 MiB
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
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
| 更新到新版本 | 先备份，再 `git pull --ff-only && docker compose up -d --build` |
| 重启 | `docker compose restart app` |
| 停止 | `docker compose down`（保留数据卷；不要加 `-v`） |

**5. 备份**

数据库、2FA 密钥和图片都在 Docker 卷 `data` 里（容器内的 `/data`）。备份命令不用停网站：

```bash
# 1. 在线备份数据库到 /data/backups（默认保留最近 14 份）
docker compose exec app node --disable-warning=ExperimentalWarning server/src/cli/backup.ts
# 2. 把数据库、同名密钥与私信图片的备份，以及普通图片拷到宿主机
install -d -m 700 ~/xiaoqiang-backup
docker compose cp app:/data/backups ~/xiaoqiang-backup/
docker compose cp app:/data/uploads ~/xiaoqiang-backup/
```

建议每天备份一次，并在私有或加密的存储保留副本。`.db`、同名 `.key` 和 `.dm-uploads` 要一起保留，不能只还原数据库。

迁移或还原到空的数据卷：先构建 `docker compose build app`（先别启动），再选择备份文件名（不含 `.db` 后缀）：

```bash
docker compose run --rm --no-deps --user root \
  -e SNAPSHOT=forum-XXXXXXXX-XXXXXX-PID \
  -v "$HOME/xiaoqiang-backup:/backup:ro" --entrypoint sh app -ec '
    test -z "$(ls -A /data)" || { echo "请还原到空的数据卷" >&2; exit 1; }
    src="/backup/backups/$SNAPSHOT"
    cp "$src.db" /data/forum.db
    if [ -f "$src.key" ]; then
      cp "$src.key" /data/account-security.key
      chmod 600 /data/account-security.key
    fi
    if [ -d "$src.dm-uploads" ]; then cp -r "$src.dm-uploads" /data/dm-uploads; fi
    cp -r /backup/uploads /data/uploads
    chown -R node:node /data
  '
docker compose up -d
```

**换服务器**：准备好代码和 `.env` 后，先还原备份，再启动服务。已有运行中的实例应保留原卷，确认新实例正常后再切换域名。

### 直接用 Node 运行

需要 Node.js 22.18 或更高版本。

```bash
npm install
npm run build        # 构建前端到 web/dist
npm start            # 后端同时托管前端页面，监听 3000
```

用上面的 Nginx 配置反代；直接运行 Node 时，可以设置 `HOST=127.0.0.1 TRUST_PROXY=1`，只接收本机反代请求。

需要长期运行可以用 `pm2 start npm --name forum -- start` 或 systemd。备份用 `npm run backup`，并复制 `server/data/uploads/`。

### 环境变量

| 环境变量 | 说明 |
|---|---|
| `PORT` / `HOST` | 监听端口 / 地址，默认 `3000` / `0.0.0.0` |
| `DATA_DIR` | 数据库和图片目录，默认 `server/data`（Docker 里是 `/data`） |
| `TRUST_PROXY=1` | 在反向代理后面时设置，限流才能拿到真实 IP（docker-compose 里默认开启） |
| `CORS_ORIGINS` | 允许跨域的来源（逗号分隔），默认已包含 App 的 WebView 来源 |
| `ANTHROPIC_API_KEY` | 可选，用 Claude 做 AI 审核时的密钥（也可以在后台填） |
| `APP_PORT` | 只用于 docker-compose，app 映射到本机的端口，默认 `3000` |
| `APP_RELEASE_REPO` | App 更新提示从哪个 GitHub 仓库找最新安装包，默认 `QingYun4ever/CampusX` |
| `APP_DOWNLOAD_MIRRORS` | 安装包下载加速前缀（逗号分隔，按顺序作为线路 1、2、3），默认 `https://ghfast.top/,https://gh-proxy.com/,https://ghproxy.net/`；设为 `none` 只用 GitHub 直连 |
| `SMTP_HOST` / `MAIL_FROM` | 可选；同时配置后才允许邮箱验证 |
| `SMTP_PORT` / `SMTP_SECURE` | 默认 587，要求 STARTTLS；465 默认隐式 TLS，也可显式设置 `SMTP_SECURE=1` |
| `SMTP_USER` / `SMTP_PASS` | SMTP 认证，要么同时设置，要么留空 |

### 图片与备份

帖子、头像和背景图存在 `DATA_DIR/uploads/`，SQLite 只保留路径；这些图片直链不是访问控制。私信图片存在独立的 `DATA_DIR/dm-uploads/`，通过鉴权接口读取，不走公开图床。撤回后服务端不再提供图片；已下载的副本不能收回。

`npm run backup` 为数据库制作快照，并在需要时生成同名 `.key` 和 `.dm-uploads`。恢复时先停服务，将它们还原为 `forum.db`、`account-security.key`（权限 `0600`）和 `dm-uploads/`；普通 `uploads/` 仍需另行备份。密钥和备份都应留在私有存储，密钥丢失后无法再用原验证器登录。

## 打包原生 App

App 登录页的「服务器地址」设置会保存在本机。可选的 `VITE_API_BASE` 只提供初始地址；正式包只允许 HTTPS，不带路径。后端设置 `CORS_ORIGINS` 时应保留 Android 的 `https://localhost` 和 iOS 的 `capacitor://localhost`。

```bash
cd web
# 可选：在 .env.app.local 中填写 VITE_API_BASE=https://forum.example.com
npm run app:sync       # 构建正式网页资源并同步到 Android 和 iOS
npm run app:android    # Android Studio
npm run app:ios        # Xcode（需要 macOS）
```

### Android 调试包

使用 JDK 21、Android SDK 36。在 `web/` 下运行：

```bash
npx vite build --mode app-debug
npx cap sync android
cd android
./gradlew :app:assembleDebug
```

安装 `app/build/outputs/apk/debug/app-debug.apk`，可在登录页填 `http://10.0.2.2:3000`（模拟器访问宿主机）或局域网服务器地址。只有调试包放行明文 HTTP。

### Android 签名发布包

准备一个仓库外的 PKCS#12 签名密钥，以及仅自己可读的 `release-signing.properties`。配置用 `storeFile`、`storePassword`、`keyAlias`、`keyPassword` 四项；相对的 `storeFile` 按配置文件所在目录解析。备份密钥，更新 APK 时要用同一个签名。

```bash
# 从 web/ 开始；打包前重新同步正式网页资源
npm run app:sync
cd android
export FORUM_ANDROID_SIGNING_PROPERTIES=/绝对路径/release-signing.properties
./gradlew :app:assembleRelease
```

APK 输出到 `app/build/outputs/apk/release/app-release.apk`。不要提交密钥、签名配置或本地环境文件。应用 ID（`com.tongxuequan.app`）和签名在发布后不能更换。

### 发布到 GitHub Releases

签名密钥留在本地。安装并登录 GitHub CLI 后，可以直接发 APK：

```bash
gh release create v0.9.1 web/android/app/build/outputs/apk/release/app-release.apk \
  --target main --title '校墙 v0.9.1' --notes 'Android 签名安装包'
```

只有 Git SSH 权限时，先推送临时分支 `android-apk/vX.Y.Z`（只含签名包 `campusx-android-X.Y.Z.apk`）及注释第一行为 `SHA256: <安装包 SHA-256>` 的版本标签 `vX.Y.Z`；注释后面几行会成为 release 正文，App 的更新提示里会显示，建议写这一版的更新日志（每行一条，可以用 `- ` 开头）。再推送指向最新 `main` 的触发标签 `android-release/vX.Y.Z`。Actions 从 GitHub 读取 APK，核对摘要、现有发布证书、包名、版本和正式版清单后上传到 Releases，然后清理临时分支和触发标签。APK 不进入 `main`，不经过第三方网盘。

## 安全说明

- 密码使用 scrypt 加盐哈希；登录态是随机 token，服务端只保存其 SHA-256，修改密码会让其他设备全部下线
- 验证码一次性使用、5 分钟过期；登录 / 注册接口按 IP 限流
- 两步验证不是必选项，开启和关闭都会吊销其他会话。验证器和恢复码请分开保存；管理员重置密码不会绕过两步验证
- 上传只接受 JPG / PNG / WebP / GIF，并校验文件头；不接受 SVG
- 除登录、注册、验证码外，所有接口和页面都要求登录

`CAPTCHA_DEBUG=1` 会让验证码接口返回明文，只用于自动化测试，并且在 `NODE_ENV=production`（`npm start`）下不会生效。

## 第三方素材

表情图片来自 [Twemoji](https://github.com/jdecked/twemoji)（`web/public/emoji/`），图形以 [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) 授权，© Twitter, Inc. 及其他贡献者。彩色表情字体 `web/src/assets/fonts/twemoji-15.0.3.woff2` 来自 [twemoji-colr-font](https://www.npmjs.com/package/twemoji-colr-font)，字体文件以 SIL OFL 1.1 授权，图形同上。

## 后续可以加的功能

- 群聊；私信改用 WebSocket 推送（目前是轮询）
- 帖子精华、举报
- 图片压缩和缩略图（如 `sharp`）
- 推送通知（`@capacitor/push-notifications`）
- 手机号 / 邮箱找回密码（需要短信或 SMTP 服务）
