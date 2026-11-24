# 校墙：前端构建 + 后端运行，一个镜像搞定
# 构建：docker build -t xiaoqiang .
# 运行：见 docker-compose.yml 和 README「Docker 部署」

# ---------- 第一阶段：构建前端 ----------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY server server
COPY web web
RUN npm run build

# ---------- 第二阶段：只带后端运行所需的东西 ----------
FROM node:24-alpine
# 视频转码、截封面要 ffmpeg；不装也能跑，只是不能发视频
RUN apk add --no-cache ffmpeg
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace=server --no-audit --no-fund && npm cache clean --force
COPY server/src server/src
# 随代码带的官方表情包，第一次启动时导入
COPY server/emoji-packs server/emoji-packs
COPY --from=build /app/web/dist web/dist
# 数据库和上传的图片都在 /data，用卷持久化；以非 root 用户运行
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.ts"]
