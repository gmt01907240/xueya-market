# 系统架构设计

## 一、设计目标

1. **可运行**：单机 `npm start` 即可完整体验，不依赖外部服务。
2. **可理解**：零框架、零构建、无隐藏魔法，评审与后续开发者可直接阅读源码。
3. **可演进**：数据层、鉴权、文件存储与支付均为明确边界，便于逐项替换为生产级方案。
4. **可运维**：单进程、单数据库文件、健康检查、幂等迁移、可整体备份。

## 二、总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        浏览器（原生 SPA）                     │
│  index.html → app.js（Hash 路由）→ layout.js / views/*        │
│  统一 api.js：fetch + Bearer Token + 错误提示                  │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTPS / JSON
┌───────────────────────────▼─────────────────────────────────┐
│                    node:http 单进程服务                       │
│                                                             │
│  index.js  路由表（路径段精确匹配）                            │
│     │                                                       │
│     ├── 静态资源（public/，含 SPA 回退）                       │
│     ├── /api/health  健康检查                                │
│     ├── 鉴权：auth.js 签发/校验 HMAC Token                    │
│     ├── 守卫：guard.js 登录 / 管理员 / 认证状态                 │
│     └── 业务 API（api-*.js）                                 │
│             │                                               │
│      ┌──────┴────────┐                                      │
│      ▼               ▼                                      │
│  SQLite (WAL)   本地文件存储 data/uploads                     │
│  data/xueya.db                                              │
└─────────────────────────────────────────────────────────────┘
```

### 模块职责

| 模块 | 职责 |
| --- | --- |
| `server/index.js` | 路由注册、静态服务、错误兜底、启动日志 |
| `server/http.js` | 路由匹配、JSON body 解析（≤24MB）、响应与文件下载 |
| `server/db.js` | 建表、幂等补列、索引、种子数据、`all/get/run/tx` 封装 |
| `server/auth.js` | 密码加盐哈希、Token 签发与校验、`resolveUser` |
| `server/guard.js` | `isVerified` 与 `requireVerified` 统一认证门禁 |
| `server/api-*.js` | 按领域拆分的业务接口 |
| `public/js/app.js` | Hash 路由、视图挂载、启动流程 |
| `public/js/layout.js` | 页头页脚、导航、登录弹窗、全局状态与未读刷新 |
| `public/js/views/*` | 页面视图，按路由懒加载 |

## 三、请求生命周期

```
请求 → 路由匹配 → 解析 body/query → resolveUser（如需鉴权）
     → 守卫（登录 / 管理员 / 已认证）
     → 业务校验 → 事务写入 / 查询
     → sendJson → 前端统一错误处理与 Toast
```

关键约定：

- 金额一律使用整数「分」（`price_cents`），展示层再格式化。
- 路由按路径段数精确匹配；`/api/tickets/unread`、`/api/threads/meta`、`/api/threads/unread` 需注册在对应 `:id` 参数路由之前，避免被吞掉。
- 管理端路由声明 `{ auth: true, admin: true }`，在路由层统一拦截。
- 所有写操作在服务端再次校验权限，不信任前端状态。

## 四、数据模型

数据库共 13 张表，核心关系如下：

```
users 1 ── n materials 1 ── n orders n ── 1 users(buyer)
  │            │ 1 ── n reviews
  │            │ 1 ── n favorites
  │ 1 ── n wants
  │ 1 ── n reports
  │ 1 ── n payments n ── 1 orders（每笔支付单对应一个资料订单）
  │ 1 ── n tickets（发起人）1 ── n ticket_replies
price_standards（独立配置表）
announcements / threads（统一卖家沟通）1 ── n messages
```

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `users` | username, email, password_hash, salt, nickname, school, role, status, balance_cents, real_name, student_no, verify_status, verify_note, verified_at | 身份、收益台账与认证信息 |
| `materials` | title, category, subject, teacher, school, price_cents, file_name, file_size, status, preview_text, preview_ratio, price_source, price_note, downloads | 资料主表，含试读与调价来源 |
| `orders` | material_id, buyer_id, seller_id, amount_cents, fee_cents, seller_income_cents, status, created_at | 交易与分账 |
| `reviews` | material_id, user_id, rating, content | 评价 |
| `favorites` | user_id, material_id | 收藏 |
| `wants` | user_id, title, description, budget_cents, status | 求购广场 |
| `threads` / `messages` | 参与者、material_id / want_id 上下文、scene 咨询场景、内容、read_at | 统一卖家沟通会话（资料咨询 / 求购沟通 / 自由对话） |
| `chat_migrations` | source, source_id, thread_id | 历史卖家咨询工单迁移映射，保证幂等 |
| `reports` | material_id, reporter_id, reason, status | 举报 |
| `announcements` | title, content, active | 公告 |
| `price_standards` | school, subject, category, base_price_cents, min_price_cents, max_price_cents, note, active | 官方价格标准库 |
| `tickets` | user_id, kind(official，历史 seller 归档), ticket_type, title, content, material_id, target_user_id, status, user_unread, staff_unread | 平台官方客服工单 |
| `ticket_replies` | ticket_id, author_id, role, content | 工单对话 |
| `payments` | payment_no, user_id, order_id, purpose, channel, amount_cents, status, channel_trade_no, expires_at, paid_at, failure_code | 统一支付流水（微信 / 支付宝 / 银行卡） |

### 迁移策略

- 建表使用 `CREATE TABLE IF NOT EXISTS`。
- 字段变更使用 `ensureColumn(table, column, ddl)` 幂等补列，启动时自动执行。
- 新表与索引同样幂等创建，因此旧库可直接升级，无需手工迁移。
- 启动时执行 `migrateSellerChat()`：把历史 `kind='seller'` 工单及其回复合并进统一会话，并用 `chat_migrations` 去重，未读状态同步映射，重复启动不会重复写入。
- 演示环境可用 `npm run reset` 重建。

## 五、API 概览

| 分组 | 主要接口 |
| --- | --- |
| 公共 | `GET /api/health`、`GET /api/meta` |
| 账号 | `POST /api/auth/register`、`POST /api/auth/login`、`GET /api/auth/me`、`PATCH /api/auth/me` |
| 资料 | `GET /api/materials`、`GET /api/materials/:id`、`GET /api/materials/:id/preview`、`POST /api/materials`、`PATCH /api/materials/:id`、`GET /api/materials/:id/download`、收藏与评价 |
| 交易 | `POST /api/orders`、`GET /api/orders/mine`、`GET /api/orders/sales`、退款 |
| 支付 | `GET /api/payments/channels`、`GET /api/payments/:id`、`POST /api/payments/callback/:channel`、`POST /api/payments/:id/simulate`、`GET /api/payments/mine` |
| 定价 | `GET /api/pricing/standards`、`GET /api/pricing/recommend` |
| 认证 | `GET /api/verify/status`、`POST /api/verify/submit` |
| 客服 | 官方工单：`GET /api/tickets`、`GET /api/tickets/unread`、`POST /api/tickets`、`GET /api/tickets/:id`、`POST /api/tickets/:id/replies`、`POST /api/tickets/:id/status`（旧 `kind=seller` 提交会自动写入统一会话） |
| 统一卖家沟通 | `GET /api/threads`、`GET /api/threads/meta`、`GET /api/threads/unread`、`POST /api/threads`、`GET /api/threads/:id`、`PATCH /api/threads/:id`（切换场景）、`POST /api/threads/:id/messages` |
| 社区 | 求购、统一卖家沟通、举报 |
| 管理 | `/api/admin/overview`、`materials`、`verifications`、`tickets`、`pricing`、`users`、`reports`、`refunds`、`payments`、`payments/reconcile`、`announcements`、`PATCH /api/admin/materials/:id/price` |

## 六、鉴权与安全

| 风险 | 措施 |
| --- | --- |
| 密码泄露 | `scrypt` 加盐哈希，数据库中不存明文 |
| Token 伪造 | HMAC-SHA256 签名，密钥独立文件保存 |
| 越权访问 | 路由级 `admin` 标记 + 业务层二次校验（owner / target / admin） |
| 未认证交易 | 购买、上传、求购统一走 `requireVerified` |
| XSS | 前端所有动态文本经 `esc()` 转义 |
| 文件风险 | 扩展名白名单、大小限制、文件名重命名、禁止路径穿越 |
| 试读泄露 | 服务端只返回截断文本，前端禁止复制与右键 |
| 重复提交 | 下单前校验是否已购买；SQLite 事务保证扣款与订单一致 |
| 暴力登录 | 生产环境建议在反向代理层增加限流（见部署文档） |

## 七、性能与容量

当前架构面向「单校 / 区域试点」，实测与估算：

| 指标 | 估算 |
| --- | --- |
| 单机并发 | 数百 QPS（读多写少，SQLite WAL） |
| 资料规模 | 10 万份以内无明显压力（已建状态、院校、学科、老师索引） |
| 文件存储 | 受磁盘限制，单文件 ≤ 约 18MB（JSON base64 传输上限 24MB） |
| 冷启动 | < 1 秒（建表 + 种子数据） |

优化顺序：分页与索引 → 静态资源缓存 → 试读文本预生成（已实现）→ 对象存储 → 读写分离 / 缓存。

## 八、演进路线（技术）

| 阶段 | 替换项 | 说明 |
| --- | --- | --- |
| 公测 | 支付网关（微信 / 支付宝） | 保留订单与分账字段，接入回调与幂等处理 |
| 公测 | 对象存储 + CDN | 替换本地 `uploads`，下载走签名 URL |
| 单校运营 | PostgreSQL | `db.js` 的查询封装可平滑替换驱动 |
| 多校 SaaS | 多租户与院校配置中心 | 院校维度隔离、独立价格库与运营后台 |
| 规模化 | Redis 缓存 + 消息队列 | 热门列表、未读计数、通知异步化 |

## 九、可观测性与运维

- 启动日志输出端口与演示账号。
- `/api/health` 供容器与负载均衡探活。
- 错误统一返回 `{ message }`，前端 Toast 展示。
- 生产建议：接入结构化日志、错误上报（Sentry）、数据库定时备份与上传目录快照。
