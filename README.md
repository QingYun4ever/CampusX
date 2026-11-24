# 校墙

给高中同学用的交流平台：贴吧式的「吧」+ 推特式的时间线。Web、Android、iOS 共用同一套代码。

- **账号**：仅凭邀请码注册，注册时需同意[用户协议](web/src/pages/Terms.tsx)（`/terms`，协议更新后老用户下次打开会被请求重新确认）；「设置 → 账户安全」可选验证邮箱、开启验证器两步验证（含一次性恢复码）。邮箱不公开，不能用于找回密码
- **隐私政策**：`/privacy` 无需登录，说明站点保存的信息、内容可见范围、第三方服务和隐私问题的联系渠道；入口在登录、注册和设置页
- **时间线**：「全部 / 关注」两个 tab，发帖、回复（楼中楼）、点赞、普通转发、附评论的引用、@提及、最多 4 张图片
- **视频**：和 X 一样，每条帖子一个视频，最长 2 分钟，不能和图片一起发。选好后在手机上用 WebCodecs 压缩（长边 1280、约 2 Mbps，H.264；已经够小的不压，浏览器不支持的直接传原文件），超过 2 分钟会问要不要只发前 2 分钟；分片上传（每片 4 MB，断网自动续传，反代限制了请求大小时自动改小分片），服务器用 ffmpeg 统一转成 H.264 + AAC 的 MP4（能直接用的只重新封装）、去掉 GPS 等元数据、截封面。处理好之前「发布」是灰的，发帖框里可以预览。时间线里划到屏幕上静音自动播放（设置里可以改成仅 Wi-Fi 或从不），左下角剩余时间、右下角声音；点开全屏播放，可拖进度条、下滑关闭。开启 AI 审核时，视频的 3 张截图一起送审
- **图片**：时间线和引用卡片按需加载缩略图（长边 1280，WebP），点开再取原图。个人头像和吧头像默认使用最多 192 像素的缩略图，个人主页大头像使用原图。查看时可缩放、翻页、保存；App 保存到相册 Pictures/校墙。站点图片是随机文件名的公开地址，浏览器和 App 通常缓存一年；私信图片单独鉴权、不缓存。
- **书签**：帖子下面的书签按钮，左栏「书签」页查看，只有自己能看到
- **Markdown + LaTeX**：标题、列表、任务清单、表格、代码块、引用；`$行内公式$`、`$$块级公式$$`（KaTeX）。发帖框可以预览。不渲染原始 HTML，外链图片只显示成链接
- **标签**：正文里的 `#话题` 自动成为标签，也可以在发帖框里单独加（最多 5 个）；`/t/标签` 是标签页，侧栏有热门标签
- **表情回应**：Telegram 式，52 个表情（Twemoji 图片，各平台一致），每人每帖一个，人少时显示头像，长按 / 右键看谁回应了
- **商场**：表情包和头像装扮放在一起挑。表情包发帖、回复和私信共用；Emoji 主题包的安装状态存在当前设备，图片表情包存在账号里；装扮有 3 种光环和 13 种头像框（流光、霓虹、星芒、樱花、猫耳、初雪、枫叶、泡泡、星轨、心动、火焰、雷电、皇冠），所有人看到的都一样，动画只在大头像（64px 以上：主页、商场）上播放
- **表情显示**：正文、私信、输入框里的表情都用 Twemoji 彩色字体，和选表情时看到的一样，不随系统变
- **浏览数**：每人每帖算一次，作者自己看也算
- **私信**：Telegram 式一对一聊天，已读双勾、在线状态、撤回；每条可发最多 4 张图片，只有双方能查看
- **蓝标认证**：管理员在后台手动给同学加蓝标，可以写认证说明
- **AI 内容审核**：开启后发帖、回复先经过 AI 审核文字和图片，通过才公开；没通过的不会发布，作者当场看到原因，并收到一条警告通知（警告次数会累计）。支持 Claude 或任何 OpenAI 兼容接口（通义千问、智谱、DeepSeek 等）
- **吧**：按班级或兴趣分区，每位同学最多建 2 个吧（管理员不限），建吧的人是吧主，可以任命最多 10 位吧务。建吧时可上传头像，吧主或站点管理员可在「编辑吧资料」中更换或恢复默认字标；支持吧公告、最多 3 条置顶和「最新回复（顶帖）/ 最新发布」排序，回复带楼层号
- **吧内等级**：贴吧式，每个吧单独算经验，关注了吧才涨。签到 +6（每连签满 7 天多 1，最多 +10）、发主题 +4、回复 +2（少于 5 字又没图的不算，发帖 + 回复每吧每天最多 40）、被点赞 / 回应 +1（同一个人每天只算一次，每天最多 10）。帖子过审才加经验，被吧务或管理员删除会扣回。1–18 级分绿（1–3）、蓝（4–9）、黄（10–15）、橙（16–18）牌，门槛在 `server/src/levels.ts`；吧主可改 18 个头衔。吧首页有签到、经验条和排行，吧列表可一键签到；帖子作者名旁显示他在该吧的等级，个人主页列出等级最高的几个吧。上线时会按历史发帖和获赞补算一次经验（「一天」按北京时间算）
- **拉黑与举报**：拉黑是单向的，拉黑时双方互相取关；被拉黑的人不能回复、赞、回应、转发、引用、关注、私信拉黑他的人，拉黑的人在时间线、吧、话题、搜索里看不到他的帖子（楼层里折叠，可点开），也收不到他的通知。帖子和用户都能举报（匿名，同一人对同一目标只记一条待处理）。后台按批次处理；可以一步删帖并结案，举报内容变化后需刷新重新确认。无法确认原目标的旧举报移到「归档」，不会自动关联到同 ID 的新帖。处理或驳回都会通知举报人；举报管理员本人或其帖子时，该管理员看不到举报人，也不能自己处理。同一目标的举报按批次处理，带版本号：处理时有新举报进来会要求刷新后再确认；0.15.3 之前的旧举报无法可靠对应到原目标，升级后放在「归档」里只读。
- **自定义表情**：表情面板「我的」里上传，服务器用 sharp 压成长边 160 的 WebP（GIF 保留动画，最多 150 帧、压缩后不超过 600 KB），每人最多 60 个；正文里写成 `[e:文件名]`，只渲染本站 `/uploads/` 下的文件。发帖和私信时只认站内登记过的表情，每条最多 8 种。帖子 Markdown 的代码、公式、已有链接和图片地址里的标记按原文处理，不算表情。开启图片审核时，实际显示的表情图也一起送审；超过上限的旧待审帖需人工处理。删掉且从没发出去过的表情，图片会被回收。别人发出来的表情可以长按（电脑上右键）加到自己的表情里：服务器复制一份到自己名下，原主删掉也不影响；同一个表情（包括别人收藏的副本）只收一次。
- **表情包**（像 Telegram 的贴纸包）：一组图片表情，在商场装上后出现在表情面板里，发出去和自定义表情一样是 `[e:文件名]`，只发表情时显示成大贴纸。
  - 官方包由管理员维护，传上去就算审核过；`server/emoji-packs/` 下随代码带了 ATRI、丛雨、橘雪莉、Kipfel 四个包（整理自 GitHub 上 AstrBot 的表情包仓库，仅限非商业使用，版权归原作者），第一次启动时自动导入，之后以数据库为准，管理员删掉的不会被导回来。后台「表情包 → 新建官方包」可以再加，编辑页能「导入文件夹」（子文件夹名变成分组）
  - 同学自己做的包：每人最多 5 个、每个 4～120 个表情，提交后管理员在后台审核，通过才上架；上架后再加的表情要再审，审核前只有作者看得到；上架后不能自己改名和介绍
  - 表情包里审核过的表情发帖时不再送 AI 审核；删包、删表情只是标记，发出去过的图片保留。官方包的文件不占任何人的图片额度，只算站点总额度
