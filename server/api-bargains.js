'use strict';

/**
 * 砍价模块
 *
 * 规则与安全要点：
 * 1. 价格、底价、有效期、次数与人数上限均以服务端快照为准，前端传入的价格字段一律忽略；
 * 2. 助力金额由服务端随机计算，且永远不会低于底价；
 * 3. 助力使用「order + helper + requestId」唯一索引做幂等，重复提交不会重复砍价；
 * 4. 并发助力通过事务 + 乐观更新（current_price_cents 版本比对）保证数据一致；
 * 5. 过期砍价单在读取与助力时惰性结算，状态实时同步。
 */

const crypto = require('node:crypto');
const { all, get, run, tx, now } = require('./db');
const { sendJson, fail } = require('./http');
const runtime = require('./runtime-config');
const { isVerified } = require('./guard');
const gateway = require('./payment-gateway');

const STATUS_TEXT = {
  active: '砍价中',
  success: '已砍到底价',
  expired: '已过期',
  cancelled: '已取消'
};

const ACTIVITY_STATUS_TEXT = {
  active: '进行中',
  offline: '已下架'
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function stamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseStamp(text) {
  if (!text) return null;
  const m = String(text).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function secondsLeft(text) {
  const date = parseStamp(text);
  if (!date) return 0;
  return Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000));
}

function progressOf(start, current, floor) {
  const total = start - floor;
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round(((start - current) / total) * 100)));
}

/** 惰性结算过期砍价单，保证列表与详情状态实时一致 */
function expireOrders() {
  const ts = now();
  const rows = all("SELECT id FROM bargain_orders WHERE status = 'active' AND expires_at <= ?", ts);
  if (!rows.length) return 0;
  tx(() => {
    for (const row of rows) {
      run("UPDATE bargain_orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'active'", ts, row.id);
    }
  });
  return rows.length;
}

const ACTIVITY_SELECT = `
  SELECT a.*, m.title AS material_title, m.price_cents AS material_price,
         m.category AS material_category, m.school AS material_school,
         m.file_name AS material_file, m.status AS material_status
  FROM bargain_activities a JOIN materials m ON m.id = a.material_id
`;

function activityView(a) {
  if (!a) return null;
  const view = {
    id: a.id,
    materialId: a.material_id,
    startPrice: a.start_price_cents,
    floorPrice: a.floor_price_cents,
    durationHours: a.duration_hours,
    maxCutsPerUser: a.max_cuts_per_user,
    maxHelpers: a.max_helpers,
    maxDiscount: a.start_price_cents - a.floor_price_cents,
    status: a.status,
    statusText: ACTIVITY_STATUS_TEXT[a.status] || a.status,
    active: a.status === 'active',
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    material: a.material_title ? {
      id: a.material_id,
      title: a.material_title,
      price: a.material_price,
      category: a.material_category,
      school: a.material_school,
      fileName: a.material_file,
      status: a.material_status
    } : null
  };
  if (a.total_orders !== undefined) {
    view.stats = {
      orders: a.total_orders,
      activeOrders: a.active_orders,
      successOrders: a.success_orders,
      participants: a.participants
    };
  }
  return view;
}

function orderRow(id) {
  return get(
    `SELECT b.*, a.duration_hours,
       m.title AS material_title, m.price_cents AS material_price, m.category AS material_category,
       m.school AS material_school, m.file_name AS material_file, m.status AS material_status,
       m.seller_id AS seller_id, u.nickname AS owner_nickname, u.school AS owner_school
     FROM bargain_orders b
     JOIN bargain_activities a ON a.id = b.activity_id
     JOIN materials m ON m.id = b.material_id
     JOIN users u ON u.id = b.user_id
     WHERE b.id = ?`,
    id
  );
}

function helperRows(orderId) {
  return all(
    `SELECT s.*, u.nickname, u.school FROM bargain_assists s
     JOIN users u ON u.id = s.helper_id
     WHERE s.order_id = ? ORDER BY s.id ASC`,
    orderId
  );
}

