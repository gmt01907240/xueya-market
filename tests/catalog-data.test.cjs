'use strict';

/**
 * 院校 / 专业官方数据一致性校验
 *
 * 校验对象：
 * - server/data/schools-official.json（教育部 2026 年全国高等学校名单）
 * - server/data/majors-official.json（教育部 2026 年本科专业目录）
 * - server/data/catalog-manifest.json（来源与数量清单）
 * - 数据库同步结果（server/db.js ensureCatalog，需与官方数据逐条一致）
 *
 * 运行：npm run test:data
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-catalog-data-'));
process.env.DATA_DIR = DATA_DIR;
process.env.SEED_DEMO = 'false';

const schools = require('../server/data/schools-official.json');
const majors = require('../server/data/majors-official.json');
const manifest = require('../server/data/catalog-manifest.json');
const { init, all, get, run, db, SCHOOLS, MAJORS } = require('../server/db');

const DEGREE_LEVELS = new Set(['本科', '专科', '成人高等学校']);
const SCHOOL_TYPES = new Set(['普通本科', '职业本科', '高职（专科）', '成人高等学校']);
const OWNERSHIPS = new Set(['公办', '民办', '中外合作办学']);
const MAJOR_CATEGORIES = new Set([
  '哲学', '经济学', '法学', '教育学', '文学', '历史学', '理学',
  '工学', '农学', '医学', '管理学', '艺术学', '交叉学科'
]);

after(() => {
  db.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('官方院校名单', () => {
  test('数量与教育部 2026 年公布口径一致', () => {
    assert.equal(schools.length, 3196);
    assert.equal(manifest.counts.schools, schools.length);
    assert.equal(schools.filter((s) => s.degreeLevel !== '成人高等学校').length, 2952);
    assert.equal(schools.filter((s) => s.degreeLevel === '成人高等学校').length, 244);
  });

  test('校名与官方标识码均无重复', () => {
    assert.equal(new Set(schools.map((s) => s.name)).size, schools.length);
    assert.equal(new Set(schools.map((s) => s.code)).size, schools.length);
  });

  test('每所院校均含完整官方字段', () => {
    for (const s of schools) {
      assert.match(s.code, /^\d{10}$/, `${s.name} 的官方标识码格式错误：${s.code}`);
      assert.ok(s.name && s.province, `${s.code} 缺少校名或省份`);
      assert.ok(DEGREE_LEVELS.has(s.degreeLevel), `${s.name} 办学层次非法：${s.degreeLevel}`);
      assert.ok(SCHOOL_TYPES.has(s.schoolType), `${s.name} 办学类型非法：${s.schoolType}`);
      assert.ok(OWNERSHIPS.has(s.ownership), `${s.name} 办学性质非法：${s.ownership}`);
      assert.ok(s.source.includes('教育部'), `${s.name} 缺少官方数据来源`);
      assert.ok(s.tags.includes(s.province), `${s.name} 标签缺少省份`);
    }
  });
});

describe('官方本科专业目录', () => {
  test('数量与门类、专业类口径一致', () => {
    assert.equal(majors.length, 883);
    assert.equal(manifest.counts.majors, majors.length);
    assert.equal(manifest.counts.majorCategories, 13);
    const categories = new Set(majors.map((m) => m.category));
    assert.equal(categories.size, 13);
    for (const name of categories) assert.ok(MAJOR_CATEGORIES.has(name), `未知学科门类：${name}`);
    // 官方专业类 92 个；交叉学科门类下的专业按门类归并为 1400，因此数据中多出一个归并编码
    const classCodes = new Set(majors.map((m) => m.classCode));
    assert.equal(classCodes.size, manifest.counts.majorClasses + 1);
    assert.ok(classCodes.has('1400'));
  });

  test('专业名称与专业代码均无重复', () => {
    assert.equal(new Set(majors.map((m) => m.name)).size, majors.length);
    assert.equal(new Set(majors.map((m) => m.code)).size, majors.length);
  });

  test('专业代码与门类 / 专业类归属严格匹配', () => {
    for (const m of majors) {
      assert.match(m.code, /^\d{6,7}[TK]{0,2}$/, `${m.name} 的专业代码格式错误：${m.code}`);
      assert.equal(m.code.slice(0, 2), m.categoryCode, `${m.name} 门类代码不一致`);
      assert.equal(m.code.slice(0, 4), m.classCode, `${m.name} 专业类代码不一致`);
      assert.ok(m.name && m.className, `${m.code} 缺少专业名称或专业类名称`);
      assert.equal(typeof m.isSpecial, 'boolean');
      assert.equal(typeof m.isControlled, 'boolean');
      assert.equal(m.isSpecial, m.code.slice(6).includes('T'), `${m.name} 特设标记不一致`);
      assert.equal(m.isControlled, m.code.slice(6).includes('K'), `${m.name} 国控标记不一致`);
    }
  });
});

describe('数据库同步一致性', () => {
  test('同步后院校与专业数量、编码与官方数据完全一致', () => {
    init();

    assert.equal(get('SELECT COUNT(*) AS c FROM schools').c, schools.length);
    assert.equal(get('SELECT COUNT(*) AS c FROM majors').c, majors.length);

    const dbSchools = all('SELECT name, code, degree_level, school_type, ownership FROM schools');
    const official = new Map(schools.map((s) => [s.code, s]));
    for (const row of dbSchools) {
      const src = official.get(row.code);
      assert.ok(src, `数据库存在非官方院校：${row.name} / ${row.code}`);
      assert.equal(row.name, src.name);
      assert.equal(row.degree_level, src.degreeLevel);
      assert.equal(row.school_type, src.schoolType);
      assert.equal(row.ownership, src.ownership);
    }

    const dbMajors = all('SELECT code, name, category, class_code FROM majors');
    const officialMajors = new Map(majors.map((m) => [m.code, m]));
    for (const row of dbMajors) {
      const src = officialMajors.get(row.code);
      assert.ok(src, `数据库存在非官方专业：${row.code}`);
      assert.equal(row.name, src.name);
      assert.equal(row.category, src.category);
      assert.equal(row.class_code, src.classCode);
    }

    assert.equal(SCHOOLS.length, schools.length);
    assert.equal(MAJORS.length, majors.length);
  });

  test('再次同步会清理不符合官方标准的条目', () => {
    run(
      `INSERT INTO schools (name, code, province, city, level, tags, created_at)
       VALUES ('示例非官方学院', '9999999999', '示例省', '示例市', '普通本科', '示例省 普通本科', '2026-01-01 00:00:00')`
    );
    init();
    assert.equal(get('SELECT COUNT(*) AS c FROM schools WHERE code = ?', '9999999999').c, 0);
    assert.equal(get('SELECT COUNT(*) AS c FROM schools').c, schools.length);
  });
});
