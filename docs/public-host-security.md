# 公网服务主机风险场景与防护方案

适用于本项目（学涯集市 · 单进程 Node 服务 + SQLite + Docker Compose）的单机公网部署。目标是把「能访问」提升到「可长期安全运行」。

---

## 一、典型问题场景

### 1.1 部署环境基线

| 项 | 当前形态 |
| --- | --- |
| 服务类型 | HTTP Web 应用（含注册登录、文件上传下载、模拟支付、管理后台） |
| 运行方式 | Docker 单容器，`docker compose up -d`，`restart: unless-stopped` |
| 数据存储 | SQLite 单文件 `/app/data/xueya.db` + 上传目录 + `secret.key` |
| 对外端口 | 3300（当前直连）；推荐改为 Nginx 80/443 反代，3300 仅监听回环 |
| 主机规格 | 1–2 核 / 1–2 GB 内存 / 40 GB 盘 / 1–5 Mbps 带宽 |
| 网络位置 | 云主机公网 IP，安全组 + 系统防火墙双层 |
| 环境属性 | `NODE_ENV=staging` 公开演示，模拟支付，管理员后台按 IP 白名单关闭 |

### 1.2 故障场景清单

| # | 现象 | 故障表现 | 触发条件 | 频率 | 根因 |
| --- | --- | --- | --- | --- | --- |
| S1 | 页面打不开、连接超时 | 浏览器一直转圈，`curl` 超时 | 安全组未放行、ufw 拦截、服务未启动 | 首次部署必现 | 网络层策略未对齐 |
| S2 | 首页正常，接口 502 | Nginx 502/504，日志有 `connect() failed` | 容器崩溃、端口未监听、健康检查失败 | 重启/升级时 | 单实例无存活保障 |
| S3 | 上传 32MB 文件失败 | 浏览器报 `ERR_CONNECTION_RESET`，Nginx 返回 413 | `client_max_body_size` 小于服务端限制 | 上传大文件时 | 代理与业务限额不一致 |
| S4 | 登录突然全部失效 | 老用户 token 全 401 | `data/secret.key` 丢失或容器重建未挂卷 | 容器重建后 | 持久化目录未挂载 |
| S5 | 数据库损坏、启动自检失败 | 启动打印「启动自检未通过」并退出 | 非正常断电、磁盘写满、SQLite 写并发异常 | 低概率但不可逆 | 无热备/未做快照 |
| S6 | 磁盘 100% | 上传失败、SQLite 报 `database or disk is full` | 日志未轮转、上传文件堆积、备份未清理 | 运行数周后 | 缺少容量治理 |
| S7 | 被扫描与爆破 | `/wp-admin`、`/.env` 大量 404；SSH 大量失败登录 | 端口直接暴露公网 | 上线数小时内 | 暴露面过大 |
| S8 | 接口被刷、CPU 打满 | 5xx 增多、响应变慢、`docker stats` CPU 100% | 无频率限制或限制过松、脚本批量注册 | 遭攻击时 | 缺少限流与封禁 |
| S9 | 支付回调重放 | 订单重复入账（当前已修复） | 回调无幂等、状态未加条件更新 | 攻击或重试时 | 业务幂等缺失 |
| S10 | 管理员后台被访问 | `/ops-login` 可打开并尝试登录 | `ADMIN_IP_ALLOWLIST` 留空或过宽 | 配置疏漏 | 管理面暴露 |
| S11 | 证书过期 | 浏览器全站红色警告，接口调用失败 | Certbot 自动续期失败 | 每 90 天节点 | 续期任务或 80 端口不可用 |
| S12 | 带宽打满 | 首屏加载 10s+，下载中断 | 大文件下载、被刷流量、无 CDN | 高峰期 | 带宽与静态资源策略不足 |
| S13 | 单点故障 | 主机宕机期间服务完全不可用 | 云主机故障、内核 OOM、误操作 | 低概率高影响 | 无冗余与快照 |
| S14 | 域名无法访问 | `ping` 通但域名不解析 | 未备案被拦截、DNS 未生效、A 记录错误 | 首次绑域名 | 合规与解析问题 |
| S15 | 日志找不到原因 | 出事后无请求上下文 | 日志仅本地、无轮转、无 requestId 检索 | 排障时 | 可观测性缺失 |

