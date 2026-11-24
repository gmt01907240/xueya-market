'use strict';

const { all, get, run, now } = require('./db');
const { sendJson, fail } = require('./http');
const { requireVerified } = require('./guard');
const contentAudit = require('./content-audit');

/* ---------------- 求购广场 ---------------- */

function listWants(ctx) {
  const category = String(ctx.query.category || '').trim();
  const school = String(ctx.query.school || '').trim();
  const where = [`w.status = 'open'`];
  const params = [];
  if (category) { where.push('w.category = ?'); params.push(category); }
  if (school) { where.push('w.school = ?'); params.push(school); }
  const rows = all(
    `SELECT w.*, u.nickname, u.school AS user_school, u.id AS user_id
     FROM wants w JOIN users u ON u.id = w.user_id
     WHERE ${where.join(' AND ')} ORDER BY w.created_at DESC LIMIT 40`, ...params
  );
  const items = rows.map((w) => ({
    id: w.id, title: w.title, description: w.description, category: w.category,
    school: w.school || w.user_school, budget: w.budget_cents, status: w.status, createdAt: w.created_at,
    user: { id: w.user_id, nickname: w.nickname },
    mine: ctx.user ? ctx.user.id === w.user_id : false
  }));
  sendJson(ctx.res, 200, { items, total: items.length });
}

