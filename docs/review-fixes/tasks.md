# 学涯集市 · 评审问题整改任务清单（tasks）

> 依赖顺序：P0 文档与上传链路 → P1 安全与稳定性 → P2 优化 → 回归与发布。
> 每完成一项，更新 `docs/review-fixes/ledger.md` 并做针对性验证。

## 阶段 A：P0 阻断项

- [x] **A1（P0-1）演示环境上传自动上架**
  - 文件：`server/api-materials.js`
  - `create()` / `update()` 状态按 `runtime.PUBLIC_DEMO` 选择 `approved` / `pending`；演示文案说明免人工审核。
  - 验证：临时 `PUBLIC_DEMO=true` 实例上传后详情 `status=approved`；普通实例仍 `pending`。
  - 依赖：无。

- [x] **A2（P0-2）作品帖移除管理员账号**
  - 文件：`docs/submission-post.md`
  - 删除管理员账号密码行，改为后台不对外开放说明。
  - 验证：检索无管理员密码。

- [x] **A3（P0-3）源码可见性口径统一**
  - 文件：`README.md`、`docs/submission-post.md`
  - 统一为「可申请只读访问 / 赛后公开」。
  - 验证：两处一致。

## 阶段 B：P1 安全与稳定性

- [x] **B1（P1-1）院校/学科/课程校验**
  - 文件：`server/api-materials.js`
  - 引入 `SCHOOLS`、`SUBJECTS` 校验；`course` ≤ 40。
  - 验证：伪造值 400；正常上传 201；相关测试通过。
  - 依赖：A1（同文件改动，建议合并实施但分开提交）。

- [x] **B2（P1-2）移除演示环境明文支付密钥**
  - 文件：`deploy/public-demo.env`
  - 删除 `PAYMENT_MOCK_SECRET` 明文行，改为注释。
  - 验证：全仓检索无该密钥；支付测试通过。
  - 依赖：无。

- [x] **B3（P1-3）容器默认加载安全配置**
  - 文件：`deploy/base.env`（新增）、`Dockerfile`、`deploy/docker-entrypoint.sh`、`docs/deployment.md`
  - 默认 `base.env`；`DEPLOY_PROFILE=public-demo` 时使用演示配置；`/api/health` 增加 `demo` 字段。
  - 验证：本地两种 profile 启动行为正确；部署后健康检查确认。
  - 依赖：B2（演示配置拆分）。

- [x] **B4（P1-4）写接口限流**
  - 文件：`server/rate-limit.js`
  - 新增上传/评价/工单/助力四类规则，环境变量可覆盖。
  - 验证：高频触发 429 + `Retry-After`。
  - 依赖：无。

- [x] **B5（P1-5）指标端点鉴权**
  - 文件：`server/index.js`
  - `METRICS_TOKEN` 校验；未配置时本机/私网全量，演示环境精简，其余 403。
  - 验证：公网匿名 403/精简；本机与带 token 200；并发测试通过。
  - 依赖：B3（演示判断）。

- [x] **B6（P1-6）作品帖占位符清理**
  - 文件：`docs/submission-post.md`
  - 去除全部【】占位，改为可发布定稿。
  - 验证：全文无【】。
  - 依赖：A2（同文件）。

- [x] **B7（P1-7）异步文件 I/O 与审核截断**
  - 文件：`server/api-materials.js`
  - `create/update` 改 async 文件读写；审核文本截断 200000 字符。
  - 验证：上传/修改正常；并发测试通过。
  - 依赖：B1（同文件）。

## 阶段 C：P2 优化

- [x] **C1（P2-1）前端路由懒加载**
  - 文件：`public/js/app.js`
  - 静态导入改动态 `import()`。
  - 验证：路由切换正常，首屏仅加载 home。
  - 依赖：无。

- [x] **C2（P2-2）Token 有效期缩短**
  - 文件：`server/auth.js`
  - `TOKEN_TTL` 7 天 → 24 小时。
  - 验证：登录与鉴权正常。
  - 依赖：无。

- [x] **C3（P2-3）HSTS**
  - 文件：`server/index.js`
  - HTTPS 请求添加 HSTS 头。
  - 验证：HTTP 无、HTTPS 有。
  - 依赖：B5（同文件）。

- [x] **C4（P2-4）SQLite busy_timeout 与 WAL checkpoint**
  - 文件：`server/db.js`
  - `PRAGMA busy_timeout=5000`；30 分钟 `wal_checkpoint(TRUNCATE)`。
  - 验证：启动正常，并发写通过。
  - 依赖：无。

- [x] **C5（P2-5）试读比例按实际字数**
  - 文件：`server/api-materials.js`、`server/db.js`
  - `makePreview` 使用 `previewRatio`；新增 `content_chars` 列；`detail/preview` 返回实际比例。
  - 验证：比例可复算且落在 10%—20%；`npm test` 通过。
  - 依赖：B7（同文件）、C4（同库迁移）。

- [x] **C6（P2-6）facet 计数复用筛选条件**
  - 文件：`server/api-materials.js`
  - 过滤条件结构化，facet 排除自身维度。
  - 验证：筛选后 facet 数量变化正确。
  - 依赖：C5（同文件）。

- [x] **C7（P2-7）q / page 边界**
  - 文件：`server/api-materials.js`
  - `q` ≤ 50；`page` ≤ 100。
  - 验证：边界请求正常。
  - 依赖：C6（同文件）。

- [x] **C8（P2-8）模块口径统一**
  - 文件：`docs/submission-post.md`、`README.md`
  - 统一「十二大模块」；删除固定测试条数。
  - 验证：文案一致。
  - 依赖：B6（同文件）。

- [x] **C9（P2-9）管理员 MFA 预置策略**
  - 文件：`server/api-admin-auth.js`、`docs/deployment.md`
  - 生产未预置 `ADMIN_MFA_SECRET` 时禁止首登自绑；文档说明。
  - 验证：非生产不变；生产返回配置错误。
  - 依赖：无。

## 阶段 D：回归与发布

- [x] **D1** 运行 `npm test`、`npm run test:unit`、`test:audit`、`test:payments`、`test:role`、`test:production`、`test:concurrency`，记录结果。
- [x] **D2** 本地验证演示上传自动上架与指标鉴权。
- [x] **D3** 编写 `docs/review-fixes/ledger.md` 整改台账。
- [ ] **D4** 按问题分组提交；启动本地代理后推送 `main`，等待 Railway 自动部署，复查 `/api/health` 与关键接口。
- [ ] **D5** 关闭代理，输出整改与回归摘要。

## 备注

- P0-3 的仓库可见性最终由用户决定；代码侧只统一文案并在台账标注「待用户操作」。
- 若 Railway 未注入 `DEPLOY_PROFILE=public-demo`，部署后 `/api/health.demo` 为 false，需用户在 Railway Variables 补充；台账记录该依赖。
