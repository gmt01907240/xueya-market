# 部署与运维指南

本项目是单进程 Node 服务 + 单文件 SQLite，部署成本低。以下提供本地、Docker、云主机与托管平台四种方式。

## 一、环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | ≥ 22.5（推荐 24 LTS 或更高；`node:sqlite` 需要该版本） |
| 操作系统 | Linux / macOS / Windows |
| 内存 | ≥ 512MB |
| 磁盘 | ≥ 1GB（含上传文件） |
| 端口 | 默认 3300，可通过 `PORT` 环境变量修改 |
| 依赖 | 无（不需要 `npm install`） |

## 二、本地运行

```bash
node -v            # 确认 >= 22.5
npm start          # 等同于 node server/index.js
```

首次启动会自动创建 `data/`、建表并写入演示数据。浏览器访问 `http://localhost:3300`。

修改端口（PowerShell）：

```powershell
$env:PORT=8080; npm start
```

重置演示数据：

```bash
npm run reset
```

### 支付环境变量

默认 `PAYMENT_MODE=mock`，无需任何配置即可体验完整支付流程（含模拟成功 / 失败）。
接入真实渠道时按需配置，未配齐的渠道会自动置为不可选：

```bash
# 微信支付
WECHAT_APP_ID=...
WECHAT_MCH_ID=...
WECHAT_API_V3_KEY=...
WECHAT_NOTIFY_URL=https://your-domain.com/api/payments/callback/wechat

# 支付宝
ALIPAY_APP_ID=...
ALIPAY_APP_SECRET=...
ALIPAY_NOTIFY_URL=https://your-domain.com/api/payments/callback/alipay

# 银行卡转账
BANK_MCH_ID=...
BANK_MERCHANT_KEY=...
BANK_NOTIFY_URL=https://your-domain.com/api/payments/callback/bankcard

# 切换生产模式
PAYMENT_MODE=live
```

回调地址需在对应渠道商户后台登记。参数细节、签名算法与异常码见 [payments.md](payments.md)。

## 三、Docker 部署（推荐）

项目根目录已提供 `Dockerfile` 与 `docker-compose.yml`，镜像基于 `node:24-alpine`（`node:sqlite` 要求 Node ≥ 22.5），内置健康检查、优雅退出与日志轮转。

### 云主机 5 分钟上线

```bash
# 1) 安装 Docker（Ubuntu/Debian）
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # 重新登录生效

# 2) 上传项目到 /opt/xueya（scp / rsync / git clone 任选）
sudo mkdir -p /opt/xueya && sudo chown $USER:$USER /opt/xueya
cd /opt/xueya

# 3) 构建并启动（自动加载 deploy/public-demo.env）
docker compose up -d --build
docker compose ps

# 4) 健康检查
curl -s http://127.0.0.1:3300/api/health

# 5) 公网访问：放行 3300，或用第四节 Nginx + HTTPS（推荐）
sudo ufw allow 3300/tcp
```

浏览器打开 `http://<公网IP>:3300` 即可注册体验。数据保存在命名卷 `xueya-data` 的 `/app/data`，容器重建不丢失。

Windows 本机可用脚本一键完成打包、上传与部署：

```powershell
# 密钥登录（推荐）
powershell -ExecutionPolicy Bypass -File deploy\upload.ps1 -Server <公网IP> -SshUser root -KeyPath $HOME\.ssh\id_ed25519

# 仅打包，手动上传
powershell -ExecutionPolicy Bypass -File deploy\upload.ps1 -Server <公网IP> -SshUser root -PackOnly
```

脚本会排除 `node_modules`、`data`、`.git` 与日志，上传到 `~/xueya-deploy.tar.gz` 后解压至 `/opt/xueya` 并执行 `deploy/install.sh`。`install.sh` 可重复执行，自动安装 Docker、构建容器、放行端口并等待健康检查通过。

公网 IP 的查找位置、SSH 密钥生成与绑定步骤见 [host-access.md](host-access.md)。

一键启动（默认加载公开演示配置）：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f xueya
```

等价的手动命令：

```bash
docker build -t xueya-market .
docker run -d \
  --name xueya \
  --env-file deploy/public-demo.env \
  -e DATA_DIR=/app/data \
  -p 3300:3300 \
  -v xueya-data:/app/data \
  --restart unless-stopped \
  xueya-market
