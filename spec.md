# 管理员身份认证加固 · 技术规格

> 项目：`campus-market`（学涯集市，零 npm 依赖，Node 26，原生 ESM 前端 + CommonJS 后端，SQLite）
> 目标：落实 7 项管理员认证硬性要求，且不破坏现有用户登录、交易与后台功能。

## 1. 现状与缺口

| 现状 | 风险 |
| --- | --- |
| 管理员与普通用户共用 `/api/auth/login`，签发的均是 7 天通用 token | 管理员身份无二次校验，token 被盗即长期可用 |
| 管理员密码为 `Admin123456`（弱密码，且出现在前端演示按钮中） | 字典攻击即可命中 |
| `runtime.adminAllowed()` 仅支持精确 IP 匹配，未配置时放行全部来源 | 无法形成 IP 白名单 |
| 后台接口仅校验 `user.role === 'admin'`，无独立 scope / token 版本 | 普通 token 与管理员 token 无边界 |
| 无 MFA、无锁定、无设备识别、无管理员审计表 | 无法告警与事后追溯 |

## 2. 总体设计

### 2.1 双通道认证
- 普通用户：保持 `/api/auth/login`，签发 `{ uid, exp }`，TTL 7 天。
- 管理员：仅允许 `/api/admin/auth/login` → `/api/admin/auth/mfa` 两步，签发
  `{ uid, adm: 1, v: <token_version>, exp }`，TTL 2 小时。
- 中间态 token（均由 HMAC 签名，不可伪造）：
  - `adm: 'mfa'`：密码已通过、待二次验证，TTL 5 分钟；
  - `adm: 'pwd'`：MFA 已通过但密码过期，仅可调用改密接口，TTL 10 分钟。
- `index.js` 的 `admin: true` 路由强制要求 `payload.adm === 1` 且
  `payload.v === users.token_version`；否则 403/401。

### 2.2 MFA（TOTP）
- RFC 6238：HMAC-SHA1、6 位、30 秒步长、校验窗口 ±1。
- base32 编解码、HOTP/TOTP、otpauth URL 全部用 `node:crypto` 自实现，无第三方依赖。
- secret 来源优先级：`ADMIN_MFA_SECRET` 环境变量 → 数据库已存 `admin_mfa_secret` → 首次登录时随机生成。
- 首次绑定：密码校验通过且尚无 secret 时，服务端生成 secret 并在 `stage:'enroll'` 响应中一次性展示
  secret 与 otpauth 链接（仅此一次，后续登录不再返回）；提交正确动态码后写入 `admin_mfa_enabled_at`。
- 生产环境强烈建议配置 `ADMIN_MFA_SECRET`；未配置时依赖首次绑定流程。
- 重放保护：`users.admin_mfa_last_step` 记录已用步长，code 对应步长 ≤ 上次值即拒绝。
- 所有管理员登录都必须经过 MFA，不区分新老设备。
- **任何响应（含非生产环境）都不返回当前 TOTP 动态码**；测试在代码内用同一 secret 独立计算。

### 2.3 专属登录入口
- 路径由 `ADMIN_LOGIN_PATH` 控制，默认 `/ops-login`。
- 命中该路径时直接返回 `public/admin-login.html`，不经过站点静态回退逻辑；响应头
  `X-Robots-Tag: noindex, nofollow`。
- 页面内联样式与脚本，无任何站内导航、页脚、注册/找回密码链接；登录成功后写入
  localStorage `xueya_token` 并跳转 `/#/admin`。
- 普通登录接口对 `role === 'admin'` 返回 403，文案统一为
  “管理员账号请通过内部安全入口登录”，不泄露专属路径。
- 前端普通登录弹窗删除管理员演示按钮（`DEMO` 仅保留个人用户）。