- **紫水晶**：全站通用的点数，和吧内经验分开（经验只涨不花）。每日签到 +5（钱包页或任意吧签到都算，连签每满 7 天 +1，最多 +8）；帖子被不同的人赞或回应 +1（同一人每天一次，每天最多 20，注册不满 3 天的账号点赞不算）；新手任务一次性 +10~20。可以解锁商场里的头像装扮（30~300），或给帖子打赏（1/5/10/20/50，每天最多送 100，注册满 3 天才能打赏）。每笔都记在 `crystal_log`（只追加），余额 `users.crystals` 在同一个事务里更新；帖子被他人当违规删除时扣回它被赞所得（不扣成负数）。改版前已佩戴的装扮自动算解锁
- **推流**：花紫水晶让一条公开主帖（7 天内）被更多人看到，1 颗 = 2 人，档位 10/25/50，每天最多 100。能买的人数上限是最近 14 天上过线、还没看过（浏览、赞、回复、推流都算看过）这条的人，减去进行中推流没用完的。插在首页「推荐」「最新」（前端带 `promo=1`，每页最多 1 条，标「推流」），不给作者和互相拉黑的人看。同页已有该帖的转发时不另插原帖，楼中楼回复也算参与过。首页下发只登记待曝光，收到首次浏览上报才计一次。看满时立即结算，服务端每分钟结算到期或不再公开的订单，按没看到的人数退款。表 `boosts`、`boost_pending_views`、`boost_views`
- **首页推荐**：`/feed?tab=all` 按热度排（`server/src/ranking.ts`）：最近 30 天的主帖，热度 = 1 + 赞 + 回应 + 2×回复人数 + 2×转发 + 2×引用 + 打赏/5，除以 (小时数 + 2)^1.5；关注的人 ×1.6、加入的吧 ×1.2、自己 1 小时内的帖子 ×3、看过或赞过 ×0.35。翻页游标 `r<偏移>`，用第一页算好的顺序（每人缓存 30 分钟），排完接着按时间翻。`tab=latest` 是原来的按时间排
- **防小号**：注册时记 IP 的哈希（`users.register_ip`，不存明文；IPv6 按 /64 算），同一个 IP 最多注册 N 个账号（默认 2，后台「邀请码」页可调，0 不限）。上线前注册的账号没有记录，不算。在反向代理后面要设 `TRUST_PROXY=1`，否则所有人都是代理的 IP；配好没有可以看后台「邀请码」页显示的「服务器看到你现在的 IP」
- **邀请同学**：注册满 3 天的用户可以生成自己的邀请码（`invites.personal = 1`，每人一个，可以换），用它注册的人 `users.invited_by` 记邀请人。被邀请的人签到满 3 天，邀请人得 20 颗紫水晶（`crystal_log` kind `invite`），最多 10 人；和邀请人同一 IP 注册的不给；一个人最多邀请 30 人。后台可以关掉。逻辑在 `server/src/invites.ts`
- **活动**：管理员在后台「站点」里办，设话题、时间、发帖奖励（0~50，每人每活动一次）和签到倍数（1~3）。开始时 App 推送，支持活动深链接的 APK 可直接打开 `/events/:id`。首页卡片在活动开始和结束时刷新；活动页只统计实际截止前的参与帖，发布带话题的主帖后会刷新。设有奖励的活动先在 `event_entries` 记一条待审核，管理员在后台「活动」里通过才发紫水晶、驳回要写理由（参与者可以再发一条重新提交），结果都会通知。拿到奖励后参与帖被当违规删除时扣回且不能再领
- **帮助页**：`/help`，不用登录也能看，说明等级经验、紫水晶、AI 助手、表情、拉黑和举报
- **AI 助手**：类似 X 的 @grok，没有聊天界面。管理后台「AI 助手」开启后会建一个不能登录的账号（默认 `@kirk`「Kirk」，带 AI 标签）；在帖子或回复里 @ 它，或直接回复它的帖子，它会读这串对话（最多 8 层，带主帖）和里面的图片（最多 6 张：被问的那条优先，再是主帖和离得近的楼层；没通过审核的楼层不看），在下面回一条短回复（提示词要求 120 字内，超过 400 字截断）。复用「内容审核」的接口和密钥，可单独指定模型；每人每 24 小时有次数上限，拉黑它就不再回
- **维护模式**：管理后台「站点」里开启，可写维护说明和预计恢复时间。开启后除管理员外所有接口返回 503，网页和 App 显示维护页并每 15 秒检查一次，解除后自动恢复；登录接口保留，管理员能登进来解除。启动时连不上服务器（网络问题）会显示「连不上服务器」并自动重试，不会把人踢回登录页
- **公告**：管理后台「站点」里发布（标题、内容、链接、显示天数），显示在首页顶部，每人可以关掉；不是置顶帖。App 会推送一次（0.15 起有单独的「公告」通知渠道，旧版走「关注的人发帖」渠道）
- **首页**：同一个人连着发的帖子会和别人的错开显示；列表里超过约 10 行的长帖折叠，点「展开」看全文。帖子详情里，楼主（和 AI 助手）在别人评论下的回复直接显示在那条评论下面（每条最多 2 条，多的点「查看全部」）
- **私密吧**：吧主可逐个或按班级添加可见成员；吧主、吧务和站点管理员始终可见，私密吧的帖子不能转发或引用。吧主或站点管理员可删除吧，帖子和回复一并删除
- **个人主页**：头像、背景图、简介、班级、届别、关注 / 粉丝；可设置头像光环 / 头像框，管理员昵称和 ID 有辉光
- **@ 补全**：输入框里打 @ 弹出候选人（当前楼里的人、互相关注、关注的人，再按用户名和昵称搜），不列拉黑关系里的人，AI 助手开启时也在里面
- **通知**：点赞、回复、转发、引用、关注、@ 我、表情回应；表情包审核结果
- **App 推送**：Android 后台约每 15 分钟检查一次私信、关注的人发帖和互动。可分别关闭；私密吧的推送和未读数按收件人当前权限过滤。
- **安装页**：`/install` 无需登录，提供官方 Android APK 下载和发布页，以及 Android、iOS 和桌面浏览器的网页版安装说明
- **App 更新提示**：服务器从 GitHub Releases 取最新版本信息并缓存 30 分钟（`/api/app/latest`，旧版 App 也用它）。App 按顺序逐条测速，一条测完立即显示；默认先测 `v4.gh-proxy.org`，再测 `axisnow.gh-proxy.org`、`v6.gh-proxy.org`、`gh-proxy.org` 和 GitHub 直连。镜像可用 `APP_DOWNLOAD_MIRRORS` 配置。下载后核对 SHA-256、包名、版本和官方签名证书才交给 Android 安装器；拿不到校验值或都下载失败时可改用浏览器下载
- **更新日志**：`/changelog`，入口在左栏底部和设置页底部
- **管理后台**（独立页面 `/admin`）：数据概览；审核模型配置、审核记录、人工通过 / 拦截；生成 / 删除邀请码；设置管理员、蓝标认证、重置密码；删除任何帖子
- **界面**：类 X 布局，左侧栏可收起，个人主页 / 设置 / 管理后台都在左下角头像菜单里（手机端点底栏头像）；浅色 / 深色 / 跟随系统；背景可选预设渐变或自己调两种颜色和方向；强调色可选或自定义
- **窄屏适配**：手机登录页保持单栏；帖子操作按钮紧凑排在一行，过宽的公式和代码块只在内容内部横滑
- **导航栏常驻**：「设置 → 自定义」可让手机滚动时保持顶部栏和底部导航栏可见；默认关闭，设置保存在本机

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

