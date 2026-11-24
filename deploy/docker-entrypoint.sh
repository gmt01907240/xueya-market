#!/bin/sh
# 容器入口：按部署 profile 选择环境文件，修正持久卷属主后降权到 node 运行。
# 云主机命名卷会继承镜像属主，通常无需修正；PaaS 平台卷常以 root 挂载，需要此步骤。
set -e

DATA_DIR="${DATA_DIR:-/app/data}"

# 默认使用通用配置；公开演示需显式开启，避免演示开关（自动实名、演示数据）泄漏到正式环境
ENV_FILE="${ENV_FILE:-deploy/base.env}"
if [ "${DEPLOY_PROFILE:-}" = "public-demo" ] || [ "${PUBLIC_DEMO:-}" = "true" ] || [ "${PUBLIC_DEMO:-}" = "1" ]; then
  ENV_FILE="deploy/public-demo.env"
fi

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR/uploads"
  chown -R node:node "$DATA_DIR"
  if [ "$#" -gt 0 ]; then
    exec su-exec node "$@"
  fi
  exec su-exec node node --env-file="$ENV_FILE" server/index.js
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi
exec node --env-file="$ENV_FILE" server/index.js
