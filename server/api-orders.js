'use strict';

const { all, get, run, now } = require('./db');
const { sendJson, fail } = require('./http');
const { requireVerified } = require('./guard');
const gateway = require('./payment-gateway');
const idempotency = require('./idempotency');

function orderView(row, ctx) {
  return {
    id: row.id,
    amount: row.amount_cents,
    commission: row.commission_cents,
    status: row.status,
    paymentChannel: row.payment_channel || '',
    createdAt: row.created_at,
    material: {
      id: row.material_id,
      title: row.title,
      category: row.category,
      fileName: row.file_name,
      fileSize: row.file_size,
      price: row.price_cents
    },
    buyer: { id: row.buyer_id, nickname: row.buyer_nickname },
    seller: { id: row.seller_id, nickname: row.seller_nickname }
  };
}

async function create(ctx) {
  const scope = `orders.create:${ctx.user.id}`;
  const replay = idempotency.replay(ctx, scope);
  if (replay) return sendJson(ctx.res, replay.statusCode, replay.data);
  if (!requireVerified(ctx, '购买资料')) return;
  const materialId = Number(ctx.body.materialId);
  const channelCode = String(ctx.body.channel || '').trim();
  const channel = gateway.getChannel(channelCode);
  if (!channel) return fail(ctx.res, 400, '请选择微信支付、支付宝或银行卡支付');

  const material = get(
    `SELECT m.*, u.nickname AS seller_nickname FROM materials m JOIN users u ON u.id = m.seller_id WHERE m.id = ?`, materialId
  );
  if (!material) return fail(ctx.res, 404, '资料不存在');
  if (material.status !== 'approved') return fail(ctx.res, 400, '该资料暂不可购买');
  if (material.seller_id === ctx.user.id) return fail(ctx.res, 400, '不能购买自己上传的资料');
  if (material.price_cents === 0) return fail(ctx.res, 400, '免费资料无需购买，可直接下载');

  const existing = get(
    `SELECT id FROM orders WHERE material_id = ? AND buyer_id = ? AND status IN ('completed','refund_requested')`,
    materialId, ctx.user.id
  );
  if (existing) return fail(ctx.res, 409, '你已购买过该资料，可直接下载');

  const pending = get(
    `SELECT * FROM orders WHERE material_id = ? AND buyer_id = ? AND status = 'pending_payment' ORDER BY id DESC LIMIT 1`,
    materialId, ctx.user.id
  );
  let orderId;
  if (pending) {
    orderId = pending.id;
    run(`UPDATE payments SET status = 'closed', failure_code = 'SWITCHED', failure_message = '用户切换支付方式' WHERE order_id = ? AND status = 'pending'`, orderId);
    run('UPDATE orders SET payment_channel = ? WHERE id = ?', channelCode, orderId);
  } else {
    const commission = Math.round(material.price_cents * 0.1);
    const info = run(
      `INSERT INTO orders (material_id, buyer_id, seller_id, amount_cents, commission_cents, status, payment_channel, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending_payment', ?, ?)`,
      materialId, ctx.user.id, material.seller_id, material.price_cents, commission, channelCode, now()
    );
    orderId = Number(info.lastInsertRowid);
  }

  const created = await gateway.createPayment({
    userId: ctx.user.id,
    orderId,
    purpose: 'order',
    channelCode,
    amountCents: material.price_cents
  });
  if (created.error) {
    run(`UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending_payment'`, orderId);
    return fail(ctx.res, 400, created.error);
  }

  const payload = {
    orderId,
    channel: channelCode,
    status: 'pending_payment',
    payment: gateway.serialize(created.row),
    payPayload: created.payload,
    mockMode: gateway.mode() === 'mock',
    message: '支付单已创建，请在有效期内完成支付'
  };
  idempotency.remember(ctx, scope, 201, payload);
  sendJson(ctx.res, 201, payload);
}