```

说明：

- `-v xueya-data:/app/data` **必须挂载**，否则容器重启会丢失数据库、上传文件与签名密钥。
- 容器内 `DATA_DIR` 固定为 `/app/data`，挂载卷即完整持久化目录。
- 健康检查请求 `/api/health`；启动自检会校验数据库可用与上传目录可写，不通过时直接退出，避免带病上线。
- 查看日志：`docker compose logs -f xueya`（标准输出为结构化 JSON，含 `requestId`、耗时与 `userId`）。

### 公开演示模式

`deploy/public-demo.env` 用于对外演示：

- `NODE_ENV=staging`，允许模拟支付；支付页明确标注「演示支付 · 不产生真实扣款」。
- `AUTO_VERIFY=true`，新用户提交实名信息后自动通过，注册即可体验完整买卖链路。
- `ADMIN_IP_ALLOWLIST=192.0.2.1/32`，公网无法进入管理后台（该地址为保留测试网段）。
- `SEED_DEMO=true`，首次启动写入演示资料，便于立即下单。

### 切换正式生产

生产环境必须接入真实支付，且不得自动通过实名认证：

```bash
docker run -d --name xueya \
  -e NODE_ENV=production \
  -e PUBLIC_DEMO=false -e AUTO_VERIFY=false -e SEED_DEMO=false \
  -e PAYMENT_MODE=live -e PAYMENT_LIVE_ENABLED=true \
  -e ADMIN_MFA_SECRET=... \
  -e WECHAT_APP_ID=... -e WECHAT_MCH_ID=... ... \
  -e DATA_DIR=/app/data \
  -p 3300:3300 -v xueya-data:/app/data --restart unless-stopped xueya-market
