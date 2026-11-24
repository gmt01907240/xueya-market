'use strict';

const { all, get, run, now } = require('./db');
const { sendJson, fail } = require('./http');
const runtime = require('./runtime-config');
const communityApi = require('./api-community');
const contentAudit = require('./content-audit');

const TICKET_TYPES = ['bug', 'suggestion', 'complaint', 'consult', 'other'];
const STATUSES = ['open', 'processing', 'resolved', 'closed'];
const STATUS_TEXT = {
  open: '待处理',
  processing: '处理中',
  resolved: '已解决',
  closed: '已关闭'
};

const BASE_SELECT = `
  SELECT t.*, u.nickname AS user_nickname, u.school AS user_school,
         tu.nickname AS target_nickname, m.title AS material_title,
         (SELECT COUNT(*) FROM ticket_replies r WHERE r.ticket_id = t.id) AS reply_count
  FROM tickets t
  JOIN users u ON u.id = t.user_id
  LEFT JOIN users tu ON tu.id = t.target_user_id
  LEFT JOIN materials m ON m.id = t.material_id
`;

function serialize(t, viewer) {
  const isOwner = viewer && t.user_id === viewer.id;
  const isStaff = viewer && (viewer.role === 'admin' || t.target_user_id === viewer.id);
  return {
    id: t.id,
    kind: t.kind,
    type: t.ticket_type,
    title: t.title,
    content: t.content,
    status: t.status,
    statusText: STATUS_TEXT[t.status] || t.status,
    priority: t.priority,
    materialId: t.material_id,
    materialTitle: t.material_title || '',
    targetUserId: t.target_user_id,
    targetName: t.target_nickname || '',
    user: { id: t.user_id, nickname: t.user_nickname || '', school: t.user_school || '' },
    replyCount: t.reply_count || 0,
    unread: isOwner ? t.user_unread : (isStaff ? t.staff_unread : 0),
    userUnread: isOwner ? t.user_unread : 0,
    staffUnread: isStaff ? t.staff_unread : 0,
    createdAt: t.created_at,
    updatedAt: t.updated_at
  };
}

function canView(t, user) {
  return user.role === 'admin' || t.user_id === user.id || t.target_user_id === user.id;
}

function isStaffFor(t, user) {
  return user.role === 'admin' || t.target_user_id === user.id;
}

function list(ctx) {
  const user = ctx.user;
  const scope = String(ctx.query.scope || 'mine');
  const status = String(ctx.query.status || '').trim();
  const kind = String(ctx.query.kind || '').trim();
  const where = [];
  const params = [];
  if (scope === 'admin' && user.role === 'admin') {
    where.push('1 = 1');
  } else if (scope === 'staff') {
    where.push("t.kind = 'official' AND t.target_user_id = ?");
    params.push(user.id);
  } else {
    where.push("t.user_id = ? AND t.kind = 'official'");
    params.push(user.id);
  }
  if (status) { where.push('t.status = ?'); params.push(status); }
  if (kind) { where.push('t.kind = ?'); params.push(kind); }
  const rows = all(
    `${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.updated_at DESC LIMIT 100`,
    ...params
  );
  const counts = { open: 0, processing: 0, resolved: 0, closed: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  sendJson(ctx.res, 200, { items: rows.map((t) => serialize(t, user)), counts, scope });
}

function unread(ctx) {
  const user = ctx.user;
  const mine = get(
    "SELECT COALESCE(SUM(user_unread), 0) AS c FROM tickets WHERE user_id = ? AND kind = 'official'", user.id
  ).c;
  let staff = 0;
  if (user.role === 'admin') {
    staff = get("SELECT COALESCE(SUM(staff_unread), 0) AS c FROM tickets WHERE kind = 'official'").c;
  } else {
    staff = get(
      "SELECT COALESCE(SUM(staff_unread), 0) AS c FROM tickets WHERE kind = 'official' AND target_user_id = ?", user.id
    ).c;
  }
  sendJson(ctx.res, 200, { user: mine, staff, total: mine + staff });
}

function detail(ctx) {
  const id = Number(ctx.params.id);
  const t = get(`${BASE_SELECT} WHERE t.id = ?`, id);
  if (!t) return fail(ctx.res, 404, '工单不存在');
  if (!canView(t, ctx.user)) return fail(ctx.res, 403, '无权查看该工单');

  if (t.user_id === ctx.user.id) run('UPDATE tickets SET user_unread = 0 WHERE id = ?', id);
  if (isStaffFor(t, ctx.user)) {
    if (ctx.user.role !== 'admin' || t.kind === 'official') {
      run('UPDATE tickets SET staff_unread = 0 WHERE id = ?', id);
    }
  }
  const refreshed = get(`${BASE_SELECT} WHERE t.id = ?`, id);
  const replies = all(
    `SELECT r.*, u.nickname, u.role AS author_role FROM ticket_replies r
     JOIN users u ON u.id = r.author_id WHERE r.ticket_id = ? ORDER BY r.id ASC`, id
  );
  sendJson(ctx.res, 200, {
    ticket: serialize(refreshed, ctx.user),
    replies: replies.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
      author: { id: r.author_id, nickname: r.nickname, role: r.author_role }
    }))
  });
}

