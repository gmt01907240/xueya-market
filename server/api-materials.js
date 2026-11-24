'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { all, get, run, now, CATEGORIES, SCHOOLS, SUBJECTS, buildPreview } = require('./db');
const { UPLOAD_DIR } = require('./paths');
const { sendJson, fail } = require('./http');
const { requireVerified, isVerified } = require('./guard');
const contentAudit = require('./content-audit');
const runtime = require('./runtime-config');

const ALLOWED_EXT = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'zip', 'rar', 'txt', 'md', 'xls', 'xlsx', 'png', 'jpg', 'jpeg'];

const SCHOOL_SET = new Set(SCHOOLS);
const SUBJECT_SET = new Set(SUBJECTS);
const AUDIT_TEXT_LIMIT = 200000;

const ZIP_SIG = [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]];
const SIGNATURES = {
  pdf: [[0x25, 0x50, 0x44, 0x46]],
  zip: ZIP_SIG,
  docx: ZIP_SIG,
  pptx: ZIP_SIG,
  xlsx: ZIP_SIG,
  rar: [[0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]],
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  jpg: [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  doc: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  xls: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  ppt: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]]
};

function startsWith(buf, sig, offset = 0) {
  if (buf.length < offset + sig.length) return false;
  return sig.every((byte, index) => buf[offset + index] === byte);
}

function signatureProblem(buf, ext) {
  if (ext === 'txt' || ext === 'md') {
    if (buf.subarray(0, 4096).includes(0)) return '文本文件包含二进制内容，请上传真实文本';
    try {
      // stream 模式允许末尾被截断的多字节字符，避免误判合法 UTF-8 文本。
      new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, 8192), { stream: true });
    } catch {
      return '文本文件需使用 UTF-8 编码';
    }
    return '';
  }
  const signatures = SIGNATURES[ext];
  if (!signatures) return '';
  const matched = signatures.some((sig) => (ext === 'pdf'
    ? buf.subarray(0, 1024).indexOf(Buffer.from(sig)) >= 0
    : startsWith(buf, sig)));
  return matched ? '' : '文件内容与扩展名不匹配，请上传真实文件';
}

function serialize(m, user) {
  if (!m) return null;
  const data = {
    id: m.id,
    title: m.title,
    description: m.description,
    category: m.category,
    school: m.school,
    subject: m.subject || '',
    teacher: m.teacher || '',
    course: m.course,
    price: m.price_cents,
    priceSource: m.price_source || 'seller',
    priceNote: m.price_note || '',
    previewRatio: actualPreviewRatio(m, (m.preview_text || '').length),
    hasPreview: !!m.preview_text,
    fileName: m.file_name,
    fileSize: m.file_size,
    tags: m.tags ? m.tags.split(',').filter(Boolean) : [],
    status: m.status,
    rejectReason: m.reject_reason,
    views: m.views,
    downloads: m.downloads,
    rating: Math.round(m.rating_avg * 10) / 10,
    ratingCount: m.rating_count,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    seller: m.seller_id ? {
      id: m.seller_id,
      nickname: m.seller_nickname || '',
      school: m.seller_school || ''
    } : null
  };
  if (user && m.seller_id === user.id) data.owned = true;
  if (user && (m.seller_id === user.id || user.role === 'admin')) {
    let hits = [];
    try { hits = JSON.parse(m.audit_hits || '[]'); } catch { hits = []; }
    data.audit = {
      verdict: m.audit_verdict || '',
      score: m.audit_score || 0,
      status: m.audit_status || '',
      at: m.audit_at || '',
      hits: Array.isArray(hits) ? hits : []
    };
  }
  return data;
}

function auditHitsJson(result) {
  return JSON.stringify((result.hits || []).slice(0, 10).map((h) => ({
    code: h.code, category: h.category, level: h.level, tip: h.tip
  })));
}

