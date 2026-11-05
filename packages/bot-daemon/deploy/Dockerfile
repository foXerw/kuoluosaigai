# syntax=docker/dockerfile:1
# saigai-bot 常驻 daemon 镜像（P2 / spec §9）。
#
# 构建上下文必须是仓库根（不是 deploy/ 目录）：
#   docker build -f packages/bot-daemon/deploy/Dockerfile -t kuoluosaigai/saigai-bot:latest .
# 多架构（amd64 + arm64，NAS 常见两种 CPU）：
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f packages/bot-daemon/deploy/Dockerfile \
#     -t <你的registry>/kuoluosaigai/saigai-bot:latest --push .
#
# 构建期不联网装第三方包：只把仓库里的两个 workspace 包 npm pack 成 tarball，
# 再在干净运行时镜像里安装。API key 不进入镜像层（只从运行环境 KUO_LLM_KEY 读）。

FROM node:22-alpine AS build
WORKDIR /build
COPY packages/bot-core ./bot-core
COPY packages/bot-daemon ./bot-daemon
RUN npm pack ./bot-core --pack-destination /tmp \
 && npm pack ./bot-daemon --pack-destination /tmp

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /opt/saigai-bot

# node 用户（uid 1000）需要可写的数据目录；配置目录只读挂载，root 所有即可。
RUN mkdir -p /config /data && chown node:node /data

COPY --from=build /tmp/*.tgz /tmp/
RUN npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund /tmp/kuoluosaigai-bot-core-*.tgz /tmp/kuoluosaigai-bot-daemon-*.tgz \
 && rm -rf /tmp/*.tgz \
 && ln -s /opt/saigai-bot/node_modules/.bin/saigai-bot /usr/local/bin/saigai-bot

USER node
ENTRYPOINT ["saigai-bot"]
CMD ["run", "--config", "/config/saigai-bot.config.js", "--data-dir", "/data"]
