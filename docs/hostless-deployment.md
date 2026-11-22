# 无本地主机部署方案（浏览器全程操作）

约束：不使用本地电脑作为服务器，全部操作在浏览器完成；项目为单进程 Node.js（≥22.5，使用 `node:sqlite`）+ 本地文件上传，必须有**持久化磁盘**。

> 唯一无法绕开的一步：源码要进入云端。可用 GitHub 网页上传、云控制台对象存储上传、或云主机网页终端（Workbench）的文件上传功能完成，之后所有构建、启动、验证均在浏览器内进行。

---

## 一、结论先行

| 方案 | 适用 | 月成本（参考） | 配置复杂度 | 关键限制 | 推荐度 |
| --- | --- | --- | --- | --- | --- |
| A 云主机 + 网页终端 | 长期运行、数据自主可控 | ¥24–60（2C2G） | 中 | 需自己运维、无免费 HTTPS | ★★★★★ |
| B Railway | 快速上线、有免费子域名 | $5 起（含用量） | 低 | 网络卷跑 SQLite 需谨慎 | ★★★★ |
| C Render | Docker + 持久盘 | $7 起 + 磁盘 $0.25/GB | 低 | 免费档无持久盘、会休眠 | ★★★ |
| D Zeabur / Koyeb | 国内访问友好的 PaaS | $5 起 | 低 | 卷实现差异大，需验证文件锁 | ★★★ |
| E GitHub Codespaces / Replit | 演示、临时试用 | 免费额度 / $20 | 低 | 不持久、休眠、不适合生产 | ★★ |
| F Serverless（Cloud Run / FC） | 有改造预算、弹性流量 | 按量，通常 <¥10 | 高 | 必须换数据库与对象存储 | ★ |

**推荐顺序**：A（最稳，SQLite 与持久盘语义正确）→ B（想免域名免备案、最快上线）→ D → C → E → F。

---

## 二、方案对比总表

| 维度 | A 云主机 | B Railway | C Render | D Zeabur/Koyeb | E Codespaces/Replit | F Serverless |
| --- | --- | --- | --- | --- | --- | --- |
| 运行 Node 24 | 自选镜像，完全可控 | Dockerfile 决定 | Dockerfile 决定 | Dockerfile 决定 | 可自装 | 自定义容器或运行时受限 |
| 持久化磁盘 | 云盘，原生块设备 | Volume（网络块存储） | Disk（付费） | Volume（PVC） | 随环境销毁 | 需挂 NAS/对象存储 |
| SQLite 适配 | 最佳 | 单实例可用，需验证 | 单实例可用 | 需验证文件锁 | 临时可用 | 不适用 |
| 免费 HTTPS | 需域名+证书 | 自带 `*.up.railway.app` | 自带 `*.onrender.com` | 自带子域名 | 预览域名 | 自带 |
| 中国大陆访问 | 快（可选地域） | 一般 | 一般 | 一般 | 一般 | 视地域 |
| 备案要求 | 绑大陆域名需 ICP | 用平台子域名免备案 | 同左 | 同左 | 免 | 视平台 |
| 运维负担 | 高 | 低 | 低 | 低 | 极低 | 中 |
| 冷启动/休眠 | 无 | 无（付费） | 免费档会休眠 | 免费档会休眠 | 会休眠/回收 | 有冷启动 |
| 扩容能力 | 垂直扩容为主 | 垂直 + 多实例（需换库） | 同左 | 同左 | 无 | 强 |
| 数据可迁移性 | 高（整卷打包） | 中（卷导出受限） | 中 | 中 | 低 | 低（绑定云服务） |

---

## 三、方案 A：云主机 + 浏览器网页终端（推荐）

### 3.1 适用与成本

- 适用：需要长期稳定运行、数据在自己手里、后续要接真实支付与备案域名。
- 成本：轻量应用服务器 2 核 2G / 40G 约 ¥24–40/月，新用户活动价更低；带宽 3–5 Mbps 即可（32MB 上传约需 55s@5Mbps）。
- 地域：优先选离用户近的（北京/上海/广州）。

### 3.2 分步实施（全程浏览器）

**第 1 步：购买与登录**
1. 浏览器打开云厂商控制台 → 轻量应用服务器 / ECS → 新建实例。
2. 镜像选 Ubuntu 24.04；规格 2C2G；系统盘 40G；勾选「自动快照」。
3. 创建完成后，在实例操作栏点「远程连接 / Workbench / OrcaTerm」，进入网页终端（无需本地 SSH）。

