# 支付方式与交易结算

> 本文档说明「学涯集市」标准化后的支付方式清单、接入参数、支付流程、回调协议、异常处理与对账规则。
> 代码实现：`server/payment-gateway.js`（通道抽象与支付单生命周期）、`server/api-payments.js`（支付接口）、`public/js/pay.js`（前端支付弹窗）。

---

## 一、支付方式清单

| 代码 | 名称 | 支付形态 | 单笔限额 | 支付时效 | 结算周期 | 通道费率 |
| --- | --- | --- | --- | --- | --- | --- |
| `wechat` | 微信支付 | 扫码（Native） | ¥0.01—¥50,000 | 扫码后实时到账 | T+1 | 约 0.6%（平台承担） |
| `alipay` | 支付宝支付 | 扫码 | ¥0.01—¥50,000 | 扫码后实时到账 | T+1 | 约 0.6%（平台承担） |
| `bankcard` | 银行卡支付 | 网银 / 手机银行转账 | ¥1—¥50,000 | 转账后 1—5 分钟到账 | T+1 | 以银行实际收取为准 |

> 平台不提供账户充值与提现，所有交易均在微信 / 支付宝 / 银行卡等外部渠道完成；卖家收益按 T+1 自动结算至收款账户。

- 支付单有效期：微信 / 支付宝 15 分钟，银行卡转账 30 分钟。
- 通道是否可用由 `isConfigured()` 判断：`mock` 模式下全部可用；`live` 模式下必须配齐对应环境变量，否则前端展示为不可选。

### 渠道选择与切换

- 所有购买均通过统一支付弹窗选择外部渠道，不再提供站内余额支付入口。
- 同一订单在支付有效期内切换渠道时，旧支付单自动置为 `closed`（`failure_code=SWITCHED`），订单沿用原订单号，避免产生重复订单。
- 已存在待支付订单再次下单会复用该订单，而不是新建。

---

## 二、接入参数

环境变量（均可选，未配置时以 `mock` 模式运行）：

| 变量 | 说明 |
| --- | --- |
| `PAYMENT_MODE` | `mock`（默认）/ `live` |
| `PAYMENT_MOCK_SECRET` | 模拟回调签名密钥，默认 `xueya-demo-payment-secret` |
| `WECHAT_APP_ID` | 微信应用 / 公众号 AppID |
| `WECHAT_MCH_ID` | 微信支付商户号 |
| `WECHAT_API_V3_KEY` | APIv3 密钥（同时作为回调验签密钥） |
| `WECHAT_NOTIFY_URL` | 微信支付回调地址 |
| `ALIPAY_APP_ID` | 支付宝应用 AppID |
| `ALIPAY_APP_SECRET` | 支付宝应用私钥 / 验签密钥 |
| `ALIPAY_NOTIFY_URL` | 支付宝异步通知地址 |
| `BANK_MCH_ID` | 银行卡收单商户号 |
| `BANK_MERCHANT_KEY` | 收单商户密钥（同时作为回调验签密钥） |
| `BANK_NOTIFY_URL` | 银行转账回调地址 |

查看当前渠道配置与可用状态：`GET /api/payments/channels`

```json
{
  "mode": "mock",
  "channels": [
    {
      "code": "wechat",
      "name": "微信支付",
      "flow": "qrcode",
      "minAmount": 1,
      "maxAmount": 5000000,
      "expireMinutes": 15,
      "settle": "T+1",
      "limits": "单笔 ¥0.01—¥50,000",
      "params": [{ "key": "WECHAT_APP_ID", "configured": false }],
      "available": true
    }
  ]
}
```

---

## 三、数据模型与状态机

### payments 表

| 字段 | 说明 |
| --- | --- |
| `payment_no` | 支付单号（唯一，`PAY` + 时间 + 随机串） |
| `user_id` / `order_id` | 付款人；每笔支付单均关联一个资料订单 |
| `purpose` | `order`（购买资料） |
| `channel` | `wechat` / `alipay` / `bankcard` |
| `amount_cents` | 金额（分） |
| `status` | `pending` / `paid` / `failed` / `closed` / `refunded` |
| `channel_trade_no` | 渠道交易号 |
| `expires_at` / `paid_at` | 过期时间 / 支付完成时间 |
| `failure_code` / `failure_message` | 失败或关闭原因 |
| `last_notify_nonce` | 最近一次处理的回调随机串 |

### 订单状态联动

