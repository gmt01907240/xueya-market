/**
 * 学涯集市 · AI 学习规划测试
 *
 * 覆盖：选项、参数校验、推荐排序、覆盖分析、逐日计划、可复现性、响应耗时、
 *       登录态学科推断、计划保存与打卡、越权访问、gzip 压缩与限流。
 *
 * 运行：npm run test:plan
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PLAN_TEST_PORT || 3402);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-plan-'));

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

async function request(url, { method = 'GET', token, body, raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data, headers: res.headers };
}

async function login(account, password) {
  const res = await request('/api/auth/login', { method: 'POST', body: { account, password } });
  return res.data?.token || '';
}

async function waitForServer(child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务启动失败，退出码 ${child.exitCode}`);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务启动超时');
}

async function generate(body) {
  return request('/api/plan/generate', { method: 'POST', body });
}

async function main() {
  console.log(`\n学涯集市 AI 学习规划测试 · ${BASE}\n`);

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, RATE_LIMIT_PLAN: '10' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (buf) => process.stderr.write(`[server] ${buf}`));

  try {
    await waitForServer(child);

    /* 1. 选项 */
    const options = await request('/api/plan/options');
    check('规划选项接口可用', options.status === 200 && options.data?.goals?.length === 5, JSON.stringify(options.data?.goals?.length));
    check('包含全部目标场景', ['final', 'postgrad', 'contest', 'paper', 'language'].every((c) => options.data.goals.some((g) => g.code === c)));
    check('学科选项来自资源库', (options.data?.subjects || []).includes('计算机科学与技术'), String((options.data?.subjects || []).length));
    check('标注本地规则引擎', options.data?.engine === 'rule-based-v1');

    /* 2. 正常生成 */
    const started = Date.now();
    const plan = await generate({ goal: 'final', subject: '计算机科学与技术', days: 7, dailyMinutes: 60 });
    const took = Date.now() - started;
    check('生成计划成功', plan.status === 200 && plan.data?.plan?.length === 7, JSON.stringify(plan.status));
    check('推荐资料不少于 3 份', (plan.data?.recommendations || []).length >= 3, String(plan.data?.recommendations?.length));
    check('每条推荐都有可解释理由', (plan.data?.recommendations || []).every((m) => Array.isArray(m.reasons) && m.reasons.length > 0));
    check('推荐按匹配分降序', (plan.data?.recommendations || []).every((m, i, arr) => i === 0 || arr[i - 1].score >= m.score));
    check('覆盖率为 0—100', plan.data?.summary?.coverage >= 0 && plan.data?.summary?.coverage <= 100, String(plan.data?.summary?.coverage));
    check('逐日任务包含时长与动作', (plan.data?.plan || []).every((d) => d.items.length > 0 && d.items.every((t) => t.minutes > 0 && t.action)));
    check('推荐结果包含价格与分类', (plan.data?.recommendations || []).every((m) => Number.isInteger(m.price) && m.category));
    check('生成响应低于 1 秒', took < 1000, `${took}ms`);

    /* 3. 可复现 */
    const again = await generate({ goal: 'final', subject: '计算机科学与技术', days: 7, dailyMinutes: 60 });
    check('相同条件结果可复现', again.data?.recommendations?.[0]?.id === plan.data.recommendations[0].id);

    /* 4. 参数校验 */
    const badGoal = await generate({ goal: 'unknown' });
    check('拒绝未知目标', badGoal.status === 400, JSON.stringify(badGoal.data));
    const badDays = await generate({ goal: 'final', days: 2 });
    check('拒绝少于 3 天', badDays.status === 400, JSON.stringify(badDays.data));
    const badMinutes = await generate({ goal: 'final', dailyMinutes: 10 });
    check('拒绝过短时长', badMinutes.status === 400, JSON.stringify(badMinutes.data));
    const badSubject = await generate({ goal: 'final', subject: '不存在的学科' });
    check('拒绝无效学科', badSubject.status === 400, JSON.stringify(badSubject.data));

    /* 5. 登录态推断与压缩 */
    const buyerToken = await login('student@xueya.cn', 'Student123456');
    const inferred = await request('/api/plan/generate', {
      method: 'POST', token: buyerToken, body: { goal: 'final', days: 5, dailyMinutes: 90 }
    });
    check('登录用户自动推断学科', inferred.status === 200 && Boolean(inferred.data?.subject), JSON.stringify(inferred.data?.subject));

    /* 6. 保存与打卡 */
    const anonSave = await request('/api/plan/save', {
      method: 'POST', body: { goal: 'final', subject: '计算机科学与技术', days: 7, dailyMinutes: 60 }
    });
    check('未登录不可保存计划', anonSave.status === 401, String(anonSave.status));

    const saved = await request('/api/plan/save', {
      method: 'POST', token: buyerToken,
      body: { goal: 'final', subject: '计算机科学与技术', days: 7, dailyMinutes: 60 }
    });
    check('登录后可保存学习计划', saved.status === 201 && saved.data?.id > 0, JSON.stringify(saved.data));
    const planId = saved.data?.id;

    const list = await request('/api/plan/mine', { token: buyerToken });
    check('我的计划包含刚保存的计划', list.status === 200 && (list.data?.items || []).some((p) => p.id === planId));

    const savedDetail = await request(`/api/plan/${planId}`, { token: buyerToken });
    check('保存的计划含逐日任务与初始进度', savedDetail.status === 200
      && savedDetail.data?.plan?.plan?.length === 7 && savedDetail.data?.progress?.done === 0);

    const checked = await request(`/api/plan/${planId}/check`, {
      method: 'POST', token: buyerToken, body: { taskKey: '1-0', done: true }
    });
    check('打卡后进度增加', checked.status === 200 && checked.data?.progress?.done === 1 && checked.data?.progress?.percent > 0,
      JSON.stringify(checked.data?.progress));

    const repeat = await request(`/api/plan/${planId}/check`, {
      method: 'POST', token: buyerToken, body: { taskKey: '1-0', done: true }
    });
    check('重复打卡幂等', repeat.status === 200 && repeat.data?.progress?.done === 1, JSON.stringify(repeat.data?.progress));

    const badTask = await request(`/api/plan/${planId}/check`, {
      method: 'POST', token: buyerToken, body: { taskKey: '99-9', done: true }
    });
    check('拒绝不存在的任务', badTask.status === 400, JSON.stringify(badTask.data));

    const sellerToken = await login('seller@xueya.cn', 'Seller123456');
    const foreign = await request(`/api/plan/${planId}`, { token: sellerToken });
    check('他人无法读取计划', foreign.status === 404, String(foreign.status));

    const undone = await request(`/api/plan/${planId}/check`, {
      method: 'POST', token: buyerToken, body: { taskKey: '1-0', done: false }
    });
    check('取消打卡后进度回退', undone.status === 200 && undone.data?.progress?.done === 0, JSON.stringify(undone.data?.progress));

    const removed = await request(`/api/plan/${planId}`, { method: 'DELETE', token: buyerToken });
    check('计划可删除', removed.status === 200, String(removed.status));
    const gone = await request(`/api/plan/${planId}`, { token: buyerToken });
    check('删除后不可读取', gone.status === 404, String(gone.status));

    /* 7. 压缩 */
    const compressed = await request('/api/plan/options', { raw: true });
    check('JSON 响应按需 gzip 压缩', compressed.headers.get('content-encoding') === 'gzip', compressed.headers.get('content-encoding') || 'none');
    const css = await request('/css/app.css', { raw: true });
    check('静态资源按需 gzip 压缩', css.headers.get('content-encoding') === 'gzip', css.headers.get('content-encoding') || 'none');

    /* 8. 限流 */
    let limited = false;
    for (let i = 0; i < 16; i++) {
      const res = await generate({ goal: 'final', days: 7, dailyMinutes: 60 });
      if (res.status === 429) { limited = true; break; }
    }
    check('规划接口触发限流', limited);
  } finally {
    child.kill();
  }

  console.log(`\n结果：${passed} 项通过，${failed} 项失败\n`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