首次启动时，在与服务相同的 `DATA_DIR` 下运行 `npm run invite -w server -- --bootstrap`。将终端输出的管理员初始化邀请码粘贴到 http://localhost:5173/register。它有效 1 小时、只能用一次；重新生成会作废之前的码。首个管理员注册完成前，普通邀请码不能注册账号。不要把初始化码发到群里或写进日志。

初始化后，在「管理」页面生成邀请码发到班级群（会复制带注册链接的邀请文案），也可用命令行生成：

```bash
npm run invite -- --uses 50 --note "高三(2)班" --days 30
```

## AI 内容审核

在 管理后台 → 内容审核 → 设置 里配置，「试一试」可以先用一段文字测试，不会影响帖子。

- **Claude**：默认模型 `claude-opus-5-5`。密钥填在后台，或者设置环境变量 `ANTHROPIC_API_KEY`
- **OpenAI 兼容接口**：填模型名、接口地址（到 `/v1` 为止）和密钥。审核图片需要支持视觉的模型
- **审核规则**：「主审核规则」可直接编辑，也可恢复默认；「补充规则」独立保留。保存后应用于后续 AI 审核，「试一试」会使用当前表单中尚未保存的改动
- 发帖时同步审核，最多等 25 秒：通过就公开；不通过就拒绝发布，草稿留在输入框，作者收到警告通知。被拒的帖子存档在后台，管理员可以人工改判
- 审核超时或接口出错时，帖子先只对作者可见，交给后台继续审核（重试 3 次）；仍然失败就按设置处理：「先不公开，等管理员处理」或「直接公开」。无效附件不属于上游故障，不能通过此设置放行。
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
  client_max_body_size 36m;          # 私信每条最多 4 张图，每张不超过 8 MiB；视频分片 4 MB
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  # listen 443 ssl; 证书配置略（可以用 certbot --nginx 自动配置）
}
```

反向代理应保留后端的 `Cache-Control`，不要在整个站点追加 `add_header Cache-Control no-cache`。HTML 入口会重新验证；带哈希的静态资源和可用的图片可长期复用；私信图片和缩略图暂时失败时返回的原图不缓存。

**3. 注册管理员**

```bash
docker compose exec app npm run invite -w server -- --bootstrap
```

打开 `https://你的域名/register`，粘贴终端输出的管理员初始化邀请码。旧版本写到启动日志里的初始化码已停用。初始化后在管理后台生成普通邀请码，也可以用命令行：

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