function buildAuditText(fields, fullText) {
  return [
    fields.title, fields.description, fields.category, fields.subject, fields.teacher,
    fields.course, Array.isArray(fields.tags) ? fields.tags.join('、') : fields.tags,
    fields.fileName, fullText
  ].filter(Boolean).join('\n').slice(0, AUDIT_TEXT_LIMIT);
}

function auditStatusOf(result) {
  if (result.verdict === 'review') return 'review';
  if (result.verdict === 'error' || result.verdict === 'block') return result.verdict === 'block' ? 'blocked' : 'error';
  return 'pass';
}

function auditMessage(result, demo = false) {
  if (demo) {
    if (result.verdict === 'review') {
      return '资料已提交并自动上架；自动检测发现疑似风险内容，已转人工复核';
    }
    if (result.verdict === 'error') {
      return '资料已提交并自动上架；自动检测服务暂不可用，已转人工复核';
    }
    return '资料已提交，演示环境免人工审核，已直接上架';
  }
  if (result.verdict === 'review') {
    return '资料已提交，自动检测发现疑似风险内容，已转人工复核（通常 24 小时内完成）';
  }
  if (result.verdict === 'error') {
    return '资料已提交，自动检测服务暂不可用，已转人工复核（通常 24 小时内完成）';
  }
  return '资料已提交，内容自动检测通过，平台将在 24 小时内完成人工审核';
}

function rejectByAudit(ctx, result) {
  const categories = (result.categories && result.categories.length)
    ? result.categories
    : [...new Set((result.hits || []).map((h) => h.category))];
  const detail = categories.length ? `涉及${categories.join('、')}相关内容` : '命中平台内容安全规则';
  sendJson(ctx.res, 422, {
    error: `内容未通过平台合规检测，${detail}，已自动拦截。请删除违规内容后重新提交，情节严重的将依法移交监管部门。`,
    code: 'CONTENT_BLOCKED',
    audit: {
      verdict: 'block',
      score: result.score,
      categories,
      rules: (result.hits || []).slice(0, 8).map((h) => ({ code: h.code, category: h.category, tip: h.tip }))
    }
  });
}

const BASE_SELECT = `
  SELECT m.*, u.nickname AS seller_nickname, u.school AS seller_school
  FROM materials m JOIN users u ON u.id = m.seller_id
`;

