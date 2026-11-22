'use strict';

const { all, get, run, tx, now } = require('./db');
const { sendJson, fail } = require('./http');
const contentAudit = require('./content-audit');
const settlements = require('./settlements');
const ledger = require('./ledger');
const idempotency = require('./idempotency');
const channels = require('./channels');
const gateway = require('./payment-gateway');

function overview(ctx) {
  const gmv = get(`SELECT COALESCE(SUM(amount_cents),0) AS c FROM orders WHERE status IN ('completed','refund_requested')`).c;
  const revenue = get(`SELECT COALESCE(SUM(commission_cents),0) AS c FROM orders WHERE status = 'completed'`).c;
  const series = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date();
    day.setDate(day.getDate() - i);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const row = get(
      `SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents),0) AS gmv FROM orders
       WHERE status IN ('completed','refund_requested') AND substr(created_at,1,10) = ?`, key
    );
    series.push({ date: key.slice(5), count: row.c, gmv: row.gmv });
  }
  const topMaterials = all(
    `SELECT m.id, m.title, m.category, COUNT(o.id) AS sold, COALESCE(SUM(o.amount_cents),0) AS gmv
     FROM materials m JOIN orders o ON o.material_id = m.id AND o.status IN ('completed','refund_requested')
     GROUP BY m.id ORDER BY gmv DESC LIMIT 6`
  );
  sendJson(ctx.res, 200, {
    stats: {
      users: get('SELECT COUNT(*) AS c FROM users').c,
      sellers: get('SELECT COUNT(DISTINCT seller_id) AS c FROM materials').c,
      materials: get(`SELECT COUNT(*) AS c FROM materials WHERE status = 'approved'`).c,
      pendingMaterials: get(`SELECT COUNT(*) AS c FROM materials WHERE status = 'pending'`).c,
      pendingAuditReviews: get(`SELECT COUNT(*) AS c FROM materials WHERE status = 'pending' AND audit_verdict IN ('review', 'error')`).c,
      blockedSubmissions: get(`SELECT COUNT(*) AS c FROM audit_logs WHERE verdict = 'block'`).c,
      orders: get(`SELECT COUNT(*) AS c FROM orders WHERE status IN ('completed','refund_requested')`).c,
      gmv,
      revenue,
      downloads: get('SELECT COALESCE(SUM(downloads),0) AS c FROM materials').c,
      pendingReports: get(`SELECT COUNT(*) AS c FROM reports WHERE status = 'pending'`).c,
      pendingRefunds: get(`SELECT COUNT(*) AS c FROM orders WHERE status = 'refund_requested'`).c,
      pendingVerifications: get(`SELECT COUNT(*) AS c FROM users WHERE verify_status = 'pending'`).c,
      openTickets: get(`SELECT COUNT(*) AS c FROM tickets WHERE status IN ('open','processing')`).c
    },
    series,
    topMaterials,
    recent: {
      materials: all(
        `SELECT m.id, m.title, m.status, m.created_at, u.nickname FROM materials m JOIN users u ON u.id = m.seller_id
         ORDER BY m.created_at DESC LIMIT 6`
      ),
      orders: all(
        `SELECT o.id, o.amount_cents, o.created_at, m.title, b.nickname AS buyer FROM orders o
         JOIN materials m ON m.id = o.material_id JOIN users b ON b.id = o.buyer_id
         ORDER BY o.created_at DESC LIMIT 6`
      )
    }
  });
}

