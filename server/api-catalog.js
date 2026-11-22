'use strict';

const { all, get } = require('./db');
const { sendJson, fail } = require('./http');
const { compareNames } = require('./name-sort');

const TYPES = new Set(['school', 'subject', 'teacher', 'major']);
const TYPE_TEXT = { school: '院校', subject: '学科', teacher: '教师', major: '专业' };

function tokensOf(q) {
  return String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4);
}

function like(token) {
  return `%${token}%`;
}

function levelRank(level = '') {
  if (level.includes('985')) return 4;
  if (level.includes('211')) return 3;
  if (level.includes('双一流')) return 2;
  return 1;
}

function scoreItem(item, tokens, primary, secondary = []) {
  if (!tokens.length) return 0;
  const q = tokens.join(' ');
  const p = String(item[primary] || '').toLowerCase();
  let score = 0;
  if (p === q) score += 1000;
  else if (p.startsWith(q)) score += 800;
  else if (p.includes(q)) score += 600;
  for (const field of secondary) {
    const value = String(item[field] || '').toLowerCase();
    if (!value) continue;
    if (value === q) score += 300;
    else if (value.startsWith(q)) score += 220;
    else if (value.includes(q)) score += 120;
  }
  for (const token of tokens) {
    if (p.includes(token)) score += 40;
    for (const field of secondary) {
      if (String(item[field] || '').toLowerCase().includes(token)) score += 12;
    }
  }
  return score;
}

function querySchools(tokens) {
  const where = tokens.length
    ? `WHERE ${tokens.map(() => '(s.name LIKE ? OR s.code LIKE ? OR s.province LIKE ? OR s.city LIKE ? OR s.level LIKE ? OR s.school_type LIKE ? OR s.ownership LIKE ?)').join(' AND ')}`
    : '';
  const params = tokens.flatMap((t) => [like(t), like(t), like(t), like(t), like(t), like(t), like(t)]);
  return all(
    `SELECT s.name, s.code, s.province, s.city, s.supervisor,
       s.degree_level AS degreeLevel, s.school_type AS schoolType, s.ownership, s.level,
       COALESCE(m.c, 0) AS materialCount,
       COALESCE(tc.c, 0) AS teacherCount
     FROM schools s
     LEFT JOIN (
       SELECT school, COUNT(*) AS c FROM materials
       WHERE status = 'approved' AND school != '' GROUP BY school
     ) m ON m.school = s.name
     LEFT JOIN (
       SELECT school, COUNT(*) AS c FROM teachers GROUP BY school
     ) tc ON tc.school = s.name
     ${where}`,
    ...params
  );
}

function queryMajors(tokens) {
  const where = tokens.length
    ? `WHERE ${tokens.map(() => '(m.code LIKE ? OR m.name LIKE ? OR m.category LIKE ? OR m.class_name LIKE ?)').join(' AND ')}`
    : '';
  const params = tokens.flatMap((t) => [like(t), like(t), like(t), like(t)]);
  return all(
    `SELECT m.code, m.name,
       m.category_code AS categoryCode, m.category,
       m.class_code AS classCode, m.class_name AS className,
       m.degree_note AS degreeNote,
       m.is_special AS isSpecial, m.is_controlled AS isControlled
     FROM majors m
     ${where}`,
    ...params
  );
}

function querySubjects(tokens) {
  const where = tokens.length
    ? `WHERE ${tokens.map(() => '(s.name LIKE ? OR s.category LIKE ?)').join(' AND ')}`
    : '';
  const params = tokens.flatMap((t) => [like(t), like(t)]);
  return all(
    `SELECT s.name, s.category,
       COALESCE(m.c, 0) AS materialCount,
       COALESCE(tc.c, 0) AS teacherCount
     FROM subjects s
     LEFT JOIN (
       SELECT subject, COUNT(*) AS c FROM materials
       WHERE status = 'approved' AND subject != '' GROUP BY subject
     ) m ON m.subject = s.name
     LEFT JOIN (
       SELECT subject, COUNT(*) AS c FROM teachers GROUP BY subject
     ) tc ON tc.subject = s.name
     ${where}`,
    ...params
  );
}