function orderView(row, viewer, opts = {}) {
  if (!row) return null;
  const helperCount = get('SELECT COUNT(DISTINCT helper_id) AS c FROM bargain_assists WHERE order_id = ?', row.id).c;
  const totalCuts = get('SELECT COUNT(*) AS c FROM bargain_assists WHERE order_id = ?', row.id).c;
  const myCutCount = viewer
    ? get('SELECT COUNT(*) AS c FROM bargain_assists WHERE order_id = ? AND helper_id = ?', row.id, viewer.id).c
    : 0;
  const expired = row.status === 'expired' || (row.status === 'active' && row.expires_at <= now());
  const paidOrder = row.order_id ? get('SELECT id, status FROM orders WHERE id = ?', row.order_id) : null;
  const purchased = !!get(
    `SELECT id FROM orders WHERE material_id = ? AND buyer_id = ? AND status IN ('completed','refund_requested') LIMIT 1`,
    row.material_id, row.user_id
  );

  let canAssist = false;
  let assistHint = '';
  if (!viewer) {
    assistHint = '登录后可帮好友砍价';
  } else if (viewer.id === row.user_id) {
    assistHint = '不能给自己的砍价单助力';
  } else if (row.status !== 'active' || expired) {
    assistHint = row.status === 'success' ? '这份资料已经砍到底价' : '砍价已结束';
  } else if (myCutCount >= row.max_cuts_per_user) {
    assistHint = '你已用完本单的助力次数';
  } else if (myCutCount === 0 && helperCount >= row.max_helpers) {
    assistHint = '本单助力人数已满';
  } else {
    canAssist = true;
  }

  const view = {
    id: row.id,
    activityId: row.activity_id,
    status: expired ? 'expired' : row.status,
    statusText: STATUS_TEXT[expired ? 'expired' : row.status] || row.status,
    startPrice: row.start_price_cents,
    currentPrice: row.current_price_cents,
    floorPrice: row.floor_price_cents,
    saved: Math.max(0, row.start_price_cents - row.current_price_cents),
    progress: progressOf(row.start_price_cents, row.current_price_cents, row.floor_price_cents),
    helperCount,
    totalCuts,
    maxHelpers: row.max_helpers,
    maxCutsPerUser: row.max_cuts_per_user,
    remainingHelpers: Math.max(0, row.max_helpers - helperCount),
    expiresAt: row.expires_at,
    expiresIn: secondsLeft(row.expires_at),
    expired,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    durationHours: row.duration_hours,
    material: {
      id: row.material_id,
      title: row.material_title,
      price: row.material_price,
      category: row.material_category,
      school: row.material_school,
      fileName: row.material_file,
      status: row.material_status,
      sellerId: row.seller_id
    },
    owner: {
      id: row.user_id,
      nickname: row.owner_nickname,
      school: row.owner_school
    },
    myCutCount,
    canAssist,
    assistHint,
    canShare: !!viewer && viewer.id === row.user_id && row.status === 'active' && !expired,
    canPurchase: !!viewer && viewer.id === row.user_id && !expired && row.status === 'success' && !purchased,
    purchased,
    purchaseOrderId: row.order_id,
    purchaseOrderStatus: paidOrder ? paidOrder.status : '',
    sharePath: `#/bargain/${row.id}`
  };

  if (opts.helpers !== false) {
    view.helpers = helperRows(row.id).map((s) => ({
      id: s.id,
      helperId: s.helper_id,
      nickname: s.nickname,
      school: s.school,
      cut: s.cut_cents,
      at: s.created_at,
      mine: !!viewer && viewer.id === s.helper_id
    }));
  }
  return view;
}

/** 打开活动详情：优先按 activityId，其次按资料当前进行中的活动 */
function resolveActivity({ activityId, materialId }) {
  if (activityId) return get(`${ACTIVITY_SELECT} WHERE a.id = ?`, activityId);
  if (materialId) {
    return get(
      `${ACTIVITY_SELECT} WHERE a.material_id = ? AND a.status = 'active' ORDER BY a.id DESC LIMIT 1`,
      materialId
    );
  }
  return null;
}