function list(ctx) {
  const q = String(ctx.query.q || '').trim().slice(0, 50);
  const category = String(ctx.query.category || '').trim();
  const school = String(ctx.query.school || '').trim();
  const subject = String(ctx.query.subject || '').trim();
  const teacher = String(ctx.query.teacher || '').trim();
  const price = String(ctx.query.price || '').trim();
  const sort = String(ctx.query.sort || 'hot');
  const page = Math.min(100, Math.max(1, Number(ctx.query.page) || 1));
  const pageSize = Math.min(24, Math.max(1, Number(ctx.query.pageSize) || 9));

  // 过滤条件结构化保存，便于主查询与各分面统计复用同一套条件
  const filters = [];
  if (q) {
    filters.push({
      key: 'q',
      sql: '(m.title LIKE ? OR m.description LIKE ? OR m.tags LIKE ? OR m.course LIKE ? OR m.subject LIKE ? OR m.teacher LIKE ?)',
      params: Array(6).fill(`%${q}%`)
    });
  }
  if (category) filters.push({ key: 'category', sql: 'm.category = ?', params: [category] });
  if (school) filters.push({ key: 'school', sql: 'm.school = ?', params: [school] });
  if (subject) filters.push({ key: 'subject', sql: 'm.subject = ?', params: [subject] });
  if (teacher) filters.push({ key: 'teacher', sql: 'm.teacher = ?', params: [teacher] });
  if (price === 'free') filters.push({ key: 'price', sql: 'm.price_cents = 0', params: [] });
  if (price === 'low') filters.push({ key: 'price', sql: 'm.price_cents > 0 AND m.price_cents <= 1500', params: [] });
  if (price === 'mid') filters.push({ key: 'price', sql: 'm.price_cents > 1500 AND m.price_cents <= 3000', params: [] });
  if (price === 'high') filters.push({ key: 'price', sql: 'm.price_cents > 3000', params: [] });

  function whereFor(excludeKey) {
    const parts = [`m.status = 'approved'`];
    const params = [];
    for (const f of filters) {
      if (f.key === excludeKey) continue;
      parts.push(f.sql);
      params.push(...f.params);
    }
    return { sql: `WHERE ${parts.join(' AND ')}`, params };
  }

  const orderMap = {
    hot: 'm.downloads DESC, m.views DESC',
    new: 'm.created_at DESC',
    rating: 'm.rating_avg DESC, m.rating_count DESC',
    price_asc: 'm.price_cents ASC, m.created_at DESC',
    price_desc: 'm.price_cents DESC, m.created_at DESC'
  };
  const order = orderMap[sort] || orderMap.hot;
  const where = whereFor(null);
  const total = get(`SELECT COUNT(*) AS c FROM materials m ${where.sql}`, ...where.params).c;
  const rows = all(
    `${BASE_SELECT} ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...where.params, pageSize, (page - 1) * pageSize
  );

  // 分面计数应用除自身维度以外的当前筛选条件，避免切换维度后计数失真
  const schoolWhere = whereFor('school');
  const facets = all(
    `SELECT m.school AS school, COUNT(*) AS count FROM materials m ${schoolWhere.sql} AND m.school != ''
     GROUP BY m.school ORDER BY count DESC LIMIT 10`,
    ...schoolWhere.params
  );
  const subjectWhere = whereFor('subject');
  const subjectFacets = all(
    `SELECT m.subject AS subject, COUNT(*) AS count FROM materials m ${subjectWhere.sql} AND m.subject != ''
     GROUP BY m.subject ORDER BY count DESC LIMIT 30`,
    ...subjectWhere.params
  );
  const teacherWhere = whereFor('teacher');
  const teacherFacets = all(
    `SELECT m.teacher AS teacher, COUNT(*) AS count FROM materials m ${teacherWhere.sql} AND m.teacher != ''
     GROUP BY m.teacher ORDER BY count DESC LIMIT 30`,
    ...teacherWhere.params
  );
  sendJson(ctx.res, 200, {
    items: rows.map((m) => serialize(m, ctx.user)),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    facets,
    subjectFacets,
    teacherFacets
  });
}

/** 试读比例按实际展示字数与原文总字数计算，旧数据缺少总字数时回退到卖家设定值 */
function actualPreviewRatio(m, previewLength) {
  const fallback = Math.min(20, Math.max(1, Number(m.preview_ratio) || 15));
  const base = Number(m.content_chars) || 0;
  if (base > 0 && previewLength > 0) {
    return Math.min(20, Math.max(1, Math.round((previewLength / base) * 100)));
  }
  return fallback;
}

function detail(ctx) {
  const id = Number(ctx.params.id);
  const row = get(`${BASE_SELECT} WHERE m.id = ?`, id);
  if (!row) return fail(ctx.res, 404, '资料不存在');
  const isOwner = ctx.user && ctx.user.id === row.seller_id;
  const isAdmin = ctx.user && ctx.user.role === 'admin';
  if (row.status !== 'approved' && !isOwner && !isAdmin) return fail(ctx.res, 404, '资料不存在或已下架');

  if (!isOwner) run('UPDATE materials SET views = views + 1 WHERE id = ?', id);

  const reviews = all(
    `SELECT r.*, u.nickname, u.school FROM reviews r JOIN users u ON u.id = r.user_id
     WHERE r.material_id = ? ORDER BY r.created_at DESC LIMIT 20`, id
  );
  const distRows = all('SELECT rating, COUNT(*) AS c FROM reviews WHERE material_id = ? GROUP BY rating', id);
  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const d of distRows) distribution[d.rating] = d.c;

  let purchased = false;
  let favorited = false;
  if (ctx.user) {
    purchased = !!get(
      `SELECT id FROM orders WHERE material_id = ? AND buyer_id = ? AND status IN ('completed','refund_requested') LIMIT 1`, id, ctx.user.id
    );
    favorited = !!get('SELECT 1 AS x FROM favorites WHERE user_id = ? AND material_id = ?', ctx.user.id, id);
  }
  if (row.price_cents === 0) purchased = true;

  const related = all(
    `${BASE_SELECT} WHERE m.status = 'approved' AND m.id != ? AND (m.category = ? OR m.school = ?)
     ORDER BY (m.category = ?) DESC, m.downloads DESC LIMIT 4`,
    id, row.category, row.school, row.category
  );

  const previewContent = previewText(row);
  sendJson(ctx.res, 200, {
    material: serialize(row, ctx.user),
    reviews: reviews.map((r) => ({
      id: r.id, rating: r.rating, content: r.content, createdAt: r.created_at,
      user: { nickname: r.nickname, school: r.school }
    })),
    distribution,
    purchased,
    favorited,
    canReview: !!ctx.user && !isOwner && purchased && !get(
      'SELECT 1 AS x FROM reviews r JOIN orders o ON o.id = r.order_id WHERE o.material_id = ? AND o.buyer_id = ?',
      id, ctx.user.id
    ),
    related: related.map((m) => serialize(m)),
    preview: {
      available: !!(row.preview_text || row.description),
      ratio: actualPreviewRatio(row, previewContent.length),
      chars: previewContent.length,
      locked: !purchased && !isOwner && !isAdmin
    }
  });
}

function previewText(row) {
  if (row.preview_text) return row.preview_text;
  return buildPreview(
    { title: row.title, desc: row.description, category: row.category, school: row.school },
    row.subject || '', row.teacher || ''
  );
}

function preview(ctx) {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM materials WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '资料不存在');
  const isOwner = ctx.user && ctx.user.id === row.seller_id;
  const isAdmin = ctx.user && ctx.user.role === 'admin';
  if (row.status !== 'approved' && !isOwner && !isAdmin) return fail(ctx.res, 404, '资料不存在或已下架');

  const purchased = !!ctx.user && (
    row.price_cents === 0 || !!get(
      `SELECT id FROM orders WHERE material_id = ? AND buyer_id = ? AND status IN ('completed','refund_requested') LIMIT 1`,
      id, ctx.user.id
    )
  );
  const fullPreview = previewText(row);
  const text = fullPreview.slice(0, 3000);
  ctx.res.setHeader('Cache-Control', 'no-store');
  sendJson(ctx.res, 200, {
    id: row.id,
    title: row.title,
    ratio: actualPreviewRatio(row, fullPreview.length),
    chars: text.length,
    text,
    unlocked: purchased || isOwner || isAdmin,
    watermark: `学涯集市 · ${row.school || '平台'} · 试读片段`,
    notice: '预览内容仅用于购买决策参考，禁止复制、截图传播或下载'
  });
}

function mine(ctx) {
  const rows = all(`${BASE_SELECT} WHERE m.seller_id = ? ORDER BY m.created_at DESC`, ctx.user.id);
  const items = rows.map((m) => serialize(m, ctx.user));
  const counts = { all: items.length, approved: 0, pending: 0, rejected: 0, offline: 0 };
  for (const m of items) counts[m.status] = (counts[m.status] || 0) + 1;
  sendJson(ctx.res, 200, { items, counts });
}

function favorites(ctx) {
  const rows = all(
    `${BASE_SELECT} JOIN favorites f ON f.material_id = m.id AND f.user_id = ?
     WHERE m.status = 'approved' ORDER BY f.created_at DESC`, ctx.user.id
  );
  sendJson(ctx.res, 200, { items: rows.map((m) => serialize(m, ctx.user)) });
}

function download(ctx) {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM materials WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '资料不存在');
  const isOwner = row.seller_id === ctx.user.id;
  const isAdmin = ctx.user.role === 'admin';
  if (!isOwner && !isAdmin && !isVerified(ctx.user)) return fail(ctx.res, 403, '请先完成实名认证与高校认证后再下载资料');
  const purchased = row.price_cents === 0 || !!get(
    `SELECT id FROM orders WHERE material_id = ? AND buyer_id = ? AND status IN ('completed','refund_requested') LIMIT 1`, id, ctx.user.id
  );
  if (!isOwner && !isAdmin && !purchased) return fail(ctx.res, 403, '请先购买后再下载');

  const filePath = path.join(UPLOAD_DIR, path.basename(row.file_path));
  if (!fs.existsSync(filePath)) return fail(ctx.res, 410, '文件已失效，请联系卖家重新上传');

  if (!isOwner) run('UPDATE materials SET downloads = downloads + 1 WHERE id = ?', id);
  const stat = fs.statSync(filePath);
  ctx.res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.file_name)}`
  });
  fs.createReadStream(filePath).pipe(ctx.res);
}