新站点使用与服务相同的 `DATA_DIR` 执行 `npm run invite -w server -- --bootstrap`，再到网页注册管理员。

用上面的 Nginx 配置反代；直接运行 Node 时，可以设置 `HOST=127.0.0.1 TRUST_PROXY=1`，只接收本机反代请求。

需要长期运行可以用 `pm2 start npm --name forum -- start` 或 systemd。备份用 `npm run backup`，并复制 `server/data/uploads/`。

### 环境变量

| 环境变量 | 说明 |
|---|---|
| `PORT` / `HOST` | 监听端口 / 地址，默认 `3000` / `0.0.0.0` |
| `DATA_DIR` | 数据库和图片目录，默认 `server/data`（Docker 里是 `/data`） |
| `TRUST_PROXY=1` | 在反向代理后面时设置，限流和同一网络注册上限才能拿到真实 IP（docker-compose 里默认开启）。数字是代理有几层：只有 Nginx 填 `1`，前面还有 CDN 填 `2`。只认代理自己追加的那一项，`$remote_addr` 和 `$proxy_add_x_forwarded_for` 两种写法都安全，用户伪造的 `X-Forwarded-For` 不算数；直接连进来的不是本机或内网地址时不看转发头 |
| `CORS_ORIGINS` | 允许跨域的来源（逗号分隔），默认已包含 App 的 WebView 来源 |
| `ANTHROPIC_API_KEY` | 可选，用 Claude 做 AI 审核时的密钥（也可以在后台填） |
| `APP_PORT` | 只用于 docker-compose，app 映射到本机的端口，默认 `3000` |
| `UPLOAD_ACCOUNT_LIMIT_BYTES` | 单账号站点上传累计配额，默认 256 MiB |
| `UPLOAD_SITE_LIMIT_BYTES` | 全站站点上传累计配额，默认 10 GiB，包含已有文件 |
| `UPLOAD_ORPHAN_TTL_MS` | 未引用上传的清理等待时间，默认 24 小时 |
| `VIDEO_MAX_UPLOAD_BYTES` | 单个视频（压缩后）最大大小，默认 300 MB |
| `VIDEO_ACCOUNT_LIMIT_BYTES` / `VIDEO_SITE_LIMIT_BYTES` | 单账号 / 全站视频累计配额，默认 2 GiB / 30 GiB；每人每天最多传 20 个 |
| `VIDEO_CONCURRENCY` | 同时转码几个视频，默认 1（小服务器别调大） |
| `FFMPEG_PATH` / `FFPROBE_PATH` | ffmpeg 的位置，默认从 PATH 里找。Docker 镜像已经自带；直接用 Node 运行要自己装（`apt install ffmpeg`）。找不到时发帖框不显示视频选项 |
| `SMTP_HOST` / `MAIL_FROM` | 可选；同时配置后才允许邮箱验证 |
| `SMTP_PORT` / `SMTP_SECURE` | 默认 587，要求 STARTTLS；465 默认隐式 TLS，也可显式设置 `SMTP_SECURE=1` |
| `SMTP_USER` / `SMTP_PASS` | SMTP 认证，要么同时设置，要么留空 |

