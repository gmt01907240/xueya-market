# 学涯集市 · 评审问题整改规格（spec）

> 目标：按评审报告的问题顺序，逐项完成根因定位、修复、验证与必要优化；不引入二次回归。
> 项目：`campus-market`（Node.js 原生 HTTP + node:sqlite，零第三方依赖，端口 3300）。
> 线上：https://xueya-production.up.railway.app （GitHub `main` 自动部署）。

---

## 1. 范围与不变量

**必须保持不变**
- 现有 API 路径、请求/响应字段（除新增可选字段外）不变。
- 非演示环境（`PUBLIC_DEMO=false`）的审核流程仍为「上传 → pending → 后台人工审核」。
- 现有 20 项测试脚本的既有断言语义不变（测试环境不是 public-demo）。
- 支付、订单、结算、砍价等核心链路行为不变。
- 不 force push；不在代码或命令中写入明文 token。

**允许的变化**
- 演示环境（`PUBLIC_DEMO=true`）上传自动通过审核。
- 新增环境变量 `METRICS_TOKEN`（可选）、`ADMIN_MFA_SECRET` 在生产环境变为强制。
- `/api/health` 增加只读字段 `demo`。
- `materials` 表新增列 `content_chars`（幂等补列，旧库兼容）。

---

## 2. 逐项修复规格

### P0-1 公开演示上传后永远待审核
- **根因**：`server/api-materials.js` `create()` 固定写入 `status='pending'`；后台审核入口被 IP 白名单关闭，演示环境无人可审。
- **改动**：`server/api-materials.js`
  - `create()`：初始状态改为 `runtime.PUBLIC_DEMO ? 'approved' : 'pending'`；响应文案在演示环境说明「演示环境免人工审核，已直接上架」。
  - `update()`：重新提交后的状态同样按 `runtime.PUBLIC_DEMO ? 'approved' : 'pending'` 处理。
  - `auditMessage()` 增加 `demo` 参数或新增 `demoAuditMessage()`，仅演示环境使用。
- **验证**：以 `PUBLIC_DEMO=true` 启动临时实例，上传资料后 `GET /api/materials/:id` 返回 `status=approved`；非演示实例仍为 `pending`。

### P0-2 作品帖公开管理员账号但后台不可达
- **根因**：`docs/submission-post.md` 公开了管理员账号，但演示环境 `ADMIN_IP_ALLOWLIST=192.0.2.1/32` 使后台从公网不可进入。
- **改动**：`docs/submission-post.md`
  - 删除「管理员 admin@xueya.cn / Admin123456」。
  - 改为「管理后台不对外开放，评审如需查看可以演示视频/只读录屏方式提供」。
- **验证**：全文检索确认无管理员密码明文。

### P0-3 源码私有导致评委不可查验
- **根因**：README 与作品帖宣称仓库私有，评审无法核验。
- **改动**：`README.md`、`docs/submission-post.md`
  - 统一口径：「源码可提供只读访问（评审申请后开通临时协作者），赛后公开」。
- **验证**：两处文案一致，无「私有不可查看」表述。

### P1-1 school / subject 未校验资源库
- **根因**：`server/api-materials.js` `create()`/`update()` 仅校验非空。
- **改动**：从 `server/db.js` 引入已导出的 `SCHOOLS`、`SUBJECTS`。
  - `school` 必填且必须命中 `SCHOOLS`，否则 400「请选择资源库中的院校」。
  - `subject` 必填且必须命中 `SUBJECTS`，否则 400「请选择资源库中的学科」。
  - `course` 限长 40（`create` 与 `update`）。
- **验证**：伪造 school/subject 返回 400；正常值 201；`audit-flow` / `role-flow` / `production-flow` 仍通过。

### P1-2 模拟支付密钥硬编码
- **根因**：`deploy/public-demo.env` 写入固定 `PAYMENT_MOCK_SECRET`。
- **改动**：
  - 删除 `deploy/public-demo.env` 中的明文密钥行，改为注释说明「不配置则每进程随机生成」。
  - `server/payment-gateway.js` 已默认随机，无需改逻辑；确认 `PAYMENT_MODE!==mock` 时模拟支付路由不可用（现有 `simulate` 内部已有校验，如缺失则补）。