### 2.4 风险拦截与告警
| 规则 | 阈值 | 处置 |
| --- | --- | --- |
| 密码连续错误 | 5 次 | 锁定 15 分钟，写安全事件 + 告警 |
| MFA 连续错误 | 3 次 | 锁定 15 分钟，写安全事件 + 告警 |
| 新设备（UA + IP 段指纹） | 首次 | 写事件 + 告警；本次登录仍强制 MFA |
| 新 IP 段（IPv4 /24、IPv6 /48） | 首次 | 写事件 + 告警 |
| 密码过期（>90 天） | — | 只签发 `adm:'pwd'` token，强制先改密 |

告警写入 `admin_alerts`；若配置 `ADMIN_ALERT_WEBHOOK`，异步 POST JSON 到 webhook（失败仅记日志，不影响登录）。

### 2.5 IP 白名单
- `runtime-config.js` 升级 `adminAllowed(ip)`：支持 `IP` 与 `CIDR`（IPv4/IPv6），逗号分隔。
- 未配置 `ADMIN_IP_ALLOWLIST` 时默认仅放行：`127.0.0.0/8`、`::1/128`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`fc00::/7`。
- 配置后严格按列表匹配；适配 `::ffff:` 映射地址。
- 管理员登录（密码阶段与 MFA 阶段）和所有 `admin` 路由均校验白名单。

### 2.6 密码策略
- 长度 12—72；必须同时含大写、小写、数字、符号。
- 禁止：常见弱密码表（`admin123456`、`password`、`qwerty...` 等）、包含用户名或邮箱 @ 前片段、4 个以上连续重复字符。
- 历史：`admin_password_history` 保留最近 20 条，校验最近 5 条 + 当前密码，禁止复用。
- 有效期 90 天；`admin_password_changed_at` 为空视为过期。
- 演示种子管理员迁移为强密码 `XyOps@2026#Secure`（满足全部规则），并写入历史。

### 2.7 审计
- 所有 `route.admin` 请求在 `res.on('finish')` 写 `admin_audit_logs`：
  `admin_id`、`admin_name`、`method`、`path`、`status`、`ip`、`ua`、`duration_ms`、`detail`、`created_at`。
  `detail` 为 query + params + 脱敏 body（移除 password/code/secret/token，截断 2KB）。
- 登录成功/失败、锁定、MFA 失败、改密、新设备等写 `admin_security_events`。
- 后台新增“安全中心”页签展示告警、安全事件、审计日志与账号安全状态。

## 3. 文件级变更

### 3.1 新增 `server/admin-security.js`
纯函数 + 数据访问（`require('./db')` 延迟加载，避免循环依赖）：
- `base32Encode/base32Decode/generateMfaSecret`
- `hotp(secret, counter)`、`totp(secret, timestamp)`、`totpStep(timestamp)`、`verifyTotp(secret, code, { window, timestamp })`
- `otpauthUrl({ account, secret, issuer })`
- `adminPasswordProblem(password, { username, email })`、`isPasswordReused(adminId, password)`、`passwordExpired(changedAt)`
- `ipPrefix(ip)`、`deviceFingerprint(adminId, ua, ip)`
- `recordEvent(adminId, type, { ip, ua, stage, detail })`
- `raiseAlert(adminId, type, message, { level, ip, ua, detail })`（内部调用 webhook）
- `writeAudit(adminId, adminName, entry)`、`sanitizeDetail(...)`
- `ADMIN_PASSWORD`（演示强密码导出，供 db 种子复用）
- 常量：`MFA_STEP=30`、`FAIL_LIMIT=5`、`MFA_FAIL_LIMIT=3`、`LOCK_MS=15min`、`PASSWORD_HISTORY=5`、`PASSWORD_MAX_AGE_DAYS=90`

### 3.2 修改 `server/auth.js`
- `signToken(userIdOrPayload, ttl = TOKEN_TTL)`：对象 payload 原样合并 `exp`，数字保持旧行为。
- `verifyToken` 保持校验逻辑与返回值。
- 导出 `TOKEN_TTL`、`signToken`、`verifyToken`、`hashPassword`、`verifyPassword`。

### 3.3 修改 `server/runtime-config.js`
- 用 `node:net` 实现 `parseAllowEntry` / `ipInCidr` / `ipToBigInt`。
- `adminAllowed(ip)`：白名单为空时匹配默认私有网段；否则逐一匹配，非法 IP 一律拒绝。
- `info().adminAllowlist` 保持布尔语义。

