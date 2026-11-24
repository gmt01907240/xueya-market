# 评审问题整改台账

> 对应规格：`docs/review-fixes/spec.md`；任务：`docs/review-fixes/tasks.md`。
> 实施日期：2026-11-24。语言：中文。

## 一、P0 阻断项

### P0-1 公开演示上传后永远待审核
- 根因：`server/api-materials.js` 的 `create()` 固定写 `status='pending'`，而演示环境管理后台被 IP 白名单关闭，无人可审核。
- 改动：`server/api-materials.js`
  - `create()`：状态取 `runtime.PUBLIC_DEMO ? 'approved' : 'pending'`（约 L486）。
  - `update()`：编辑后状态同规则（约 L592）。
  - `auditMessage(result, demo)`：演示环境返回「免人工审核，已直接上架」。
- 验证：`PUBLIC_DEMO=true` 实例上传 → 详情 `status=approved`，提示语正确；非演示实例（audit-flow）仍为 `pending`。
- 结果：通过。

### P0-2 作品帖公开管理员账号但后台不可达
- 根因：`docs/submission-post.md` 公开管理员账号密码，但演示环境 `ADMIN_IP_ALLOWLIST=192.0.2.1/32` 使后台公网不可入。
- 改动：删除管理员账号行，改为「管理后台默认不对外开放，如需查看可提供演示视频/录屏」。
- 验证：全文检索无 `admin@xueya.cn`、无 `Admin123456`。
- 结果：通过。

### P0-3 源码私有导致评委不可查验
- 根因：README 与作品帖表述为私有仓库。
- 改动：`README.md`、`docs/submission-post.md` 统一为「可申请只读访问，评审通过临时协作者查看；赛后公开」。
- 验证：两处文案一致。
- 结果：代码侧完成。**待用户操作**：按需为评审开通仓库只读/临时协作者权限。

## 二、P1 安全与稳定性

### P1-1 school / subject 未校验资源库
- 根因：仅校验非空。
- 改动：`server/api-materials.js` 引入 `SCHOOLS`、`SUBJECTS` 并建立集合；`create()`/`update()` 要求院校命中 `SCHOOLS`、学科命中 `SUBJECTS`，`course` ≤ 40。
- 验证：伪造值返回 400；`audit-flow`、`role-flow`、`production-flow` 全部通过（`role-flow` 测试数据学科改为资源库中的「数学」）。
- 结果：通过。

### P1-2 模拟支付密钥硬编码
- 根因：`deploy/public-demo.env` 写入固定 `PAYMENT_MOCK_SECRET`。
- 改动：删除明文密钥，改为注释「未配置则每进程随机生成；多实例共享时由部署变量注入」。
- 验证：全仓检索无原密钥；`test:payments`、`test:production` 通过；`simulate` 路由已有 `MODE!=mock` 拦截。
- 结果：通过。

### P1-3 Dockerfile 固定加载演示配置
- 根因：CMD 固定 `--env-file=deploy/public-demo.env`，任何生产部署都会带入 `AUTO_VERIFY` 等演示开关。
- 改动：
  - 新增 `deploy/base.env`（仅 `NODE_ENV=staging`、`HOST`、`DATA_DIR`）。
  - `Dockerfile` 移除固定 CMD，由入口脚本选择配置。
  - `deploy/docker-entrypoint.sh`：默认 `base.env`；`DEPLOY_PROFILE=public-demo` 或 `PUBLIC_DEMO=true` 时改用 `public-demo.env`。
  - `docs/deployment.md` 同步生产/演示配置说明。
- 验证：Node `--env-file` 不覆盖平台注入变量；`/api/health` 新增 `demo` 字段可用于部署后确认。
- 结果：代码侧通过。**上线后需确认** Railway 已注入 `DEPLOY_PROFILE=public-demo`，否则 `/api/health.demo` 为 false（见第五节）。

### P1-4 写接口无通用限流/配额
- 根因：限流规则只覆盖认证、AI、支付模拟等。
- 改动：`server/rate-limit.js` 新增：
  - 上传 20 次/小时（`RATE_LIMIT_UPLOAD`）
  - 评价 20 次/小时（`RATE_LIMIT_REVIEW`）
  - 工单 10 次/小时（`RATE_LIMIT_TICKET`）
  - 砍价助力 60 次/分钟（`RATE_LIMIT_BARGAIN_ASSIST`）
- 验证：规则按 IP 计数，超限返回 429 + `Retry-After`；全部流程测试未误伤。
- 结果：通过。

### P1-5 /api/metrics 公网无鉴权
- 根因：匿名可直接读取全量聚合指标。
- 改动：`server/index.js`
  - 配置 `METRICS_TOKEN` 时校验 `Authorization: Bearer` 或 `?token=`，失败 401（定时安全比较）。
  - 未配置时：本机/私网返回全量；`PUBLIC_DEMO` 返回精简字段；其余 403。
- 验证：公网模拟（`X-Forwarded-For: 8.8.8.8`）返回仅 `service/status/uptime/time`；本机返回全量；`test:concurrency` 通过。
- 结果：通过。

### P1-6 作品帖占位符
- 根因：多处【】未定稿。
- 改动：`docs/submission-post.md` 全量重写为可发布定稿；配图与 Session ID 以「发布时插入」「见 TRAE 任务历史」明确标注。
- 验证：全文无「【」「】」。
- 结果：通过。