function createWant(ctx) {
  if (!requireVerified(ctx, '发布求购')) return;
  const title = String(ctx.body.title || '').trim();
  const description = String(ctx.body.description || '').trim();
  const category = String(ctx.body.category || '').trim();
  const school = String(ctx.body.school || '').trim();
  const budget = Number(ctx.body.budget || 0);
  if (title.length < 4 || title.length > 60) return fail(ctx.res, 400, '求购标题需为 4—60 个字符');
  if (description.length > 300) return fail(ctx.res, 400, '补充说明不能超过 300 字');
  if (!Number.isFinite(budget) || budget < 0 || budget > 999) return fail(ctx.res, 400, '预算需在 0—999 元之间');
  const audit = contentAudit.guard(`${title}\n${description}`, {
    targetType: 'want', targetId: null, userId: ctx.user.id
  });
  if (audit.verdict === 'block') return fail(ctx.res, 422, '求购内容未通过平台合规检测，请修改后重试');
  const info = run(
    `INSERT INTO wants (user_id, title, description, category, school, budget_cents, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    ctx.user.id, title, description, category, school, Math.round(budget * 100), now()
  );
  sendJson(ctx.res, 201, { id: Number(info.lastInsertRowid), message: '求购已发布，卖家会通过站内消息联系你' });
}

function closeWant(ctx) {
  const id = Number(ctx.params.id);
  const want = get('SELECT * FROM wants WHERE id = ?', id);
  if (!want) return fail(ctx.res, 404, '求购不存在');
  if (want.user_id !== ctx.user.id && ctx.user.role !== 'admin') return fail(ctx.res, 403, '无权操作');
  run(`UPDATE wants SET status = 'closed' WHERE id = ?`, id);
  sendJson(ctx.res, 200, { message: '求购已关闭' });
}

/* ---------------- 统一卖家沟通（会话 + 消息） ---------------- */

const CHAT_SCENES = [
  {
    key: 'consult', text: '资料咨询', desc: '内容、版本与适用范围',
    quickReplies: ['这份资料包含最新年份吗？', '资料大概多少页？', '是否包含完整答案或解析？', '适合什么基础的同学使用？']
  },
  {
    key: 'price', text: '价格与优惠', desc: '价格、打包与优惠',
    quickReplies: ['可以小刀吗？', '买多份有优惠吗？', '价格包含后续更新吗？']
  },
  {
    key: 'delivery', text: '交付与下载', desc: '文件格式、下载与更新',
    quickReplies: ['是 PDF 还是可编辑源文件？', '购买后可以立即下载吗？', '后续更新会免费提供吗？']
  },
  {
    key: 'after_sale', text: '售后问题', desc: '文件异常、内容不符',
    quickReplies: ['下载后文件打不开怎么办？', '内容和描述不一致，怎么处理？', '可以申请退款吗？']
  },
  {
    key: 'free', text: '自由沟通', desc: '不限话题的日常沟通',
    quickReplies: ['同学你好，想咨询一下～', '还有其他相关资料推荐吗？', '好的，谢谢你的解答。']
  }
];
const SCENE_KEYS = new Set(CHAT_SCENES.map((s) => s.key));
const sceneMeta = (key) => CHAT_SCENES.find((s) => s.key === key) || CHAT_SCENES[CHAT_SCENES.length - 1];

const THREAD_SELECT = `
  SELECT t.*, a.nickname AS a_nickname, a.school AS a_school,
         b.nickname AS b_nickname, b.school AS b_school,
         m.title AS material_title, m.seller_id AS material_seller_id,
         w.title AS want_title, w.user_id AS want_owner_id
  FROM threads t
  JOIN users a ON a.id = t.user_a
  JOIN users b ON b.id = t.user_b
  LEFT JOIN materials m ON m.id = t.material_id
  LEFT JOIN wants w ON w.id = t.want_id
`;

function contextOf(row) {
  if (row.material_id) return { type: 'material', title: row.material_title || '资料咨询' };
  if (row.want_id) return { type: 'want', title: row.want_title || '求购沟通' };
  return { type: 'direct', title: '直接沟通' };
}

function perspectiveOf(row, meId) {
  if (row.material_id) return row.material_seller_id === meId ? 'sell' : 'buy';
  if (row.want_id) return row.want_owner_id === meId ? 'buy' : 'sell';
  return 'peer';
}

function threadView(row, meId, cache = null) {
  const other = row.user_a === meId
    ? { id: row.user_b, nickname: row.b_nickname, school: row.b_school }
    : { id: row.user_a, nickname: row.a_nickname, school: row.a_school };
  let last;
  let unreadCount;
  if (cache) {
    last = cache.last.get(row.id) || null;
    unreadCount = cache.unread.get(row.id) || 0;
  } else {
    last = get(
      'SELECT content, sender_id, created_at FROM messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', row.id
    );
    unreadCount = get(
      `SELECT COUNT(*) AS c FROM messages WHERE thread_id = ? AND sender_id != ? AND read_at IS NULL`, row.id, meId
    ).c;
  }
  const context = contextOf(row);
  const scene = sceneMeta(row.scene || (context.type === 'material' ? 'consult' : 'free'));
  return {
    id: row.id,
    other,
    perspective: perspectiveOf(row, meId),
    unread: unreadCount,
    scene: scene.key,
    sceneText: scene.text,
    context,
    material: row.material_id ? { id: row.material_id, title: row.material_title } : null,
    want: row.want_id ? { id: row.want_id, title: row.want_title } : null,
    lastMessage: last ? { content: last.content, mine: last.sender_id === meId, createdAt: last.created_at } : null,
    lastMessageAt: row.last_message_at
  };
}

function chatMeta(ctx) {
  sendJson(ctx.res, 200, {
    scenes: CHAT_SCENES.map(({ quickReplies, ...rest }) => rest),
    quickReplies: CHAT_SCENES.reduce((map, s) => { map[s.key] = s.quickReplies; return map; }, {})
  });
}

function listThreads(ctx) {
  const perspective = String(ctx.query.perspective || '').trim();
  const rows = all(
    `${THREAD_SELECT} WHERE t.user_a = ? OR t.user_b = ? ORDER BY t.last_message_at DESC`, ctx.user.id, ctx.user.id
  );
  // 批量取每个会话的最后一条消息与未读数，避免列表 N+1 查询
  const cache = { last: new Map(), unread: new Map() };
  if (rows.length) {
    const placeholders = rows.map(() => '?').join(',');
    const ids = rows.map((r) => r.id);
    for (const item of all(
      `SELECT m.thread_id, m.content, m.sender_id, m.created_at FROM messages m
       JOIN (SELECT thread_id, MAX(id) AS id FROM messages WHERE thread_id IN (${placeholders}) GROUP BY thread_id) x
         ON x.id = m.id`, ...ids
    )) cache.last.set(item.thread_id, item);
    for (const item of all(
      `SELECT thread_id, COUNT(*) AS c FROM messages
       WHERE thread_id IN (${placeholders}) AND sender_id != ? AND read_at IS NULL GROUP BY thread_id`,
      ...ids, ctx.user.id
    )) cache.unread.set(item.thread_id, item.c);
  }
  let items = rows.map((r) => threadView(r, ctx.user.id, cache));
  // 直接沟通（无资料/求购上下文，如店铺主页发起）视为双方都可参与，买卖视角均可见
  if (perspective === 'sell') items = items.filter((t) => t.perspective !== 'buy');
  else if (perspective === 'buy') items = items.filter((t) => t.perspective !== 'sell');
  else if (perspective === 'peer') items = items.filter((t) => t.perspective === 'peer');
  const unread = items.reduce((sum, t) => sum + t.unread, 0);
  sendJson(ctx.res, 200, { items, total: items.length, unread, perspective: perspective || 'all' });
}

function threadUnread(ctx) {
  const me = ctx.user.id;
  const total = get(
    `SELECT COUNT(*) AS c FROM messages m JOIN threads t ON t.id = m.thread_id
     WHERE m.sender_id != ? AND m.read_at IS NULL AND (t.user_a = ? OR t.user_b = ?)`, me, me, me
  ).c;
  const asSeller = get(
    `SELECT COUNT(*) AS c FROM messages m JOIN threads t ON t.id = m.thread_id
     JOIN materials mt ON mt.id = t.material_id
     WHERE m.sender_id != ? AND m.read_at IS NULL AND mt.seller_id = ?
       AND (t.user_a = ? OR t.user_b = ?)`, me, me, me, me
  ).c;
  sendJson(ctx.res, 200, { total, asSeller, asBuyer: total - asSeller });
}

function pickScene(scene, materialId, wantId, fallback = '') {
  const value = String(scene || '').trim();
  if (SCENE_KEYS.has(value)) return value;
  if (SCENE_KEYS.has(fallback)) return fallback;
  return materialId ? 'consult' : 'free';
}

function openThread(ctx) {
  const toUserId = Number(ctx.body.toUserId);
  const content = String(ctx.body.content || '').trim();
  const materialId = ctx.body.materialId ? Number(ctx.body.materialId) : null;
  const wantId = ctx.body.wantId ? Number(ctx.body.wantId) : null;
  if (!toUserId || toUserId === ctx.user.id) return fail(ctx.res, 400, '无法给自己发送消息');
  if (!get('SELECT id FROM users WHERE id = ?', toUserId)) return fail(ctx.res, 404, '用户不存在');
  if (!content) return fail(ctx.res, 400, '请输入消息内容');
  if (content.length > 1000) return fail(ctx.res, 400, '单条消息不能超过 1000 字');

  let thread = get(
    `SELECT * FROM threads WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)`,
    ctx.user.id, toUserId, toUserId, ctx.user.id
  );
  const ts = now();
  const scene = pickScene(ctx.body.scene, materialId, wantId, thread ? thread.scene : '');
  let threadId;
  if (thread) {
    threadId = thread.id;
    run(
      `UPDATE threads SET last_message_at = ?, material_id = COALESCE(?, material_id),
         want_id = COALESCE(?, want_id), scene = ? WHERE id = ?`,
      ts, materialId, wantId, scene, threadId
    );
  } else {
    const info = run(
      `INSERT INTO threads (user_a, user_b, material_id, want_id, scene, last_message_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ctx.user.id, toUserId, materialId, wantId, scene, ts, ts
    );
    threadId = Number(info.lastInsertRowid);
  }
  run(
    'INSERT INTO messages (thread_id, sender_id, content, read_at, created_at) VALUES (?, ?, ?, NULL, ?)',
    threadId, ctx.user.id, content, ts
  );
  sendJson(ctx.res, 201, { threadId, scene, message: '消息已发送' });
}