function create(ctx) {
  if (!runtime.feature('tickets')) return fail(ctx.res, 403, '工单功能暂未开放');
  const user = ctx.user;
  const body = ctx.body;

  // 兼容旧版「咨询卖家客服」入口：统一写入会话，不再生成独立工单
  if (body.kind === 'seller') {
    const content = String(body.content || '').trim();
    if (content.length < 5) return fail(ctx.res, 400, '请详细描述你的问题（至少 5 个字）');
    if (content.length > 1000) return fail(ctx.res, 400, '内容不能超过 1000 字');
    const mid = Number(body.materialId) || null;
    let targetUserId = Number(body.targetUserId) || 0;
    if (mid) {
      const material = get('SELECT id, seller_id FROM materials WHERE id = ?', mid);
      if (!material) return fail(ctx.res, 404, '资料不存在');
      if (material.seller_id === user.id) return fail(ctx.res, 400, '不能咨询自己发布的资料');
      targetUserId = material.seller_id;
    } else if (targetUserId) {
      if (targetUserId === user.id) return fail(ctx.res, 400, '不能咨询自己');
      if (!get('SELECT id FROM users WHERE id = ?', targetUserId)) return fail(ctx.res, 404, '卖家不存在');
    }
    if (!targetUserId) return fail(ctx.res, 400, '缺少咨询对象');
    return communityApi.openThread({
      ...ctx,
      body: { toUserId: targetUserId, materialId: mid, content, scene: 'consult' }
    });
  }

  let type = String(body.type || 'other').trim();
  if (!['bug', 'suggestion', 'complaint', 'other'].includes(type)) type = 'other';

  const content = String(body.content || '').trim();
  if (content.length < 5) return fail(ctx.res, 400, '请详细描述你的问题（至少 5 个字）');
  if (content.length > 2000) return fail(ctx.res, 400, '内容不能超过 2000 字');

  let title = String(body.title || '').trim();
  if (!title) title = { bug: '问题反馈', suggestion: '功能建议', complaint: '交易投诉', other: '其他咨询' }[type];

  if (title.length < 2 || title.length > 80) return fail(ctx.res, 400, '标题需为 2—80 个字符');
  const audit = contentAudit.guard(`${title}\n${content}`, { targetType: 'ticket', targetId: null, userId: user.id });
  if (audit.verdict === 'block') return fail(ctx.res, 422, '工单内容未通过平台合规检测，请修改后重试');
  const ts = now();
  const info = run(
    `INSERT INTO tickets (user_id, kind, ticket_type, title, content, material_id, target_user_id,
       status, priority, user_unread, staff_unread, created_at, updated_at)
     VALUES (?, 'official', ?, ?, ?, NULL, NULL, 'open', 'normal', 0, 1, ?, ?)`,
    user.id, type, title, content, ts, ts
  );
  const t = get(`${BASE_SELECT} WHERE t.id = ?`, Number(info.lastInsertRowid));
  sendJson(ctx.res, 201, {
    ticket: serialize(t, user),
    message: '工单已提交，客服会尽快处理'
  });
}