function createOrder(ctx) {
  if (!runtime.feature('bargain')) return fail(ctx.res, 403, '砍价活动暂未开放，请关注平台公告');
  expireOrders();
  const materialId = Number(ctx.body.materialId);
  const activityId = Number(ctx.body.activityId) || 0;
  const activity = resolveActivity({ activityId, materialId });
  if (!activity) return fail(ctx.res, 404, '该资料暂无进行中的砍价活动');
  if (activity.status !== 'active') return fail(ctx.res, 400, '该砍价活动已结束');

  const material = get('SELECT * FROM materials WHERE id = ?', activity.material_id);
  if (!material) return fail(ctx.res, 404, '资料不存在');
  if (material.status !== 'approved') return fail(ctx.res, 400, '该资料暂不可参与砍价');
  if (material.seller_id === ctx.user.id) return fail(ctx.res, 400, '不能对自己的资料发起砍价');
  if (material.price_cents <= 0) return fail(ctx.res, 400, '免费资料无需砍价');

  if (get(
    `SELECT id FROM orders WHERE material_id = ? AND buyer_id = ? AND status IN ('completed','refund_requested')`,
    material.id, ctx.user.id
  )) return fail(ctx.res, 409, '你已购买过该资料，可直接下载');

  const existing = get(
    `SELECT * FROM bargain_orders WHERE activity_id = ? AND user_id = ? AND status = 'active'`,
    activity.id, ctx.user.id
  );
  if (existing) {
    return sendJson(ctx.res, 200, {
      orderId: existing.id,
      existed: true,
      order: orderView(orderRow(existing.id), ctx.user),
      message: '你已发起过该资料的砍价，继续邀请好友助力吧'
    });
  }

  const ts = now();
  const expiresAt = stamp(new Date(Date.now() + activity.duration_hours * 3600 * 1000));
  let info;
  try {
    info = run(
      `INSERT INTO bargain_orders (activity_id, material_id, user_id, start_price_cents, current_price_cents,
         floor_price_cents, max_cuts_per_user, max_helpers, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      activity.id, material.id, ctx.user.id,
      activity.start_price_cents, activity.start_price_cents, activity.floor_price_cents,
      activity.max_cuts_per_user, activity.max_helpers, expiresAt, ts, ts
    );
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      return fail(ctx.res, 409, '你已发起过该资料的砍价，请勿重复创建');
    }
    throw err;
  }

  const id = Number(info.lastInsertRowid);
  sendJson(ctx.res, 201, {
    orderId: id,
    order: orderView(orderRow(id), ctx.user),
    message: '砍价已发起，快分享给好友帮你砍价吧'
  });
}

function detail(ctx) {
  expireOrders();
  const id = Number(ctx.params.id);
  const row = orderRow(id);
  if (!row) return fail(ctx.res, 404, '砍价单不存在或已失效');
  sendJson(ctx.res, 200, {
    order: orderView(row, ctx.user),
    serverTime: now()
  });
}

function materialActivity(ctx) {
  expireOrders();
  const materialId = Number(ctx.params.materialId);
  const activity = get(
    `${ACTIVITY_SELECT} WHERE a.material_id = ? AND a.status = 'active' ORDER BY a.id DESC LIMIT 1`,
    materialId
  );
  let myOrder = null;
  if (ctx.user) {
    const row = get(
      `SELECT id FROM bargain_orders WHERE material_id = ? AND user_id = ?
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'success' THEN 1 ELSE 2 END, id DESC LIMIT 1`,
      materialId, ctx.user.id
    );
    if (row) myOrder = orderView(orderRow(row.id), ctx.user, { helpers: false });
  }
  sendJson(ctx.res, 200, { activity: activityView(activity), myOrder });
}

function mine(ctx) {
  expireOrders();
  const rows = all('SELECT id FROM bargain_orders WHERE user_id = ? ORDER BY id DESC LIMIT 100', ctx.user.id);
  const items = rows.map((r) => orderView(orderRow(r.id), ctx.user, { helpers: false }));
  const counts = { all: items.length, active: 0, success: 0, expired: 0, cancelled: 0 };
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  sendJson(ctx.res, 200, { items, counts });
}

function randomCut(remaining) {
  const ratio = 0.1 + Math.random() * 0.2;
  let cut = Math.round(remaining * ratio);
  if (cut < 1) cut = 1;
  if (cut > remaining) cut = remaining;
  return cut;
}

function assist(ctx) {
  expireOrders();
  const id = Number(ctx.params.id);
  const requestId = String(ctx.body.requestId || '').trim().slice(0, 64);
  const idemKey = requestId || `srv-${crypto.randomBytes(8).toString('hex')}`;

  const row = get('SELECT * FROM bargain_orders WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '砍价单不存在或已失效');

  // 幂等优先：同一用户携带同一 requestId 重复提交，直接返回首次结果
  if (requestId) {
    const dup = get(
      'SELECT * FROM bargain_assists WHERE order_id = ? AND helper_id = ? AND request_id = ?',
      id, ctx.user.id, requestId
    );
    if (dup) {
      return sendJson(ctx.res, 200, {
        duplicated: true,
        cut: dup.cut_cents,
        order: orderView(orderRow(id), ctx.user),
        message: '该次助力已生效，请勿重复提交'
      });
    }
  }

  if (row.user_id === ctx.user.id) return fail(ctx.res, 400, '不能给自己的砍价单助力');
  if (row.status === 'success') return fail(ctx.res, 400, '这份资料已经砍到底价');
  if (row.status !== 'active') return fail(ctx.res, 400, '砍价已结束');
  if (row.expires_at <= now()) return fail(ctx.res, 400, '砍价已过期，请让好友重新发起');

  let outcome;
  try {
    outcome = tx(() => {
      const current = get('SELECT * FROM bargain_orders WHERE id = ?', id);
      if (!current || current.status !== 'active') {
        const err = new Error(current && current.status === 'success' ? '这份资料已经砍到底价' : '砍价已结束');
        err.httpStatus = 400;
        throw err;
      }
      if (current.expires_at <= now()) {
        run("UPDATE bargain_orders SET status = 'expired', updated_at = ? WHERE id = ?", now(), id);
        const err = new Error('砍价已过期，请让好友重新发起');
        err.httpStatus = 400;
        throw err;
      }

      const mineCount = get(
        'SELECT COUNT(*) AS c FROM bargain_assists WHERE order_id = ? AND helper_id = ?',
        id, ctx.user.id
      ).c;
      if (mineCount >= current.max_cuts_per_user) {
        const err = new Error('你已用完本单的助力次数');
        err.httpStatus = 429;
        throw err;
      }
      const helperCount = get(
        'SELECT COUNT(DISTINCT helper_id) AS c FROM bargain_assists WHERE order_id = ?', id
      ).c;
      if (mineCount === 0 && helperCount >= current.max_helpers) {
        const err = new Error('本单助力人数已满');
        err.httpStatus = 400;
        throw err;
      }

      const remaining = Math.max(0, current.current_price_cents - current.floor_price_cents);
      if (remaining <= 0) {
        run("UPDATE bargain_orders SET status = 'success', updated_at = ? WHERE id = ? AND status = 'active'", now(), id);
        const err = new Error('这份资料已经砍到底价');
        err.httpStatus = 400;
        throw err;
      }

      // 最后一位有效助力者直接砍到底价，保证「人数上限 = 必达底价」
      const helperCountAfter = mineCount === 0 ? helperCount + 1 : helperCount;
      const willFinish = helperCountAfter >= current.max_helpers;
      const cut = willFinish ? remaining : Math.min(remaining, randomCut(remaining));
      const nextPrice = Math.max(current.floor_price_cents, current.current_price_cents - cut);
      const nextStatus = nextPrice <= current.floor_price_cents ? 'success' : 'active';
      const ts = now();

      // 乐观更新：价格被其他请求改动时放弃本次写入，避免超砍
      const updated = run(
        `UPDATE bargain_orders SET current_price_cents = ?, status = ?, updated_at = ?
         WHERE id = ? AND status = 'active' AND current_price_cents = ?`,
        nextPrice, nextStatus, ts, id, current.current_price_cents
      );
      if (!updated.changes) {
        const err = new Error('助力人数较多，请稍后重试');
        err.httpStatus = 409;
        throw err;
      }

      const actual = current.current_price_cents - nextPrice;
      const info = run(
        `INSERT INTO bargain_assists (order_id, helper_id, cut_cents, seq, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id, ctx.user.id, actual, mineCount + 1, idemKey, ts
      );

      return {
        assistId: Number(info.lastInsertRowid),
        cut: actual,
        completed: nextStatus === 'success'
      };
    });
  } catch (err) {
    if (err && err.httpStatus) return fail(ctx.res, err.httpStatus, err.message);
    if (String(err.message || '').includes('UNIQUE')) return fail(ctx.res, 409, '该次助力已生效，请勿重复提交');
    throw err;
  }

  sendJson(ctx.res, 200, {
    duplicated: false,
    assistId: outcome.assistId,
    cut: outcome.cut,
    completed: outcome.completed,
    order: orderView(orderRow(id), ctx.user),
    message: outcome.completed
      ? `助力成功，已砍掉 ¥${(outcome.cut / 100).toFixed(2)}，砍价直接到底价！`
      : `助力成功，砍掉 ¥${(outcome.cut / 100).toFixed(2)}`
  });
}