```
pending_payment ──支付成功──▶ completed（卖家入账 amount - 10% 服务费）
       │
       ├──支付失败/超时关闭──▶ cancelled
       └──切换外部渠道──▶ 旧支付单 closed，订单保持 pending_payment，新建支付单
```

`orders.payment_channel` 记录实际外部支付渠道。历史种子订单该字段为空，对账时自动排除，避免误报。

---

## 四、支付流程

### 购买资料

```
买家点击购买
   │  GET /api/payments/channels（渠道、限额、时效）
   ▼
POST /api/orders { materialId, channel }
   └─ 订单 pending_payment → 创建 pending 支付单 → 返回扫码 / 转账参数
          │
          ▼
   前端展示二维码 / 转账信息 + 倒计时，每 3 秒轮询 GET /api/payments/:id
          │
          ▼
   渠道回调 POST /api/payments/callback/:channel
          │  验签 → 校验时间戳 → 校验金额 → 幂等 → 事务落账
          ▼
   支付单 paid，订单 completed，前端轮询到 paid 后刷新页面
```

### 查询接口

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/payments/channels` | 公开 | 渠道清单、限额、时效、参数配置状态 |
| `POST /api/orders` | 登录 + 已认证 | 创建订单并按外部渠道发起支付（`channel` 必填） |
| `GET /api/payments/:id` | 本人 / 管理员 | 支付单详情、订单状态、剩余时间 |
| `POST /api/payments/:id/simulate` | 本人 / 管理员 | mock 模式模拟支付成功 / 失败 |
| `POST /api/payments/callback/:channel` | 公开（验签） | 渠道异步通知 |
| `GET /api/payments/mine` | 登录 | 本人支付流水（最近 50 笔） |
| `GET /api/admin/payments` | 管理员 | 支付流水筛选与汇总 |
| `GET /api/admin/payments/reconcile` | 管理员 | 按日对账与异常检测 |

---

## 五、回调协议

统一通知体（JSON）：

```json
{
  "paymentNo": "PAY20261120121723600595",
  "tradeNo": "4200001234202611201234567890",
  "amountCents": 2990,
  "status": "SUCCESS",
  "timestamp": 1795148243058,
  "nonce": "9f2c1a7be0d34c55",
  "sign": "f3a1..."
}
```

签名算法：

```
canonical = `${paymentNo}|${tradeNo}|${amountCents}|${status}|${timestamp}|${nonce}`
sign      = HMAC-SHA256(secret, canonical)   // 小写十六进制
```

校验顺序与响应：

| 顺序 | 校验项 | 失败返回 |
| --- | --- | --- |
| 1 | 渠道存在（微信 / 支付宝 / 银行卡） | 400 `CHANNEL_ERROR` |
| 2 | 必填字段完整、`status` ∈ {SUCCESS, FAIL} | 400 `PARAM_ERROR` / `STATUS_ERROR` |
| 3 | 时间戳在 ±5 分钟内 | 400 `TIMESTAMP_EXPIRED` |
| 4 | 渠道密钥已配置 | 400 `NOT_CONFIGURED` |
| 5 | 签名一致（常量时间比较） | 400 `SIGN_ERROR` |
| 6 | 支付单存在、渠道匹配 | 404 `NOT_FOUND` / 400 `CHANNEL_MISMATCH` |
| 7 | 已支付则直接返回成功（幂等） | 200 `SUCCESS` + `duplicated: true` |
| 8 | 状态必须为 `pending`，且未超时 | 400 `PAYMENT_CLOSED` / `PAYMENT_EXPIRED` |
| 9 | 金额与支付单一致 | 400 `AMOUNT_MISMATCH` |
| 10 | `SUCCESS` 事务落账；`FAIL` 记录失败并取消订单 | 200 `SUCCESS` |

> 成功响应统一为 `200 {"code":"SUCCESS"}`，渠道侧据此停止重试；除幂等重复通知外，任何 4xx 都会触发渠道按策略重发。

---

## 六、异常场景处理

| 场景 | 处理策略 |
| --- | --- |
| 未选择支付方式 | 下单接口要求 `channel` 必填，缺失或为 `balance` 时返回 400 |
| 金额超出渠道限额 | 创建支付单前拦截，返回 400 并提示限额 |
| 重复支付 / 重复通知 | 支付单已 `paid` 直接返回幂等成功，不重复入账 |
| 回调签名错误 | 拒绝并记录，前端支付单保持 `pending`，可重新发起 |
| 回调金额不一致 | 拒绝落账，避免金额篡改 |
| 时间戳过期 / 重放 | 超出 ±5 分钟拒绝；同一 `nonce` 重复通知幂等处理 |
| 支付超时 | 定时任务每分钟关闭超时支付单，订单同步 `cancelled` |
| 用户切换支付方式 | 旧支付单 `closed`，复用订单创建新支付单 |
| 支付成功后客户端未刷新 | 前端轮询 + 「刷新支付状态」按钮兜底 |
| 渠道未配置（live） | 渠道置为不可选，接口返回「该支付方式暂未开通」 |
| 支付成功但订单状态异常 | 对账页「支付成功但订单未完成」异常项，人工介入 |

---

## 七、支付安全规范

- 回调验签使用 HMAC-SHA256，`crypto.timingSafeEqual` 常量时间比较，防止时序攻击。
- 时间戳 ±5 分钟容差 + `nonce` 幂等，抵御重放攻击。
- 金额以「分」为单位的整数存储与比对，避免浮点误差。
- 回调落账在数据库事务内完成：更新支付单、更新订单、卖家入账要么全部成功，要么全部回滚。
- 支付单只能由本人或管理员查询；模拟支付按 `PAYMENT_MODE` 严格控制，`live` 模式直接 403。
- 渠道密钥仅存放在环境变量中，接口只返回「是否已配置」，不返回密钥内容。
- 订单与支付流水双向可追溯：`payments.order_id` ↔ `orders.payment_channel`。

---

## 八、交易对账

后台「支付对账」页（`#/admin?tab=payments`）：