### 3.4 修改 `server/db.js`
- `SCHEMA` 增加 5 张表与索引（见 §4）。
- `init()` 用 `ensureColumn` 补 users 8 个字段；调用 `ensureAdminSecuritySeed()`。
- `seed()` 中管理员改用 `ADMIN_PASSWORD`，并写入 `admin_password_changed_at`、密码历史；
  MFA secret 留空（或由 `ADMIN_MFA_SECRET` 注入），首次登录走绑定流程。
- `ensureAdminSecuritySeed()`：旧库管理员若仍为 `Admin123456`（或缺少安全字段）则迁移为强密码、
  写入历史；仅当配置了 `ADMIN_MFA_SECRET` 时才写入 secret，否则保持空值走首次绑定流程。
- 导出保持不变。

### 3.5 新增 `server/api-admin-auth.js`
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/auth/login` | 密码阶段；IP 白名单 → 锁定检查 → 校验密码 → 新设备/新网段告警 → 未绑定则返回 `stage:'enroll'`，否则 `stage:'mfa'` |
| POST | `/api/admin/auth/mfa` | 校验 mfaToken + TOTP + 重放 + 锁定；成功签发 `adm:1` 或 `adm:'pwd'` |
| POST | `/api/admin/auth/password` | 需 `adm:1` 或 `adm:'pwd'` token + 旧密码 + TOTP；策略/历史校验；`token_version++` |
| GET | `/api/admin/auth/status` | 需 `adm:1`；返回 MFA、密码期限、锁定状态 |
| GET | `/api/admin/security/overview` | 告警/事件/审计计数与最近记录 |
| GET | `/api/admin/security/events` | 分页安全事件 |
| GET | `/api/admin/security/alerts` | 分页告警 |
| POST | `/api/admin/security/alerts/:id/ack` | 标记告警已处理 |
| GET | `/api/admin/security/audit` | 分页审计日志 |

所有响应（包括非生产环境）都不返回当前 TOTP 动态码；首次绑定时返回的 secret 仅在密码校验通过后的本次响应中出现。

### 3.6 修改 `server/index.js`
- 引入 `adminSecurity`、`adminAuthApi`，注册 §3.5 路由（均不带 `admin` 标记，鉴权在模块内完成）。
- `resolveAuth(req)` 返回 `{ user, payload }`；`admin` 路由校验：
  `payload.adm === 1`、`payload.v === user.token_version`、`user.role === 'admin'`、`runtime.adminAllowed(ip)`。
- `admin` 路由注册 `res.on('finish')` 写审计日志（含耗时、IP、UA、脱敏 body）。
- 静态层拦截 `ADMIN_LOGIN_PATH` 返回 `public/admin-login.html`，并设置 `X-Robots-Tag`。
- 启动日志提示专属入口路径（仅本地控制台，不进入页面）。

### 3.7 修改 `server/api-auth.js`
- `login()`：密码校验通过后若 `user.role === 'admin'` 返回 403 专用入口提示；密码错误仍返回通用 401。
- `changePassword()`：管理员返回 403，指向专用改密流程。
- 其他逻辑不变。

### 3.8 新增 `public/admin-login.html` + `public/js/admin-login.js`
- 内联 CSS，独立深色安全页；`<meta name="robots" content="noindex,nofollow">`。
- 步骤：账号密码 → MFA 动态码（含首次绑定 secret/otpauth 展示）→ 密码过期改密 → 成功跳转。
- 错误提示、锁定倒计时、限流提示；提交按钮防重复点击；不引用站点导航或 logo 链接。

### 3.9 修改 `public/js/layout.js`
- `DEMO` 仅保留 `student@xueya.cn`。
- 演示区文案改为“个人用户登录后可买卖一体化”，不再出现管理员账号。

### 3.10 修改 `public/js/views/admin.js` + 新增 `public/js/views/admin-security.js`
- `TABS` 增加 `['security', '安全中心', 'shield']`。
- `securityContent(ctx)` 渲染：账号安全状态卡、告警列表（可确认）、安全事件表、审计日志表。
- `bindSecurity(root, ctx, rerender)` 绑定告警确认。

### 3.11 测试
- 新增 `tests/admin-login-helper.mjs`：独立 TOTP 实现 + `adminLogin(base, opts)`。
- 新增 `tests/admin-security.mjs`：覆盖 §6 全部断言。
- 更新 `tests/{smoke,audit-flow,bargain-flow,catalog-ai-flow,payment-flow,production-flow,role-flow,verify-flow,release-flow}.mjs`：
  管理员登录改用专用 API + TOTP；服务启动参数补 `ADMIN_MFA_SECRET`、`ADMIN_IP_ALLOWLIST`。
- `package.json` 增加 `"test:admin": "node tests/admin-security.mjs"`。
- `README.md` 补充安全配置、管理员入口、MFA 绑定、演示账号说明。

## 4. 数据库变更（精确 DDL）

users 追加列：

```sql
admin_mfa_secret TEXT NOT NULL DEFAULT ''
admin_mfa_enabled_at TEXT
admin_mfa_last_step INTEGER NOT NULL DEFAULT 0
admin_password_changed_at TEXT
admin_fail_count INTEGER NOT NULL DEFAULT 0
admin_mfa_fail_count INTEGER NOT NULL DEFAULT 0
admin_lock_until INTEGER NOT NULL DEFAULT 0
token_version INTEGER NOT NULL DEFAULT 0
```

新增表：

```sql
CREATE TABLE IF NOT EXISTS admin_password_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  ua TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  ip_prefix TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE(admin_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS admin_security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  type TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'warning',
  message TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  admin_name TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
```

## 5. 状态码与响应约定

- `401` 账号/密码错误、TOTP 错误、token 失效（统一模糊文案）。
- `403` 非白名单 IP、非管理员账号、普通 token 访问后台、管理员走普通登录。
- `423` 账号锁定，附带 `retryAfter`（秒）与 `lockUntil`。
- `429` 接口限流。
- 成功登录响应绝不包含当前 TOTP 动态码；首次绑定的 secret 仅返回一次。

## 6. 验收断言

1. `GET /ops-login` 返回 200 且含 `noindex`，页面无站内链接。
2. 普通 `/api/auth/login` 登录管理员 → 403，且响应文本不包含 `/ops-login`。
3. 错误密码 5 次 → 423 锁定并产生 `login_locked` 告警；重置锁定后可继续。
4. 正确密码且未绑定 MFA → `stage:'enroll'` 一次性返回 secret；正确绑定后 `admin_mfa_enabled_at` 写入。
5. 已绑定后正确密码 → `stage:'mfa'`，无可用后台 token；错误 TOTP 3 次 → 锁定 + 告警。
6. 正确 TOTP → 获得 token，可访问 `/api/admin/overview`；同一 code 再次提交被拒绝（重放保护）。
7. 普通用户 token / mfaToken 访问后台 → 403。
8. `ADMIN_IP_ALLOWLIST` 不含 127.0.0.1 时登录 → 403。
9. 弱密码、含账号片段、历史密码改密全部被拒绝；强密码改密成功；旧 token 立即失效。
10. 审计日志存在至少一条包含 IP、UA、method、path 的管理员请求记录。
11. 更换 UA 再登录 → 产生 `new_device` 告警。
12. 任意成功/失败响应均不含 6 位动态码字段。
13. 既有全量测试通过，普通用户登录与交易流程无回归。

## 7. 验证命令

```bash
npm run test:unit
npm run test:data
npm run test:admin
npm test
npm run test:auth
npm run test:phone
npm run test:role
npm run test:payments
npm run test:audit
npm run test:bargain
npm run test:catalog
npm run test:production
npm run test:release
```

服务重启后浏览器验证 `/ops-login`：错误密码锁定提示、TOTP 登录、进入后台、安全中心可见告警与审计。
