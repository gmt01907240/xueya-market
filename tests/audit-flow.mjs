/**
 * 学涯集市 · 内容自动审核流程测试
 *
 * 覆盖：违法内容自动拦截、疑似内容转人工复核、审核日志落库、
 *       规则动态增删改即时生效、阈值更新、毫秒级响应。
 *
 * 运行：先启动服务（npm start），再执行 npm run test:audit
 * 可选：BASE_URL=https://your-domain.com npm run test:audit
 */

const BASE = (process.env.BASE_URL || 'http://localhost:3300').replace(/\/$/, '');

import { adminLogin } from './admin-login-helper.mjs';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

async function login(account, password) {
  const res = await request('/api/auth/login', { method: 'POST', body: { account, password } });
  if (res.status !== 200 || !res.data?.token) throw new Error(`登录失败：${account}`);
  return res.data.token;
}

function materialPayload({ title, description, fileName = 'audit-test.txt', content = '' }) {
  const text = content || `${title}\n\n${description}\n\n本资料为正常的课程复习笔记，包含章节重点、例题解析与复习建议。`;
  return {
    title,
    description,
    category: '课堂笔记',
    subject: '计算机科学与技术',
    teacher: '王海涛',
    course: '数据结构',
    previewRatio: 15,
    price: 9.9,
    tags: ['自动审核测试'],
    fileName,
    fileData: Buffer.from(text, 'utf8').toString('base64')
  };
}

async function mineCount(token) {
  const res = await request('/api/materials/mine?status=all', { token });
  return (res.data?.items || []).length;
}