### 图片与备份

帖子配图、个人头像、吧头像和背景图存在 `DATA_DIR/uploads/`，按随机文件名公开访问并长期缓存（和 X 的图片一样，知道地址就能打开）；不能拿别人上传的图片路径重新附加。私信图片走独立的参与者鉴权。

每张图片按原图大小的两倍计入配额（最低 4 KiB），包含缩略图预留；历史图片计入全站配额。服务启动时及每小时清理超过保留时间且不再被帖子、个人资料或吧头像引用的文件。图片备份无需包含 `uploads/.thumbs/`，缩略图可重新生成。

`npm run backup` 为数据库制作快照，并在需要时生成同名 `.key` 和 `.dm-uploads`。恢复时先停服务，将它们还原为 `forum.db`、`account-security.key`（权限 `0600`）和 `dm-uploads/`；普通 `uploads/` 和视频 `videos/` 仍需另行备份。

### 视频

视频存在 `DATA_DIR/videos/`：`<id>.mp4` 和封面 `<id>.jpg` 按随机文件名公开访问（支持 Range，可以拖进度），`<id>.f1-3.jpg` 是送审用的截图，不公开。传了没发出去的视频 24 小时后删掉，帖子删掉后视频也会在一小时内删掉。转码用 `nice` 降低优先级，一次只转一个；手机已经压好的视频通常只需重新封装，一两秒就好，需要转码的 2 分钟视频要几十秒。密钥和备份都应留在私有存储，密钥丢失后无法再用原验证器登录。

