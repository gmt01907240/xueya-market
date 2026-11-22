/**
 * 学涯集市 · 正式发布版本加固测试
 *
 * 覆盖：生产模式不写演示数据、邀请码准入与次数限制、功能开关、
 *       后台来源限制、X-Forwarded-For 防伪造、请求追踪、优雅退出。
 *
 * 运行：npm run test:release
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adminLogin } from './admin-login-helper.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT_A = Number(process.env.RELEASE_TEST_PORT_A || 3403);
const PORT_B = Number(process.env.RELEASE_TEST_PORT_B || 3404);
const PORT_GUARD = Number(process.env.RELEASE_TEST_PORT_GUARD || 3405);
const BASE_A = `http://localhost:${PORT_A}`;
const BASE_B = `http://localhost:${PORT_B}`;
const DATA_A = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-release-a-'));
const DATA_B = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-release-b-'));
const DATA_GUARD = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-release-guard-'));

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

async function request(base, url, { method = 'GET', token, body, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  if (token) finalHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${url}`, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data, headers: res.headers };
}

async function waitForServer(child, base, output) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`服务启动失败，退出码 ${child.exitCode}\n${output()}`);
    }
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`服务启动超时：${base}\n${output()}`);
}

function startServer(port, dataDir, extraEnv, capture) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (buf) => capture.stdout += buf.toString());
  child.stderr.on('data', (buf) => {
    capture.stderr += buf.toString();
    process.stderr.write(`[server:${port}] ${buf}`);
  });
  return child;
}

function waitForExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function stopServer(child) {
  if (child.exitCode !== null) return child.exitCode;
  child.kill('SIGTERM');
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 6000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function main() {
  console.log(`\n学涯集市正式发布加固测试\n  A: ${BASE_A}\n  B: ${BASE_B}\n`);

  const captureA = { stdout: '', stderr: '' };
  const captureB = { stdout: '', stderr: '' };

  const childA = startServer(PORT_A, DATA_A, {
    NODE_ENV: 'development',
    SEED_DEMO: 'true',
    INVITE_CODES: 'BETA-001:2',
    FEATURE_PLAN: 'off',
    FEATURE_BARGAIN: 'off',
    FEATURE_UPLOAD: 'off',
    FEATURE_AI_SUPPORT: 'off',
    ADMIN_IP_ALLOWLIST: '10.9.9.9',
    RATE_LIMIT_LOGIN: '5'
  }, captureA);

  let childB = null;
  try {
    await waitForServer(childA, BASE_A, () => captureA.stderr || captureA.stdout);

    /* 1. 版本与运行环境 */
    const health = await request(BASE_A, '/api/health');
    check('健康检查返回 1.1.0', health.status === 200 && health.data?.version === '1.1.0', JSON.stringify(health.data));

    const meta = await request(BASE_A, '/api/meta');
    check('元信息暴露环境与功能开关', meta.status === 200
      && meta.data?.environment?.inviteRequired === true
      && meta.data?.environment?.features?.plan === false
      && meta.data?.environment?.features?.bargain === false, JSON.stringify(meta.data?.environment));

    /* 2. 邀请码准入 */
    const noInvite = await request(BASE_A, '/api/auth/register', {
      method: 'POST',
      body: { nickname: '无邀请', username: 'noinvite', email: 'noinvite@test.cn', password: 'Test123456' }
    });
    check('未填写邀请码被拒绝', noInvite.status === 400 && /邀请码/.test(noInvite.data?.error || ''), JSON.stringify(noInvite.data));

    const wrongInvite = await request(BASE_A, '/api/auth/register', {
      method: 'POST',
      body: { nickname: '错码', username: 'wrongcode', email: 'wrongcode@test.cn', password: 'Test123456', inviteCode: 'BETA-XXX' }
    });
    check('错误邀请码被拒绝', wrongInvite.status === 400 && /无效/.test(wrongInvite.data?.error || ''), JSON.stringify(wrongInvite.data));

    const invite1 = await request(BASE_A, '/api/auth/register', {
      method: 'POST',
      body: { nickname: '内测一', username: 'betaone', email: 'betaone@test.cn', password: 'Test123456', inviteCode: 'beta-001' }
    });
    check('邀请码注册成功且不区分大小写', invite1.status === 201 && Boolean(invite1.data?.token), JSON.stringify(invite1.data));

    const invite2 = await request(BASE_A, '/api/auth/register', {
      method: 'POST',
      body: { nickname: '内测二', username: 'betatwo', email: 'betatwo@test.cn', password: 'Test123456', inviteCode: 'BETA-001' }
    });
    check('邀请码第二次使用成功', invite2.status === 201 && Boolean(invite2.data?.token), JSON.stringify(invite2.data));

    const invite3 = await request(BASE_A, '/api/auth/register', {
      method: 'POST',
      body: { nickname: '内测三', username: 'betathree', email: 'betathree@test.cn', password: 'Test123456', inviteCode: 'BETA-001' }
    });
    check('邀请码超过次数被拒绝', invite3.status === 400 && /上限/.test(invite3.data?.error || ''), JSON.stringify(invite3.data));

    /* 3. 功能开关 */
    const token = invite1.data?.token || '';
    const planOff = await request(BASE_A, '/api/plan/generate', {
      method: 'POST', token, body: { goal: 'final', days: 7, dailyMinutes: 60 }
    });
    check('规划开关关闭时返回 403', planOff.status === 403, JSON.stringify(planOff.data));

    const bargainOff = await request(BASE_A, '/api/bargains', {
      method: 'POST', token, body: { materialId: 1 }
    });
    check('砍价开关关闭时返回 403', bargainOff.status === 403, JSON.stringify(bargainOff.data));

    const uploadOff = await request(BASE_A, '/api/materials', {
      method: 'POST', token,
      body: { title: '开关测试', description: '功能开关关闭时不允许上传资料。', category: '课堂笔记', subject: '计算机科学与技术', price: 1, fileName: 'a.txt', fileData: Buffer.from('test').toString('base64') }
    });
    check('上传开关关闭时返回 403', uploadOff.status === 403, JSON.stringify(uploadOff.data));

    const aiOff = await request(BASE_A, '/api/support/ai', {
      method: 'POST', body: { message: '怎么下载资料？' }
    });
    check('AI 客服开关关闭时返回 403', aiOff.status === 403, JSON.stringify(aiOff.data));

    /* 4. 后台来源限制与请求追踪 */
    const adminAuth = await adminLogin(BASE_A);
    check('管理员专属入口按 IP 白名单拒绝非受信来源', adminAuth.ok === false && adminAuth.status === 403, JSON.stringify(adminAuth.data || {}));

    const adminBlocked = await request(BASE_A, '/api/admin/overview', { token: 'invalid-admin-token' });
    check('后台接口拒绝未授权 token', adminBlocked.status === 401 || adminBlocked.status === 403, JSON.stringify(adminBlocked.data));

    check('API 响应包含 X-Request-Id', Boolean(meta.headers.get('x-request-id')));

    /* 5. X-Forwarded-For 防伪造：未开启 TRUST_PROXY 时仍按真实来源限流 */
    let limited = false;
    for (let i = 0; i < 6; i += 1) {
      const res = await request(BASE_A, '/api/auth/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': `203.0.113.${i + 1}` },
        body: { account: 'admin@xueya.cn', password: 'wrong-password' }
      });
      if (res.status === 429) limited = true;
    }
    check('伪造 X-Forwarded-For 无法绕过登录限流', limited);

    /* 6. 生产环境支付未配置时必须拒绝启动（安全闸门） */
    const captureGuard = { stdout: '', stderr: '' };
    const guardChild = startServer(PORT_GUARD, DATA_GUARD, { NODE_ENV: 'production' }, captureGuard);
    const guardExit = await waitForExit(guardChild);
    const guardOutput = `${captureGuard.stdout}\n${captureGuard.stderr}`;
    check('生产环境支付未就绪时拒绝启动', guardExit === 1 && /MOCK_IN_PRODUCTION/.test(guardOutput), `exit=${guardExit}`);

    /* 7. 生产模式：不写演示数据（支付功能显式关闭，避免闸门阻断与测试目标无关的校验） */
    childB = startServer(PORT_B, DATA_B, {
      NODE_ENV: 'production',
      DATA_DIR: DATA_B,
      FEATURE_PAYMENTS: 'off'
    }, captureB);
    await waitForServer(childB, BASE_B, () => captureB.stderr || captureB.stdout);

    const prodMeta = await request(BASE_B, '/api/meta');
    check('生产模式元信息标记为非演示环境', prodMeta.status === 200 && prodMeta.data?.environment?.demo === false, JSON.stringify(prodMeta.data?.environment));
    check('生产模式初始用户数为 0', prodMeta.data?.stats?.users === 0, String(prodMeta.data?.stats?.users));

    const prodAdmin = await request(BASE_B, '/api/auth/login', {
      method: 'POST', body: { account: 'admin@xueya.cn', password: 'Admin123456' }
    });
    check('生产模式不存在演示管理员', prodAdmin.status === 401, String(prodAdmin.status));

    const prodRegister = await request(BASE_B, '/api/auth/register', {
      method: 'POST',
      body: { nickname: '生产用户', username: 'produser', email: 'produser@test.cn', password: 'Test123456' }
    });
    check('生产模式可正常注册真实用户', prodRegister.status === 201 && Boolean(prodRegister.data?.token), JSON.stringify(prodRegister.data));

    check('生产启动日志不输出演示密码', !captureB.stdout.includes('Student123456') && !captureB.stdout.includes('Admin123456'), captureB.stdout.slice(0, 200));

    const exitCode = await stopServer(childB);
    childB = null;
    check('收到终止信号后及时退出', exitCode !== 'timeout', String(exitCode));
  } finally {
    if (childB) await stopServer(childB);
    await stopServer(childA);
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
