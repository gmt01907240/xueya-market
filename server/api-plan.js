'use strict';

/**
 * 智能学习规划
 *
 * 基于「目标场景 + 学科 + 院校 + 资料质量 + 购买/收藏行为」做可解释的多因子排序，
 * 生成逐日学习安排与资料组合建议。全部在服务端本地计算，不依赖外部大模型，
 * 每条推荐都会返回命中原因，便于用户判断与答辩演示。
 */

const { all, get, run, tx, now, SUBJECTS } = require('./db');
const { sendJson, fail } = require('./http');
const runtime = require('./runtime-config');

const MAX_SAVED_PLANS = 20;

const GOALS = [
  {
    code: 'final',
    name: '期末冲刺',
    desc: '用真题和笔记快速建立考点框架',
    categories: ['期末真题', '课堂笔记', '课件讲义'],
    action: '限时完成一套真题，对照笔记整理错题'
  },
  {
    code: 'postgrad',
    name: '考研备考',
    desc: '真题、教材与笔记组合成完整复习链',
    categories: ['考研资料', '电子教材', '课堂笔记'],
    action: '按章节推进复习，完成对应真题并记录薄弱点'
  },
  {
    code: 'contest',
    name: '竞赛考证',
    desc: '专项题解与教材配合，按模块突破',
    categories: ['竞赛考证', '电子教材', '课堂笔记'],
    action: '完成一个专项模块，整理模板与易错点'
  },
  {
    code: 'paper',
    name: '论文写作',
    desc: '拆解范文结构，补齐写作方法',
    categories: ['论文范文', '电子教材', '语言学习'],
    action: '拆解一篇范文的结构与论证方式，完成写作提纲'
  },
  {
    code: 'language',
    name: '语言提升',
    desc: '输入与输出结合，保持每日练习',
    categories: ['语言学习', '课堂笔记', '电子教材'],
    action: '完成一组听说读写练习，整理高频表达'
  }
];

const CATEGORY_ACTION = {
  考研资料: '完成对应章节真题，标注知识盲区',
  期末真题: '限时完成一套真题，按题型归因',
  课堂笔记: '梳理知识框架，补齐课堂重点',
  课件讲义: '对照课件过一遍章节，整理公式与概念',
  电子教材: '精读指定章节，输出一页知识卡片',
  竞赛考证: '完成一个专项模块，整理解题模板',
  论文范文: '拆解范文结构，仿写一段论证',
  语言学习: '完成一组听说读写练习，积累表达'
};

function goalOf(code) {
  return GOALS.find((g) => g.code === code);
}

function subjectNames() {
  return SUBJECTS.slice();
}

function buildOptions() {
  return {
    goals: GOALS.map(({ code, name, desc, categories }) => ({ code, name, desc, categories })),
    subjects: subjectNames(),
    limits: { days: [3, 30], dailyMinutes: [20, 240] },
    engine: 'rule-based-v1',
    note: '本地多因子排序，推荐理由可解释，不上传个人资料内容'
  };
}

function options(ctx) {
  sendJson(ctx.res, 200, buildOptions());
}

function inferSubject(userId) {
  if (!userId) return '';
  const row = get(
    `SELECT m.subject, COUNT(*) AS c FROM orders o JOIN materials m ON m.id = o.material_id
     WHERE o.buyer_id = ? AND o.status IN ('completed', 'refund_requested') AND m.subject != ''
     GROUP BY m.subject ORDER BY c DESC LIMIT 1`, userId
  );
  if (row) return row.subject;
  const fav = get(
    `SELECT m.subject, COUNT(*) AS c FROM favorites f JOIN materials m ON m.id = f.material_id
     WHERE f.user_id = ? AND m.subject != '' GROUP BY m.subject ORDER BY c DESC LIMIT 1`, userId
  );
  return fav ? fav.subject : '';
}

function purchasedIds(userId) {
  if (!userId) return new Set();
  return new Set(all(
    `SELECT DISTINCT material_id FROM orders WHERE buyer_id = ? AND status IN ('completed', 'refund_requested')`,
    userId
  ).map((r) => r.material_id));
}