const TEXT_EXT = ['txt', 'md', 'csv', 'json', 'html', 'htm'];

function extractText(buf, ext) {
  const sample = buf.subarray(0, 120 * 1024);
  if (TEXT_EXT.includes(ext)) return sample.toString('utf8');
  if (sample.includes(0)) return '';
  let printable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126) || b >= 128) printable++;
  }
  return printable / Math.max(1, sample.length) > 0.95 ? sample.toString('utf8') : '';
}

function makePreview({ title, description, category, school, subject, teacher, previewRatio }, fullText) {
  const fallback = buildPreview({ title, desc: description, category, school }, subject, teacher);
  if (!fullText || fullText.trim().length < 200) return fallback;
  const ratio = Math.min(20, Math.max(10, Number(previewRatio) || 15));
  const limit = Math.min(1500, Math.max(200, Math.round((fullText.length * ratio) / 100)));
  return [
    `《${title}》`,
    `${school || '通用'} ｜ 学科：${subject || '其他'} ｜ 授课老师：${teacher || '—'} ｜ 类型：${category}`,
    '',
    '【内容节选】',
    fullText.trim().slice(0, limit),
    '',
    '—— 以上为试读节选，完整内容需购买后查看 ——'
  ].join('\n');
}

async function create(ctx) {
  if (!runtime.feature('upload')) return fail(ctx.res, 403, '资料上传暂未开放，请关注平台公告');
  if (!requireVerified(ctx, '发布资料')) return;
  const body = ctx.body;
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const category = String(body.category || '').trim();
  const school = String(body.school || ctx.user.school || '').trim();
  const subject = String(body.subject || '').trim();
  const teacher = String(body.teacher || '').trim();
  const course = String(body.course || '').trim();
  const price = Number(body.price);
  const tags = Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 5) : [];
  const fileName = String(body.fileName || '').trim();
  const fileData = String(body.fileData || '');
  const previewRatio = Math.min(20, Math.max(10, Number(body.previewRatio) || 15));

  if (title.length < 4 || title.length > 80) return fail(ctx.res, 400, '资料标题需为 4—80 个字符');
  if (description.length < 20) return fail(ctx.res, 400, '资料介绍至少 20 个字，方便同学判断是否适合自己');
  if (!CATEGORIES.includes(category)) return fail(ctx.res, 400, '请选择正确的资料分类');
  if (!school) return fail(ctx.res, 400, '请选择资料所属院校');
  if (!SCHOOL_SET.has(school)) return fail(ctx.res, 400, '请选择资源库中的院校');
  if (!subject) return fail(ctx.res, 400, '请选择资料所属学科');
  if (!SUBJECT_SET.has(subject)) return fail(ctx.res, 400, '请选择资源库中的学科');
  if (teacher.length > 30) return fail(ctx.res, 400, '授课老师姓名过长');
  if (course.length > 40) return fail(ctx.res, 400, '课程名称不能超过 40 个字符');
  if (!Number.isFinite(price) || price < 0 || price > 999) return fail(ctx.res, 400, '价格需在 0—999 元之间');
  if (!fileName || !fileData) return fail(ctx.res, 400, '请上传资料文件');

  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) return fail(ctx.res, 400, '仅支持 PDF / Word / PPT / Excel / ZIP / 图片 / 文本格式');

  const base64 = fileData.includes(',') ? fileData.split(',').pop() : fileData;
  let buf;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    return fail(ctx.res, 400, '文件解析失败');
  }
  if (!buf.length) return fail(ctx.res, 400, '文件内容为空');
  if (buf.length > 20 * 1024 * 1024) return fail(ctx.res, 400, '单个文件不能超过 20MB');
  const signature = signatureProblem(buf, ext);
  if (signature) return fail(ctx.res, 400, signature);

  const fullText = extractText(buf, ext);
  const auditText = buildAuditText({ title, description, category, subject, teacher, course, tags, fileName }, fullText);
  const audit = contentAudit.safeInspect(auditText);
  if (audit.verdict === 'block') {
    contentAudit.record({ targetId: null, userId: ctx.user.id, action: 'submit', text: auditText, result: audit });
    return rejectByAudit(ctx, audit);
  }

  const stored = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  try {
    await fs.promises.writeFile(path.join(UPLOAD_DIR, stored), buf);
  } catch (err) {
    console.error('[materials] 资料文件写入失败', err.message);
    return fail(ctx.res, 500, '文件保存失败，请稍后重试');
  }

  const preview = makePreview({ title, description, category, school, subject, teacher, previewRatio }, fullText);
  // 公开演示环境无人可执行后台审核，上传即上架；正式环境仍走人工审核
  const initialStatus = runtime.PUBLIC_DEMO ? 'approved' : 'pending';
  const ts = now();
  const info = run(
    `INSERT INTO materials (seller_id, title, description, category, school, subject, teacher, course,
       preview_text, preview_ratio, price_source, price_note, price_cents, file_name, file_path, file_size,
       tags, status, reject_reason, audit_verdict, audit_score, audit_hits, audit_status, audit_at,
       content_chars, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seller', '', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.user.id, title, description, category, school, subject, teacher, course,
    preview, previewRatio, Math.round(price * 100), fileName, stored, buf.length, tags.join(','), initialStatus,
    audit.verdict, audit.score, auditHitsJson(audit), auditStatusOf(audit), ts, fullText.length, ts, ts
  );
  const id = Number(info.lastInsertRowid);
  contentAudit.record({ targetId: id, userId: ctx.user.id, action: 'submit', text: auditText, result: audit });
  sendJson(ctx.res, 201, {
    id,
    message: auditMessage(audit, runtime.PUBLIC_DEMO),
    audit: {
      verdict: audit.verdict,
      score: audit.score,
      categories: audit.categories || [],
      hitCount: (audit.hits || []).length
    }
  });
}

async function update(ctx) {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM materials WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '资料不存在');
  if (row.seller_id !== ctx.user.id && ctx.user.role !== 'admin') return fail(ctx.res, 403, '无权修改该资料');
  if (row.seller_id === ctx.user.id && !requireVerified(ctx, '修改资料')) return;
  const body = ctx.body;

  const title = String(body.title ?? row.title).trim();
  const description = String(body.description ?? row.description).trim();
  const category = String(body.category ?? row.category).trim();
  const school = String(body.school ?? row.school).trim();
  const subject = String(body.subject ?? row.subject ?? '').trim();
  const teacher = String(body.teacher ?? row.teacher ?? '').trim();
  const course = String(body.course ?? row.course).trim();
  const previewRatio = Math.min(20, Math.max(10, Number(body.previewRatio ?? row.preview_ratio) || 15));
  const price = body.price === undefined ? row.price_cents / 100 : Number(body.price);
  const tags = body.tags === undefined
    ? row.tags
    : (Array.isArray(body.tags) ? body.tags : String(body.tags).split(',')).map((t) => String(t).trim()).filter(Boolean).slice(0, 5).join(',');

  if (title.length < 4 || title.length > 80) return fail(ctx.res, 400, '资料标题需为 4—80 个字符');
  if (description.length < 20) return fail(ctx.res, 400, '资料介绍至少 20 个字');
  if (!CATEGORIES.includes(category)) return fail(ctx.res, 400, '请选择正确的资料分类');
  if (!school) return fail(ctx.res, 400, '请选择资料所属院校');
  if (!SCHOOL_SET.has(school)) return fail(ctx.res, 400, '请选择资源库中的院校');
  if (!subject) return fail(ctx.res, 400, '请选择资料所属学科');
  if (!SUBJECT_SET.has(subject)) return fail(ctx.res, 400, '请选择资源库中的学科');
  if (course.length > 40) return fail(ctx.res, 400, '课程名称不能超过 40 个字符');
  if (!Number.isFinite(price) || price < 0 || price > 999) return fail(ctx.res, 400, '价格需在 0—999 元之间');

  const priceCents = Math.round(price * 100);
  const priceChanged = priceCents !== row.price_cents;
  // 卖家未主动改价时保留平台定价来源与说明，避免仅编辑介绍就覆盖运营校准结果
  const priceSource = priceChanged ? 'seller' : (row.price_source || 'seller');
  const priceNote = priceChanged ? '' : (row.price_note || '');

  let fullText = '';
  if (row.file_path) {
    const p = path.join(UPLOAD_DIR, path.basename(row.file_path));
    try {
      const fileBuf = await fs.promises.readFile(p);
      const ext = path.extname(row.file_path).slice(1).toLowerCase();
      fullText = extractText(fileBuf, ext);
    } catch {
      fullText = '';
    }
  }
  const preview = makePreview({ title, description, category, school, subject, teacher, previewRatio }, fullText);

  const auditText = buildAuditText({ title, description, category, subject, teacher, course, tags, fileName: row.file_name }, fullText);
  const audit = contentAudit.safeInspect(auditText);
  if (audit.verdict === 'block') {
    contentAudit.record({ targetId: id, userId: ctx.user.id, action: 'update', text: auditText, result: audit });
    return rejectByAudit(ctx, audit);
  }

  // 公开演示环境无人可执行后台审核，编辑后维持上架；正式环境重新进入待审核
  const nextStatus = runtime.PUBLIC_DEMO ? 'approved' : 'pending';
  run(
    `UPDATE materials SET title = ?, description = ?, category = ?, school = ?, subject = ?, teacher = ?, course = ?,
       preview_text = ?, preview_ratio = ?, price_cents = ?, price_source = ?, price_note = ?, tags = ?,
       status = ?, reject_reason = '', audit_verdict = ?, audit_score = ?, audit_hits = ?, audit_status = ?, audit_at = ?,
       content_chars = ?, updated_at = ? WHERE id = ?`,
    title, description, category, school, subject, teacher, course,
    preview, previewRatio, priceCents, priceSource, priceNote, tags,
    nextStatus, audit.verdict, audit.score, auditHitsJson(audit), auditStatusOf(audit), now(),
    fullText.length, now(), id
  );
  contentAudit.record({ targetId: id, userId: ctx.user.id, action: 'update', text: auditText, result: audit });
  sendJson(ctx.res, 200, {
    message: `修改已保存，${auditMessage(audit, runtime.PUBLIC_DEMO)}`,
    audit: {
      verdict: audit.verdict,
      score: audit.score,
      categories: audit.categories || [],
      hitCount: (audit.hits || []).length
    }
  });
}

function remove(ctx) {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM materials WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '资料不存在');
  if (row.seller_id !== ctx.user.id && ctx.user.role !== 'admin') return fail(ctx.res, 403, '无权删除该资料');
  const orderCount = get('SELECT COUNT(*) AS c FROM orders WHERE material_id = ?', id).c;
  if (orderCount > 0) {
    run(`UPDATE materials SET status = 'offline', updated_at = ? WHERE id = ?`, now(), id);
    return sendJson(ctx.res, 200, { message: '该资料已有成交记录，已下架处理（历史订单不受影响）' });
  }
  run('DELETE FROM favorites WHERE material_id = ?', id);
  run('DELETE FROM materials WHERE id = ?', id);
  if (row.file_path) {
    const p = path.join(UPLOAD_DIR, path.basename(row.file_path));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  sendJson(ctx.res, 200, { message: '资料已删除' });
}

function toggleFavorite(ctx) {
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM materials WHERE id = ?', id)) return fail(ctx.res, 404, '资料不存在');
  const exists = get('SELECT 1 AS x FROM favorites WHERE user_id = ? AND material_id = ?', ctx.user.id, id);
  if (exists) {
    run('DELETE FROM favorites WHERE user_id = ? AND material_id = ?', ctx.user.id, id);
    return sendJson(ctx.res, 200, { favorited: false, message: '已取消收藏' });
  }
  run('INSERT INTO favorites (user_id, material_id, created_at) VALUES (?, ?, ?)', ctx.user.id, id, now());
  sendJson(ctx.res, 200, { favorited: true, message: '已加入收藏' });
}

function report(ctx) {
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM materials WHERE id = ?', id)) return fail(ctx.res, 404, '资料不存在');
  const reason = String(ctx.body.reason || '').trim();
  const detail = String(ctx.body.detail || '').trim();
  if (!reason) return fail(ctx.res, 400, '请选择举报原因');
  if (detail.length > 300) return fail(ctx.res, 400, '补充说明不能超过 300 字');
  if (get(`SELECT id FROM reports WHERE material_id = ? AND reporter_id = ? AND status = 'pending'`, id, ctx.user.id)) {
    return fail(ctx.res, 409, '你已提交过举报，平台正在核实');
  }
  run(
    `INSERT INTO reports (material_id, reporter_id, reason, detail, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
    id, ctx.user.id, reason, detail, now()
  );
  sendJson(ctx.res, 201, { message: '举报已提交，平台将在 48 小时内核实' });
}