async function purchase(ctx) {
  if (!isVerified(ctx.user)) return fail(ctx.res, 403, '请先完成实名认证与高校认证后再购买');
  expireOrders();
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM bargain_orders WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '砍价单不存在或已失效');
  if (row.user_id !== ctx.user.id) return fail(ctx.res, 403, '只有发起人可以按砍价价购买');
  if (row.status !== 'success') return fail(ctx.res, 400, '砍价尚未完成，暂时无法购买');

  const channelCode = String(ctx.body.channel || '').trim();
  const channel = gateway.getChannel(channelCode);
  if (!channel) return fail(ctx.res, 400, '请选择微信支付、支付宝或银行卡支付');

  const material = get('SELECT * FROM materials WHERE id = ?', row.material_id);
  if (!material) return fail(ctx.res, 404, '资料不存在');
  if (material.status !== 'approved') return fail(ctx.res, 400, '该资料暂不可购买');

  if (get(
    `SELECT id FROM orders WHERE material_id = ? AND buyer_id = ? AND status IN ('completed','refund_requested')`,
    material.id, ctx.user.id
  )) return fail(ctx.res, 409, '你已购买过该资料，可直接下载');

  // 金额完全取自服务端砍价单快照，拒绝前端传入价格
  const amount = Math.max(1, row.current_price_cents);
  const linked = row.order_id ? get('SELECT * FROM orders WHERE id = ?', row.order_id) : null;

  let orderId;
  if (linked && linked.status === 'pending_payment') {
    orderId = linked.id;
    run(`UPDATE payments SET status = 'closed', failure_code = 'SWITCHED', failure_message = '用户切换支付方式' WHERE order_id = ? AND status = 'pending'`, orderId);
    run('UPDATE orders SET payment_channel = ?, amount_cents = ?, commission_cents = ? WHERE id = ?',
      channelCode, amount, Math.round(amount * 0.1), orderId);
  } else {
    const info = run(
      `INSERT INTO orders (material_id, buyer_id, seller_id, amount_cents, commission_cents, status, payment_channel, bargain_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?)`,
      material.id, ctx.user.id, material.seller_id, amount, Math.round(amount * 0.1), channelCode, id, now()
    );
    orderId = Number(info.lastInsertRowid);
    run('UPDATE bargain_orders SET order_id = ?, updated_at = ? WHERE id = ?', orderId, now(), id);
  }

  const created = await gateway.createPayment({
    userId: ctx.user.id,
    orderId,
    purpose: 'order',
    channelCode,
    amountCents: amount
  });
  if (created.error) {
    run(`UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending_payment'`, orderId);
    return fail(ctx.res, 400, created.error);
  }

  sendJson(ctx.res, 201, {
    orderId,
    bargainId: id,
    channel: channelCode,
    status: 'pending_payment',
    amount,
    payment: gateway.serialize(created.row),
    payPayload: created.payload,
    mockMode: gateway.mode() === 'mock',
    message: '砍价专享价支付单已创建，请在有效期内完成支付'
  });
}

