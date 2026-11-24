/**
 * 学涯集市 · 角色与权限体验全链路测试
 *
 * 覆盖：统一登录入口、仅个人用户 / 管理员两种角色、
 *       个人用户买家与卖家能力一体化、权限边界越权拦截、登录态会话保持。
 *
 * 运行：npm run test:role
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adminLogin, ADMIN_PASSWORD } from './admin-login-helper.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.ROLE_TEST_PORT || 3407);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-role-'));

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
  console.log('角色与权限体验测试');
  await waitForServer(child, output);

  /* ---- 统一登录入口，两种角色同一接口 ---- */
  const personal = await request('/api/auth/login', {
    method: 'POST',
    body: { account: 'judge@xueya.cn', password: 'Judge123456' }
  });
  check('个人用户通过统一登录接口登录', personal.status === 200, `status=${personal.status}`);
  check('个人用户角色为 user', personal.data?.user?.role === 'user', JSON.stringify(personal.data?.user?.role));

  const adminBlocked = await request('/api/auth/login', {
    method: 'POST',
    body: { account: 'admin@xueya.cn', password: ADMIN_PASSWORD }
  });
  check('普通登录入口拒绝管理员', adminBlocked.status === 403, `status=${adminBlocked.status}`);
  check('拒绝提示不暴露专属入口路径', !JSON.stringify(adminBlocked.data || {}).includes('/ops-login'));

  const adminAuth = await adminLogin(BASE);
  check('管理员专属入口完成密码+MFA登录', adminAuth.ok === true && Boolean(adminAuth.token), JSON.stringify(adminAuth.data || {}));
  check('管理员角色为 admin', adminAuth.user?.role === 'admin', JSON.stringify(adminAuth.user?.role));

  const personalToken = personal.data?.token;
  const adminToken = adminAuth.token;
  check('两种角色分别由独立入口签发 token', typeof personalToken === 'string' && typeof adminToken === 'string');

  /* ---- 注册账号默认归属个人用户，角色集合仅 user / admin ---- */
  const stamp = Date.now().toString(36);
  const reg = await request('/api/auth/register', {
    method: 'POST',
    body: {
      nickname: '角色测试用户',
      username: `role${stamp}`,
      email: `role${stamp}@xueya.cn`,
      password: 'Role123456',
      school: '武汉大学'
    }
  });
  check('新注册账号成功', reg.status === 201, `status=${reg.status}`);
  check('新注册账号固定为个人用户角色', reg.data?.user?.role === 'user', JSON.stringify(reg.data?.user?.role));

  const adminUsers = await request('/api/admin/users', { token: adminToken });
  check('管理员可读取用户列表', adminUsers.status === 200, `status=${adminUsers.status}`);
  const roles = new Set((adminUsers.data?.items || []).map((u) => u.role));
  check('系统内角色仅有 user 与 admin', roles.size > 0 && [...roles].every((r) => r === 'user' || r === 'admin'), [...roles].join(','));

  /* ---- 权限边界：个人用户访问管理端被拦截 ---- */
  const personalOverview = await request('/api/admin/overview', { token: personalToken });
  check('个人用户访问管理概览被拒绝（403）', personalOverview.status === 403, `status=${personalOverview.status}`);
  const personalAdminUsers = await request('/api/admin/users', { token: personalToken });
  check('个人用户读取用户列表被拒绝（403）', personalAdminUsers.status === 403, `status=${personalAdminUsers.status}`);
  const adminOverview = await request('/api/admin/overview', { token: adminToken });
  check('管理员可访问管理概览', adminOverview.status === 200, `status=${adminOverview.status}`);

  /* ---- 买家与卖家能力由同一账号同时具备 ---- */
  const sellerOverview = await request('/api/seller/overview', { token: personalToken });
  check('个人用户可进入卖家中心', sellerOverview.status === 200, `status=${sellerOverview.status}`);
  const sales = await request('/api/orders/sales', { token: personalToken });
  check('个人用户可查看卖家订单', sales.status === 200, `status=${sales.status}`);
  const myMaterials = await request('/api/materials/mine', { token: personalToken });
  check('个人用户可查看自己发布的资料', myMaterials.status === 200, `status=${myMaterials.status}`);
  const buyerOrders = await request('/api/orders/mine', { token: personalToken });
  check('同一账号可查看买家订单', buyerOrders.status === 200, `status=${buyerOrders.status}`);
  const favorites = await request('/api/materials/favorites', { token: personalToken });
  check('同一账号可查看买家收藏', favorites.status === 200, `status=${favorites.status}`);

  /* ---- 卖家动作：发布资料 ---- */
  const fileText = '高等数学复习提纲：函数、极限、导数与积分的核心知识点整理。';
  const created = await request('/api/materials', {
    method: 'POST',
    token: personalToken,
    body: {
      title: '角色权限测试考研数学笔记',
      description: '用于验证个人用户同时具备买家与卖家权限的测试资料，内容为高等数学复习要点整理。',
      category: '考研资料',
      school: '武汉大学',
      subject: '数学',
      teacher: '',
      course: '高等数学',
      price: 9.9,
      fileName: 'role-note.txt',
      fileData: Buffer.from(fileText, 'utf8').toString('base64')
    }
  });
  check('个人用户可发布卖家资料', created.status === 201, `status=${created.status} ${JSON.stringify(created.data)}`);

  /* ---- 买家动作：收藏并下单购买他人资料 ---- */
  const list = await request('/api/materials?sort=new&pageSize=24', { token: personalToken });
  const candidates = (list.data?.items || []).filter((m) =>
    m.price > 0 && m.seller && m.seller.id !== personal.data?.user?.id
  );
  check('资料市场存在可购买资料', candidates.length > 0, JSON.stringify(list.data?.total));
  if (candidates.length) {
    const fav = await request(`/api/materials/${candidates[0].id}/favorite`, { method: 'POST', token: personalToken });
    check('个人用户可收藏资料（买家动作）', fav.status === 200, `status=${fav.status}`);
    let order = { status: 0, data: null };
    for (const candidate of candidates.slice(0, 10)) {
      order = await request('/api/orders', {
        method: 'POST',
        token: personalToken,
        body: { materialId: candidate.id, channel: 'wechat' }
      });
      if (order.status !== 409) break;
    }
    check('个人用户可下单购买资料（买家动作）', order.status === 201, `status=${order.status} ${JSON.stringify(order.data)}`);
  }

  /* ---- 登录态持久化与会话管理 ---- */
  const me1 = await request('/api/auth/me', { token: personalToken });
  const me2 = await request('/api/auth/me', { token: personalToken });
  check('token 可重复读取会话（持久登录）', me1.status === 200 && me2.status === 200, `status=${me1.status}/${me2.status}`);
  check('同一 token 会话用户一致', me1.data?.user?.id === personal.data?.user?.id && me2.data?.user?.id === personal.data?.user?.id);
  check('会话返回角色与登录一致', me1.data?.user?.role === 'user', JSON.stringify(me1.data?.user?.role));
  const noToken = await request('/api/auth/me');
  check('未携带 token 访问会话返回 401', noToken.status === 401, `status=${noToken.status}`);
  const badToken = await request('/api/auth/me', { token: 'invalid-token-value' });
  check('无效 token 访问会话返回 401', badToken.status === 401, `status=${badToken.status}`);
} catch (err) {
  failed += 1;
  console.error('测试执行失败：', err.message);
} finally {
  cleanup();
}

console.log(`\n${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed === 0 ? 0 : 1);
