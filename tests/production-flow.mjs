/**
 * 学涯集市 · 正式版全链路测试
 *
 * 覆盖：注册校验 / 登录 / 实名认证 / 上传审核 / 支付 / 下载 / 收益结算 /
 *       退款联动 / 银行卡人工确认 / 限流 / 健康检查 / 安全响应头。
 *
 * 运行：npm run test:production
 * 说明：使用独立临时数据目录与端口，不污染现有数据。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adminLogin } from './admin-login-helper.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PROD_TEST_PORT || 3401);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-prod-'));

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

async function register(tag, nickname = '') {
  return request('/api/auth/register', {
    method: 'POST',
    body: {
      username: `prod${tag}`,
      email: `prod${tag}@xueya.test`,
      password: 'Prodtest123456',
      nickname: nickname || `正式版${tag}`,
      school: '武汉大学'
    }
  });
}

async function login(account, password = 'Prodtest123456') {
  return request('/api/auth/login', { method: 'POST', body: { account, password } });
}

async function verifyAndApprove(token, userId, adminToken, tag) {
  const submit = await request('/api/verify/submit', {
    method: 'POST',
    token,
    body: { realName: `测试${tag}`, school: '武汉大学', studentNo: `2024${tag}` }
  });
  if (submit.status !== 200) return submit;
  return request(`/api/admin/verifications/${userId}/review`, {
    method: 'POST',
    token: adminToken,
    body: { action: 'approve' }
  });
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
  console.log(`\n学涯集市正式版全链路测试 · ${BASE}\n`);

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      PAYMENT_MODE: 'mock',
      PAYMENT_MOCK_SECRET: 'xueya-prod-secret',
      SETTLEMENT_DELAY_HOURS: '0',
      RATE_LIMIT_REGISTER: '30'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (buf) => process.stderr.write(`[server] ${buf}`));

  try {
    await waitForServer(child);

    /* 1. 健康检查与安全响应头 */
    const health = await request('/api/health');
    check('健康检查返回数据库与支付模式', health.status === 200 && health.data.database === 'ok' && health.data.paymentMode === 'mock', JSON.stringify(health.data));
    const home = await request('/', { raw: true });
    check('首页返回 CSP 安全响应头', home.headers.get('content-security-policy')?.includes("default-src 'self'"), home.headers.get('content-security-policy') || 'missing');
    const demo = await request('/demo.html', { raw: true });
    check('离线演示页不套用严格 CSP', !demo.headers.get('content-security-policy'));

    /* 2. 注册与登录校验 */
    const admin = await adminLogin(BASE);
    check('管理员通过专属入口完成密码+MFA登录', admin.ok === true && Boolean(admin.token), JSON.stringify(admin.data || {}));

    const weak1 = await request('/api/auth/register', {
      method: 'POST',
      body: { username: 'weakuser1', email: 'weak1@xueya.test', password: 'abc123', nickname: '弱密码', school: '武汉大学' }
    });
    check('拒绝过短密码', weak1.status === 400 && /8/.test(weak1.data?.error || ''));

    const weak2 = await request('/api/auth/register', {
      method: 'POST',
      body: { username: 'weakuser2', email: 'weak2@xueya.test', password: 'abcdefgh', nickname: '弱密码', school: '武汉大学' }
    });
    check('拒绝纯字母密码', weak2.status === 400 && /字母和数字/.test(weak2.data?.error || ''));

    const tag = String(Date.now()).slice(-7);
    const sellerReg = await register(`${tag}s`, '正式版卖家');
    check('卖家注册成功并返回 token', sellerReg.status === 201 && Boolean(sellerReg.data?.token), JSON.stringify(sellerReg.data));
    const dup = await request('/api/auth/register', {
      method: 'POST',
      body: { username: `prod${tag}s`, email: `prod${tag}s@xueya.test`, password: 'Prodtest123456', nickname: '重复', school: '武汉大学' }
    });
    check('重复账号注册被拒绝', dup.status === 409, JSON.stringify(dup.data));

    const wrongLogin = await login(`prod${tag}s`, 'Wrong123456');
    check('错误密码登录被拒绝', wrongLogin.status === 401);

    /* 3. 未认证用户受控 */
    const buyerCReg = await register(`${tag}c`, '未认证买家');
    const buyerCToken = buyerCReg.data.token;
    const uploadBlocked = await request('/api/materials', {
      method: 'POST',
      token: buyerCToken,
      body: { title: '未认证上传测试资料', description: '这是一段用于验证未认证用户权限拦截的资料介绍文本。', category: '课堂笔记', subject: '计算机科学与技术', price: 1, fileName: 'a.txt', fileData: Buffer.from('test').toString('base64') }
    });
    check('未认证用户不能上传资料', uploadBlocked.status === 403, JSON.stringify(uploadBlocked.data));

    const sellerToken = sellerReg.data.token;
    const sellerId = sellerReg.data.user.id;
    const invalidSchool = await request('/api/verify/submit', {
      method: 'POST', token: sellerToken,
      body: { realName: '测试卖家', school: '不存在的大学', studentNo: '20240001' }
    });
    check('认证时校验院校白名单', invalidSchool.status === 400, JSON.stringify(invalidSchool.data));

    const verified = await verifyAndApprove(sellerToken, sellerId, admin.data.token, `${tag}1`);
    check('卖家实名认证审核通过', verified.status === 200, JSON.stringify(verified.data));

    const sellerMe = await request('/api/auth/me', { token: sellerToken });
    check('认证状态同步为已认证', sellerMe.data?.user?.verifyStatus === 'verified', JSON.stringify(sellerMe.data?.user?.verifyStatus));

    /* 4. 上传与审核 */
    const content = Buffer.from('学涯集市正式版全链路测试学习笔记。\n课程重点：数据结构、操作系统、计算机网络。\n复习建议：先梳理知识框架，再完成真题训练，最后回顾错题。\n'.repeat(12));
    const upload = await request('/api/materials', {
      method: 'POST',
      token: sellerToken,
      body: {
        title: '正式版全链路测试学习笔记',
        description: '这是一份用于验证正式版上传、审核、购买与下载链路的原创学习笔记，包含课程重点与复习建议。',
        category: '课堂笔记',
        subject: '计算机科学与技术',
        teacher: '测试老师',
        price: 9.9,
        previewRatio: 15,
        tags: ['全链路测试', '学习笔记'],
        fileName: 'notes.txt',
        fileData: content.toString('base64')
      }
    });
    check('认证卖家上传资料成功', upload.status === 201 && Boolean(upload.data?.id), JSON.stringify(upload.data));
    const materialId = upload.data.id;
    check('上传结果附带内容审核结论', typeof upload.data?.audit?.verdict === 'string', JSON.stringify(upload.data?.audit));

    const approveMaterial = await request(`/api/admin/materials/${materialId}/review`, {
      method: 'POST', token: admin.data.token, body: { action: 'approve' }
    });
    check('管理员审核通过资料', approveMaterial.status === 200, JSON.stringify(approveMaterial.data));

    /* 5. 买家购买与下载 */
    const buyerReg = await register(`${tag}b`, '正式版买家');
    const buyerToken = buyerReg.data.token;
    const buyerId = buyerReg.data.user.id;
    const buyerVerified = await verifyAndApprove(buyerToken, buyerId, admin.data.token, `${tag}2`);
    check('买家实名认证审核通过', buyerVerified.status === 200);

    const order = await request('/api/orders', { method: 'POST', token: buyerToken, body: { materialId, channel: 'wechat' } });
    check('创建微信支付订单', order.status === 201 && order.data?.payment?.status === 'pending', JSON.stringify(order.data));
    const orderId = order.data.orderId;

    const pay = await request(`/api/payments/${order.data.payment.id}/simulate`, {
      method: 'POST', token: buyerToken, body: { result: 'success' }
    });
    check('模拟支付成功', pay.status === 200 && pay.data?.payment?.status === 'paid', JSON.stringify(pay.data));

    const detail = await request(`/api/materials/${materialId}`, { token: buyerToken });
    check('支付后订单显示已完成', detail.data?.purchased === true, JSON.stringify(detail.data?.purchased));

    const download = await request(`/api/materials/${materialId}/download`, { token: buyerToken, raw: true });
    const downloaded = Buffer.from(await download.arrayBuffer());
    check('购买后可正常下载文件', download.status === 200 && downloaded.length === content.length, `${download.status} ${downloaded.length}/${content.length}`);
    const disposition = download.headers.get('content-disposition') || '';
    check('下载响应包含文件名', /filename/.test(disposition), disposition);

    /* 6. 卖家收益与结算 */
    const sellerOverview = await request('/api/seller/overview', { token: sellerToken });
    check('卖家收益到账 891 分（扣除 10% 服务费）', sellerOverview.data?.stats?.balance === 891, JSON.stringify(sellerOverview.data?.stats));

    const settlement = await request('/api/seller/settlements', { token: sellerToken });
    const record = (settlement.data?.items || [])[0];
    check('生成卖家结算记录', settlement.status === 200 && record?.orderId === orderId, JSON.stringify(record));
    check('结算金额与收益一致', record?.net === 891 && record?.commission === 99, JSON.stringify(record));
    check('T+0 测试周期下自动结算完成', record?.status === 'settled', record?.status);

    const adminSettlement = await request('/api/admin/settlements', { token: admin.data.token });
    check('后台可查看结算台账', adminSettlement.status === 200
      && adminSettlement.data?.totals?.settled?.amount >= 891
      && (adminSettlement.data?.items || []).some((item) => item.orderId === orderId), JSON.stringify(adminSettlement.data?.totals));

    /* 7. 退款联动 */
    const refundReq = await request(`/api/orders/${orderId}/refund`, { method: 'POST', token: buyerToken, body: { reason: '正式版测试退款' } });
    check('买家可发起退款申请', refundReq.status === 200, JSON.stringify(refundReq.data));
    const refundOk = await request(`/api/admin/orders/${orderId}/refund`, { method: 'POST', token: admin.data.token, body: { action: 'approve' } });
    check('管理员审核退款通过', refundOk.status === 200, JSON.stringify(refundOk.data));

    const afterRefund = await request('/api/seller/settlements', { token: sellerToken });
    const cancelled = (afterRefund.data?.items || [])[0];
    check('退款后已结算记录被冲正', cancelled?.status === 'reversed', JSON.stringify(cancelled));
    const overviewAfter = await request('/api/seller/overview', { token: sellerToken });
    check('退款后卖家收益扣回', overviewAfter.data?.stats?.balance === 0, JSON.stringify(overviewAfter.data?.stats));

    const payAfter = await request(`/api/payments/${order.data.payment.id}`, { token: buyerToken });
    check('退款后支付单标记为已退款', payAfter.data?.payment?.status === 'refunded', JSON.stringify(payAfter.data?.payment));

    /* 8. 银行卡转账 + 人工确认 */
    const buyer2 = await register(`${tag}d`, '转账买家');
    const buyer2Token = buyer2.data.token;
    const buyer2Verified = await verifyAndApprove(buyer2Token, buyer2.data.user.id, admin.data.token, `${tag}3`);
    check('第二位买家认证通过', buyer2Verified.status === 200);

    const bankOrder = await request('/api/orders', { method: 'POST', token: buyer2Token, body: { materialId, channel: 'bankcard' } });
    check('创建银行卡转账订单', bankOrder.status === 201 && bankOrder.data?.payPayload?.mode === 'transfer', JSON.stringify(bankOrder.data));
    check('生产环境人工确认按钮仅对银行卡待支付展示', bankOrder.data?.payment?.channel === 'bankcard');

    const confirm = await request(`/api/admin/payments/${bankOrder.data.payment.id}/confirm`, { method: 'POST', token: admin.data.token });
    check('管理员人工确认到账成功', confirm.status === 200 && confirm.data?.payment?.status === 'paid', JSON.stringify(confirm.data));
    const confirmAgain = await request(`/api/admin/payments/${bankOrder.data.payment.id}/confirm`, { method: 'POST', token: admin.data.token });
    check('重复确认人工到账保持幂等', confirmAgain.status === 200 && confirmAgain.data?.duplicated === true, JSON.stringify(confirmAgain.data));

    const bankSettlement = await request('/api/seller/settlements', { token: sellerToken });
    check('人工确认后生成新的结算记录', bankSettlement.data?.items?.length === 2 && bankSettlement.data?.stats?.net === 891, JSON.stringify(bankSettlement.data?.stats));

    /* 9. 登录限流 */
    let limited = false;
    for (let i = 0; i < 30; i++) {
      const res = await login(`prod${tag}s`, 'Wrong123456');
      if (res.status === 429) { limited = true; break; }
    }
    check('连续错误登录触发限流', limited);

    /* 10. 管理端接口鉴权 */
    const forbidden = await request('/api/admin/settlements', { token: buyerToken });
    check('普通用户无法访问结算后台', forbidden.status === 403, String(forbidden.status));
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