```

> 容器默认加载 `deploy/base.env`（通用配置），演示配置只在 `DEPLOY_PROFILE=public-demo` 或 `PUBLIC_DEMO=true` 时启用。生产环境不要设置这两个变量。
> 生产环境必须通过 `ADMIN_MFA_SECRET` 预置管理员 TOTP 密钥；未预置时管理员首次登录会被拒绝，禁止自行绑定。`-e` 的优先级高于 `--env-file`，可逐项覆盖。生产模式下若支付通道未就绪，服务会拒绝启动，这是有意设计的安全闸门。

## 四、云主机部署（Ubuntu + systemd + Nginx）

### 1. 安装 Node

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

### 2. 上传代码并启动

```bash
sudo mkdir -p /opt/xueya && sudo chown $USER:$USER /opt/xueya
# 将项目文件上传到 /opt/xueya
cd /opt/xueya
node -v
PORT=3300 node --env-file=deploy/public-demo.env server/index.js   # 先前台验证（公开演示配置）
```

### 3. systemd 守护

创建 `/etc/systemd/system/xueya.service`：

```ini
[Unit]
Description=Xueya Market
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/xueya
# 公开演示配置；正式生产请改为生产环境变量文件，并接入真实支付
ExecStart=/usr/bin/node --env-file=deploy/public-demo.env server/index.js
Environment=PORT=3300
Environment=DATA_DIR=/opt/xueya/data
Restart=always
RestartSec=3
# 优雅退出：先发送 SIGTERM，等待在途请求完成
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xueya
sudo systemctl status xueya
```

### 4. Nginx 反向代理 + HTTPS

```nginx
server {
    listen 80;
    server_name market.example.com;

    client_max_body_size 35m;

    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> 使用上述反向代理时，请同时设置 `TRUST_PROXY=1`，否则服务端会忽略 `X-Forwarded-For`，所有请求会按代理 IP 统一限流。未部署反向代理时不要开启该变量，防止客户端伪造 IP。

使用 Certbot 申请证书：

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d market.example.com
```

也可用 Caddy 一行完成 HTTPS：

```caddyfile
market.example.com {
    reverse_proxy 127.0.0.1:3300
}
```

### 5. 防火墙

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 五、托管平台部署

> 无本地服务器、全程浏览器操作的多方案对比（云主机网页终端 / Railway / Render / Zeabur / Codespaces / Serverless）见 [hostless-deployment.md](hostless-deployment.md)。

适用于 Render / Railway / Zeabur / Fly.io / 阿里云 / 腾讯云等支持 Docker 与持久卷的平台。

通用步骤：

1. 将代码推送到 GitHub 仓库，或直接上传项目目录。
2. 新建 Web Service，选择 **Docker** 构建，入口为仓库根目录 `Dockerfile`。
3. 暴露端口 `3300`（平台若通过 `PORT` 注入端口，服务会自动使用该值）。
4. **挂载持久化磁盘到 `/app/data`**（SQLite、上传文件与 `secret.key` 都在此目录）；这是上线硬性前提。
5. 健康检查路径填写 `/api/health`。
6. 公开演示：设置 `DEPLOY_PROFILE=public-demo`（容器入口自动加载 `deploy/public-demo.env`），或按该文件逐项配置环境变量；正式生产：不设该变量（默认 `deploy/base.env`），配置 `NODE_ENV=production`、`ADMIN_MFA_SECRET` 与真实支付参数（见上节）。

注意事项：

- 无持久化磁盘的实例会在重启后丢失数据，**不满足正式服务要求**，仅适合临时演示。
- 平台若限制文件系统写入，需确认 `/app/data` 可写。
- 单实例即可承载中小规模并发；如需水平扩展，应将会话与业务数据迁移到外部数据库，并使用共享对象存储保存上传文件。
- 首次部署后访问域名，确认首页、注册登录、资料列表与 `/api/health` 正常。

### Railway 部署（已验证上线）

主站地址：`https://xueya-production.up.railway.app`

已验证：10 项公网 E2E 全部通过（注册 → 实名自动通过 → 下单 → 演示支付 → 幂等回调 → 下载 → 401/403 边界），且重启后账号与订单仍在（持久卷生效）。

部署要点：

1. 新建 Project，Builder 选 Dockerfile；添加 Volume，Mount Path 填 `/app/data`。
2. Variables 按 `deploy/public-demo.env` 录入，并额外设置 `PORT=3300`、`DATA_DIR=/app/data`。
3. Settings → Networking 生成域名，目标端口填 `3300`，Healthcheck Path 为 `/api/health`。
4. CLI 方式：`railway init --name xueya-market` → `railway add --service xueya` → `railway volume add --mount-path /app/data` → `railway up --ci` → `railway domain --port 3300`。
5. GitHub 自动部署：Settings → Source 已连接私有仓库 `gmt01907240/xueya-market`，生产分支 `main`。已实测向 `main` 推送提交后，Railway 自动触发构建并上线（Deployments 中记录来源为 GitHub），无需再执行 `railway up`。

> 说明：Settings → Source 区域若显示 `Auto deploy unavailable`，不影响基于分支推送的自动部署，实测 push 后仍会正常触发构建。

三个已踩过的坑：

- `.gitignore` / `.dockerignore` 里若写 `data`（不带斜杠），会连 `server/data/schools-official.json` 一起排除，容器启动报 `ENOENT`。必须写成 `/data`。
- PaaS 的卷通常以 root 属主挂载，而镜像默认用 `node` 用户，会 `EACCES`。项目已提供 `deploy/docker-entrypoint.sh`，以 root 修正属主后 `su-exec node` 降权。
- 平台会注入自己的 `PORT`，若与域名目标端口不一致会返回 502。本次固定 `PORT=3300` 与目标端口一致。

另注：`railway.toml` 属于 Config as Code，官方标记为弃用（2026-12-01 前仍可用），后续可迁移到 `.railway/railway.ts`。

## 六、环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3300` | HTTP 监听端口 |
| `NODE_ENV` | `production`（`deploy/base.env`） | `production` 强制真实支付通道就绪，否则拒绝启动；仅本地开发/演示显式改回 `development`/`staging` |
| `DEPLOY_PROFILE` | 空 | 设为 `public-demo` 开启公开演示模式 |
| `PUBLIC_DEMO` | `false` | 公开演示开关，等价于 `DEPLOY_PROFILE=public-demo` |
| `AUTO_VERIFY` | 跟随 `PUBLIC_DEMO` | 实名认证自动通过；仅演示环境开启，生产必须为 `false` |
| `DATA_DIR` | 项目下 `data/` | 数据库、上传文件与 `secret.key` 的持久化目录；容器内为 `/app/data` |
| `PAYMENT_MODE` | `mock` | 生产改为 `live`，并配齐渠道参数与 `PAYMENT_LIVE_ENABLED=true` |
| `PAYMENT_MOCK_SECRET` | 进程内随机 | 仅 mock 模式使用；多实例或需回调复现时固定该值 |
| `SETTLEMENT_DELAY_HOURS` | `24` | 收益结算延迟，`0` 表示支付成功即结算 |
| `RATE_LIMIT_LOGIN` 等 | 见 `server/rate-limit.js` | 各接口每分钟限流阈值 |
| `SEED_DEMO` | 非生产 `true`，生产 `false` | 是否写入演示账号与演示订单；生产必须为 `false` |
| `TRUST_PROXY` | `false` | 部署在 Nginx/托管平台代理后设为 `1`，只信任代理传来的 `X-Forwarded-For` |
| `TRUST_PROXY_HOPS` | `1` | 可信代理层数；取 `X-Forwarded-For` 自右向左第 N 跳，避免客户端伪造最左值绕过限流 |
| `METRICS_TOKEN` | 空 | 设置后 `/api/metrics` 仅接受 `Authorization: Bearer <token>`；不再支持 URL 查询参数传令牌 |
| `UPLOAD_DAILY_QUOTA` | `20` | 单用户 24 小时资料上传配额，超限返回 429 |
| `UPLOAD_MIN_FREE_MB` | `500` | 上传目录剩余空间下限，低于该值拒绝上传并返回 507、同时输出错误日志 |
| `AUDIT_LOG_KEEP_DAYS` | `180` | 审计日志保留天数，启动时自动清理超期记录（最小 7 天） |
| `INVITE_CODES` | 空 | 内测邀请码，格式 `BETA-001:50,BETA-002:100`，留空表示注册不需要邀请码 |
| `FEATURE_REGISTRATION` 等 | 开启 | 设为 `off`/`false`/`0` 关闭对应功能；支持注册、上传、支付、规划、砍价、AI 客服、工单 |
| `ADMIN_IP_ALLOWLIST` | 空 | 后台允许来源，支持 IP 与 CIDR，逗号分隔；留空时仅允许本机与私网，公网演示建议设为保留网段以彻底关闭后台 |

数据库、上传目录与密钥默认位于项目下 `data/`，通过挂载卷持久化；也可用 `DATA_DIR` 指向独立磁盘。

## 七、健康检查与监控

```bash
curl -s http://localhost:3300/api/health
```

返回示例：

```json
{
  "status": "ok",
  "service": "xueya-market",
  "version": "1.1.0",
  "database": "ok",
  "paymentMode": "mock",
  "paymentReady": true,
  "uptime": 128,
  "time": "2026-11-22T08:00:00.000Z"
}
```

运行指标（聚合计数，不含用户身份信息）。配置了 `METRICS_TOKEN` 时只能通过请求头访问，避免令牌出现在访问日志与浏览器历史中：

```bash
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3300/api/metrics
```

返回包含累计请求量、状态码分布、5xx 数量、内存占用、数据库体积与当前部署环境，可直接接入云监控探针。

建议监控项：

- 进程存活与健康检查状态（`/api/health` 非 200 即告警）
- 5xx 错误率（`/api/metrics` 中 `requests.serverErrors`）
- 磁盘使用率（上传文件与 SQLite 增长）；剩余空间低于 `UPLOAD_MIN_FREE_MB`（默认 500MB）时接口返回 507 并输出 `[materials] 磁盘剩余空间不足` 日志，需立即扩容或清理
- 上传异常（429 表示用户超出日配额；507 表示磁盘告警）
- 数据库文件大小与备份是否成功（备份脚本退出码非 0 即告警）
- 进程重启次数（异常退出应排查标准错误输出中的 `[uncaughtException]` / `[unhandledRejection]`）

### 生产最小变量清单

只加载 `deploy/base.env` 或仅配置以下变量即可安全启动生产环境：

```bash
NODE_ENV=production
DATA_DIR=/app/data
PORT=3300
PAYMENT_MODE=live
PAYMENT_LIVE_ENABLED=true
SEED_DEMO=false
AUTO_VERIFY=false
ADMIN_MFA_SECRET=<32 字节以上随机串>
ADMIN_IP_ALLOWLIST=<办公网出口 IP/CIDR>
# 真实支付渠道参数与 METRICS_TOKEN 按需补充
```

> `SEED_DEMO=true` 在非回环地址会被拒绝启动；公网演示必须显式设置 `DEPLOY_PROFILE=public-demo`，此时后台路由统一返回 404。

## 八、数据备份与恢复

需要备份的目录只有一个：`data/`。

```bash
# 备份
tar -czf xueya-backup-$(date +%Y%m%d).tar.gz -C /opt/xueya data

# 恢复（先停止服务）
sudo systemctl stop xueya
tar -xzf xueya-backup-20261120.tar.gz -C /opt/xueya
sudo systemctl start xueya
```

说明：

- `data/xueya.db` 为 SQLite 数据库，`data/uploads/` 为资料文件，`data/secret.key` 为 Token 签名密钥。
- 备份时应暂停写入，或使用一致性快照；项目内置热备脚本（`VACUUM INTO`），**无需停服**。

### 一致性热备（推荐）

```bash
npm run backup
# 容器内：
docker exec xueya npm run backup
```

脚本会在 `data/backups/` 生成 `xueya-YYYYMMDD-HHmmss.db` 快照并同步备份 `secret.key`，默认保留最近 14 份（`BACKUP_KEEP` 可调）。快照文件位于持久卷内，建议再同步到对象存储或异地。

导出命名卷到宿主机（可用于异地归档）：

```bash
mkdir -p /backup
docker run --rm \
  -v xueya-data:/data \
  -v /backup:/backup \
  alpine tar -czf /backup/xueya-$(date +%F).tar.gz -C /data .
```

### 定时备份

```cron
# 每天 03:00 生成热备快照
0 3 * * * cd /opt/xueya && /usr/bin/node scripts/backup.mjs >> /var/log/xueya-backup.log 2>&1

# 每天 03:30 打包上传文件与备份目录到异地
30 3 * * * tar -czf /backup/xueya-files-$(date +\%F).tar.gz -C /opt/xueya data/uploads data/backups
```

## 九、升级流程

1. 备份 `data/`。
2. 拉取新代码。
3. 重启服务：`sudo systemctl restart xueya` 或 `docker restart xueya`。
4. 启动时会自动执行幂等建表与补列迁移。
5. 访问 `/api/health` 与首页确认正常。

## 十、安全加固清单

> 完整的公网主机故障场景、五层防护措施、验证指标与应急恢复流程见 [public-host-security.md](public-host-security.md)。

- [ ] 全站 HTTPS，禁止明文 HTTP
- [ ] 修改演示账号密码或删除演示账号
- [ ] 限制 SSH 来源 IP，禁用密码登录
- [ ] Nginx 配置请求体上限（35m，需大于服务端 32MB）与基础限流
- [ ] 定期备份 `data/` 并验证可恢复
- [ ] 生产环境接入持牌支付，平台不沉淀资金
- [ ] 实名信息加密存储与访问审计
- [ ] 上传目录禁止脚本执行，下载统一走鉴权接口

Nginx 基础限流示例：

```nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=20r/s;

location /api/ {
    limit_req zone=api burst=40 nodelay;
    proxy_pass http://127.0.0.1:3300;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

## 十一、故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 启动报 `Cannot find module 'node:sqlite'` | Node 版本过低 | 升级到 ≥ 22.5，推荐 24 LTS |
| `EADDRINUSE` | 端口被占用 | 修改 `PORT` 或停止占用进程 |
| 页面空白 / 404 | 静态目录缺失 | 确认 `public/` 完整 |
| 上传失败 | 文件过大或类型不支持 | 检查服务端 32MB 请求上限与反向代理 `client_max_body_size`（建议 35m） |
| 容器重启数据丢失 | 未挂载 `/app/data` | 添加数据卷 |
| 登录后立即失效 | 容器重建导致 `secret.key` 变化 | 持久化 `data/` |
| 数据库损坏 | 非正常断电 | 从备份恢复，启用 WAL 与定期快照 |
