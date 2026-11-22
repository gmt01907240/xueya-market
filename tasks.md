# 管理员身份认证加固 · 实施任务

> 依据 `spec.md` 执行。每项完成后勾选并记录验证结果。

## T1 安全基础模块

- [x] 新建 `server/admin-security.js`
  - base32、HOTP/TOTP、otpauth、密码策略、历史校验、IP 段、设备指纹、事件/告警/审计写入
  - 常量与演示凭据 (`ADMIN_PASSWORD = 'XyOps@2026#Secure'`)，不提供固定演示 MFA secret
- 验证：`node -e "const s=require('./server/admin-security'); ..."` 计算 TOTP 与 RFC 测试向量一致

## T2 令牌与运行时配置

- [x] `server/auth.js`：`signToken(payload|uid, ttl)`，导出 `TOKEN_TTL`
- [x] `server/runtime-config.js`：CIDR 白名单 + 默认私有网段
- 验证：单元脚本断言 `127.0.0.1`、`192.168.1.20` 命中默认段，`8.8.8.8` 拒绝；`10.0.0.0/8` 匹配

## T3 数据库迁移与种子

- [x] `server/db.js`：新增 5 张表 + users 8 列
- [x] 管理员强密码、MFA secret、密码历史、`admin_password_changed_at`
- [x] `ensureAdminSecuritySeed()` 迁移旧库弱密码
- 验证：临时 DATA_DIR 启动后查询 `users`、`admin_password_history` 字段完整

## T4 管理员认证 API

- [x] 新建 `server/api-admin-auth.js`：login / mfa / password / status / security 查询
- [x] 限流规则（login 10/min、mfa 10/min、password 5/5min）
- 验证：用 TOTP 完成两步登录，错误路径返回 401/403/423

## T5 服务端接入与审计

- [x] `server/index.js`：注册路由、`resolveAuth`、admin scope + token_version + IP 校验、审计 finish 钩子、专属入口静态页
- [x] `server/api-auth.js`：普通登录拒绝管理员、普通改密拒绝管理员
- 验证：普通 token 访问后台 403；管理员 token 访问后台 200 且审计表新增记录

## T6 专属登录页

- [x] `public/admin-login.html`（内联样式、noindex、无站内链接）
- [x] `public/js/admin-login.js`（密码→MFA→首次绑定→密码过期→跳转后台）
- [x] `public/js/layout.js`：DEMO 仅保留个人用户
- 验证：浏览器访问 `/ops-login` 完成全流程，页面无外链

## T7 后台安全中心

- [x] 新增 `public/js/views/admin-security.js`
- [x] `public/js/views/admin.js` 增加 `security` 页签与绑定
- 验证：后台可见告警、安全事件、审计日志，告警可确认

## T8 测试与文档

- [x] 新增 `tests/admin-login-helper.mjs`、`tests/admin-security.mjs`（§6 全部断言）
- [x] 更新 9 个既有测试的管理员登录方式与环境变量
- [x] `package.json` 增加 `test:admin`
- [x] `README.md` 补充安全配置说明
- 验证：`npm run test:admin` 全绿；既有测试全绿

## T9 全量回归

- [x] 重启 3300 服务（加载新代码）
- [x] 运行 spec §7 全部命令
- [x] 浏览器验证 `/ops-login`、MFA、锁定、后台安全中心、普通用户登录
- 验收：spec §6 共 11 条断言全部通过，无既有功能回归
