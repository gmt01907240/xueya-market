'use strict';

const { all, get, run, now, CATEGORIES } = require('./db');
const { sendJson, fail } = require('./http');

const DEFAULT_BASE = {
  考研资料: 2500,
  期末真题: 1500,
  课堂笔记: 1500,
  课件讲义: 1200,
  电子教材: 1800,
  竞赛考证: 2500,
  论文范文: 1000,
  语言学习: 2000
};

const BASIS_TEXT = {
  exact: '已匹配「院校 + 学科 + 类型」官方标准',
  school: '已匹配「院校 + 类型」官方标准（该学科暂无单独标准）',
  subject: '已匹配「学科 + 类型」通用标准',
  category: '已匹配「类型」全平台参考价',
  fallback: '暂未收录标准，使用平台默认参考价'
};

function findStandard(school, subject, category) {
  if (!category) return { std: null, basis: 'fallback' };
  if (school && subject) {
    const std = get(
      `SELECT * FROM price_standards WHERE active = 1 AND school = ? AND subject = ? AND category = ?`,
      school, subject, category
    );
    if (std) return { std, basis: 'exact' };
  }
  if (school) {
    const std = get(
      `SELECT * FROM price_standards WHERE active = 1 AND school = ? AND subject = '*' AND category = ?`,
      school, category
    );
    if (std) return { std, basis: 'school' };
  }
  if (subject) {
    const std = get(
      `SELECT * FROM price_standards WHERE active = 1 AND school = '*' AND subject = ? AND category = ?`,
      subject, category
    );
    if (std) return { std, basis: 'subject' };
  }
  const generic = get(
    `SELECT * FROM price_standards WHERE active = 1 AND school = '*' AND subject = '*' AND category = ?`,
    category
  );
  if (generic) return { std: generic, basis: 'category' };
  return { std: null, basis: 'fallback' };
}

function priceAdvice(school, subject, category) {
  const { std, basis } = findStandard(school, subject, category);
  const base = std ? std.base_price_cents : (DEFAULT_BASE[category] || 1500);
  return {
    matched: !!std,
    standardId: std ? std.id : null,
    basis,
    basisText: BASIS_TEXT[basis],
    suggestion: base,
    min: std ? std.min_price_cents : Math.round(base * 0.6),
    max: std ? std.max_price_cents : Math.round(base * 1.8),
    note: std ? std.note : '平台默认参考价',
    category: category || ''
  };
}

function serialize(s) {
  return {
    id: s.id,
    school: s.school,
    subject: s.subject,
    category: s.category,
    basePrice: s.base_price_cents,
    minPrice: s.min_price_cents,
    maxPrice: s.max_price_cents,
    note: s.note,
    active: !!s.active,
    updatedAt: s.updated_at
  };
}

function listStandards(ctx) {
  const school = String(ctx.query.school || '').trim();
  const subject = String(ctx.query.subject || '').trim();
  const category = String(ctx.query.category || '').trim();
  const where = ['1 = 1'];
  const params = [];
  if (school) { where.push('school = ?'); params.push(school); }
  if (subject) { where.push('subject = ?'); params.push(subject); }
  if (category) { where.push('category = ?'); params.push(category); }
  const rows = all(
    `SELECT * FROM price_standards WHERE ${where.join(' AND ')}
     ORDER BY (school = '*') ASC, school ASC, category ASC, subject ASC LIMIT 300`,
    ...params
  );
  sendJson(ctx.res, 200, { items: rows.map(serialize), categories: CATEGORIES });
}

function recommend(ctx) {
  const school = String(ctx.query.school || '').trim();
  const subject = String(ctx.query.subject || '').trim();
  const category = String(ctx.query.category || '').trim();
  if (!category) return fail(ctx.res, 400, '请提供资料类型');
  sendJson(ctx.res, 200, { recommendation: priceAdvice(school, subject, category) });
}

function adminList(ctx) {
  const rows = all(
    `SELECT * FROM price_standards ORDER BY (school = '*') ASC, school ASC, category ASC, subject ASC LIMIT 500`
  );
  sendJson(ctx.res, 200, {
    items: rows.map(serialize),
    categories: CATEGORIES,
    total: rows.length
  });
}

function adminCreate(ctx) {
  const body = ctx.body;
  const school = String(body.school || '*').trim() || '*';
  const subject = String(body.subject || '*').trim() || '*';
  const category = String(body.category || '').trim();
  const base = Math.round(Number(body.basePrice) * 100);
  if (!category) return fail(ctx.res, 400, '请选择资料类型');
  if (!Number.isFinite(base) || base <= 0) return fail(ctx.res, 400, '请填写有效的标准价');
  if (get(
    'SELECT id FROM price_standards WHERE school = ? AND subject = ? AND category = ?',
    school, subject, category
  )) return fail(ctx.res, 409, '该院校 + 学科 + 类型的标准已存在，请直接编辑');
  const min = Math.max(0, Math.round((Number(body.minPrice) || base / 100 * 0.7) * 100));
  const max = Math.max(min + 100, Math.round((Number(body.maxPrice) || base / 100 * 1.6) * 100));
  const ts = now();
  const info = run(
    `INSERT INTO price_standards (school, subject, category, base_price_cents, min_price_cents, max_price_cents, note, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    school, subject, category, base, min, max, String(body.note || '管理员维护的官方标准价').trim(), 1, ts, ts
  );
  const row = get('SELECT * FROM price_standards WHERE id = ?', Number(info.lastInsertRowid));
  sendJson(ctx.res, 201, { item: serialize(row), message: '标准价已新增' });
}

function adminUpdate(ctx) {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM price_standards WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '标准不存在');
  const baseRaw = ctx.body.basePrice;
  const base = baseRaw === undefined ? row.base_price_cents : Math.round(Number(baseRaw) * 100);
  if (!Number.isFinite(base) || base <= 0) return fail(ctx.res, 400, '标准价无效');
  const minRaw = ctx.body.minPrice;
  const maxRaw = ctx.body.maxPrice;
  const min = minRaw === undefined ? row.min_price_cents : Math.max(0, Math.round(Number(minRaw) * 100));
  const max = maxRaw === undefined ? row.max_price_cents : Math.max(min + 100, Math.round(Number(maxRaw) * 100));
  const active = ctx.body.active === undefined ? row.active : (ctx.body.active ? 1 : 0);
  run(
    `UPDATE price_standards SET base_price_cents = ?, min_price_cents = ?, max_price_cents = ?,
       note = COALESCE(NULLIF(?, ''), note), active = ?, updated_at = ? WHERE id = ?`,
    base, min, max, String(ctx.body.note || '').trim(), active, now(), id
  );
  sendJson(ctx.res, 200, { item: serialize(get('SELECT * FROM price_standards WHERE id = ?', id)), message: '标准价已更新' });
}

function adminDelete(ctx) {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM price_standards WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '标准不存在');
  run('DELETE FROM price_standards WHERE id = ?', id);
  sendJson(ctx.res, 200, { message: '标准价已删除' });
}

module.exports = {
  priceAdvice,
  listStandards,
  recommend,
  adminList,
  adminCreate,
  adminUpdate,
  adminDelete
};