function queryTeachers(tokens) {
  const where = tokens.length
    ? `WHERE ${tokens.map(() => '(t.name LIKE ? OR t.school LIKE ? OR t.subject LIKE ? OR t.title LIKE ?)').join(' AND ')}`
    : '';
  const params = tokens.flatMap((t) => [like(t), like(t), like(t), like(t)]);
  return all(
    `SELECT t.name, t.school, t.subject, t.title,
       COALESCE(m.c, 0) AS materialCount
     FROM teachers t
     LEFT JOIN (
       SELECT teacher, COUNT(*) AS c FROM materials
       WHERE status = 'approved' AND teacher != '' GROUP BY teacher
     ) m ON m.teacher = t.name
     ${where}`,
    ...params
  );
}

function search(ctx) {
  const started = process.hrtime.bigint();
  const type = String(ctx.query.type || '').trim();
  if (!TYPES.has(type)) return fail(ctx.res, 400, '搜索类型需为 school / subject / teacher / major');

  const rawQ = String(ctx.query.q || '').trim().slice(0, 40);
  const tokens = tokensOf(rawQ);
  const limit = Math.min(50, Math.max(1, Number(ctx.query.limit) || 24));
  const page = Math.max(1, Number(ctx.query.page) || 1);

  let rows;
  let primary;
  let secondary;
  if (type === 'school') {
    rows = querySchools(tokens);
    primary = 'name';
    secondary = ['code', 'province', 'city', 'level', 'schoolType', 'ownership'];
  } else if (type === 'subject') {
    rows = querySubjects(tokens);
    primary = 'name';
    secondary = ['category'];
  } else if (type === 'major') {
    rows = queryMajors(tokens);
    primary = 'name';
    secondary = ['code', 'category', 'className'];
  } else {
    rows = queryTeachers(tokens);
    primary = 'name';
    secondary = ['school', 'subject', 'title'];
  }

  const items = rows.map((row) => ({ ...row, score: scoreItem(row, tokens, primary, secondary) }));
  items.sort((a, b) => {
    // 无关键词浏览时统一按名称拼音 / 字母升序，便于按首字母查找
    if (tokens.length === 0) return compareNames(a.name, b.name);
    if (b.score !== a.score) return b.score - a.score;
    if ((b.materialCount || 0) !== (a.materialCount || 0)) return (b.materialCount || 0) - (a.materialCount || 0);
    return compareNames(a.name, b.name);
  });

  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const slice = items.slice((page - 1) * limit, page * limit).map(({ score, ...rest }) => rest);
  const tookMs = Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100;

  sendJson(ctx.res, 200, {
    type,
    typeText: TYPE_TEXT[type],
    q: rawQ,
    total,
    page,
    pages,
    limit,
    tookMs,
    items: slice
  });
}

function overview(ctx) {
  const schools = get('SELECT COUNT(*) AS c FROM schools').c;
  const majors = get('SELECT COUNT(*) AS c FROM majors').c;
  const subjects = get('SELECT COUNT(*) AS c FROM subjects').c;
  const teachers = get('SELECT COUNT(*) AS c FROM teachers').c;
  const provinces = get('SELECT COUNT(DISTINCT province) AS c FROM schools').c;
  const materials = get(`SELECT COUNT(*) AS c FROM materials WHERE status = 'approved'`).c;
  const topSchools = all(
    `SELECT name, province, level FROM schools
     WHERE level LIKE '%985%' ORDER BY name LIMIT 8`
  );
  const topMajors = all(
    `SELECT name, code, category FROM majors ORDER BY code LIMIT 8`
  );
  const topSubjects = all(
    `SELECT s.name, COUNT(t.id) AS teacherCount
     FROM subjects s LEFT JOIN teachers t ON t.subject = s.name
     GROUP BY s.id ORDER BY teacherCount DESC, s.id ASC LIMIT 8`
  );
  sendJson(ctx.res, 200, {
    schools, majors, subjects, teachers, provinces, materials,
    hotSchools: topSchools,
    hotMajors: topMajors,
    hotSubjects: topSubjects,
    source: '教育部《全国高等学校名单（2026）》 · 《普通高等学校本科专业目录（2026年）》'
  });
}

module.exports = { search, overview };
