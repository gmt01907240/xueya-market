#!/bin/sh
# 容器入口：修正持久卷属主后降权到 node 运行。
# 云主机命名卷会继承镜像属主，通常无需修正；PaaS 平台卷常以 root 挂载，需要此步骤。
set -e

DATA_DIR="${DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR/uploads"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi

exec "$@"