function materials(ctx) {
  const status = String(ctx.query.status || 'all');
  const q = String(ctx.query.q || '').trim();
  const where = [];
  const params = [];
  if (status !== 'all') { where.push('m.status = ?'); params.push(status); }
  if (q) { where.push('(m.title LIKE ? OR u.nickname LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(
    `SELECT m.*, u.nickname AS seller_nickname, u.school AS seller_school,
       (SELECT COUNT(*) FROM reports r WHERE r.material_id = m.id AND r.status = 'pending') AS pending_reports
     FROM materials m JOIN users u ON u.id = m.seller_id
     ${whereSql} ORDER BY CASE m.status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END, m.created_at DESC
     LIMIT 200`, ...params
  );
  sendJson(ctx.res, 200, {
    items: rows.map((m) => ({
      id: m.id, title: m.title, category: m.category, school: m.school,
      subject: m.subject, teacher: m.teacher, price: m.price_cents,
      priceSource: m.price_source, priceNote: m.price_note,
      status: m.status, rejectReason: m.reject_reason, fileName: m.file_name, fileSize: m.file_size,
      downloads: m.downloads, createdAt: m.created_at, seller: { nickname: m.seller_nickname, school: m.seller_school },
      pendingReports: m.pending_reports,
      audit: {
        verdict: m.audit_verdict || '',
        score: m.audit_score || 0,
        status: m.audit_status || '',
        at: m.audit_at || '',
        hits: (() => { try { return JSON.parse(m.audit_hits || '[]'); } catch { return []; } })()
      }
    })),
    counts: {
      pending: get(`SELECT COUNT(*) AS c FROM materials WHERE status = 'pending'`).c,
      autoReview: get(`SELECT COUNT(*) AS c FROM materials WHERE status = 'pending' AND audit_verdict IN ('review', 'error')`).c,
      approved: get(`SELECT COUNT(*) AS c FROM materials WHERE status = 'approved'`).c,
      rejected: get(`SELECT COUNT(*) AS c FROM materials WHERE status = 'rejected'`).c,
      offline: get(`SELECT COUNT(*) AS c FROM materials WHERE status = 'offline'`).c
    }
  });
}

function reviewMaterial(ctx) {
  const id = Number(ctx.params.id);
  const material = get('SELECT * FROM materials WHERE id = ?', id);
  if (!material) return fail(ctx.res, 404, '资料不存在');
  const action = String(ctx.body.action || '');
  const reason = String(ctx.body.reason || '').trim();
  if (action === 'approve') {
    run(`UPDATE materials SET status = 'approved', reject_reason = '', updated_at = ? WHERE id = ?`, now(), id);
    contentAudit.markReviewed(id, 'approve', `管理员 ${ctx.user.nickname} 通过审核`);
    return sendJson(ctx.res, 200, { message: '已通过审核，资料已在市场展示' });
  }
  if (action === 'reject') {
    if (!reason) return fail(ctx.res, 400, '请填写驳回原因，便于卖家修改');
    run(`UPDATE materials SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ?`, reason, now(), id);
    contentAudit.markReviewed(id, 'reject', reason);
    return sendJson(ctx.res, 200, { message: '已驳回，卖家可在卖家中心查看原因' });
  }
  if (action === 'offline') {
    run(`UPDATE materials SET status = 'offline', reject_reason = ?, updated_at = ? WHERE id = ?`, reason || '平台下架', now(), id);
    contentAudit.markReviewed(id, 'reject', reason || '平台下架');
    return sendJson(ctx.res, 200, { message: '资料已下架' });
  }
  fail(ctx.res, 400, '未知操作');
}

function users(ctx) {
  const q = String(ctx.query.q || '').trim();
  const params = [];
  let where = '';
  if (q) { where = 'WHERE u.nickname LIKE ? OR u.email LIKE ? OR u.username LIKE ?'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = all(
    `SELECT u.*,
      (SELECT COUNT(*) FROM materials m WHERE m.seller_id = u.id) AS material_count,
      (SELECT COALESCE(SUM(amount_cents - commission_cents),0) FROM orders o WHERE o.seller_id = u.id AND o.status = 'completed') AS income,
      (SELECT COALESCE(SUM(amount_cents),0) FROM orders o WHERE o.buyer_id = u.id AND o.status = 'completed') AS spend
     FROM users u ${where} ORDER BY u.created_at DESC LIMIT 200`, ...params
  );
  sendJson(ctx.res, 200, {
    items: rows.map((u) => ({
      id: u.id, nickname: u.nickname, username: u.username, email: u.email, school: u.school,
      role: u.role, status: u.status, balance: u.balance_cents, createdAt: u.created_at,
      realName: u.real_name, studentNo: u.student_no, verifyStatus: u.verify_status,
      verifyNote: u.verify_note, verifiedAt: u.verified_at,
      materialCount: u.material_count, income: u.income, spend: u.spend
    }))
  });
}

function adjustMaterialPrice(ctx) {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM materials WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '资料不存在');
  const price = Number(ctx.body.price);
  const note = String(ctx.body.note || '').trim();
  if (!Number.isFinite(price) || price < 0 || price > 999) return fail(ctx.res, 400, '价格需在 0—999 元之间');
  if (note.length > 100) return fail(ctx.res, 400, '调价说明不能超过 100 字');
  run(
    `UPDATE materials SET price_cents = ?, price_source = 'admin', price_note = ?, updated_at = ? WHERE id = ?`,
    Math.round(price * 100), note || '平台运营校准', now(), id
  );
  sendJson(ctx.res, 200, { message: '资料价格已校准，卖家可在卖家中心查看说明' });
}

function verifications(ctx) {
  const status = String(ctx.query.status || 'pending');
  const rows = all(
    `SELECT * FROM users WHERE verify_status = ? ORDER BY created_at DESC LIMIT 200`, status
  );
  sendJson(ctx.res, 200, {
    items: rows.map((u) => ({
      id: u.id, nickname: u.nickname, username: u.username, email: u.email,
      school: u.school, realName: u.real_name, studentNo: u.student_no,
      verifyStatus: u.verify_status, verifyNote: u.verify_note, verifiedAt: u.verified_at,
      createdAt: u.created_at,
      materialCount: get('SELECT COUNT(*) AS c FROM materials WHERE seller_id = ?', u.id).c
    })),
    counts: {
      pending: get(`SELECT COUNT(*) AS c FROM users WHERE verify_status = 'pending'`).c,
      verified: get(`SELECT COUNT(*) AS c FROM users WHERE verify_status = 'verified'`).c,
      rejected: get(`SELECT COUNT(*) AS c FROM users WHERE verify_status = 'rejected'`).c,
      none: get(`SELECT COUNT(*) AS c FROM users WHERE verify_status = 'none'`).c
    }
  });
}

function reviewVerification(ctx) {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM users WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '用户不存在');
  if (row.verify_status !== 'pending') return fail(ctx.res, 409, '该申请不在待审核状态');
  const action = String(ctx.body.action || '');
  if (action === 'approve') {
    run(
      `UPDATE users SET verify_status = 'verified', verify_note = '', verified_at = ? WHERE id = ?`,
      now(), id
    );
    return sendJson(ctx.res, 200, { message: '认证已通过，用户将获得资料买卖权限并默认进入本校专区' });
  }
  if (action === 'reject') {
    const note = String(ctx.body.note || '').trim();
    if (!note) return fail(ctx.res, 400, '请填写驳回原因，便于用户重新提交');
    run(`UPDATE users SET verify_status = 'rejected', verify_note = ?, verified_at = NULL WHERE id = ?`, note, id);
    return sendJson(ctx.res, 200, { message: '已驳回认证申请' });
  }
  fail(ctx.res, 400, '未知操作');
}