function candidates(subject, goal, limit = 240) {
  const base = `SELECT id, seller_id, title, category, subject, school, teacher, course,
      price_cents, rating_avg AS rating, downloads, description
    FROM materials WHERE status = 'approved'`;
  let rows = [];
  if (subject) {
    rows = all(`${base} AND subject = ? ORDER BY downloads DESC, rating_avg DESC LIMIT ?`, subject, limit);
  }
  if (rows.length < 8) {
    const fill = all(`${base} ORDER BY downloads DESC, rating_avg DESC LIMIT ?`, limit);
    const seen = new Set(rows.map((r) => r.id));
    for (const row of fill) {
      if (rows.length >= limit) break;
      if (!seen.has(row.id)) rows.push(row);
    }
  }
  return rows.filter((r) => r.category);
}

function scoreMaterial(row, ctx) {
  let score = 0;
  const reasons = [];
  if (ctx.subject && row.subject === ctx.subject) { score += 26; reasons.push(`匹配学科「${row.subject}」`); }
  if (ctx.school && row.school === ctx.school) { score += 16; reasons.push(`${row.school}同校资料`); }
  if (ctx.goal.categories.includes(row.category)) { score += 38; reasons.push(`符合${ctx.goal.name}场景`); }
  if (row.rating >= 4.5 && row.rating > 0) { score += 10; reasons.push(`评分 ${Number(row.rating).toFixed(1)}`); }
  if (row.downloads > 0) {
    const hot = Math.min(10, Math.round(Math.log10(row.downloads + 1) * 4));
    score += hot;
    if (row.downloads >= 100) reasons.push(`已下载 ${row.downloads} 次`);
  }
  if (row.price_cents <= 5000) { score += 4; reasons.push('价格友好'); }
  if (ctx.purchased.has(row.id)) { score += 2; reasons.push('你已购买，可用于复盘'); }
  else { score += 8; }
  if (row.teacher) score += 1;
  return { score, reasons };
}