function threadDetail(ctx) {
  const id = Number(ctx.params.id);
  const row = get(`${THREAD_SELECT} WHERE t.id = ?`, id);
  if (!row) return fail(ctx.res, 404, '会话不存在');
  if (row.user_a !== ctx.user.id && row.user_b !== ctx.user.id) return fail(ctx.res, 403, '无权查看该会话');

  run('UPDATE messages SET read_at = ? WHERE thread_id = ? AND sender_id != ? AND read_at IS NULL', now(), id, ctx.user.id);
  const messages = all(
    `SELECT msg.*, u.nickname FROM messages msg JOIN users u ON u.id = msg.sender_id
     WHERE msg.thread_id = ? ORDER BY msg.created_at ASC, msg.id ASC LIMIT 200`, id
  );
  const view = threadView(row, ctx.user.id);
  sendJson(ctx.res, 200, {
    thread: view,
    quickReplies: sceneMeta(view.scene).quickReplies,
    messages: messages.map((m) => ({
      id: m.id, content: m.content, createdAt: m.created_at,
      sender: { id: m.sender_id, nickname: m.nickname },
      mine: m.sender_id === ctx.user.id
    }))
  });
}

function sendMessage(ctx) {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM threads WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '会话不存在');
  if (row.user_a !== ctx.user.id && row.user_b !== ctx.user.id) return fail(ctx.res, 403, '无权发送消息');
  const content = String(ctx.body.content || '').trim();
  if (!content) return fail(ctx.res, 400, '请输入消息内容');
  if (content.length > 1000) return fail(ctx.res, 400, '单条消息不能超过 1000 字');
  const audit = contentAudit.guard(content, { targetType: 'message', targetId: id, userId: ctx.user.id });
  if (audit.verdict === 'block') return fail(ctx.res, 422, '消息未通过平台合规检测，请修改后重试');
  const ts = now();
  run('INSERT INTO messages (thread_id, sender_id, content, read_at, created_at) VALUES (?, ?, ?, NULL, ?)', id, ctx.user.id, content, ts);
  const scene = String(ctx.body.scene || '').trim();
  if (SCENE_KEYS.has(scene)) run('UPDATE threads SET scene = ?, last_message_at = ? WHERE id = ?', scene, ts, id);
  else run('UPDATE threads SET last_message_at = ? WHERE id = ?', ts, id);
  sendJson(ctx.res, 201, {
    message: { content, mine: true, createdAt: ts, sender: { id: ctx.user.id, nickname: ctx.user.nickname } }
  });
}

function updateThread(ctx) {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM threads WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '会话不存在');
  if (row.user_a !== ctx.user.id && row.user_b !== ctx.user.id) return fail(ctx.res, 403, '无权操作该会话');
  const scene = String(ctx.body.scene || '').trim();
  if (!SCENE_KEYS.has(scene)) return fail(ctx.res, 400, '咨询场景不合法');
  run('UPDATE threads SET scene = ? WHERE id = ?', scene, id);
  sendJson(ctx.res, 200, { scene, sceneText: sceneMeta(scene).text, message: '咨询场景已更新' });
}

module.exports = {
  listWants, createWant, closeWant,
  listThreads, threadUnread, chatMeta, openThread, threadDetail, sendMessage, updateThread,
  CHAT_SCENES, SCENE_KEYS, pickScene
};
