# 好友砍价

砍价是资料交易的价格优惠玩法：用户选择已上架资料发起砍价单，分享给好友助力，好友每次随机砍掉一部分差价；砍到底价后，发起人可按砍价金额直接购买。实现文件：`server/api-bargains.js`、`public/js/views/bargain.js`、`tests/bargain-flow.mjs`。

## 一、业务规则

| 规则 | 说明 |
| --- | --- |
| 参与资料 | 仅 `approved` 且价格大于 0 的资料，发起人不能是资料卖家 |
| 有效期 | 活动配置 1—720 小时，发起砍价时写入砍价单 `expires_at` |
| 初始价 / 底价 | 发起时快照到砍价单，后续修改活动不影响已创建砍价单 |
| 单用户可砍次数 | 每位好友在单张砍价单内的助力次数上限（1—10 次） |
| 最大助力人数 | 单张砍价单的去重助力人数上限（1—100 人） |
| 随机砍价 | 服务端按剩余差价 10%—30% 随机计算，最低 1 分，永远不击穿底价 |
| 最后一击 | 达到最大助力人数的最后一位好友直接砍到底价，状态转为「已砍到底价」 |
| 过期 | 读取、助力、购买前惰性结算；过期后不可助力，但可重新发起 |
| 购买 | 仅发起人、砍价成功且未购买时可下单，金额取服务端快照 |

## 二、数据模型

- `bargain_activities`：活动配置（资料、初始价、底价、有效期、次数上限、人数上限、状态、创建人）。
- `bargain_orders`：砍价单（活动与资料关联、发起人、价格与规则快照、状态、过期时间、购买订单 `order_id`）。
- `bargain_assists`：助力记录（砍价单、助力人、砍价金额、序号、`request_id`）。
- `orders.bargain_id`：砍价专享价订单与砍价单关联。

关键索引：

```sql
UNIQUE(order_id, helper_id, request_id)   -- 助力幂等
UNIQUE(order_id, helper_id, seq)          -- 次数上限兜底
UNIQUE(activity_id, user_id) WHERE status = 'active'  -- 同一活动仅一张进行中砍价单
```

## 三、状态机

```text
active（砍价中） --最后一击/到价--> success（已砍到底价） --支付完成--> 已购买
active --超过 expires_at--> expired（已过期） --重新发起--> 新 active 砍价单
```

活动状态：`active` 进行中 / `offline` 已下架。下架只阻止新增砍价单，不影响已创建的砍价单。

## 四、接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/bargains` | 登录 | 发起砍价，body：`materialId` 或 `activityId` |
| GET | `/api/bargains/mine` | 登录 | 我的砍价列表与状态统计 |
| GET | `/api/bargains/material/:materialId` | 公开 | 资料当前活动与我的砍价单 |
| GET | `/api/bargains/:id` | 公开 | 砍价单详情、助力列表、进度与权限提示 |
| POST | `/api/bargains/:id/assist` | 登录 | 助力，body：`requestId`（幂等键） |
| POST | `/api/bargains/:id/purchase` | 登录 + 认证 | 按砍价价创建支付单，body：`channel` |
| GET | `/api/admin/bargains` | 管理员 | 活动列表、运营统计、可选资料 |
| POST | `/api/admin/bargains` | 管理员 | 创建活动 |
| PATCH | `/api/admin/bargains/:id` | 管理员 | 编辑规则 / 上下架 |
| DELETE | `/api/admin/bargains/:id` | 管理员 | 删除（仅无砍价单活动） |

## 五、安全与一致性

1. **防篡改**：创建与助力请求中的价格、砍价金额字段全部忽略，服务端只读取活动/砍价单快照。
2. **幂等**：同一用户携带同一 `requestId` 重复提交直接返回首次结果，不再扣减价格；`seq` 唯一索引兜底次数上限。
3. **并发**：助力在事务内读取最新价格，使用 `WHERE current_price_cents = ?` 乐观更新；价格被其他请求修改时放弃本次写入并返回 409，避免超砍。
4. **越权**：发起人不能给自己助力；只有发起人可按砍价价购买；非管理员不能访问活动管理接口。
5. **实时同步**：详情页每 5 秒轮询一次，倒计时每秒刷新；状态与助力列表变化时自动重渲染。

## 六、测试

```bash
npm run test:bargain
```

覆盖 65 项断言：活动创建与规则校验、上下架、重复活动、发起与重复发起、随机金额边界、价格快照防篡改、助力幂等、单用户次数上限、最大助力人数、最后一击到底价、过期结算与重新发起、并发助力一致性、砍价成功支付、越权与未登录拦截。