function setUserStatus(ctx) {
  const id = Number(ctx.params.id);
  const status = String(ctx.body.status || '');
  if (!['active', 'banned'].includes(status)) return fail(ctx.res, 400, '状态不合法');
  const user = get('SELECT * FROM users WHERE id = ?', id);
  if (!user) return fail(ctx.res, 404, '用户不存在');
  if (user.role === 'admin') return fail(ctx.res, 400, '不能限制管理员账号');
  if (user.id === ctx.user.id) return fail(ctx.res, 400, '不能操作自己的账号');
  run('UPDATE users SET status = ? WHERE id = ?', status, id);
  sendJson(ctx.res, 200, { message: status === 'banned' ? '账号已限制登录' : '账号已恢复正常' });
}

function reports(ctx) {
  const status = String(ctx.query.status || 'pending');
  const rows = all(
    `SELECT r.*, m.title, m.status AS material_status, u.nickname AS reporter, s.nickname AS seller
     FROM reports r
     JOIN materials m ON m.id = r.material_id
     JOIN users u ON u.id = r.reporter_id
     JOIN users s ON s.id = m.seller_id
     ${status === 'all' ? '' : 'WHERE r.status = ?'} ORDER BY r.created_at DESC LIMIT 100`,
    ...(status === 'all' ? [] : [status])
  );
  sendJson(ctx.res, 200, {
    items: rows.map((r) => ({
      id: r.id, reason: r.reason, detail: r.detail, status: r.status, createdAt: r.created_at,
      reporter: r.reporter, seller: r.seller,
      material: { id: r.material_id, title: r.title, status: r.material_status }
    })),
    pending: get(`SELECT COUNT(*) AS c FROM reports WHERE status = 'pending'`).c
  });
}