async function main() {
  console.log(`\n学涯集市内容自动审核测试 · ${BASE}\n`);

  const health = await request('/api/health');
  check('服务健康检查', health.status === 200 && health.data?.status === 'ok', String(health.status));
  if (health.status !== 200) process.exit(1);

  const seller = await login('seller@xueya.cn', 'Seller123456');
  const adminAuth = await adminLogin(BASE);
  check('管理员专属入口密码+MFA 登录', adminAuth.ok === true && Boolean(adminAuth.token), JSON.stringify(adminAuth.data || {}));
  const admin = adminAuth.token;

  /* ---- 规则库与配置 ---- */
  const overview = await request('/api/admin/audit/overview', { token: admin });
  check('管理端审核概览', overview.status === 200 && !!overview.data?.stats, String(overview.status));
  check('内置多分类规则已加载', (overview.data?.stats?.totalRules || 0) >= 20, String(overview.data?.stats?.totalRules));
  check('审核阈值配置存在', overview.data?.stats?.settings?.reviewThreshold > 0 && overview.data?.stats?.settings?.blockThreshold > 0);
  check('无权限用户无法访问规则库', (await request('/api/admin/audit/rules')).status === 401);

  const rules = await request('/api/admin/audit/rules', { token: admin });
  check('规则库接口返回分类', rules.status === 200 && Array.isArray(rules.data?.categories) && rules.data.categories.length >= 6);

  /* ---- 直接拦截 ---- */
  const before = await mineCount(seller);
  const blocked = await request('/api/materials', {
    method: 'POST', token: seller,
    body: materialPayload({
      title: '出售冰毒与吸毒工具渠道',
      description: '提供各类毒品与吸毒工具，长期出售冰毒、海洛因，支持代购与快递发货，联系后私聊。'
    })
  });
  check('违法内容提交返回 422', blocked.status === 422, String(blocked.status));
  check('返回明确的合规提示', blocked.data?.code === 'CONTENT_BLOCKED' && /合规检测/.test(blocked.data?.error || ''));
  check('命中涉毒分类', Array.isArray(blocked.data?.audit?.categories) && blocked.data.audit.categories.includes('涉毒'), JSON.stringify(blocked.data?.audit?.categories));
  check('拦截后资料未入库', (await mineCount(seller)) === before, `${before} -> ${await mineCount(seller)}`);

  /* ---- 正常内容放行 ---- */
  const clean = await request('/api/materials', {
    method: 'POST', token: seller,
    body: materialPayload({
      title: '数据结构期末复习笔记',
      description: '整理数据结构课程的核心章节、典型例题与复习建议，适合期末阶段查漏补缺使用。'
    })
  });
  check('正常内容提交成功', clean.status === 201, String(clean.status));
  check('正常内容机审通过', clean.data?.audit?.verdict === 'pass', clean.data?.audit?.verdict);
  const cleanId = clean.data?.id;

  if (cleanId) {
    const detail = await request(`/api/materials/${cleanId}`, { token: seller });
    check('资料记录包含机审结果', detail.data?.material?.audit?.verdict === 'pass' && detail.data?.material?.status === 'pending');
    await request(`/api/materials/${cleanId}`, { method: 'DELETE', token: seller });
  }

  /* ---- 疑似内容转人工复核 ---- */
  const review = await request('/api/materials', {
    method: 'POST', token: seller,
    body: materialPayload({
      title: '网络赌博文化现象观察',
      description: '从社会学角度整理网络赌博群体的行为特征与相关研究，包含赌博平台案例的讨论与课堂笔记。'
    })
  });
  check('疑似内容允许提交（不误杀）', review.status === 201, String(review.status));
  check('疑似内容判定为人工复核', review.data?.audit?.verdict === 'review', review.data?.audit?.verdict);
  const reviewId = review.data?.id;
  if (reviewId) {
    const detail = await request(`/api/materials/${reviewId}`, { token: seller });
    check('资料标记为待人工复核', detail.data?.material?.audit?.status === 'review' && detail.data?.material?.status === 'pending');
    await request(`/api/materials/${reviewId}`, { method: 'DELETE', token: seller });
  }

  /* ---- 审核日志与耗时 ---- */
  const blockLogs = await request('/api/admin/audit/logs?verdict=block&pageSize=5', { token: admin });
  check('审核日志可查询到拦截记录', blockLogs.status === 200 && (blockLogs.data?.items || []).some((l) => l.verdict === 'block' && l.status === 'blocked'));
  check('拦截日志保存触发规则', (blockLogs.data?.items || [])[0]?.hits?.length > 0);
  const reviewLogs = await request('/api/admin/audit/logs?verdict=review&pageSize=5', { token: admin });
  check('审核日志可查询到复核记录', (reviewLogs.data?.items || []).some((l) => l.status === 'pending_review'));
  const fastest = (blockLogs.data?.items || [])[0]?.durationMs;
  check('检测耗时保持毫秒级', typeof fastest === 'number' && fastest < 1000, `${fastest} ms`);

  /* ---- 规则动态新增 / 停用 / 删除 ---- */
  const code = `TEST_${Date.now()}`;
  const created = await request('/api/admin/audit/rules', {
    method: 'POST', token: admin,
    body: { code, category: '涉政', level: 'review', weight: 20, matchType: 'keyword', pattern: '测试专用违禁词', tip: '自动化测试规则' }
  });
  check('管理员可新增规则', created.status === 201, JSON.stringify(created.data));

  const tested = await request('/api/admin/audit/rules/test', {
    method: 'POST', token: admin,
    body: { text: '这段文本包含测试专用违禁词，用于验证规则热更新。' }
  });
  check('规则测试立即命中新增规则', tested.data?.result?.verdict === 'review' && tested.data?.result?.hits?.some((h) => h.code === code));

  const dynamic = await request('/api/materials', {
    method: 'POST', token: seller,
    body: materialPayload({
      title: '规则热更新验证资料',
      description: '本资料用于验证新增规则是否即时生效，正文中包含测试专用违禁词这一测试短语。'
    })
  });
  check('新增规则对真实提交即时生效', dynamic.status === 201 && dynamic.data?.audit?.verdict === 'review');
  if (dynamic.data?.id) await request(`/api/materials/${dynamic.data.id}`, { method: 'DELETE', token: seller });

  const ruleId = (await request('/api/admin/audit/rules', { token: admin })).data?.items?.find((r) => r.code === code)?.id;
  check('规则可在规则库中检索', !!ruleId);
  if (ruleId) {
    const disabled = await request(`/api/admin/audit/rules/${ruleId}`, { method: 'PATCH', token: admin, body: { active: false } });
    check('规则支持停用', disabled.status === 200, String(disabled.status));
    const afterDisable = await request('/api/admin/audit/rules/test', {
      method: 'POST', token: admin,
      body: { text: '这段文本包含测试专用违禁词。' }
    });
    check('停用后规则立即失效', afterDisable.data?.result?.verdict === 'pass');
    const removed = await request(`/api/admin/audit/rules/${ruleId}`, { method: 'DELETE', token: admin });
    check('规则支持删除', removed.status === 200, String(removed.status));
  }

  /* ---- 阈值动态更新 ---- */
  const settings = await request('/api/admin/audit/settings', {
    method: 'PATCH', token: admin,
    body: { reviewThreshold: 35, blockThreshold: 85 }
  });
  check('阈值支持动态更新', settings.status === 200 && settings.data?.settings?.reviewThreshold === 35);
  await request('/api/admin/audit/settings', { method: 'PATCH', token: admin, body: { reviewThreshold: 30, blockThreshold: 80 } });

  /* ---- 人工复核结果回写日志 ---- */
  const pending = await request('/api/materials', {
    method: 'POST', token: seller,
    body: materialPayload({
      title: '人工复核回写日志测试',
      description: '本资料介绍包含赌博相关字样的学术讨论，用于验证人工审核结果能够回写日志。'
    })
  });
  if (pending.data?.id) {
    const approve = await request(`/api/admin/materials/${pending.data.id}/review`, {
      method: 'POST', token: admin, body: { action: 'approve' }
    });
    check('管理员可通过机审疑似资料', approve.status === 200, String(approve.status));
    const logs = await request(`/api/admin/audit/logs?targetId=${pending.data.id}`, { token: admin });
    check('人工审核结果已回写日志', (logs.data?.items || []).some((l) => l.status === 'manual_approved'));
    await request(`/api/materials/${pending.data.id}`, { method: 'DELETE', token: seller });
  } else {
    check('人工复核回写日志测试资料创建', false, String(pending.status));
  }

  console.log(`\n结果：${passed} 项通过，${failed} 项失败\n`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error('测试执行失败：', err);
  process.exit(1);
});