**第 2 步：把代码送进云端（三选一）**
- 方式 1（推荐）：浏览器打开 GitHub → New repository → 网页「Add file → Upload files」，按目录分批上传项目（单次上限 100 个文件，本项目约 136 个，分两次）。随后在网页终端 `git clone`。
- 方式 2：云控制台「对象存储 OSS/COS」网页上传压缩包 → 生成临时下载链接 → 在网页终端 `curl -O <链接>` 后 `tar -xzf`。
- 方式 3：Workbench 自带「文件上传」，直接上传压缩包到 `/opt/xueya` 后解压。

```bash
sudo mkdir -p /opt/xueya && sudo chown -R $USER:$USER /opt/xueya
cd /opt/xueya
# 方式1
git clone https://github.com/<你的账号>/xueya-market.git .
# 方式2/3
tar -xzf ~/xueya-deploy.tar.gz -C /opt/xueya
```

**第 3 步：一键安装与启动**

```bash
cd /opt/xueya
bash deploy/install.sh
```

脚本会自动安装 Docker、构建镜像、启动容器、放行 3300 并等待健康检查。

**第 4 步：安全组放行**
控制台 → 防火墙/安全组 → 添加规则：TCP 3300，来源填 `0.0.0.0/0`（演示期）；SSH 22 建议只对你的出口 IP 开放。

**第 5 步：浏览器验证**
访问 `http://<公网IP>:3300`，完成注册 → 实名自动通过 → 下单 → 演示支付 → 下载。

**第 6 步（可选，需域名）**
1. 域名解析 A 记录指向公网 IP；大陆节点需先完成 ICP 备案（否则 80/443 会被拦截）。
2. 网页终端安装 Nginx + Certbot，按 [public-host-security.md](public-host-security.md) 配置 HTTPS。
3. compose 端口改为 `127.0.0.1:3300:3300`，只暴露 80/443。

### 3.3 验证方法

| 检查 | 命令（网页终端） | 期望 |
| --- | --- | --- |
| 容器状态 | `docker compose ps` | Up (healthy) |
| 健康检查 | `curl -s 127.0.0.1:3300/api/health` | `status: ok`、`database: ok` |
| 指标 | `curl -s 127.0.0.1:3300/api/metrics` | 有 `requests`、`memory`、`database` |
| 持久化 | `docker compose restart` 后重新登录 | 账号与订单仍在 |
| 外部可达 | 浏览器开 `http://IP:3300` | 首页正常 |

### 3.4 排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 外部打不开，本机 curl 正常 | 安全组/ufw 未放行 | 控制台加规则；`sudo ufw allow 3300/tcp` |
| 容器反复重启 | 数据目录权限/端口占用 | `docker compose logs --tail=100 xueya` |
| 构建卡在拉取镜像 | 网络访问 Docker Hub 慢 | 配置镜像加速器后重试 |
| 登录态重启后失效 | 未挂载 `xueya-data` | `docker volume ls` 确认卷存在 |
| 上传 413 | 反向代理限额小 | `client_max_body_size 35m` |

---

## 四、方案 B：Railway（最快拿到 HTTPS 地址）

### 4.1 适用与成本

- 适用：希望 10 分钟内出可访问地址、不想碰服务器；自带 `https://xxx.up.railway.app`，无需域名与备案。
- 成本：Hobby 约 $5/月（含等额用量），Volume 按 GB/月计费。以官网为准。

### 4.2 分步实施

1. 浏览器把代码上传到 GitHub（同方案 A 第 2 步）。
2. 打开 railway.app → 用 GitHub 登录 → New Project → Deploy from GitHub repo → 选择仓库。
3. Railway 识别到 `Dockerfile` 自动构建（基础镜像 `node:24-alpine`，满足 `node:sqlite`）。
4. 添加 Volume：服务 → Variables/Settings → Volumes → Mount path 填 `/app/data`。
5. 配置环境变量：把 `deploy/public-demo.env` 的键值逐条粘贴到 Variables（`DATA_DIR=/app/data`、`PORT` 由平台注入可不必填、`TRUST_PROXY=true`）。
6. Settings → Networking → Generate Domain，端口填 3300。
7. Healthcheck Path 填 `/api/health`，重启策略默认即可。

### 4.3 验证

```bash
curl -s https://<域名>/api/health
curl -s https://<域名>/api/metrics
```

浏览器走完注册→下单→支付→下载；随后在 Railway 面板 Redeploy 一次，确认账号与订单未丢失（验证卷挂载）。