function resolveReport(ctx) {
  const id = Number(ctx.params.id);
  const report = get('SELECT * FROM reports WHERE id = ?', id);
  if (!report) return fail(ctx.res, 404, '举报不存在');
  const action = String(ctx.body.action || '');
  if (action === 'dismiss') {
    run(`UPDATE reports SET status = 'dismissed' WHERE id = ?`, id);
    return sendJson(ctx.res, 200, { message: '举报已驳回，资料保持正常展示' });
  }
  if (action === 'takedown') {
    tx(() => {
      run(`UPDATE reports SET status = 'resolved' WHERE id = ?`, id);
      run(`UPDATE materials SET status = 'offline', reject_reason = ?, updated_at = ? WHERE id = ?`,
        `平台核实下架：${report.reason}`, now(), report.material_id);
      run(`UPDATE reports SET status = 'resolved' WHERE material_id = ? AND status = 'pending'`, report.material_id);
    });
    return sendJson(ctx.res, 200, { message: '资料已下架，相关举报已处理' });
  }
  fail(ctx.res, 400, '未知操作');
}

function refunds(ctx) {
  const rows = all(
    `SELECT o.*, m.title, b.nickname AS buyer, s.nickname AS seller
     FROM orders o JOIN materials m ON m.id = o.material_id
     JOIN users b ON b.id = o.buyer_id JOIN users s ON s.id = o.seller_id
     WHERE o.status = 'refund_requested' ORDER BY o.created_at DESC`
  );
  sendJson(ctx.res, 200, {
    items: rows.map((o) => ({
      id: o.id, amount: o.amount_cents, createdAt: o.created_at, buyer: o.buyer, seller: o.seller,
      material: { id: o.material_id, title: o.title }
    }))
  });
}