- **验证**：仓库全量检索无该密钥字符串；`npm run test:payments` 通过（测试自带 `PAYMENT_MOCK_SECRET`）。

### P1-3 Dockerfile 固定加载演示配置
- **根因**：`Dockerfile` CMD 固定 `--env-file=deploy/public-demo.env`，任何生产部署都会带上 `AUTO_VERIFY=true` 等演示值。
- **改动**：
  - 新增 `deploy/base.env`：仅通用运行配置（`NODE_ENV=staging`、`HOST=0.0.0.0`、`DATA_DIR=./data`），不含演示/自动认证/演示密钥。
  - `Dockerfile` CMD 改为 `node --env-file=deploy/base.env server/index.js`。
  - `deploy/docker-entrypoint.sh`：当 `DEPLOY_PROFILE=public-demo` 或 `PUBLIC_DEMO=true` 时改用 `deploy/public-demo.env`；否则用 `base.env`。
  - 本地 `npm run start:public` 与手动 `--env-file deploy/public-demo.env` 行为不变。
  - 兼容说明：Node 的 `--env-file` 不覆盖平台已注入变量，Railway 现有 Variables 继续优先生效。
- **验证**：本地 `docker build` 后默认启动为通用配置；显式传 `DEPLOY_PROFILE=public-demo` 时为演示配置；Railway 部署后 `/api/health` 的 `demo` 字段与线上预期一致。

### P1-4 写接口无通用限流/配额
- **根因**：`server/rate-limit.js` 仅覆盖认证、AI、支付模拟等。
- **改动**：新增规则（均可通过环境变量覆盖）
  - 上传 `POST /api/materials`：10 次/小时。
  - 评价 `POST /api/materials/:id/reviews`：20 次/小时。
  - 工单 `POST /api/tickets`：10 次/小时。
  - 砍价助力 `POST /api/bargains/:id/assist`：60 次/分钟。
- **验证**：连续请求触发 429 并带 `Retry-After`；正常低频操作不受影响。

### P1-5 /api/metrics 公网无鉴权
- **根因**：`server/index.js` 直接返回全量聚合指标。
- **改动**：`server/index.js` `/api/metrics`
  - 配置 `METRICS_TOKEN`：校验 `Authorization: Bearer <token>` 或 `?token=`，失败 401。
  - 未配置：仅本机/私网可读全量；`PUBLIC_DEMO=true` 返回精简字段（`status`、`uptime`、`time`）；其余 403。
  - 抽公共函数 `timingSafeEqualStr` 或直接用 `crypto.timingSafeEqual` 比较摘要。
- **验证**：公网无 token 访问 403/精简；本机 200；带正确 token 200；`test:concurrency` 仍通过（本机）。

### P1-6 作品帖占位符
- **根因**：`docs/submission-post.md` 多处【】。
- **改动**：清理所有占位符：
  - 体验地址去掉「备用 http://【云主机 IP】」。
  - 灵感痛点、截图、Session ID、个人介绍改为可直接发布的定稿文字。
  - 章节结构保留，标注「截图位置」为正式表述而非【截图】。
- **验证**：全文无「【」「】」。

### P1-7 同步 I/O 阻塞
- **根因**：`create()` 使用 `fs.writeFileSync`；`update()` 使用 `fs.readFileSync`；审核文本无上限。
- **改动**：`server/api-materials.js`
  - `create()` 改为 `async`，使用 `await fs.promises.writeFile`；写盘失败返回 500 且不入库。
  - `update()` 改为 `async`，使用 `await fs.promises.readFile`。
  - `buildAuditText()` 结果截断到 200000 字符后再送审。
- **验证**：上传/修改接口正常；大文件上传不阻塞事件循环（并发测试通过）。

### P2-1 前端未懒加载
- **根因**：`public/js/app.js` 顶部静态导入全部视图。
- **改动**：改为路由级动态 `import()`；`ROUTES.view` 存加载函数或键名，`router()` 中 `await` 加载后再渲染。
- **验证**：首屏只加载 home；切换路由正常；无循环依赖和重复渲染。

### P2-2 Token 7 天
- **根因**：`server/auth.js` `TOKEN_TTL = 7 * 24 * 3600 * 1000`。
- **改动**：缩短为 24 小时；前端 `session-expired` 逻辑已存在，无需改。
- **验证**：登录返回 token 可正常使用；过期逻辑由单测覆盖。