function reply(ctx) {
  const id = Number(ctx.params.id);
  const t = get('SELECT * FROM tickets WHERE id = ?', id);
  if (!t) return fail(ctx.res, 404, '工单不存在');
  if (!canView(t, ctx.user)) return fail(ctx.res, 403, '无权操作该工单');

  // 历史卖家咨询工单：回复写入统一会话，避免出现两套消息记录
  if (t.kind === 'seller' && t.target_user_id) {
    const content = String(ctx.body.content || '').trim();
    if (!content) return fail(ctx.res, 400, '请输入回复内容');
    if (content.length > 1000) return fail(ctx.res, 400, '回复不能超过 1000 字');
    const audit = contentAudit.guard(content, { targetType: 'ticket', targetId: id, userId: ctx.user.id });
    if (audit.verdict === 'block') return fail(ctx.res, 422, '回复未通过平台合规检测，请修改后重试');
    let thread = get(
      `SELECT * FROM threads WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)
       ORDER BY last_message_at DESC LIMIT 1`,
      t.user_id, t.target_user_id, t.target_user_id, t.user_id
    );
    const ts = now();
    let threadId;
    if (thread) {
      threadId = thread.id;
    } else {
      const info = run(
        `INSERT INTO threads (user_a, user_b, material_id, want_id, scene, last_message_at, created_at)
         VALUES (?, ?, ?, NULL, 'consult', ?, ?)`,
        t.user_id, t.target_user_id, t.material_id, ts, ts
      );
      threadId = Number(info.lastInsertRowid);
    }
    run(
      'INSERT INTO messages (thread_id, sender_id, content, read_at, created_at) VALUES (?, ?, ?, NULL, ?)',
      threadId, ctx.user.id, content, ts
    );
    run('UPDATE threads SET last_message_at = ? WHERE id = ?', ts, threadId);
    run('UPDATE tickets SET updated_at = ? WHERE id = ?', ts, id);
    return sendJson(ctx.res, 200, { message: '回复已同步到统一会话', threadId });
  }

  if (t.status === 'closed') return fail(ctx.res, 400, '工单已关闭，无法继续回复');
  const content = String(ctx.body.content || '').trim();
  if (content.length < 1) return fail(ctx.res, 400, '请输入回复内容');
  if (content.length > 2000) return fail(ctx.res, 400, '回复不能超过 2000 字');
  const audit = contentAudit.guard(content, { targetType: 'ticket', targetId: id, userId: ctx.user.id });
  if (audit.verdict === 'block') return fail(ctx.res, 422, '回复未通过平台合规检测，请修改后重试');

  const isOwner = t.user_id === ctx.user.id;
  const role = ctx.user.role === 'admin' ? 'admin' : 'user';
  const ts = now();
  run(
    `INSERT INTO ticket_replies (ticket_id, author_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    id, ctx.user.id, role, content, ts
  );
  let status = t.status;
  if (isOwner) {
    run('UPDATE tickets SET staff_unread = staff_unread + 1, user_unread = 0, updated_at = ? WHERE id = ?', ts, id);
    if (status === 'resolved') status = 'open';
  } else {
    run('UPDATE tickets SET user_unread = user_unread + 1, staff_unread = 0, updated_at = ? WHERE id = ?', ts, id);
    if (status === 'open' || status === 'resolved') status = 'processing';
  }
  if (status !== t.status) run('UPDATE tickets SET status = ? WHERE id = ?', status, id);

  const refreshed = get(`${BASE_SELECT} WHERE t.id = ?`, id);
  sendJson(ctx.res, 200, {
    ticket: serialize(refreshed, ctx.user),
    message: isOwner ? '回复已发送' : '回复已发送，用户会收到通知'
  });
}

function updateStatus(ctx) {
  const id = Number(ctx.params.id);
  const t = get('SELECT * FROM tickets WHERE id = ?', id);
  if (!t) return fail(ctx.res, 404, '工单不存在');
  const status = String(ctx.body.status || '').trim();
  if (!STATUSES.includes(status)) return fail(ctx.res, 400, '状态不合法');
  const isOwner = t.user_id === ctx.user.id;
  const isStaff = isStaffFor(t, ctx.user);
  if (!isStaff && !(isOwner && status === 'closed')) return fail(ctx.res, 403, '无权修改工单状态');

  run('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?', status, now(), id);
  if (isStaff && (status === 'resolved' || status === 'closed')) {
    run('UPDATE tickets SET user_unread = user_unread + 1, staff_unread = 0 WHERE id = ?', id);
  }
  const refreshed = get(`${BASE_SELECT} WHERE t.id = ?`, id);
  sendJson(ctx.res, 200, { ticket: serialize(refreshed, ctx.user), message: '工单状态已更新' });
}

function adminList(ctx) {
  const status = String(ctx.query.status || '').trim();
  const kind = String(ctx.query.kind || '').trim();
  const q = String(ctx.query.q || '').trim();
  const where = ['1 = 1'];
  const params = [];
  if (status) { where.push('t.status = ?'); params.push(status); }
  if (kind) { where.push('t.kind = ?'); params.push(kind); }
  if (q) {
    where.push('(t.title LIKE ? OR t.content LIKE ? OR u.nickname LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const rows = all(
    `${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY
       CASE t.status WHEN 'open' THEN 0 WHEN 'processing' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END,
       t.updated_at DESC LIMIT 100`,
    ...params
  );
  const counts = { open: 0, processing: 0, resolved: 0, closed: 0 };
  for (const r of all('SELECT status, COUNT(*) AS c FROM tickets GROUP BY status')) counts[r.status] = r.c;
  sendJson(ctx.res, 200, {
    items: rows.map((t) => serialize(t, ctx.user)),
    counts,
    statusText: STATUS_TEXT,
    types: TICKET_TYPES
  });
}

module.exports = {
  list,
  unread,
  detail,
  create,
  reply,
  updateStatus,
  adminList,
  STATUS_TEXT
};
