/**
 * 学涯集市 · 登录与注册全链路测试
 *
 * 覆盖：统一登录入口（管理员 / 个人用户同一流程）、普通用户注册、
 *       邮箱 / 用户名两种登录方式、错误密码、重复账号、弱密码与权限边界。
 *
 * 运行：npm run test:auth
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.AUTH_TEST_PORT || 3405);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-auth-'));

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

async function request(url, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, data };
}

async function waitForServer(child, output) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`服务启动失败，退出码 ${child.exitCode}\n${output()}`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`服务启动超时：${BASE}\n${output()}`);
}

const capture = { out: '', err: '' };
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR, SEED_DEMO: 'true' },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (b) => { capture.out += b.toString(); });
child.stderr.on('data', (b) => { capture.err += b.toString(); });
const output = () => `--- stdout ---\n${capture.out}\n--- stderr ---\n${capture.err}`;

function cleanup() {
  if (child.exitCode === null) child.kill('SIGTERM');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

try {
  await waitForServer(child, output);

  const stamp = Date.now().toString().slice(-8);
  const email = `auth${stamp}@xueya.cn`;
  const username = `auth${stamp}`;
  const password = 'Auth123456';
  const nickname = '认证测试用户';

  /* ---- 体验账号（个人用户角色）登录 ---- */
  const judge = await request('/api/auth/login', {
    method: 'POST',
    body: { account: 'judge@xueya.cn', password: 'Judge123456' }
  });
  check('体验账号可用统一登录流程登录', judge.status === 200, `status=${judge.status}`);
  check('体验账号角色为个人用户 user', judge.data?.user?.role === 'user', JSON.stringify(judge.data?.user?.role));
  check('体验账号已通过认证', judge.data?.user?.verified === true, String(judge.data?.user?.verified));
  const judgeToken = judge.data?.token;
  const judgeMe = await request('/api/auth/me', { token: judgeToken });
  check('体验账号 token 可读取个人信息', judgeMe.status === 200 && judgeMe.data?.user?.email === 'judge@xueya.cn', `status=${judgeMe.status}`);
  const judgeAdmin = await request('/api/admin/overview', { token: judgeToken });
  check('个人用户无后台权限（403）', judgeAdmin.status === 403, `status=${judgeAdmin.status}`);

  /* ---- 普通用户注册 ---- */
  const reg = await request('/api/auth/register', {
    method: 'POST',
    body: { nickname, username, email, password, school: '武汉大学' }
  });
  check('新用户注册成功', reg.status === 201, `status=${reg.status} ${JSON.stringify(reg.data)}`);
  check('注册返回登录 token', typeof reg.data?.token === 'string' && reg.data.token.length > 10, 'token 缺失');
  check('注册返回昵称与用户名', reg.data?.user?.nickname === nickname && reg.data?.user?.username === username, JSON.stringify(reg.data?.user));
  check('新用户初始为未认证', reg.data?.user?.verified === false, String(reg.data?.user?.verified));

  /* ---- 登录方式 ---- */
  const byEmail = await request('/api/auth/login', {
    method: 'POST',
    body: { account: email, password }
  });
  check('注册用户可用邮箱登录', byEmail.status === 200, `status=${byEmail.status}`);
  const byName = await request('/api/auth/login', {
    method: 'POST',
    body: { account: username, password }
  });
  check('注册用户可用用户名登录', byName.status === 200, `status=${byName.status}`);
  check('两种登录方式为同一账号', byEmail.data?.user?.id === byName.data?.user?.id, `${byEmail.data?.user?.id} vs ${byName.data?.user?.id}`);

  const wrong = await request('/api/auth/login', {
    method: 'POST',
    body: { account: email, password: 'WrongPass123' }
  });
  check('错误密码被拒绝（401）', wrong.status === 401, `status=${wrong.status}`);

  /* ---- 注册校验 ---- */
  const dupEmail = await request('/api/auth/register', {
    method: 'POST',
    body: { nickname: '重复邮箱', username: `dup${stamp}`, email, password }
  });
  check('重复邮箱注册被拒绝（409）', dupEmail.status === 409, `status=${dupEmail.status}`);
  const dupName = await request('/api/auth/register', {
    method: 'POST',
    body: { nickname: '重复用户名', username, email: `dup${stamp}@xueya.cn`, password }
  });
  check('重复用户名注册被拒绝（409）', dupName.status === 409, `status=${dupName.status}`);
  const weak = await request('/api/auth/register', {
    method: 'POST',
    body: { nickname: '弱密码', username: `weak${stamp}`, email: `weak${stamp}@xueya.cn`, password: '12345678' }
  });
  check('纯数字弱密码被拒绝（400）', weak.status === 400, `status=${weak.status}`);
  const shortName = await request('/api/auth/register', {
    method: 'POST',
    body: { nickname: '短用户名', username: 'ab', email: `short${stamp}@xueya.cn`, password }
  });
  check('过短用户名被拒绝（400）', shortName.status === 400, `status=${shortName.status}`);

  /* ---- 登录态 ---- */
  const me = await request('/api/auth/me', { token: byEmail.data?.token });
  check('注册用户 token 可读取个人信息', me.status === 200 && me.data?.user?.email === email, `status=${me.status}`);
} catch (err) {
  failed += 1;
  console.error('测试执行失败：', err.message);
} finally {
  cleanup();
}

console.log(`\n${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed === 0 ? 0 : 1);