### 4.4 排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 构建失败 `node: not found` | 误用了 Nixpacks 而非 Dockerfile | Settings 强制 Builder = Dockerfile |
| 启动即退出 | 生产模式支付闸门 | 保持 `NODE_ENV=staging` 或配齐真实支付 |
| 数据重启丢失 | Volume 未挂到 `/app/data` | 检查挂载路径大小写 |
| `SQLITE_BUSY` 频发 | 网络卷延迟 + 多实例 | 固定单实例，勿开多副本 |
| 健康检查失败 | 启动慢于阈值 | 调大 healthcheck 超时/初始等待 |

---

## 五、方案 C：Render（Docker + 持久盘）

### 5.1 适用与成本

- 适用：需要稳定 Docker 托管、可接受付费磁盘。
- 成本：Starter $7/月起；Disk $0.25/GB/月（1GB 起）。**免费档无持久盘且会休眠，不能用于本项目**。

### 5.2 分步实施

1. 代码上传 GitHub（同前）。
2. render.com → New → Web Service → 连接仓库 → Runtime 选 Docker。
3. Instance Type 选 Starter（免费档无磁盘）。
4. Disks → Add Disk：Name `xueya-data`，Mount Path `/app/data`，Size 1GB。
5. Environment → 逐条添加 `public-demo.env` 变量；`PORT` 由平台注入。
6. Health Check Path `/api/health`；Auto-Deploy 可选开。
7. 保存后等待部署，访问 `https://xxx.onrender.com`。

### 5.3 验证与排查

- 验证：`/api/health`、`/api/metrics`、完整交易链路、手动 Restart 后数据仍在。
- 排查重点：磁盘权限（容器内 `node` uid 1000，若报 `EACCES` 需在 Dockerfile 调整目录属主）、免费档休眠导致首次请求 30s 以上、磁盘扩容不可逆。

---

## 六、方案 D：Zeabur / Koyeb

- **Zeabur**：GitHub 导入 → 识别 Dockerfile → 添加 Volume 挂载 `/app/data` → 绑定自动域名。中文界面，国内访问较友好，约 $5/月起。
- **Koyeb**：Create Service → Docker → 配置端口 3300、健康检查 `/api/health`；Volume 为付费功能，免费实例会休眠。

共同注意：
1. 平台 Volume 多为网络存储，SQLite 的 WAL 与文件锁在部分实现上不稳定。上线前必须做「并发写入 + 重启」验证：跑 `npm run test:concurrency`，并连续重启 3 次确认无 `database is locked`。
2. 若出现锁问题，改用 `journal_mode=DELETE` 或直接回到方案 A（本地块设备）。

---

## 七、方案 E：在线开发环境（仅演示）

- **GitHub Codespaces**：仓库页 → Code → Codespaces → 新建；终端执行 `npm run start:public`；Ports 面板把 3300 设为 Public 即得临时 HTTPS 地址。免费额度约 60 核时/月，闲置自动停止，**不持久**。
- **Replit**：导入仓库 → 运行命令 `npm run start:public` → Webview 预览；需 Reserved VM 才能常驻，SQLite 持久性依赖其磁盘策略。
- **Gitpod / StackBlitz**：同类，均不适合作为正式服务。

适用：答辩演示、临时联调。验证方式同前，但**不要**在此环境录入真实个人信息。

---

## 八、方案 F：Serverless（需改造，谨慎选择）

当前架构与 Serverless 有三处硬冲突：

| 冲突点 | 现状 | Serverless 要求 |
| --- | --- | --- |
| 运行时 | `node:sqlite` 需 Node ≥22.5 | 多数平台运行时受限，需自定义容器 |
| 存储 | 本地 SQLite 文件 | 无持久本地盘，需 PostgreSQL/MySQL |
| 文件 | 本地 `uploads/` | 需对象存储（OSS/S3） |

改造清单（预估工作量最大项）：
1. 数据层抽象：把 `server/db.js` 的 SQLite 调用替换为 PostgreSQL 驱动（保留 SQL 方言差异处理）。
2. 上传改为对象存储直传 + 签名 URL 下载。
3. 会话改 JWT 无状态或 Redis。
4. 定时任务（结算、对账）改云函数定时触发。
5. 迁移后重新跑全量测试与并发测试。

可选平台：Google Cloud Run（容器 + Cloud SQL）、阿里云函数计算 FC（自定义容器 + NAS）、腾讯云 CloudBase Run。成本通常低于云主机，但改造与验证成本远高于省下的钱。