async function resolveRefund(ctx) {
  const replay = idempotency.replay(ctx, 'admin.refund');
  if (replay) return sendJson(ctx.res, replay.statusCode, replay.data);
  const id = Number(ctx.params.id);
  const order = get('SELECT * FROM orders WHERE id = ?', id);
  if (!order) return fail(ctx.res, 404, '订单不存在');
  if (order.status !== 'refund_requested') return fail(ctx.res, 400, '该订单当前不可处理');
  const action = String(ctx.body.action || '');
  if (action === 'approve') {
    const paidPayment = get(
      "SELECT * FROM payments WHERE order_id = ? AND status IN ('paid', 'refunded') ORDER BY id DESC LIMIT 1", id
    );
    // 真实模式必须先取得渠道退款受理结果，再变更本地订单与账本
    if (gateway.mode() === 'live' && paidPayment && paidPayment.status === 'paid') {
      let payload = {};
      try {
        payload = JSON.parse(paidPayment.channel_payload || '{}');
      } catch {
        payload = {};
      }
      try {
        await channels.refund(paidPayment.channel, {
          paymentNo: paidPayment.payment_no,
          refundNo: `REFUND-${id}`,
          refundCents: order.amount_cents,
          totalCents: order.amount_cents,
          queryId: paidPayment.channel_trade_no,
          txnTime: payload.txnTime,
          reason: '用户申请退款'
        });
      } catch (err) {
        return fail(ctx.res, 502, `渠道退款失败：${err.message}`);
      }
    }
    tx(() => {
      run(`UPDATE orders SET status = 'refunded' WHERE id = ?`, id);
      const sellerIncome = order.amount_cents - order.commission_cents;
      run('UPDATE users SET balance_cents = MAX(0, balance_cents - ?) WHERE id = ?', sellerIncome, order.seller_id);
      run(
        `UPDATE payments SET status = 'refunded', failure_code = 'REFUNDED', failure_message = '订单已退款'
         WHERE order_id = ? AND status = 'paid'`, id
      );
      // 只有真实支付流水才写退款凭证，避免为演示种子订单凭空记账
      if (paidPayment) ledger.recordOrderRefund(order);
      settlements.cancelForOrder(id);
    });
    const payload = { message: '退款已通过，款项将按原支付渠道退回（T+1 到账），卖家结算已取消' };
    idempotency.remember(ctx, 'admin.refund', 200, payload);
    return sendJson(ctx.res, 200, payload);
  }
  if (action === 'reject') {
    run(`UPDATE orders SET status = 'completed' WHERE id = ?`, id);
    const payload = { message: '已驳回退款申请，订单恢复正常' };
    idempotency.remember(ctx, 'admin.refund', 200, payload);
    return sendJson(ctx.res, 200, payload);
  }
  fail(ctx.res, 400, '未知操作');
}

function announcements(ctx) {
  const rows = all('SELECT * FROM announcements ORDER BY created_at DESC');
  sendJson(ctx.res, 200, { items: rows });
}

function createAnnouncement(ctx) {
  const title = String(ctx.body.title || '').trim();
  const content = String(ctx.body.content || '').trim();
  const tag = String(ctx.body.tag || '公告').trim();
  if (title.length < 2 || title.length > 60) return fail(ctx.res, 400, '标题需为 2—60 个字符');
  if (content.length < 5) return fail(ctx.res, 400, '公告内容太短');
  run(
    `INSERT INTO announcements (title, content, tag, active, created_at) VALUES (?, ?, ?, 1, ?)`,
    title, content, tag, now()
  );
  sendJson(ctx.res, 201, { message: '公告已发布' });
}

function updateAnnouncement(ctx) {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM announcements WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '公告不存在');
  const title = String(ctx.body.title ?? row.title).trim();
  const content = String(ctx.body.content ?? row.content).trim();
  const tag = String(ctx.body.tag ?? row.tag).trim();
  const active = ctx.body.active === undefined ? row.active : (ctx.body.active ? 1 : 0);
  if (title.length < 2 || title.length > 60) return fail(ctx.res, 400, '标题需为 2—60 个字符');
  if (content.length < 5) return fail(ctx.res, 400, '公告内容太短');
  run('UPDATE announcements SET title = ?, content = ?, tag = ?, active = ? WHERE id = ?', title, content, tag, active, id);
  sendJson(ctx.res, 200, { message: '公告已更新' });
}

function deleteAnnouncement(ctx) {
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM announcements WHERE id = ?', id)) return fail(ctx.res, 404, '公告不存在');
  run('DELETE FROM announcements WHERE id = ?', id);
  sendJson(ctx.res, 200, { message: '公告已删除' });
}

module.exports = {
  overview, materials, reviewMaterial, adjustMaterialPrice, users, setUserStatus,
  verifications, reviewVerification,
  reports, resolveReport,
  refunds, resolveRefund,
  announcements, createAnnouncement, updateAnnouncement, deleteAnnouncement
};
