'use strict';

const crypto = require('node:crypto');
const { all, get, run, now } = require('./db');
const { AUDIT_CATEGORIES, AUDIT_LEVELS, DEFAULT_SETTINGS, DEFAULT_RULES } = require('./audit-default-rules');

const STATUS_MAP = {
  pass: 'auto_pass',
  review: 'pending_review',
  block: 'blocked',
  error: 'error_review'
};

const CACHE_TTL = 5000;

let ruleCache = null;
let ruleCacheAt = 0;
let lastError = '';
let engineVersion = 1;

function invalidate() {
  ruleCache = null;
  ruleCacheAt = 0;
  engineVersion += 1;
  return engineVersion;
}

function init() {
  try {
    const ts = now();
    for (const rule of DEFAULT_RULES) {
      run(
        `INSERT OR IGNORE INTO audit_rules
         (code, category, level, weight, match_type, pattern, tip, source, active, hit_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'builtin', 1, 0, ?, ?)`,
        rule.code, rule.category, rule.level, rule.weight, rule.matchType, rule.pattern, rule.tip, ts, ts
      );
    }
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      run(
        `INSERT OR IGNORE INTO audit_settings (key, value, updated_at) VALUES (?, ?, ?)`,
        key, String(value), ts
      );
    }
    invalidate();
    loadRules();
    return true;
  } catch (err) {
    lastError = err.message;
    console.error('[audit] 初始化失败，审核将降级为人工复核', err);
    return false;
  }
}

function loadSettings() {
  const settings = { ...DEFAULT_SETTINGS };
  try {
    for (const row of all('SELECT key, value FROM audit_settings')) {
      const num = Number(row.value);
      if (Number.isFinite(num)) settings[row.key] = num;
    }
  } catch (err) {
    console.error('[audit] 读取审核配置失败，使用默认阈值', err);
  }
  return settings;
}

function loadRules() {
  if (ruleCache && Date.now() - ruleCacheAt < CACHE_TTL) return ruleCache;
  const rules = [];
  try {
    const rows = all('SELECT * FROM audit_rules WHERE active = 1 ORDER BY weight DESC, id ASC');
    for (const row of rows) {
      let re = null;
      if (row.match_type === 'regex') {
        try {
          re = new RegExp(row.pattern, 'i');
        } catch (err) {
          console.error(`[audit] 规则 ${row.code} 正则编译失败，已跳过`, err.message);
          continue;
        }
      }
      rules.push({
        id: row.id,
        code: row.code,
        category: row.category,
        level: row.level,
        weight: Number(row.weight) || 0,
        matchType: row.match_type,
        pattern: row.pattern,
        tip: row.tip,
        terms: row.match_type === 'keyword'
          ? row.pattern.split('|').map((t) => compact(t)).filter(Boolean)
          : null,
        re
      });
    }
    ruleCache = rules;
    ruleCacheAt = Date.now();
  } catch (err) {
    lastError = err.message;
    console.error('[audit] 读取规则失败，本次使用内置规则兜底', err);
    if (!rules.length) {
      for (const rule of DEFAULT_RULES) {
        try {
          rules.push({
            ...rule,
            terms: rule.matchType === 'keyword' ? rule.pattern.split('|').map((t) => compact(t)).filter(Boolean) : null,
            re: rule.matchType === 'regex' ? new RegExp(rule.pattern, 'i') : null
          });
        } catch {
          /* 内置规则异常时忽略 */
        }
      }
    }
  }
  return rules;
}

function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase();
}

function compact(text) {
  return normalize(text).replace(/[\s\p{P}\p{S}]+/gu, '');
}