---

## 九、统一验收清单（所有方案通用）

浏览器或网页终端执行：

1. `GET /api/health` → `status=ok`、`database=ok`、`paymentMode=mock`、`paymentReady=true`
2. `GET /api/metrics` → 有请求计数、内存、数据库体积、`environment.publicDemo=true`
3. 注册新用户 → 提交实名 → 立即 `verified`
4. 浏览资料 → 下单 → 演示支付成功 → 订单 `completed`
5. 下载已购资料 → 返回文件流
6. 重复支付回调 → `duplicated=true`
7. 公网访问 `/api/admin/overview` → 401/403（后台已关闭）
8. 重启服务/重新部署 → 账号、订单、上传文件仍在
9. 并发验证（有终端时）：`npm run test:concurrency`、`npm run test:permissions`

---

## 十、常见问题总表

| 类别 | 现象 | 排查顺序 |
| --- | --- | --- |
| 构建 | 镜像构建失败 | 看构建日志首行错误 → 确认 Dockerfile 基础镜像 → 确认 `.dockerignore` 未误删 `server/` |
| 启动 | 容器退出码 1 | `NODE_ENV=production` 且支付未就绪会被闸门拒绝；演示务必 `staging` |
| 启动 | `Cannot find module 'node:sqlite'` | 运行时 Node < 22.5；改用 Dockerfile 构建 |
| 存储 | 重启数据丢失 | 卷未挂载或路径不是 `/app/data` |
| 存储 | `SQLITE_BUSY` / `database is locked` | 多实例、网络卷锁语义、长事务；固定单实例 |
| 网络 | 平台 502 | 端口不匹配（须 3300）、健康检查路径错、启动超时 |
| 网络 | 上传 413 | 平台/代理请求体上限，调到 35m |
| 权限 | `EACCES /app/data` | 容器用户 uid 1000 与卷属主不一致，构建时 chown |
| 认证 | 部署后全员掉线 | `secret.key` 未持久化或被重建 |
| 支付 | 回调 400 | 固定 `PAYMENT_MOCK_SECRET`，否则重启后签名不匹配 |

---

## 十一、方案间迁移注意事项

**通用原则**：镜像、环境变量、数据卷路径三者保持一致（`/app/data`），迁移成本最低。

1. **先备份，再迁移**：`npm run backup` 生成 SQLite 快照；`data/` 整目录打包（含 `uploads/`、`secret.key`）。
2. **保留 `secret.key`**：否则所有用户 token 失效，需重新登录。
3. **保留 `PAYMENT_MOCK_SECRET`**：避免待支付订单回调失败。
4. **DNS 切换**：提前把 TTL 降到 60s；切换后观察 10 分钟再恢复。
5. **并发窗口**：切换期间停止旧实例写入，避免两边数据分叉（SQLite 无法双向同步）。
6. **从 PaaS 迁回云主机**：先在云主机用相同镜像启动并挂载空卷，导入备份，健康检查通过后再切流量。
7. **从云主机迁到 PaaS**：确认平台卷支持 SQLite 文件锁（先跑并发测试），再迁移。
8. **Serverless 方向不可逆**：一旦改为外部数据库与对象存储，回迁需反向改造成本，建议一步到位并保留数据访问层抽象。
9. **镜像归档**：迁移前 `docker save xueya-market:latest | gzip > xueya-image.tar.gz`，便于离线恢复。
10. **迁移后必跑**：健康检查 → 完整交易链路 → 并发/权限测试 → 重启持久性验证。

---

## 十二、选型建议（结合本项目现状）

| 目标 | 选择 |
| --- | --- |
| 本周就要能公网访问、且要长期稳定 | 方案 A，2C2G 轻量 + `install.sh`，30 分钟内上线 |
| 完全不想运维、要现成 HTTPS 地址 | 方案 B Railway（Docker + Volume） |
| 只是答辩/评审演示两天 | 方案 E Codespaces，Public 端口 |
| 未来要接真实支付、备案域名 | 方案 A，后续加 Nginx + 证书 + 安全组收敛 |
| 预期流量大、愿意改造 | 方案 F，先完成数据库与对象存储迁移 |

成本不是主要变量（都在每月几十元量级），**SQLite 的磁盘语义与运维可控性**才是决定因素，因此默认推荐方案 A；若以「最快拿到 HTTPS、零服务器运维」为第一目标，选方案 B。
