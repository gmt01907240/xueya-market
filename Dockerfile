# 学涯集市 · 单进程 Node 服务镜像
#
# 运行时要求 Node.js >= 22.5（项目使用 node:sqlite），因此固定使用 24 LTS。
# 默认加载 deploy/public-demo.env（公开演示：自动实名认证 + 模拟支付），
# 数据目录固定为 /app/data，必须挂载持久卷，否则重启会丢失数据库与上传文件。

FROM node:24-alpine

WORKDIR /app

ENV PORT=3300
ENV DATA_DIR=/app/data

COPY package.json ./
COPY server ./server
COPY public ./public
COPY deploy ./deploy
COPY scripts ./scripts

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3300
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3300) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# 生产真实支付：追加 -e NODE_ENV=production -e PAYMENT_MODE=live -e PAYMENT_LIVE_ENABLED=true
# -e PUBLIC_DEMO=false -e AUTO_VERIFY=false 并配齐渠道参数，覆盖演示配置。
CMD ["node", "--env-file=deploy/public-demo.env", "server/index.js"]