function addReview(ctx) {
  const id = Number(ctx.params.id);
  const rating = Number(ctx.body.rating);
  const content = String(ctx.body.content || '').trim();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail(ctx.res, 400, '请选择 1—5 星评分');
  if (content.length > 300) return fail(ctx.res, 400, '评价内容不能超过 300 字');
  const order = get(
    `SELECT o.* FROM orders o LEFT JOIN reviews r ON r.order_id = o.id
     WHERE o.material_id = ? AND o.buyer_id = ? AND o.status = 'completed' AND r.id IS NULL
     ORDER BY o.created_at DESC LIMIT 1`, id, ctx.user.id
  );
  if (!order) return fail(ctx.res, 403, '只有购买过该资料的同学可以评价，且每笔订单限评一次');

  run(
    'INSERT INTO reviews (material_id, order_id, user_id, rating, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, order.id, ctx.user.id, rating, content, now()
  );
  const agg = get('SELECT COUNT(*) AS c, AVG(rating) AS avg FROM reviews WHERE material_id = ?', id);
  run('UPDATE materials SET rating_avg = ?, rating_count = ? WHERE id = ?', Math.round(agg.avg * 10) / 10, agg.c, id);
  sendJson(ctx.res, 201, { message: '评价已发布，感谢你的反馈' });
}

module.exports = { list, detail, preview, mine, favorites, download, create, update, remove, toggleFavorite, report, addReview };