- **渠道汇总**：按日统计各渠道成功笔数、成功金额、待支付、失败/关闭数量与结算周期。
- **流水筛选**：按状态、渠道、日期组合筛选，展示用户、用途、金额、失败原因。
- **异常检测**（`GET /api/admin/payments/reconcile?date=YYYY-MM-DD`）：
  - `paidWithoutCompletedOrder`：支付单已支付但订单不是 `completed`；
  - `completedOrderWithoutPayment`：订单已完成但缺少 `paid` 流水（排除 `payment_channel` 为空的历史种子订单）。
- 对账口径：金额取支付单 `amount_cents`，与订单金额一致。
- **收益结算台账**：同页展示 `settlements` 账单，含订单金额、10% 服务费、结算金额、结算状态与预计结算时间，汇总待结算 / 已结算金额。
- **退款联动**：退款通过后支付单转为 `refunded`，结算记录转为 `cancelled`，卖家收益扣回，对账汇总同步减少。
- **银行卡人工确认**：`live` 模式下银行卡待支付单可在流水列表点击「确认到账」（`POST /api/admin/payments/:id/confirm`），仅管理员可用、仅银行卡可用，重复确认幂等。

---

## 九、测试

```bash
npm run test:payments
```

测试会以临时数据目录和独立端口（默认 3399）启动服务，不影响现有数据，覆盖 35 项检查：

| 分组 | 覆盖点 |
| --- | --- |
| 渠道配置 | 3 种外部支付方式、限额与时效、演示模式标记 |
| 下单 | 微信扫码参数、待支付订单、支付单与订单关联 |
| 安全 | 错误签名、时间戳过期、金额篡改、渠道不匹配 |
| 状态同步 | 模拟成功、订单完成、失败后订单取消、渠道回调成功 |
| 幂等 | 重复模拟支付、重复回调 |
| 去余额化 | 充值接口 404、提现接口 404、`balance` 渠道下单 400、未指定渠道 400 |
| 权限 | 他人支付单不可见、普通用户不可访问对账 |
| 对账 | 流水列表、3 个渠道汇总、异常字段、管理员权限 |

正式版全链路另由 `npm run test:production` 覆盖（40 项），包含支付成功后生成结算、退款取消结算、银行卡人工确认与幂等、结算台账汇总。同时保留原有 `npm test`（20 项只读冒烟检查）。

---

## 十、接入真实渠道时的改造点

当前 `mock` 模式完整复刻了「下单 → 支付 → 异步回调 → 落账」链路。切换 `PAYMENT_MODE=live` 后，只需替换两处：

1. `createPayment()` 中生成支付参数的部分：调用微信 Native 下单 / 支付宝预创建 / 银行收单接口，返回真实 `code_url`、`qr_code` 或转账账号。
2. 回调验签：将 `signPayload()` 的 HMAC 替换为各渠道官方验签（微信 APIv3 平台证书、支付宝 RSA2、银行收单签名），其余状态机、幂等、事务与对账逻辑无需改动。

回调地址按渠道配置为 `https://<domain>/api/payments/callback/{channel}`，需在渠道商户后台登记。