function mine(ctx) {
  const rows = all(
    `SELECT o.*, m.title, m.category, m.file_name, m.file_size, m.price_cents,
            u.nickname AS seller_nickname, b.nickname AS buyer_nickname
     FROM orders o
     JOIN materials m ON m.id = o.material_id
     JOIN users u ON u.id = o.seller_id
     JOIN users b ON b.id = o.buyer_id
     WHERE o.buyer_id = ? ORDER BY o.created_at DESC`, ctx.user.id
  );
  const reviewed = new Set(
    all('SELECT order_id FROM reviews WHERE user_id = ?', ctx.user.id).map((r) => r.order_id)
  );
  sendJson(ctx.res, 200, {
    items: rows.map((r) => ({
      ...orderView(r, ctx),
      canReview: r.status === 'completed' && !reviewed.has(r.id),
      reviewed: reviewed.has(r.id)
    }))
  });
}

function sales(ctx) {
  const rows = all(
    `SELECT o.*, m.title, m.category, m.file_name, m.file_size, m.price_cents,
            u.nickname AS seller_nickname, b.nickname AS buyer_nickname
     FROM orders o
     JOIN materials m ON m.id = o.material_id
     JOIN users u ON u.id = o.seller_id
     JOIN users b ON b.id = o.buyer_id
     WHERE o.seller_id = ? ORDER BY o.created_at DESC LIMIT 50`, ctx.user.id
  );
  sendJson(ctx.res, 200, { items: rows.map((r) => orderView(r, ctx)) });
}

function refund(ctx) {
  const id = Number(ctx.params.id);
  const order = get('SELECT * FROM orders WHERE id = ?', id);
  if (!order) return fail(ctx.res, 404, '订单不存在');
  if (order.buyer_id !== ctx.user.id) return fail(ctx.res, 403, '无权操作该订单');
  if (order.status !== 'completed') return fail(ctx.res, 400, '当前订单状态不支持申请退款');
  const created = new Date(order.created_at.replace(' ', 'T')).getTime();
  if (Date.now() - created > 7 * 24 * 3600 * 1000) return fail(ctx.res, 400, '订单已超过 7 天退款申请期');
  run(`UPDATE orders SET status = 'refund_requested' WHERE id = ?`, id);
  sendJson(ctx.res, 200, { message: '退款申请已提交，平台将在 1—3 个工作日内处理' });
}

function sellerOverview(ctx) {
  const uid = ctx.user.id;
  const stats = {
    sold: get(`SELECT COUNT(*) AS c FROM orders WHERE seller_id = ? AND status = 'completed'`, uid).c,
    revenue: get(`SELECT COALESCE(SUM(amount_cents - commission_cents),0) AS c FROM orders WHERE seller_id = ? AND status = 'completed'`, uid).c,
    gross: get(`SELECT COALESCE(SUM(amount_cents),0) AS c FROM orders WHERE seller_id = ? AND status = 'completed'`, uid).c,
    refunding: get(`SELECT COUNT(*) AS c FROM orders WHERE seller_id = ? AND status = 'refund_requested'`, uid).c,
    balance: get('SELECT balance_cents FROM users WHERE id = ?', uid).balance_cents,
    materials: get('SELECT COUNT(*) AS c FROM materials WHERE seller_id = ?', uid).c,
    pending: get(`SELECT COUNT(*) AS c FROM materials WHERE seller_id = ? AND status = 'pending'`, uid).c,
    downloads: get('SELECT COALESCE(SUM(downloads),0) AS c FROM materials WHERE seller_id = ?', uid).c
  };
  const series = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date();
    day.setDate(day.getDate() - i);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const row = get(
      `SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents - commission_cents),0) AS revenue FROM orders
       WHERE seller_id = ? AND status IN ('completed','refund_requested') AND substr(created_at,1,10) = ?`, uid, key
    );
    series.push({ date: key.slice(5), count: row.c, revenue: row.revenue });
  }
  const top = all(
    `SELECT m.id, m.title, COUNT(o.id) AS sold, COALESCE(SUM(o.amount_cents - o.commission_cents),0) AS revenue
     FROM materials m LEFT JOIN orders o ON o.material_id = m.id AND o.status = 'completed'
     WHERE m.seller_id = ? GROUP BY m.id ORDER BY revenue DESC LIMIT 5`, uid
  );
  sendJson(ctx.res, 200, { stats, series, top });
}

module.exports = { create, mine, sales, refund, sellerOverview };