/* ------------------------------ 管理后台 ------------------------------ */

function adminList(ctx) {
  expireOrders();
  const rows = all(
    `SELECT a.*, m.title AS material_title, m.price_cents AS material_price,
       m.category AS material_category, m.school AS material_school,
       m.file_name AS material_file, m.status AS material_status,
       (SELECT COUNT(*) FROM bargain_orders b WHERE b.activity_id = a.id) AS total_orders,
       (SELECT COUNT(*) FROM bargain_orders b WHERE b.activity_id = a.id AND b.status = 'active') AS active_orders,
       (SELECT COUNT(*) FROM bargain_orders b WHERE b.activity_id = a.id AND b.status = 'success') AS success_orders,
       (SELECT COUNT(DISTINCT s.helper_id) FROM bargain_assists s
          JOIN bargain_orders b ON b.id = s.order_id WHERE b.activity_id = a.id) AS participants
     FROM bargain_activities a JOIN materials m ON m.id = a.material_id
     ORDER BY CASE a.status WHEN 'active' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 200`
  );
  const materials = all(
    `SELECT m.id, m.title, m.price_cents, m.category, m.school, m.status, u.nickname AS seller_nickname
     FROM materials m JOIN users u ON u.id = m.seller_id
     WHERE m.status = 'approved' ORDER BY m.title ASC LIMIT 500`
  );
  const counts = {
    total: rows.length,
    active: rows.filter((r) => r.status === 'active').length,
    offline: rows.filter((r) => r.status !== 'active').length,
    orders: get('SELECT COUNT(*) AS c FROM bargain_orders').c,
    success: get("SELECT COUNT(*) AS c FROM bargain_orders WHERE status = 'success'").c,
    participants: get('SELECT COUNT(DISTINCT helper_id) AS c FROM bargain_assists').c
  };
  sendJson(ctx.res, 200, {
    items: rows.map(activityView),
    materials: materials.map((m) => ({
      id: m.id, title: m.title, price: m.price_cents, category: m.category,
      school: m.school, sellerNickname: m.seller_nickname
    })),
    counts
  });
}