function fmtDate(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildPlan({ goal, subject, school, days, dailyMinutes, picks }) {
  const plan = [];
  const focusMin = Math.max(15, Math.round(dailyMinutes * 0.7 / 5) * 5);
  const reviewMin = Math.max(5, dailyMinutes - focusMin);
  for (let i = 0; i < days; i++) {
    const main = picks[i % picks.length];
    const review = picks[(i + 1) % picks.length];
    const items = [{
      type: 'focus',
      minutes: focusMin,
      materialId: main.id,
      title: main.title,
      category: main.category,
      action: CATEGORY_ACTION[main.category] || goal.action,
      reason: main.reasons[0] || `符合${goal.name}场景`
    }];
    if (review && review.id !== main.id) {
      items.push({
        type: 'review',
        minutes: reviewMin,
        materialId: review.id,
        title: review.title,
        category: review.category,
        action: `回顾 30 分钟前序内容，整理 3 条易错点`,
        reason: '间隔复习，巩固记忆'
      });
    }
    plan.push({ day: i + 1, date: fmtDate(i), minutes: dailyMinutes, items });
  }
  return plan;
}

function compose(user, body) {
  body = body || {};
  const goal = goalOf(String(body.goal || ''));
  if (!goal) return { error: '请选择有效的学习目标' };

  const days = Number(body.days || 7);
  if (!Number.isInteger(days) || days < 3 || days > 30) return { error: '规划天数需为 3—30 天的整数' };

  const dailyMinutes = Number(body.dailyMinutes || 60);
  if (!Number.isInteger(dailyMinutes) || dailyMinutes < 20 || dailyMinutes > 240) {
    return { error: '每日学习时长需为 20—240 分钟的整数' };
  }

  let subject = String(body.subject || '').trim();
  if (subject && !subjectNames().includes(subject)) return { error: '请选择有效的学科' };
  if (!subject && user) subject = inferSubject(user.id);

  const school = (user && user.school) || '';
  const purchased = purchasedIds(user ? user.id : 0);
  const rows = candidates(subject, goal).filter((row) => !user || row.seller_id !== user.id);

  if (!rows.length) {
    return {
      data: {
        goal: { code: goal.code, name: goal.name },
        subject,
        days,
        dailyMinutes,
        engine: 'rule-based-v1',
        summary: { candidateCount: 0, matchedCount: 0, coverage: 0, strengths: [], gaps: goal.categories.map((c) => `暂无${c}资料`) },
        recommendations: [],
        plan: [],
        tips: ['当前条件下没有匹配资料，换一个学科或目标试试']
      }
    };
  }

  const scored = rows.map((row) => {
    const { score, reasons } = scoreMaterial(row, { subject, school, goal, purchased });
    return { ...row, score, reasons };
  }).sort((a, b) => b.score - a.score || b.downloads - a.downloads);

  const target = Math.max(3, Math.min(6, Math.ceil(days / 2)));
  const picks = [];
  const usedCategories = new Set();
  // 优先保证目标场景分类覆盖，再按分数补齐
  for (const cat of goal.categories) {
    const hit = scored.find((row) => row.category === cat && !picks.includes(row));
    if (hit) { picks.push(hit); usedCategories.add(cat); }
  }
  for (const row of scored) {
    if (picks.length >= target) break;
    if (!picks.includes(row)) { picks.push(row); usedCategories.add(row.category); }
  }
  picks.length = Math.min(picks.length, target);

  const coverage = Math.round((goal.categories.filter((c) => usedCategories.has(c)).length / goal.categories.length) * 100);
  const gaps = goal.categories.filter((c) => !usedCategories.has(c)).map((c) => `缺少${c}类资料，建议补充或发布求购`);
  const strengths = [];
  if (subject) strengths.push(`已按「${subject}」聚焦`);
  if (school) strengths.push(`优先${school}同校资料`);
  if (picks.some((p) => p.reasons.some((r) => r.includes('已下载')))) strengths.push('包含高下载口碑资料');

  const recommendations = [...picks].sort((a, b) => b.score - a.score).map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    subject: row.subject,
    school: row.school,
    teacher: row.teacher,
    course: row.course,
    price: row.price_cents,
    rating: row.rating,
    downloads: row.downloads,
    score: row.score,
    reasons: row.reasons.slice(0, 3),
    purchased: purchased.has(row.id)
  }));

  return {
    data: {
      goal: { code: goal.code, name: goal.name },
      subject,
      school,
      days,
      dailyMinutes,
      engine: 'rule-based-v1',
      summary: {
        candidateCount: rows.length,
        matchedCount: picks.length,
        coverage,
        strengths,
        gaps
      },
      recommendations,
      plan: buildPlan({ goal, subject, school, days, dailyMinutes, picks }),
      tips: [
        coverage < 100 ? `当前资料覆盖 ${coverage}%，缺口已列入建议` : '资料结构完整，按计划推进即可',
        '每天结束前用 5 分钟记录错题与疑问，周末集中复盘'
      ]
    }
  };
}

function generate(ctx) {
  if (!runtime.feature('plan')) return fail(ctx.res, 403, '学习规划功能暂未开放');
  const result = compose(ctx.user, ctx.body);
  if (result.error) return fail(ctx.res, 400, result.error);
  sendJson(ctx.res, 200, result.data);
}

/* ---- 计划保存与打卡 ---- */

function taskKeysOf(payload) {
  const keys = new Set();
  for (const day of payload.plan || []) {
    (day.items || []).forEach((item, index) => keys.add(`${day.day}-${index}`));
  }
  return keys;
}

function planProgress(planId, payload) {
  const total = (payload.plan || []).reduce((sum, day) => sum + (day.items || []).length, 0);
  const row = get('SELECT COUNT(*) AS c FROM study_plan_checks WHERE plan_id = ?', planId);
  const done = row ? Number(row.c) : 0;
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
}