### 1.3 风险矩阵（按当前基线）

| 风险 | 可能性 | 影响 | 优先级 |
| --- | --- | --- | --- |
| 端口直接暴露被扫描爆破 | 高 | 中 | P0 |
| 无 HTTPS / 明文传输 | 高 | 高 | P0 |
| 数据卷未持久化或备份缺失 | 中 | 极高 | P0 |
| 单实例无存活兜底 | 中 | 高 | P1 |
| 无限流被刷 | 中 | 中高 | P1 |
| 管理后台暴露 | 中 | 高 | P1 |
| DDoS | 低 | 高 | P2 |
| 主机被入侵 | 低 | 极高 | P2 |
| 磁盘写满 | 中 | 中 | P1 |

---

## 二、五层防护措施

### 2.1 网络层防护

**目标**：只暴露必要端口，流量先经过代理与清洗。

#### 措施 N1：收敛暴露面

操作步骤：

```bash
# 1) 云控制台安全组：入方向仅保留
#    TCP 22   来源 = 你的固定出口 IP（124.207.151.66/32）
#    TCP 80   来源 = 0.0.0.0/0
#    TCP 443  来源 = 0.0.0.0/0
#    删除 3300 的 0.0.0.0/0 规则

# 2) 系统防火墙
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 124.207.151.66 to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

docker-compose 端口改为仅回环：

```yaml
ports:
  - "127.0.0.1:3300:3300"   # 不再对外暴露 3300
```

配置要求：公网仅 22/80/443；3300 只能从本机访问。

验证方法：

```bash
sudo ss -tlnp | grep -E ':(22|80|443|3300)'
# 期望：3300 显示 127.0.0.1:3300，而非 0.0.0.0:3300
curl -m 5 http://<公网IP>:3300/api/health   # 期望超时/拒绝
curl -m 5 https://<域名>/api/health          # 期望 200
```

效果指标：公网开放端口数 = 3；外部访问 3300 成功率 = 0。

#### 措施 N2：Nginx 反向代理 + TLS

操作步骤：

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d market.example.com
```

配置要点：

```nginx
server {
    listen 443 ssl http2;
    server_name market.example.com;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    client_max_body_size 35m;          # 必须大于服务端 32MB
    server_tokens off;                 # 隐藏版本号

    limit_req_zone $binary_remote_addr zone=api:10m rate=20r/s;
    location /api/ {
        limit_req zone=api burst=40 nodelay;
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_set_header Host $host;
    }
}
server {
    listen 80;
    server_name market.example.com;
    return 301 https://$host$request_uri;
}
```

同时设置应用侧 `TRUST_PROXY=1`，否则所有请求会被识别为代理 IP 而共用限流桶。

验证方法：

```bash
curl -I https://market.example.com          # 200，含 HSTS
curl -I http://market.example.com           # 301
openssl s_client -connect market.example.com:443 -tls1_2 </dev/null 2>/dev/null | grep 'Protocol'
sudo certbot renew --dry-run
```

效果指标：TLS 握手成功率 100%；HTTP 明文请求 100% 跳转；证书剩余有效期 > 30 天。

#### 措施 N3：SSH 收敛

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sudo systemctl reload sshd

sudo apt-get install -y fail2ban
sudo tee /etc/fail2ban/jail.d/sshd.local >/dev/null <<'EOF'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF
sudo systemctl enable --now fail2ban
```

验证：

```bash
sudo fail2ban-client status sshd        # 查看当前封禁
sudo journalctl -u sshd -n 50           # 确认无密码登录成功记录
```

指标：SSH 失败登录 < 20 次/天；封禁 IP 数可查询；密码登录成功次数 = 0。

#### 措施 N4：抗 DDoS 与流量清洗

- 开启云厂商免费基础防护（如 5 Gbps 清洗），配置流量告警阈值。
- 静态资源（JS/CSS/图片）上 CDN，减少源站带宽占用；源站只允许 CDN 回源 IP。
- 对登录、注册、下单、上传接口使用应用内限流（已内置 `server/rate-limit.js`），并按需下调阈值。
- 演示期可启用云 WAF 的基础规则集，拦截 SQL 注入、路径穿越、常见扫描器 UA。

验证：压测工具（如 `wrk -t4 -c100 -d30s`）下 5xx < 1%，CPU < 80%，触发限流返回 429 而非崩溃。

指标：异常流量占比、429 比例、源站带宽曲线、清洗触发次数。

---

### 2.2 主机层加固

#### 措施 H1：系统基线

```bash
# 补丁与自动更新
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades

# 时间同步（TLS、TOTP、回调时间戳都依赖）
sudo timedatectl set-timezone Asia/Shanghai
sudo timedatectl set-ntp true

# 仅保留必要服务
sudo systemctl disable --now snapd 2>/dev/null || true
sudo ss -tlnp                        # 逐个确认监听服务来源
```

标准：系统补丁滞后 < 7 天；时间偏差 < 1 秒；无多余监听端口。

#### 措施 H2：容器加固

在 `docker-compose.yml` 中追加：

```yaml
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    mem_limit: 1g
    pids_limit: 256
    tmpfs:
      - /tmp:size=64m
    read_only: true          # 可选，先在预发验证上传/备份链路
```

要求：容器内进程非 root（Dockerfile 已是 `USER node`）；禁止 `privileged`；禁止挂载 `/var/run/docker.sock`；日志轮转已配置 `max-size: 10m, max-file: 5`。

验证：

```bash
docker inspect xueya --format '{{.HostConfig.Privileged}} {{.HostConfig.ReadonlyRootfs}} {{.Config.User}}'
docker exec xueya id        # 期望 uid=1000(node)
docker stats --no-stream    # 内存/CPU 是否受限
```

指标：容器重启次数、OOMKilled 次数（`docker inspect --format '{{.State.OOMKilled}}'`）、单容器内存峰值。

#### 措施 H3：密钥与配置管理

- `deploy/public-demo.env` 权限设为 `600`，属主为部署用户；不得提交到仓库。
- 生产切换时必须替换：`PAYMENT_MOCK_SECRET`、`ADMIN_MFA_SECRET`、管理员初始密码、`secret.key`。
- `ADMIN_IP_ALLOWLIST` 生产环境填写办公固定 IP，演示环境保持保留网段（当前 `192.0.2.1/32`）。
- 云 API 密钥不要放在主机上；如必须，使用只读子账号并单独目录。

验证：

```bash
stat -c '%a %U:%G' deploy/public-demo.env   # 期望 600
grep -rE 'SECRET|PASSWORD|KEY' deploy/ | grep -v example
```

#### 措施 H4：文件与目录

```bash
sudo chown -R deploy:deploy /opt/xueya
sudo chmod 750 /opt/xueya
sudo chmod 700 /opt/xueya/data
```

上传目录不参与静态直出（当前下载走鉴权接口），Nginx 不配置 `alias` 指向 `data/`。

---

### 2.3 架构冗余

#### 措施 A1：进程级高可用（单机必做）

- `restart: unless-stopped` + 健康检查已配置，失败时自动重启。
- 增加 systemd 兜底单元（Docker 服务异常退出时拉起）：

```ini
[Unit]
Description=Xueya Compose
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/xueya
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
```

- 云主机开启「宕机自动重启」与「定时快照」（每日 1 次，保留 7 天）。

#### 措施 A2：数据冗余

- 每日 `npm run backup` 生成 SQLite 一致性快照（已实现，默认保留 14 份）。
- 用 `rclone` 或对象存储 CLI 把 `data/backups` 同步到异地，保留 30 天。
- 每周做一次「从备份恢复」演练，记录实际 RTO。

RPO/RTO 目标：RPO ≤ 24h（可提升到每小时）、RTO ≤ 30min。

#### 措施 A3：水平扩展的边界

SQLite 与本地文件决定了当前只能单写实例。若需多实例：

1. 数据库迁移到 PostgreSQL/MySQL；
2. 上传文件迁移到对象存储；
3. 会话改为共享存储或 JWT + 统一密钥；
4. Nginx/负载均衡后挂 2 个以上应用实例。

在此之前，不要盲目加实例，否则会出现数据分叉。

#### 措施 A4：发布与回滚

- 镜像按日期打标签：`docker tag xueya-market:latest xueya-market:20261122`。
- 发布前打数据快照；发布失败直接回退镜像标签。
- 数据库变更保持幂等建表与补列（当前已实现），禁止不可逆删除。

---

### 2.4 监控告警

#### 措施 M1：三层探针

| 层级 | 工具 | 频率 | 告警条件 |
| --- | --- | --- | --- |
| 外部可用性 | Uptime Kuma / 云监控 | 60s | 连续 2 次非 200 |
| 容器存活 | Docker healthcheck | 30s | 连续 3 次 unhealthy |
| 业务指标 | `/api/metrics` 采集 | 60s | 5xx 比例 > 1% 持续 5min |

#### 措施 M2：关键指标与阈值

```bash
curl -s https://market.example.com/api/health
curl -s https://market.example.com/api/metrics | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.requests,j.memory,j.database)})"
```

| 指标 | 来源 | 阈值 | 处置 |
| --- | --- | --- | --- |
| 可用性 | 外部探针 | < 99.5%（月度） | 排查网络/进程 |
| 5xx 率 | `requests.serverErrors / total` | > 1% | 查日志 requestId |
| P95 延迟 | Nginx `$request_time` | > 1s | 查慢查询与带宽 |
| 内存 | `memory.rssBytes` | > 80% 限额 | 查泄漏、重启 |
| 数据库体积 | `database.sizeBytes` | > 2GB 或增速异常 | 归档与清理 |
| 磁盘 | `df -h` | > 70% 预警 / 85% 严重 | 清日志与旧备份 |
| 容器重启 | `docker inspect` | 1 小时内 > 2 次 | 查退出码与 OOM |
| 登录失败 | 应用日志 | > 100 次/小时 | 触发 fail2ban/限流 |

#### 措施 M3：日志规范

- 应用已输出结构化 JSON（`requestId`、`path`、`status`、`ms`、`userId`）。
- Docker 日志轮转已限制总量（5 × 10MB）。
- 集中检索可选：Loki + Promtail，或云日志服务；至少保证 `docker compose logs --since 1h` 可查。
- 禁止把密码、token、身份证号写入日志（现有代码已做脱敏，新增字段需评审）。

验证：注入一次 500（测试环境），确认 5 分钟内收到告警且能通过 requestId 定位。

---

### 2.5 应急响应

#### 2.5.1 响应流程（30 分钟内）

1. **确认（0–5min）**：外部探针/用户反馈 → `curl /api/health` → 判定是网络、进程还是数据问题。
2. **止损（5–10min）**：回滚镜像 / 重启容器 / 切换安全组 / 开启云清洗。
3. **取证（10–20min）**：`docker logs`、`/api/metrics`、`last`、`journalctl`；可疑入侵先打快照再操作。
4. **恢复（20–30min）**：按场景执行下方命令，验证健康检查与核心链路。
5. **复盘（24h 内）**：记录时间线、根因、改进项与责任人。

#### 2.5.2 场景化处置

**R1 服务不可用（5xx / 502）**

```bash
cd /opt/xueya
docker compose ps
docker compose logs --tail=200 xueya
docker compose restart xueya
curl -s http://127.0.0.1:3300/api/health
# 仍失败则回滚镜像
docker compose down
docker tag xueya-market:20261121 xueya-market:latest
docker compose up -d
```

**R2 数据库损坏 / 启动自检失败**

```bash
docker compose stop xueya
docker run --rm -v xueya-data:/data -v /backup:/backup alpine sh -c \
  "cp /data/xueya.db /data/xueya.db.bad.$(date +%s) && \
   cp /backup/xueya-20261122-030000.db /data/xueya.db && \
   cp /backup/xueya-20261122-030000.secret.key /data/secret.key"