function parseRules(body, base) {
  const start = body.startPrice === undefined ? base.start : Math.round(Number(body.startPrice) * 100);
  const floor = body.floorPrice === undefined ? base.floor : Math.round(Number(body.floorPrice) * 100);
  const durationHours = body.durationHours === undefined ? base.hours : Number(body.durationHours);
  const maxCutsPerUser = body.maxCutsPerUser === undefined ? base.cuts : Number(body.maxCutsPerUser);
  const maxHelpers = body.maxHelpers === undefined ? base.helpers : Number(body.maxHelpers);
  const status = body.status === undefined ? base.status : String(body.status);

  if (!Number.isFinite(start) || !Number.isFinite(floor)) return { error: '请填写有效的初始价与底价' };
  if (floor < 100) return { error: '目标底价不得低于 ¥1.00' };
  if (start <= floor) return { error: '初始价必须高于目标底价' };
  if (!Number.isInteger(durationHours) || durationHours < 1 || durationHours > 720) return { error: '有效期需为 1—720 小时的整数' };
  if (!Number.isInteger(maxCutsPerUser) || maxCutsPerUser < 1 || maxCutsPerUser > 10) return { error: '单个用户可砍次数需为 1—10 的整数' };
  if (!Number.isInteger(maxHelpers) || maxHelpers < 1 || maxHelpers > 100) return { error: '最大助力人数需为 1—100 的整数' };
  if (!['active', 'offline'].includes(status)) return { error: '活动状态不合法' };
  return { start, floor, durationHours, maxCutsPerUser, maxHelpers, status };
}