function loadOwned(ctx) {
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    fail(ctx.res, 404, '学习计划不存在');
    return null;
  }
  const row = get('SELECT * FROM study_plans WHERE id = ?', id);
  if (!row || row.user_id !== ctx.user.id) {
    fail(ctx.res, 404, '学习计划不存在');
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    fail(ctx.res, 500, '学习计划数据损坏');
    return null;
  }
  return { row, payload };
}

function save(ctx) {
  if (!runtime.feature('plan')) return fail(ctx.res, 403, '学习规划功能暂未开放');
  const result = compose(ctx.user, ctx.body);
  if (result.error) return fail(ctx.res, 400, result.error);
  const data = result.data;
  const count = get('SELECT COUNT(*) AS c FROM study_plans WHERE user_id = ?', ctx.user.id);
  if (count && Number(count.c) >= MAX_SAVED_PLANS) {
    return fail(ctx.res, 400, `最多保存 ${MAX_SAVED_PLANS} 份学习计划，请先删除旧计划`);
  }
  const stamp = now();
  const info = run(
    `INSERT INTO study_plans (user_id, goal, goal_name, subject, school, days, daily_minutes, coverage, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.user.id, data.goal.code, data.goal.name, data.subject || '', data.school || '',
    data.days, data.dailyMinutes, data.summary.coverage, JSON.stringify(data), stamp, stamp
  );
  const id = Number(info.lastInsertRowid);
  sendJson(ctx.res, 201, { id, savedAt: stamp, progress: planProgress(id, data) });
}

function mine(ctx) {
  const rows = all(
    'SELECT * FROM study_plans WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    ctx.user.id, MAX_SAVED_PLANS
  );
  const items = rows.map((row) => {
    let payload = {};
    try { payload = JSON.parse(row.payload); } catch { /* 忽略损坏数据 */ }
    const progress = planProgress(row.id, payload);
    return {
      id: row.id,
      goal: row.goal,
      goalName: row.goal_name,
      subject: row.subject,
      school: row.school,
      days: row.days,
      dailyMinutes: row.daily_minutes,
      coverage: row.coverage,
      createdAt: row.created_at,
      progress
    };
  });
  sendJson(ctx.res, 200, { items, limit: MAX_SAVED_PLANS });
}

function detail(ctx) {
  const owned = loadOwned(ctx);
  if (!owned) return;
  const checks = all('SELECT task_key, done_at FROM study_plan_checks WHERE plan_id = ? ORDER BY done_at', owned.row.id);
  sendJson(ctx.res, 200, {
    id: owned.row.id,
    savedAt: owned.row.created_at,
    plan: owned.payload,
    checks: checks.map((c) => c.task_key),
    progress: planProgress(owned.row.id, owned.payload)
  });
}

function check(ctx) {
  const owned = loadOwned(ctx);
  if (!owned) return;
  const body = ctx.body || {};
  const taskKey = String(body.taskKey || '');
  if (!taskKeysOf(owned.payload).has(taskKey)) return fail(ctx.res, 400, '任务不存在');

  if (body.done === false) {
    run('DELETE FROM study_plan_checks WHERE plan_id = ? AND task_key = ?', owned.row.id, taskKey);
  } else {
    run('INSERT OR IGNORE INTO study_plan_checks (plan_id, task_key, done_at) VALUES (?, ?, ?)', owned.row.id, taskKey, now());
  }
  run('UPDATE study_plans SET updated_at = ? WHERE id = ?', now(), owned.row.id);
  sendJson(ctx.res, 200, { taskKey, done: body.done !== false, progress: planProgress(owned.row.id, owned.payload) });
}

function remove(ctx) {
  const owned = loadOwned(ctx);
  if (!owned) return;
  tx(() => {
    run('DELETE FROM study_plan_checks WHERE plan_id = ?', owned.row.id);
    run('DELETE FROM study_plans WHERE id = ?', owned.row.id);
  });
  sendJson(ctx.res, 200, { ok: true });
}

module.exports = { options, generate, save, mine, detail, check, remove, buildOptions };