docker compose start xueya
curl -s http://127.0.0.1:3300/api/health
```

**R3 磁盘写满**

```bash
df -h; du -sh /var/lib/docker /opt/xueya/data/*
docker system prune -f --filter "until=168h"
find /opt/xueya/data/backups -name '*.db' -mtime +14 -delete
# 扩容云盘后：
sudo growpart /dev/vda 1 && sudo resize2fs /dev/vda1
```

**R4 被攻击 / 疑似入侵**

```bash
# 1) 先隔离：安全组只保留你的 IP 访问 22
# 2) 快照留证
# 3) 查异常
last -20; sudo ss -tlnp; docker ps; sudo journalctl -u sshd --since "2 hours ago" | grep Failed
# 4) 轮换所有密钥：secret.key、PAYMENT_MOCK_SECRET、ADMIN_MFA_SECRET、SSH 密钥
# 5) 重装系统并恢复数据，而不是在受污染主机上继续运行
```

**R5 证书过期**

```bash
sudo certbot renew --force-renewal
sudo systemctl reload nginx
curl -Iv https://market.example.com 2>&1 | grep expire
```

**R6 误删数据**

立即停止写入（`docker compose stop xueya`），从最近快照恢复，再核对订单、账本、余额一致性；恢复后跑 `npm run test:concurrency` 与 `npm run test:permissions`。

---

## 三、日常运维检查清单

### 每日（5 分钟）

- [ ] 外部探针与 `/api/health` 正常，无连续失败
- [ ] `/api/metrics` 中 5xx 为 0，内存无异常抬升
- [ ] `docker compose ps` 容器 Up 且 healthy
- [ ] `df -h` 磁盘使用 < 70%
- [ ] 检查 fail2ban 封禁与 SSH 失败登录量

### 每周（20 分钟）

- [ ] 备份文件存在且大小正常，异地同步成功
- [ ] 用备份在临时目录恢复一次并抽查数据
- [ ] 检查 Nginx 4xx/5xx 趋势与 Top 慢接口
- [ ] 核对 `docker image ls` 是否有可清理的旧镜像
- [ ] 检查证书剩余天数 > 30

### 每月

- [ ] 系统补丁与基础镜像更新，重建容器
- [ ] 轮换演示环境口令；生产按 90 天策略轮换
- [ ] 复核安全组与 ufw 规则，删除临时放行
- [ ] 压测一次（100 并发/30s），确认 5xx < 1%
- [ ] 复核日志中是否出现敏感信息

### 每季度

- [ ] 完整灾备演练：模拟主机丢失，从快照+备份重建
- [ ] 权限复核：SSH 用户、管理员账号、云账号子用户
- [ ] 依赖与依赖镜像 CVE 扫描（`docker scout` 或 `trivy`）
- [ ] 更新应急联系人、告警渠道与值班安排

---

## 四、验证与效果评估

| 维度 | 验证命令/方法 | 合格标准 |
| --- | --- | --- |
| 暴露面 | `sudo ss -tlnp`、外部 `nmap -Pn -p- <IP>` | 仅 22/80/443 开放 |
| TLS | `curl -I https://域名`、`openssl s_client` | TLS1.2+、HSTS、无证书告警 |
| 认证 | 关闭密码登录后尝试 `ssh` | 仅密钥可登录 |
| 限流 | `wrk` 或脚本并发登录 | 超限返回 429，无 5xx |
| 管理面 | 公网访问 `/ops-login` | 无法登录（IP 白名单生效） |
| 持久化 | 删除并重建容器 | 数据与登录态不丢 |
| 备份 | 恢复演练 | RTO ≤ 30min，数据一致 |
| 可观测 | 人为制造 500 | 5min 内告警，可定位 requestId |
| 容量 | 32MB 上传 + 100 并发下载 | 无超时、无 OOM |

月度目标：可用性 ≥ 99.5%，5xx ≤ 0.5%，P95 ≤ 800ms，磁盘 ≤ 70%，备份成功率 100%。

---

## 五、实施顺序建议

1. **P0（上线前）**：收敛端口、Nginx + HTTPS、数据卷与备份、SSH 密钥登录、管理员白名单。
2. **P1（上线首周）**：fail2ban、外部探针、磁盘与 5xx 告警、镜像标签与回滚演练。
3. **P2（稳定期）**：CDN、WAF、异地备份、季度灾备演练、容器进一步加固（只读根文件系统）。

> 说明：本项目当前为公开演示环境（模拟支付、自动实名、后台关闭）。切换正式生产前，除上述措施外还需完成真实支付渠道接入、ICP/公安备案（大陆域名）、隐私政策与实名信息加密存储评审。