function adminCreate(ctx) {
  const materialId = Number(ctx.body.materialId);
  const material = get('SELECT * FROM materials WHERE id = ?', materialId);
  if (!material) return fail(ctx.res, 404, '资料不存在');
  if (material.status !== 'approved') return fail(ctx.res, 400, '仅已上架资料可创建砍价活动');
  if (material.price_cents <= 0) return fail(ctx.res, 400, '免费资料无需创建砍价活动');

  const rules = parseRules(ctx.body, { start: material.price_cents, floor: 0, hours: 48, cuts: 1, helpers: 5, status: 'active' });
  if (rules.error) return fail(ctx.res, 400, rules.error);
  if (rules.start > material.price_cents) return fail(ctx.res, 400, '初始价不应高于资料当前售价');

  if (rules.status === 'active' && get(
    `SELECT id FROM bargain_activities WHERE material_id = ? AND status = 'active'`, materialId
  )) return fail(ctx.res, 409, '该资料已有进行中的砍价活动，请先下架或编辑原活动');

  const ts = now();
  const info = run(
    `INSERT INTO bargain_activities (material_id, start_price_cents, floor_price_cents, duration_hours,
       max_cuts_per_user, max_helpers, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    materialId, rules.start, rules.floor, rules.durationHours,
    rules.maxCutsPerUser, rules.maxHelpers, rules.status, ctx.user.id, ts, ts
  );
  const created = get(`${ACTIVITY_SELECT} WHERE a.id = ?`, Number(info.lastInsertRowid));
  sendJson(ctx.res, 201, { item: activityView(created), message: '砍价活动已创建' });
}

function adminUpdate(ctx) {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM bargain_activities WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '砍价活动不存在');

  const rules = parseRules(ctx.body, {
    start: row.start_price_cents,
    floor: row.floor_price_cents,
    hours: row.duration_hours,
    cuts: row.max_cuts_per_user,
    helpers: row.max_helpers,
    status: row.status
  });
  if (rules.error) return fail(ctx.res, 400, rules.error);

  const material = get('SELECT * FROM materials WHERE id = ?', row.material_id);
  if (rules.start > material.price_cents) return fail(ctx.res, 400, '初始价不应高于资料当前售价');
  if (rules.status === 'active' && row.status !== 'active' && get(
    `SELECT id FROM bargain_activities WHERE material_id = ? AND status = 'active' AND id != ?`,
    row.material_id, id
  )) return fail(ctx.res, 409, '该资料已有其他进行中的砍价活动');

  run(
    `UPDATE bargain_activities SET start_price_cents = ?, floor_price_cents = ?, duration_hours = ?,
       max_cuts_per_user = ?, max_helpers = ?, status = ?, updated_at = ? WHERE id = ?`,
    rules.start, rules.floor, rules.durationHours, rules.maxCutsPerUser,
    rules.maxHelpers, rules.status, now(), id
  );
  const updated = get(`${ACTIVITY_SELECT} WHERE a.id = ?`, id);
  sendJson(ctx.res, 200, { item: activityView(updated), message: '砍价活动已更新' });
}

function adminDelete(ctx) {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM bargain_activities WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '砍价活动不存在');
  if (get('SELECT COUNT(*) AS c FROM bargain_orders WHERE activity_id = ?', id).c > 0) {
    return fail(ctx.res, 409, '该活动已产生砍价单，请改为下架');
  }
  run('DELETE FROM bargain_activities WHERE id = ?', id);
  sendJson(ctx.res, 200, { message: '砍价活动已删除' });
}

module.exports = {
  createOrder,
  detail,
  materialActivity,
  mine,
  assist,
  purchase,
  adminList,
  adminCreate,
  adminUpdate,
  adminDelete
};
