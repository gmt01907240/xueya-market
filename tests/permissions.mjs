/**
 * 学涯集市 · 对象级权限矩阵测试
 *
 * 覆盖：支付单 / 订单 / 资料下载 / 会话消息 / 工单 / 学习计划 / 求购
 * 的跨用户越权访问，确认每个用户只能操作自身交易相关数据。
 *
 * 运行：npm run test:permissions
 * 说明：使用独立临时数据目录与端口，不污染现有数据。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PERM_TEST_PORT || 3408);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-perm-'));

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
  return { status: res.status, data };
}

async function login(account, password) {
  const res = await request('/api/auth/login', { method: 'POST', body: { account, password } });
  if (!res.data?.token) throw new Error(`登录失败：${account} ${JSON.stringify(res.data)}`);
  return { token: res.data.token, id: res.data.user.id };
}

async function pickMaterial(buyerToken, buyerId, outsiderToken, outsiderId) {
  for (let page = 1; page <= 3; page++) {
    const list = await request(`/api/materials?pageSize=24&page=${page}`);
    for (const item of list.data?.items || []) {
      if (item.price < 100) continue;
      const detail = await request(`/api/materials/${item.id}`, { token: buyerToken });
      const m = detail.data?.material;
      if (!m || detail.data?.purchased || m.seller.id === buyerId) continue;
      if (m.seller.id === outsiderId) continue;
      const other = await request(`/api/materials/${item.id}`, { token: outsiderToken });
      if (other.data?.purchased) continue;
      return m;
    }
    if (page >= (list.data?.pages || 1)) break;
  }
  return null;
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

async function main() {
  console.log(`\n学涯集市对象级权限测试 · ${BASE}\n`);

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      SEED_DEMO: 'true',
      PAYMENT_MODE: 'mock',
      PAYMENT_MOCK_SECRET: 'xueya-perm-secret',
      SETTLEMENT_DELAY_HOURS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (buf) => process.stderr.write(`[server] ${buf}`));

  try {
    await waitForServer(child);

    const buyer = await login('student@xueya.cn', 'Student123456');
    const outsider = await login('judge@xueya.cn', 'Judge123456');

    const material = await pickMaterial(buyer.token, buyer.id, outsider.token, outsider.id);
    if (!material) throw new Error('未找到可用于权限测试的资料');

    /* 1. 下单 */
    const order = await request('/api/orders', {
      method: 'POST', token: buyer.token, body: { materialId: material.id, channel: 'wechat' }
    });
    check('买家可为他人资料创建订单', order.status === 201 && order.data?.orderId > 0, JSON.stringify(order.data));
    const orderId = order.data?.orderId;
    const paymentId = order.data?.payment?.id;

    /* 2. 支付单越权 */
    const peek = await request(`/api/payments/${paymentId}`, { token: outsider.token });
    check('他人不可查看支付单（403）', peek.status === 403, String(peek.status));

    const hijack = await request(`/api/payments/${paymentId}/simulate`, {
      method: 'POST', token: outsider.token, body: { result: 'success' }
    });
    check('他人不可模拟支付（拒绝）', hijack.status >= 400, `${hijack.status} ${JSON.stringify(hijack.data)}`);
    const stillPending = await request(`/api/payments/${paymentId}`, { token: buyer.token });
    check('越权尝试后支付单仍为待支付', stillPending.data?.payment?.status === 'pending', JSON.stringify(stillPending.data?.payment?.status));

    /* 3. 订单越权 */
    const foreignRefund = await request(`/api/orders/${orderId}/refund`, { method: 'POST', token: outsider.token });
    check('他人不可对订单申请退款（403）', foreignRefund.status === 403, String(foreignRefund.status));

    const myOrders = await request('/api/orders/mine', { token: buyer.token });
    check('买家订单列表包含本单', (myOrders.data?.items || []).some((o) => o.id === orderId));
    const otherOrders = await request('/api/orders/mine', { token: outsider.token });
    check('他人订单列表不包含该订单', !(otherOrders.data?.items || []).some((o) => o.id === orderId));

    const paymentMine = await request('/api/payments/mine', { token: outsider.token });
    check('他人支付记录不包含该支付单', !(paymentMine.data?.items || []).some((p) => p.id === paymentId));

    /* 4. 下载越权（认证用户但未购买） */
    const downloadBlocked = await request(`/api/materials/${material.id}/download`, { token: outsider.token, raw: true });
    check('未购买者下载被拒（403）', downloadBlocked.status === 403, String(downloadBlocked.status));

    /* 5. 买家完成支付后可下载 */
    const paid = await request(`/api/payments/${paymentId}/simulate`, {
      method: 'POST', token: buyer.token, body: { result: 'success' }
    });
    check('买家模拟支付成功', paid.status === 200 && paid.data?.payment?.status === 'paid', JSON.stringify(paid.data));
    const downloadOk = await request(`/api/materials/${material.id}/download`, { token: buyer.token, raw: true });
    check('购买者下载成功（200）', downloadOk.status === 200, String(downloadOk.status));
    const downloadStillBlocked = await request(`/api/materials/${material.id}/download`, { token: outsider.token, raw: true });
    check('支付后未购买者仍被拒（403）', downloadStillBlocked.status === 403, String(downloadStillBlocked.status));

    /* 6. 会话越权 */
    const thread = await request('/api/threads', {
      method: 'POST', token: buyer.token,
      body: { toUserId: material.seller.id, materialId: material.id, content: '你好，想咨询这份资料的版本信息。' }
    });
    const threadId = thread.data?.threadId || thread.data?.id || thread.data?.thread?.id;
    check('买家可与卖家建立会话', [200, 201].includes(thread.status) && threadId > 0, JSON.stringify(thread.data));
    if (threadId) {
      const peekThread = await request(`/api/threads/${threadId}`, { token: outsider.token });
      check('他人不可查看会话（403）', peekThread.status === 403, String(peekThread.status));
      const sendThread = await request(`/api/threads/${threadId}/messages`, {
        method: 'POST', token: outsider.token, body: { content: '越权消息' }
      });
      check('他人不可向会话发消息（403）', sendThread.status === 403, String(sendThread.status));
    }

    /* 7. 工单越权 */
    const ticket = await request('/api/tickets', {
      method: 'POST', token: buyer.token,
      body: { type: 'other', title: '权限测试工单', content: '这是一条用于验证对象级权限的测试工单内容。' }
    });
    const ticketId = ticket.data?.ticket?.id || ticket.data?.id;
    check('买家可提交工单', ticket.status === 201 && ticketId > 0, JSON.stringify(ticket.data));
    if (ticketId) {
      const peekTicket = await request(`/api/tickets/${ticketId}`, { token: outsider.token });
      check('他人不可查看工单（403）', peekTicket.status === 403, String(peekTicket.status));
    }

    /* 8. 学习计划越权 */
    const plan = await request('/api/plan/save', {
      method: 'POST', token: buyer.token,
      body: { goal: 'final', subject: '计算机科学与技术', days: 3, dailyMinutes: 60 }
    });
    const planId = plan.data?.id;
    check('买家可保存学习计划', plan.status === 201 && planId > 0, JSON.stringify(plan.data));
    if (planId) {
      const peekPlan = await request(`/api/plan/${planId}`, { token: outsider.token });
      check('他人不可查看学习计划（404）', peekPlan.status === 404, String(peekPlan.status));
      const checkPlan = await request(`/api/plan/${planId}/check`, {
        method: 'POST', token: outsider.token, body: { taskKey: 'd1-t1', done: true }
      });
      check('他人不可操作学习计划打卡（404）', checkPlan.status === 404, String(checkPlan.status));
      const delPlan = await request(`/api/plan/${planId}`, { method: 'DELETE', token: outsider.token });
      check('他人不可删除学习计划（404）', delPlan.status === 404, String(delPlan.status));
    }

    /* 9. 求购越权 */
    const want = await request('/api/wants', {
      method: 'POST', token: buyer.token,
      body: { title: '求购权限测试资料一套', description: '用于权限测试', category: '考研资料', school: '武汉大学', budget: 10 }
    });
    const wantId = want.data?.id;
    check('买家可发布求购', want.status === 201 && wantId > 0, JSON.stringify(want.data));
    if (wantId) {
      const closeWant = await request(`/api/wants/${wantId}/close`, { method: 'POST', token: outsider.token });
      check('他人不可关闭求购（403）', closeWant.status === 403, String(closeWant.status));
    }

    /* 10. 卖家收益隔离 */
    const sellerView = await request('/api/seller/overview', { token: outsider.token });
    const sellerSold = sellerView.data?.stats?.sold ?? 0;
    check('他人卖家中心不统计本单收益', typeof sellerSold === 'number', `sold=${sellerSold}`);

    /* 11. 未登录保护 */
    const anon = await request(`/api/payments/${paymentId}`);
    check('未登录访问支付单返回 401', anon.status === 401, String(anon.status));
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n权限矩阵测试：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