## 打包原生 App

App 默认连接 `https://www.cjlwall.cc`，登录页的「服务器地址」可以改，改过后保存在本机。打包时可用 `VITE_API_BASE` 换掉默认地址；正式包只允许 HTTPS，不带路径。后端设置 `CORS_ORIGINS` 时应保留 Android 的 `https://localhost` 和 iOS 的 `capacitor://localhost`。

```bash
cd web
# 可选：在 .env.app.local 中填写 VITE_API_BASE=https://你的站点 换掉默认的 https://www.cjlwall.cc
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

签名密钥留在本地。安装并登录 GitHub CLI 后，可直接上传正式签名包和同名摘要。附件名必须与版本对应：

```bash
version=0.12.1
name="campusx-android-$version.apk"
cp web/android/app/build/outputs/apk/release/app-release.apk "$name"
sha256sum "$name" > "$name.sha256"
gh release create "v$version" "$name" "$name.sha256" \
  --target main --title "校墙 v$version" --notes 'Android 签名安装包'
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

发视频时在本地压缩用的是 [Mediabunny](https://github.com/Vanilagy/mediabunny)（MPL-2.0，未修改，只在选视频时按需加载）。服务器转码用系统里的 ffmpeg，不随项目分发。

## 后续可以加的功能

- 群聊；私信改用 WebSocket 推送（目前是轮询）
- 帖子精华
- 图片压缩和缩略图（如 `sharp`）
- 推送通知（`@capacitor/push-notifications`）
- 手机号 / 邮箱找回密码（需要短信或 SMTP 服务）