function snippet(raw, rule) {
  const text = String(raw || '');
  let idx = -1;
  try {
    if (rule.matchType === 'keyword') {
      const term = String(rule.pattern).split('|')[0];
      idx = text.toLowerCase().indexOf(term.toLowerCase());
    } else if (rule.re) {
      rule.re.lastIndex = 0;
      const match = rule.re.exec(normalize(text));
      if (match) idx = Math.min(text.length - 1, match.index);
    }
  } catch {
    idx = -1;
  }
  if (idx < 0) return text.slice(0, 60).replace(/\s+/g, ' ');
  const start = Math.max(0, idx - 24);
  const end = Math.min(text.length, idx + 42);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

function inspect(text) {
  const started = process.hrtime.bigint();
  const settings = loadSettings();
  if (settings.enabled === 0) {
    return { verdict: 'pass', score: 0, hits: [], durationMs: 0, disabled: true, settings };
  }
  const limited = String(text || '').slice(0, Math.max(1000, settings.maxScanChars));
  const normalized = normalize(limited);
  const compacted = compact(limited);
  const rules = loadRules();
  const hits = [];
  let score = 0;
  let blockHit = null;

  for (const rule of rules) {
    let matched = false;
    if (rule.matchType === 'regex') {
      if (rule.re) {
        rule.re.lastIndex = 0;
        matched = rule.re.test(normalized);
      }
    } else {
      const terms = rule.terms || [compact(rule.pattern)];
      matched = terms.some((term) => term && compacted.includes(term));
    }
    if (!matched) continue;
    score += rule.weight;
    if (rule.level === 'block' && !blockHit) blockHit = rule;
    hits.push({
      code: rule.code,
      category: rule.category,
      level: rule.level,
      weight: rule.weight,
      tip: rule.tip,
      excerpt: snippet(limited, rule)
    });
    if (hits.length >= 50) break;
  }

  const capped = Math.min(100, score);
  const verdict = blockHit || capped >= settings.blockThreshold
    ? 'block'
    : (hits.some((h) => h.level === 'review') || capped >= settings.reviewThreshold ? 'review' : 'pass');

  const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100;
  return {
    verdict,
    score: capped,
    hits,
    categories: [...new Set(hits.map((h) => h.category))],
    durationMs,
    engineVersion,
    settings
  };
}

function safeInspect(text) {
  try {
    return inspect(text);
  } catch (err) {
    lastError = err.message;
    console.error('[audit] 内容检测异常，已降级为人工复核', err);
    return {
      verdict: 'error',
      score: 0,
      hits: [],
      categories: [],
      durationMs: 0,
      engineVersion,
      error: err.message
    };
  }
}

function record({ targetType = 'material', targetId = null, userId = null, action = 'submit', text = '', result, note = '' }) {
  const verdict = result?.verdict || 'error';
  const status = STATUS_MAP[verdict] || 'error_review';
  const hits = (result?.hits || []).slice(0, 20);
  try {
    const digest = crypto.createHash('sha256').update(String(text || '')).digest('hex');
    const excerpt = hits.length ? hits[0].excerpt : '';
    const info = run(
      `INSERT INTO audit_logs
       (target_type, target_id, user_id, action, verdict, score, hits, digest, excerpt, status, duration_ms, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      targetType, targetId, userId, action, verdict, Math.round(result?.score || 0),
      JSON.stringify(hits), digest, excerpt, status, Math.round(result?.durationMs || 0), note, now()
    );
    const logId = Number(info.lastInsertRowid);
    for (const hit of hits) {
      run('UPDATE audit_rules SET hit_count = hit_count + 1 WHERE code = ?', hit.code);
    }
    return { logId, status, verdict };
  } catch (err) {
    lastError = err.message;
    console.error('[audit] 审核日志写入失败（不影响业务主流程）', err);
    return { logId: null, status, verdict };
  }
}

function markReviewed(targetId, action, note = '') {
  try {
    const row = get(
      `SELECT id FROM audit_logs WHERE target_type = 'material' AND target_id = ? ORDER BY id DESC LIMIT 1`,
      Number(targetId)
    );
    if (!row) return false;
    const status = action === 'approve' ? 'manual_approved' : 'manual_rejected';
    run('UPDATE audit_logs SET status = ?, note = ? WHERE id = ?', status, String(note).slice(0, 200), row.id);
    return true;
  } catch (err) {
    lastError = err.message;
    console.error('[audit] 更新人工复核结果失败', err);
    return false;
  }
}

function parseHits(raw) {
  try {
    const hits = JSON.parse(raw || '[]');
    return Array.isArray(hits) ? hits : [];
  } catch {
    return [];
  }
}

function listLogs(query = {}) {
  const verdict = String(query.verdict || '');
  const status = String(query.status || '');
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  const where = [];
  const params = [];
  if (verdict) { where.push('l.verdict = ?'); params.push(verdict); }
  if (status) { where.push('l.status = ?'); params.push(status); }
  if (query.targetId) { where.push('l.target_id = ?'); params.push(Number(query.targetId)); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) AS c FROM audit_logs l ${whereSql}`, ...params).c;
  const rows = all(
    `SELECT l.*, u.nickname AS user_nickname, m.title AS material_title
     FROM audit_logs l
     LEFT JOIN users u ON u.id = l.user_id
     LEFT JOIN materials m ON m.id = l.target_id
     ${whereSql} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize
  );
  const counts = {
    all: get('SELECT COUNT(*) AS c FROM audit_logs').c,
    pass: get(`SELECT COUNT(*) AS c FROM audit_logs WHERE verdict = 'pass'`).c,
    review: get(`SELECT COUNT(*) AS c FROM audit_logs WHERE verdict = 'review'`).c,
    block: get(`SELECT COUNT(*) AS c FROM audit_logs WHERE verdict = 'block'`).c,
    error: get(`SELECT COUNT(*) AS c FROM audit_logs WHERE verdict = 'error'`).c
  };
  return {
    items: rows.map((row) => ({
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      materialTitle: row.material_title || '',
      user: row.user_nickname || '系统',
      action: row.action,
      verdict: row.verdict,
      score: row.score,
      hits: parseHits(row.hits),
      excerpt: row.excerpt,
      status: row.status,
      durationMs: row.duration_ms,
      note: row.note,
      createdAt: row.created_at
    })),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    counts
  };
}

function stats() {
  const settings = loadSettings();
  const today = now().slice(0, 10);
  const todayRow = get(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN verdict = 'block' THEN 1 ELSE 0 END), 0) AS blocked,
       COALESCE(SUM(CASE WHEN verdict = 'review' THEN 1 ELSE 0 END), 0) AS review,
       COALESCE(SUM(CASE WHEN verdict = 'pass' THEN 1 ELSE 0 END), 0) AS passed,
       COALESCE(AVG(duration_ms), 0) AS avg_ms
     FROM audit_logs WHERE substr(created_at, 1, 10) = ?`, today
  );
  const pendingReviewMaterials = get(
    `SELECT COUNT(*) AS c FROM materials WHERE status = 'pending' AND audit_verdict IN ('review', 'error')`
  ).c;
  const totalBlocked = get(`SELECT COUNT(*) AS c FROM audit_logs WHERE verdict = 'block'`).c;
  const totalRules = get('SELECT COUNT(*) AS c FROM audit_rules').c;
  const activeRules = get('SELECT COUNT(*) AS c FROM audit_rules WHERE active = 1').c;
  const categories = all(
    `SELECT category, COUNT(*) AS rules, COALESCE(SUM(hit_count), 0) AS hits
     FROM audit_rules GROUP BY category ORDER BY hits DESC, rules DESC`
  );
  return {
    today: {
      total: todayRow.total,
      blocked: todayRow.blocked,
      review: todayRow.review,
      pass: todayRow.passed,
      avgDurationMs: Math.round(Number(todayRow.avg_ms || 0) * 100) / 100
    },
    totalBlocked,
    pendingReviewMaterials,
    totalRules,
    activeRules,
    categories,
    settings,
    engineVersion,
    lastError
  };
}

function validateRule(payload, existing = {}) {
  const code = String(payload.code ?? existing.code ?? '').trim().toUpperCase();
  const category = String(payload.category ?? existing.category ?? '').trim();
  const level = String(payload.level ?? existing.level ?? 'review').trim();
  const weight = Number(payload.weight ?? existing.weight ?? 10);
  const matchType = String(payload.matchType ?? existing.match_type ?? 'keyword').trim();
  const pattern = String(payload.pattern ?? existing.pattern ?? '').trim();
  const tip = String(payload.tip ?? existing.tip ?? '').trim();
  const active = payload.active === undefined ? (existing.active === undefined ? 1 : existing.active) : (payload.active ? 1 : 0);

  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return { error: '规则编号需为 3—40 位大写字母、数字、下划线或短横线' };
  if (!AUDIT_CATEGORIES.includes(category)) return { error: '请选择正确的违规分类' };
  if (!AUDIT_LEVELS.some((l) => l.key === level)) return { error: '规则等级不合法' };
  if (!Number.isFinite(weight) || weight < 1 || weight > 100) return { error: '规则权重需在 1—100 之间' };
  if (!['keyword', 'regex'].includes(matchType)) return { error: '匹配方式仅支持关键词或正则' };
  if (!pattern || pattern.length > 500) return { error: '匹配表达式不能为空且不超过 500 字符' };
  if (tip.length > 120) return { error: '规则说明不能超过 120 字' };
  if (matchType === 'regex') {
    try {
      new RegExp(pattern, 'i');
    } catch {
      return { error: '正则表达式无法编译，请检查语法' };
    }
  }
  return { value: { code, category, level, weight: Math.round(weight), matchType, pattern, tip, active } };
}

function listRules() {
  const rows = all('SELECT * FROM audit_rules ORDER BY active DESC, category ASC, weight DESC, id ASC');
  return rows.map((row) => {
    let valid = true;
    if (row.match_type === 'regex') {
      try { new RegExp(row.pattern, 'i'); } catch { valid = false; }
    }
    return {
      id: row.id,
      code: row.code,
      category: row.category,
      level: row.level,
      weight: row.weight,
      matchType: row.match_type,
      pattern: row.pattern,
      tip: row.tip,
      source: row.source,
      active: !!row.active,
      hitCount: row.hit_count,
      valid,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}

function createRule(payload) {
  const checked = validateRule(payload);
  if (checked.error) return checked;
  const value = checked.value;
  if (get('SELECT id FROM audit_rules WHERE code = ?', value.code)) return { error: '规则编号已存在，请更换编号' };
  const ts = now();
  const info = run(
    `INSERT INTO audit_rules (code, category, level, weight, match_type, pattern, tip, source, active, hit_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'custom', ?, 0, ?, ?)`,
    value.code, value.category, value.level, value.weight, value.matchType, value.pattern, value.tip, value.active, ts, ts
  );
  invalidate();
  return { id: Number(info.lastInsertRowid) };
}

function updateRule(id, payload) {
  const row = get('SELECT * FROM audit_rules WHERE id = ?', Number(id));
  if (!row) return { error: '规则不存在' };
  const checked = validateRule(payload, row);
  if (checked.error) return checked;
  const value = checked.value;
  const dup = get('SELECT id FROM audit_rules WHERE code = ? AND id != ?', value.code, row.id);
  if (dup) return { error: '规则编号已存在，请更换编号' };
  run(
    `UPDATE audit_rules SET code = ?, category = ?, level = ?, weight = ?, match_type = ?, pattern = ?, tip = ?, active = ?, updated_at = ?
     WHERE id = ?`,
    value.code, value.category, value.level, value.weight, value.matchType, value.pattern, value.tip, value.active, now(), row.id
  );
  invalidate();
  return { id: row.id };
}

function deleteRule(id) {
  const row = get('SELECT * FROM audit_rules WHERE id = ?', Number(id));
  if (!row) return { error: '规则不存在' };
  run('DELETE FROM audit_rules WHERE id = ?', row.id);
  invalidate();
  return { id: row.id };
}

function updateSettings(payload) {
  const current = loadSettings();
  const next = {
    enabled: payload.enabled === undefined ? current.enabled : (payload.enabled ? 1 : 0),
    reviewThreshold: payload.reviewThreshold === undefined ? current.reviewThreshold : Number(payload.reviewThreshold),
    blockThreshold: payload.blockThreshold === undefined ? current.blockThreshold : Number(payload.blockThreshold),
    maxScanChars: payload.maxScanChars === undefined ? current.maxScanChars : Number(payload.maxScanChars)
  };
  if (!Number.isFinite(next.reviewThreshold) || next.reviewThreshold < 1 || next.reviewThreshold > 100) {
    return { error: '人工复核阈值需在 1—100 之间' };
  }
  if (!Number.isFinite(next.blockThreshold) || next.blockThreshold < next.reviewThreshold || next.blockThreshold > 100) {
    return { error: '自动拦截阈值需大于等于复核阈值且不超过 100' };
  }
  if (!Number.isFinite(next.maxScanChars) || next.maxScanChars < 1000 || next.maxScanChars > 1000000) {
    return { error: '单次扫描字符数需在 1000—1000000 之间' };
  }
  const ts = now();
  for (const [key, value] of Object.entries(next)) {
    run(
      `INSERT INTO audit_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key, String(value), ts
    );
  }
  return { settings: next };
}

function testText(text) {
  return safeInspect(text);
}

module.exports = {
  init,
  invalidate,
  loadSettings,
  inspect,
  safeInspect,
  record,
  markReviewed,
  listLogs,
  stats,
  listRules,
  createRule,
  updateRule,
  deleteRule,
  updateSettings,
  testText,
  AUDIT_CATEGORIES,
  AUDIT_LEVELS
};