### P2-3 缺 HSTS
- **改动**：`server/index.js` 在 HTTPS（`x-forwarded-proto=https` 或 socket 加密）时加 `Strict-Transport-Security: max-age=31536000; includeSubDomains`。
- **验证**：本地 HTTP 不发送该头；模拟 HTTPS 头存在。

### P2-4 无 busy_timeout
- **改动**：`server/db.js` 初始化加 `PRAGMA busy_timeout = 5000;`；增加每 30 分钟 `PRAGMA wal_checkpoint(TRUNCATE);`（`unref`，异常忽略）。
- **验证**：启动正常，并发写不报 SQLITE_BUSY。

### P2-5 试读比例口径不一致
- **根因**：`makePreview()` 固定 15%，`preview_ratio` 仅用于展示；`detail/preview` 返回的 `ratio` 是名义值。
- **改动**：
  - `makePreview()` 接收并使用 `previewRatio` 计算截断长度（10%—20%，200—1500 字）。
  - `materials` 新增 `content_chars` 列（`db.js` 幂等补列），`create/update` 写入原文长度。
  - `detail()` 与 `preview()` 的 `ratio` 改为实际比例（`preview_text` 有效字数 / `content_chars`，夹在 1—20）；`content_chars=0` 时回退 `preview_ratio`。
- **验证**：上传后可复算比例与展示一致；`npm test` 断言 10%—20% 仍通过。

### P2-6 facet 计数不受筛选影响
- **改动**：`server/api-materials.js` `list()` 重构过滤条件为数组 `{key, sql, params}`；主查询用全部条件，`schoolFacets/subjectFacets/teacherFacets` 分别排除自身维度后统计。
- **验证**：带 `category` 筛选时 facet 数量随筛选变化；无筛选时与原结果一致。

### P2-7 q 无上限 / LIKE 前导 % / page 无上限
- **改动**：`q` 截断 50 字符；`page` 上限 100；保留参数化查询与转义；`pageSize` 维持 1—24。
- **验证**：超长 q 与超大 page 返回正常且不报错。

### P2-8 文档口径不一 / 测试断言缺失
- **改动**：
  - `docs/submission-post.md` 与 `README.md` 统一为「十二大模块」（以管理后台实际模块为准）。
  - 删除测试数量的夸大表述（`npm test` 覆盖核心流程，不写死条数）。
- **验证**：两处文案一致；后台实际模块数一致。

### P2-9 管理员首登可自绑 TOTP
- **改动**：
  - `server/api-admin-auth.js`：生产环境（`IS_PRODUCTION`）且未配置 `ADMIN_MFA_SECRET` 时拒绝首登自绑，返回明确配置提示；非生产保持现状（演示可用）。
  - `docs/deployment.md` 补充：生产必须预置 `ADMIN_MFA_SECRET`，首登绑定仅限本地/演示。
- **验证**：非生产环境登录流程不变；生产模拟用例返回配置错误。

---

## 3. 交付物

- 代码与配置改动（上述文件）。
- `docs/review-fixes/ledger.md`：逐项整改台账（编号/根因/改动位置/验证方式/结果）。
- 回归结果：`npm test` 与公网健康检查输出摘要。

## 4. 验收标准

1. 19 项问题全部有对应改动或明确说明（如 P0-3 需用户决定仓库可见性）。
2. `npm test` 全部通过；核心流程测试（audit/payments/role/production）通过。
3. 演示环境上传即上架；非演示仍待审核。
4. `/api/metrics` 公网不可匿名读取全量指标。
5. 推送 `main` 后 Railway 自动部署成功，`/api/health` 正常。

## 5. 风险与回滚

- **P1-3 风险**：若 Railway 未按文档注入 `DEPLOY_PROFILE=public-demo`，容器将使用通用配置。通过 `/api/health.demo` 验证；如为 false，需在 Railway Variables 补 `DEPLOY_PROFILE=public-demo`（用户侧操作），台账标注。
- **P1-1 风险**：旧资料 school/subject 可能不在资源库。仅校验新写入，历史数据允许查询（列表不做强校验）。
- **P2-2 风险**：Token 缩短会使旧 token 在 24h 后失效，属预期。
- 回滚：单次提交粒度按问题分组，可 `git revert` 对应提交；数据库仅新增列，无破坏性迁移。
