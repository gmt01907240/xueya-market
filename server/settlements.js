'use strict';

/**
 * 收益结算账本
 *
 * 规则：
 * 1. 订单支付成功后生成一条结算记录，金额 = 订单金额 - 平台服务费；
 * 2. 结算周期为 T+N（默认 24 小时，可用 SETTLEMENT_DELAY_HOURS 调整），到期自动标记为已结算；
 * 3. 订单退款时对应结算记录置为已取消，卖家收益同步扣回；
 * 4. 平台不提供站内充值 / 提现，收益按结算周期划付至卖家收款账户。
 */

const { all, get, run, now } = require('./db');

const DELAY_HOURS = (() => {
  const value = Number(process.env.SETTLEMENT_DELAY_HOURS);
  return Number.isFinite(value) && value >= 0 ? value : 24;
})();

const STATUS_TEXT = {
  pending: '待结算',
  settled: '已结算',
  cancelled: '已取消'
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function stamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseStamp(text) {
  if (!text) return new Date();
  const d = new Date(String(text).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function dueAt(baseText) {
  return stamp(new Date(parseStamp(baseText).getTime() + DELAY_HOURS * 3600 * 1000));
}

function recordForOrder(order, paidAt) {
  if (!order || !order.id) return null;
  const exists = get('SELECT id FROM settlements WHERE order_id = ?', order.id);
  if (exists) return null;
  const net = order.amount_cents - order.commission_cents;
  run(
    `INSERT INTO settlements (order_id, seller_id, buyer_id, order_amount_cents, commission_cents, net_cents,
       status, settle_due, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    order.id, order.seller_id, order.buyer_id, order.amount_cents, order.commission_cents, net,
    dueAt(paidAt || now()), '', paidAt || now()
  );
  return get('SELECT * FROM settlements WHERE order_id = ?', order.id);
}

function settleDue() {
  const ts = now();
  const info = run(
    `UPDATE settlements SET status = 'settled', settled_at = ?
     WHERE status = 'pending' AND settle_due <= ?`,
    ts, ts
  );
  return info.changes || 0;
}

function cancelForOrder(orderId, note = '订单退款，结算已取消') {
  run(
    `UPDATE settlements SET status = 'cancelled', cancelled_at = ?, note = ?
     WHERE order_id = ? AND status IN ('pending', 'settled')`,
    now(), note, orderId
  );
}

/** 为历史订单补建结算记录，保证升级后账单完整 */
function backfill() {
  const rows = all(
    `SELECT o.* FROM orders o LEFT JOIN settlements s ON s.order_id = o.id
     WHERE s.id IS NULL AND o.status IN ('completed', 'refund_requested')`
  );
  for (const row of rows) recordForOrder(row, row.created_at);
  settleDue();
  return rows.length;
}

function serialize(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    material: row.material_id ? { id: row.material_id, title: row.title || '', category: row.category || '' } : null,
    buyer: row.buyer_nickname ? { id: row.buyer_id, nickname: row.buyer_nickname } : { id: row.buyer_id, nickname: '' },
    seller: row.seller_nickname ? { id: row.seller_id, nickname: row.seller_nickname } : undefined,
    orderAmount: row.order_amount_cents,
    commission: row.commission_cents,
    net: row.net_cents,
    status: row.status,
    statusText: STATUS_TEXT[row.status] || row.status,
    settleDue: row.settle_due,
    settledAt: row.settled_at,
    cancelledAt: row.cancelled_at,
    note: row.note || '',
    createdAt: row.created_at
  };
}

const SELLER_SELECT = `
  SELECT s.*, m.id AS material_id, m.title, m.category, b.nickname AS buyer_nickname
  FROM settlements s
  JOIN orders o ON o.id = s.order_id
  JOIN materials m ON m.id = o.material_id
  JOIN users b ON b.id = s.buyer_id
`;

function sellerList(sellerId) {
  settleDue();
  const rows = all(`${SELLER_SELECT} WHERE s.seller_id = ? ORDER BY s.created_at DESC LIMIT 50`, sellerId);
  const totals = get(
    `SELECT COUNT(*) AS count,
       COALESCE(SUM(CASE WHEN status != 'cancelled' THEN net_cents ELSE 0 END), 0) AS net,
       COALESCE(SUM(CASE WHEN status != 'cancelled' THEN order_amount_cents ELSE 0 END), 0) AS gross,
       COALESCE(SUM(CASE WHEN status != 'cancelled' THEN commission_cents ELSE 0 END), 0) AS commission,
       COALESCE(SUM(CASE WHEN status = 'pending' THEN net_cents ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN status = 'settled' THEN net_cents ELSE 0 END), 0) AS settled
     FROM settlements WHERE seller_id = ?`, sellerId
  );
  const pendingCount = get(
    `SELECT COUNT(*) AS c FROM settlements WHERE seller_id = ? AND status = 'pending'`, sellerId
  ).c;
  return {
    cycle: DELAY_HOURS >= 24 ? 'T+1' : `T+${DELAY_HOURS}h`,
    delayHours: DELAY_HOURS,
    feeRate: 0.1,
    stats: { ...totals, pendingCount },
    items: rows.map(serialize)
  };
}

function adminList(status = '') {
  settleDue();
  const where = status && STATUS_TEXT[status] ? 'WHERE s.status = ?' : '';
  const params = where ? [status] : [];
  const rows = all(
    `SELECT s.*, m.id AS material_id, m.title, m.category,
            b.nickname AS buyer_nickname, u.nickname AS seller_nickname
     FROM settlements s
     JOIN orders o ON o.id = s.order_id
     JOIN materials m ON m.id = o.material_id
     JOIN users b ON b.id = s.buyer_id
     JOIN users u ON u.id = s.seller_id
     ${where} ORDER BY s.created_at DESC LIMIT 200`, ...params
  );
  const totalRows = all(
    `SELECT status, COUNT(*) AS count, COALESCE(SUM(net_cents), 0) AS amount
     FROM settlements GROUP BY status`
  );
  const totals = { pending: { count: 0, amount: 0 }, settled: { count: 0, amount: 0 }, cancelled: { count: 0, amount: 0 } };
  for (const row of totalRows) totals[row.status] = { count: row.count, amount: row.amount };
  return { cycle: DELAY_HOURS >= 24 ? 'T+1' : `T+${DELAY_HOURS}h`, delayHours: DELAY_HOURS, totals, items: rows.map(serialize) };
}

module.exports = {
  DELAY_HOURS,
  STATUS_TEXT,
  recordForOrder,
  settleDue,
  cancelForOrder,
  backfill,
  sellerList,
  adminList
};
