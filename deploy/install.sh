#!/usr/bin/env bash
# 学涯集市 · 主机端一键部署脚本（在云主机上执行，可重复运行）
#
# 用法：
#   bash deploy/install.sh
#   APP_DIR=/opt/xueya PORT=3300 bash deploy/install.sh
#
# 前提：项目已上传到 APP_DIR，且存在 deploy/public-demo.env
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PORT="${PORT:-3300}"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[提示] %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m[错误] %s\033[0m\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "缺少 curl，请先安装"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "需要 root 或 sudo 权限"
  SUDO="sudo"
fi

# 1. 安装 Docker
if ! command -v docker >/dev/null 2>&1; then
  log "未检测到 Docker，开始安装"
  curl -fsSL https://get.docker.com | $SUDO sh
fi
$SUDO systemctl enable --now docker >/dev/null 2>&1 || true

if ! $SUDO docker compose version >/dev/null 2>&1; then
  die "缺少 docker compose 插件，请安装 docker-compose-plugin 后重试"
fi

# 2. 校验项目
cd "$APP_DIR" || die "无法进入 $APP_DIR"
[ -f docker-compose.yml ] || die "未找到 $APP_DIR/docker-compose.yml，请先上传项目"
[ -f deploy/public-demo.env ] || die "缺少 deploy/public-demo.env"

# 3. 构建并启动
log "构建并启动容器（首次构建可能需要几分钟）"
$SUDO docker compose up -d --build

# 4. 放行防火墙端口（仅当 ufw 已启用）
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
  $SUDO ufw allow "${PORT}/tcp" >/dev/null 2>&1 && log "已放行 ${PORT}/tcp"
fi

# 5. 等待健康检查
log "等待服务就绪"
READY=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done

if [ "$READY" -ne 1 ]; then
  $SUDO docker compose logs --tail=100 xueya || true
  die "健康检查超时，请查看上方日志"
fi

log "服务已就绪"
curl -s "http://127.0.0.1:${PORT}/api/health"; echo
$SUDO docker compose ps

IP="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
if [ -z "$IP" ]; then IP="<公网IP>"; fi
printf '\n访问地址: http://%s:%s\n' "$IP" "$PORT"
printf '运维命令: cd %s && sudo docker compose logs -f xueya\n' "$APP_DIR"
printf '数据备份: cd %s && sudo docker exec xueya npm run backup\n' "$APP_DIR"