### P1-7 同步 I/O 阻塞
- 根因：`fs.writeFileSync` / `fs.readFileSync`；审核文本无上限。
- 改动：`server/api-materials.js`
  - `create()` 改 `async` + `fs.promises.writeFile`，失败返回 500 且不入库。
  - `update()` 改 `async` + `fs.promises.readFile`。
  - `buildAuditText()` 截断至 200000 字符。
- 验证：上传/编辑、内容审核、并发测试全部通过。
- 结果：通过。

## 三、P2 优化

### P2-1 前端未懒加载
- 改动：`public/js/app.js` 静态导入改为 `VIEW_LOADERS` 路由级 `import()`；渲染前校验路由序列与 `AbortSignal`。
- 验证：各视图路由测试与发布流程通过；首屏仅加载 home 模块。
- 结果：通过。

### P2-2 Token 7 天
- 改动：`server/auth.js` `TOKEN_TTL` 改为 24 小时；`tests/auth-unit.test.cjs` 断言同步更新。
- 验证：`test:unit`、`test:auth` 通过。
- 结果：通过。

### P2-3 缺 HSTS
- 改动：`server/index.js` HTTPS（socket 加密或 `x-forwarded-proto=https`）下添加 `Strict-Transport-Security: max-age=31536000; includeSubDomains`。
- 验证：带 `X-Forwarded-Proto: https` 的请求返回该头；纯 HTTP 不返回。
- 结果：通过。

### P2-4 无 busy_timeout
- 改动：`server/db.js` 增加 `PRAGMA busy_timeout = 5000`，并每 30 分钟执行 `PRAGMA wal_checkpoint(TRUNCATE)`（`unref`，异常忽略）。
- 验证：全部流程与并发测试通过。
- 结果：通过。

### P2-5 试读比例口径不一致
- 改动：`server/api-materials.js`、`server/db.js`
  - `makePreview()` 使用卖家选择的 `previewRatio`（10%—20%，200—1500 字）。
  - 新增 `materials.content_chars` 列，创建/更新时写入原文长度。
  - `detail()`、`preview()`、`serialize()` 统一返回按实际字数计算的比例（1%—20%，无总字数时回退设定值）。
- 验证：上传样例返回 `ratio=20`（短文档按上限收敛）、`content_chars` 可复算；`npm test` 比例区间断言通过。
- 结果：通过。

### P2-6 facet 计数不受筛选影响
- 改动：`server/api-materials.js` `list()` 将筛选条件结构化为 `{key,sql,params}`；院校/学科/老师分面分别排除自身维度后统计。
- 验证：按分类筛选后分面数量与总数联动；无筛选时与原逻辑一致。
- 结果：通过。

### P2-7 q 无上限 / LIKE 前导 % / page 无上限
- 改动：`q` 截断 50 字符；`page` 上限 100；继续使用参数化查询与 `pageSize` 1—24。
- 验证：`page=99999` 返回 `page=100`；超长 `q` 正常返回。
- 结果：通过。

### P2-8 文档口径不一
- 改动：`docs/submission-post.md` 与 `README.md` 统一为「十二大模块」；删除固定测试条数表述。
- 验证：两处均为十二大模块；后台模块列表一致。
- 结果：通过。

### P2-9 管理员首登可自绑 TOTP
- 改动：
  - `server/api-admin-auth.js`：生产环境未配置 `ADMIN_MFA_SECRET` 时拒绝首登自绑并提示配置。
  - `docs/deployment.md`：生产必须预置 `ADMIN_MFA_SECRET`，首登绑定仅限本地/演示。
- 验证：非生产登录流程不变（`test:admin`、`test:auth` 通过）；生产分支为显式错误返回。
- 结果：通过。

## 四、回归测试结果

| 套件 | 结果 |
| --- | --- |
| `npm test`（只读冒烟） | 21 通过 |
| `test:unit` | 通过 |
| `test:data` | 通过 |
| `test:audit` | 通过（非演示仍为 pending） |
| `test:role` | 通过 |
| `test:payments` | 通过 |
| `test:permissions` | 通过 |
| `test:admin` | 通过 |
| `test:concurrency` | 通过 |
| `test:production` | 通过 |
| `test:auth` / `test:verify` / `test:phone` | 通过 |
| `test:chat` / `test:bargain` | 通过 |
| `test:catalog` / `test:plan` | 通过 |
| `test:release` | 22 通过，0 失败 |

针对性验证（演示实例 3311）：
- 上传返回 201 且提示「演示环境免人工审核，已直接上架」，详情 `status=approved`。
- 匿名公网指标仅返回 `service/status/uptime/time`；本机返回全量。
- `X-Forwarded-Proto: https` 返回 HSTS。
- `page=99999` 被收敛为 100；分面计数随分类筛选变化。

## 五、上线验证（2026-11-24）

- 提交 `2f5f3d1` 已推送 `main`，Railway 自动构建并上线。
- `GET /api/health` 返回 `demo:true`，确认 `DEPLOY_PROFILE=public-demo` 已生效，演示行为保持不变。
- 公网匿名 `GET /api/metrics` 仅返回 `service/status/uptime/time`，全量指标不再公开。
- `https` 响应包含 `Strict-Transport-Security: max-age=31536000; includeSubDomains`。
- 线上实测：演示卖家上传返回 201「演示环境免人工审核，已直接上架」，详情 `status=approved`；验证后已删除临时资料。

## 六、遗留事项

1. P0-3 仓库可见性需用户按评审要求开通只读访问或临时协作者权限。
2. Token 有效期改为 24 小时，旧登录态会在到期后失效，属预期。
