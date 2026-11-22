/**
 * 学涯集市 · 支付全流程测试
 *
 * 覆盖：支付方式列表、下单、签名校验、金额校验、时间戳防重放、
 *       模拟支付成功/失败、幂等、超时相关状态、外部渠道专属下单、后台对账。
 *       平台不提供充值与提现，所有交易仅通过微信 / 支付宝 / 银行卡完成。
 *
 * 运行：npm run test:payments
 * 说明：测试会启动一个使用临时数据目录的独立服务（默认端口 3399），不会污染现有数据。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { adminLogin } from './admin-login-helper.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PAY_TEST_PORT || 3399);
const SECRET = 'xueya-test-secret';
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-pay-'));

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

async function request(url, { method = 'GET', token, body, idempotencyKey } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data };
}

async function login(account, password) {
  const res = await request('/api/auth/login', { method: 'POST', body: { account, password } });
  if (res.status !== 200 || !res.data?.token) throw new Error(`登录失败：${account}`);
  return res.data;
}

function signPayload(payload) {
  const canonical = [payload.paymentNo, payload.tradeNo || '', payload.amountCents, payload.status, payload.timestamp, payload.nonce].join('|');
  return crypto.createHmac('sha256', SECRET).update(canonical).digest('hex');
}

function makeNotify(payment, status = 'SUCCESS', overrides = {}) {
  const payload = {
    paymentNo: payment.paymentNo,
    tradeNo: `TRADE${Date.now()}${crypto.randomInt(1000, 9999)}`,
    amountCents: payment.amount,
    status,
    timestamp: Date.now(),
    nonce: crypto.randomBytes(8).toString('hex'),
    ...overrides
  };
  payload.sign = signPayload(payload);
  return payload;
}

async function notify(channel, payload) {
  return request(`/api/payments/callback/${channel}`, { method: 'POST', body: payload });
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

async function pickMaterials(token, userId, excludeIds = []) {
  const items = [];
  for (let page = 1; page <= 3; page++) {
    const list = await request(`/api/materials?pageSize=24&page=${page}`);
    items.push(...(list.data?.items || []));
    if (page >= (list.data?.pages || 1)) break;
  }
  const picks = [];
  for (const item of items) {
    if (item.price < 100 || excludeIds.includes(item.id)) continue;
    const detail = await request(`/api/materials/${item.id}`, { token });
    const m = detail.data?.material;
    if (!m || detail.data.purchased || m.seller.id === userId) continue;
    picks.push(m);
    if (picks.length >= 4) break;
  }
  return picks;
}

async function main() {
  console.log(`\n学涯集市支付全流程测试 · ${BASE}\n`);

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      PAYMENT_MODE: 'mock',
      PAYMENT_MOCK_SECRET: SECRET
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (buf) => process.stderr.write(`[server] ${buf}`));

  try {
    await waitForServer(child);

    /* 1. 支付方式配置 */
    const channels = await request('/api/payments/channels');
    const codes = (channels.data?.channels || []).map((c) => c.code);
    check('支付方式列表 /api/payments/channels', channels.status === 200 && codes.length === 3, JSON.stringify(codes));
    check('仅包含微信/支付宝/银行卡', codes.length === 3 && ['wechat', 'alipay', 'bankcard'].every((c) => codes.includes(c)) && !codes.includes('balance'));
    check('演示模式标记', channels.data?.mode === 'mock');
    const wechat = (channels.data?.channels || []).find((c) => c.code === 'wechat');
    check('微信限额与时效配置', wechat?.limits === '单笔 ¥0.01—¥50,000' && wechat?.expireMinutes === 15, JSON.stringify(wechat));

    /* 2. 登录、注册新买家并完成认证（避免种子账号已购买大量资料） */
    const adminAuth = await adminLogin(BASE);
    check('管理员专属入口密码+MFA 登录', adminAuth.ok === true && Boolean(adminAuth.token), JSON.stringify(adminAuth.data || {}));
    const admin = adminAuth;
    const tag = String(Date.now()).slice(-8);
    const reg = await request('/api/auth/register', {
      method: 'POST',
      body: {
        username: `paytest${tag}`,
        email: `paytest${tag}@xueya.test`,
        password: 'Paytest123456',
        nickname: '支付测试',
        school: '武汉大学'
      }
    });
    if (!reg.data?.token) throw new Error(`注册测试买家失败：${JSON.stringify(reg.data)}`);
    const buyer = { token: reg.data.token, id: reg.data.user.id };
    await request('/api/verify/submit', {
      method: 'POST',
      token: buyer.token,
      body: { realName: '支付测试', school: '武汉大学', studentNo: `2024${tag}` }
    });
    const approved = await request(`/api/admin/verifications/${buyer.id}/review`, {
      method: 'POST',
      token: admin.token,
      body: { action: 'approve' }
    });
    check('测试买家认证通过', approved.status === 200, JSON.stringify(approved.data));

    const materials = await pickMaterials(buyer.token, buyer.id);
    check('准备测试资料', materials.length >= 4, `仅找到 ${materials.length} 份`);
    const [m1, m2, m3, m4] = materials;

    /* 3. 微信扫码下单 */
    const created = await request('/api/orders', { method: 'POST', token: buyer.token, body: { materialId: m1.id, channel: 'wechat' } });
    check('微信下单创建待支付订单', created.status === 201 && created.data?.status === 'pending_payment', `${created.status} ${JSON.stringify(created.data)}`);
    check('返回微信扫码参数', created.data?.payPayload?.mode === 'qrcode' && String(created.data?.payPayload?.qrText || '').startsWith('weixin://'));
    check('支付单初始为待支付', created.data?.payment?.status === 'pending' && created.data?.payment?.expiresIn > 0);
    const pay1 = created.data.payment;

    const detail = await request(`/api/payments/${pay1.id}`, { token: buyer.token });
    check('支付单详情与订单关联', detail.status === 200 && detail.data?.order?.status === 'pending_payment' && detail.data?.order?.id === created.data.orderId);

    /* 4. 回调安全校验 */
    const badSign = makeNotify(pay1);
    badSign.sign = 'deadbeef';
    const sigRes = await notify('wechat', badSign);
    check('错误签名被拒绝', sigRes.status === 400 && sigRes.data?.code === 'SIGN_ERROR', JSON.stringify(sigRes.data));

    const expired = makeNotify(pay1, 'SUCCESS', { timestamp: Date.now() - 10 * 60 * 1000 });
    const expRes = await notify('wechat', expired);
    check('过期时间戳被拒绝（防重放）', expRes.status === 400 && expRes.data?.code === 'TIMESTAMP_EXPIRED', JSON.stringify(expRes.data));

    const wrongAmount = makeNotify(pay1, 'SUCCESS', { amountCents: pay1.amount - 100 });
    const amtRes = await notify('wechat', wrongAmount);
    check('回调金额不一致被拒绝', amtRes.status === 400 && amtRes.data?.code === 'AMOUNT_MISMATCH', JSON.stringify(amtRes.data));

    const wrongChannel = await notify('alipay', makeNotify(pay1));
    check('支付渠道不匹配被拒绝', wrongChannel.status === 400 && wrongChannel.data?.code === 'CHANNEL_MISMATCH', JSON.stringify(wrongChannel.data));

    /* 5. 模拟支付成功 */
    const sim = await request(`/api/payments/${pay1.id}/simulate`, { method: 'POST', token: buyer.token, body: { result: 'success' } });
    check('模拟支付成功', sim.status === 200 && sim.data?.payment?.status === 'paid', JSON.stringify(sim.data));
    const afterPaid = await request(`/api/payments/${pay1.id}`, { token: buyer.token });
    check('订单随支付成功转为已完成', afterPaid.data?.order?.status === 'completed', JSON.stringify(afterPaid.data?.order));

    const orders = await request('/api/orders/mine', { token: buyer.token });
    const completedOrder = (orders.data?.items || []).find((o) => o.id === created.data.orderId);
    check('买家订单列表显示已完成', completedOrder?.status === 'completed' && completedOrder?.paymentChannel === 'wechat');

    const ledgerAfterPay = await request('/api/admin/finance/ledger', { token: admin.token });
    check('支付成功写入复式账本且借贷平衡',
      ledgerAfterPay.status === 200 && ledgerAfterPay.data?.trial?.balanced === true && ledgerAfterPay.data?.trial?.totalDebit >= pay1.amount,
      JSON.stringify(ledgerAfterPay.data?.trial));
    check('账本余额与卖家余额一致',
      Array.isArray(ledgerAfterPay.data?.mismatches) && ledgerAfterPay.data.mismatches.length === 0,
      JSON.stringify(ledgerAfterPay.data?.mismatches));

    /* 6. 幂等 */
    const simAgain = await request(`/api/payments/${pay1.id}/simulate`, { method: 'POST', token: buyer.token, body: { result: 'success' } });
    check('重复模拟支付幂等', simAgain.status === 200 && simAgain.data?.duplicated === true, JSON.stringify(simAgain.data));
    const replay = await notify('wechat', makeNotify(pay1));
    check('重复回调幂等', replay.status === 200 && replay.data?.duplicated === true, JSON.stringify(replay.data));

    /* 7. 支付宝支付失败 */
    const order2 = await request('/api/orders', { method: 'POST', token: buyer.token, body: { materialId: m2.id, channel: 'alipay' } });
    check('支付宝下单', order2.status === 201 && order2.data?.payment?.channel === 'alipay');
    const failSim = await request(`/api/payments/${order2.data.payment.id}/simulate`, { method: 'POST', token: buyer.token, body: { result: 'fail' } });
    check('模拟支付失败', failSim.status === 200 && failSim.data?.payment?.status === 'failed', JSON.stringify(failSim.data));
    const order2Detail = await request(`/api/payments/${order2.data.payment.id}`, { token: buyer.token });
    check('失败后订单自动取消', order2Detail.data?.order?.status === 'cancelled', JSON.stringify(order2Detail.data?.order));

    /* 8. 银行卡转账 + 渠道回调 */
    const order3 = await request('/api/orders', { method: 'POST', token: buyer.token, body: { materialId: m3.id, channel: 'bankcard' } });
    check('银行卡下单返回转账信息', order3.status === 201 && order3.data?.payPayload?.mode === 'transfer' && order3.data?.payPayload?.remark === order3.data?.payment?.paymentNo);
    const bankNotify = await notify('bankcard', makeNotify(order3.data.payment));
    check('渠道回调支付成功', bankNotify.status === 200 && bankNotify.data?.code === 'SUCCESS', JSON.stringify(bankNotify.data));
    const bankDetail = await request(`/api/payments/${order3.data.payment.id}`, { token: buyer.token });
    check('回调后订单完成', bankDetail.data?.payment?.status === 'paid' && bankDetail.data?.order?.status === 'completed');

    /* 9. 已移除充值与余额支付 */
    const topup = await request('/api/payments/topup', { method: 'POST', token: buyer.token, body: { amount: 100, channel: 'wechat' } });
    check('充值接口已下线（404）', topup.status === 404, String(topup.status));

    const balanceOrder = await request('/api/orders', { method: 'POST', token: buyer.token, body: { materialId: m4.id, channel: 'balance' } });
    check('余额支付渠道已禁用', balanceOrder.status === 400, JSON.stringify(balanceOrder.data));

    const noChannelOrder = await request('/api/orders', { method: 'POST', token: buyer.token, body: { materialId: m4.id } });
    check('未指定外部渠道无法下单', noChannelOrder.status === 400, JSON.stringify(noChannelOrder.data));

    const withdrawal = await request('/api/withdrawals/mine', { token: buyer.token });
    check('提现接口已下线（404）', withdrawal.status === 404, String(withdrawal.status));

    const badChannel = await request('/api/orders', { method: 'POST', token: buyer.token, body: { materialId: m4.id, channel: 'paypal' } });
    check('不支持的支付方式被拒绝', badChannel.status === 400, String(badChannel.status));

    /* 11. 权限隔离 */
    const seller = await login('seller@xueya.cn', 'Seller123456');
    const forbidden = await request(`/api/payments/${pay1.id}`, { token: seller.token });
    check('他人支付单不可查看', forbidden.status === 403, String(forbidden.status));

    /* 12. 后台对账 */
    const adminList = await request('/api/admin/payments', { token: admin.token });
    check('后台支付流水 /api/admin/payments', adminList.status === 200 && adminList.data?.items?.length >= 3, String(adminList.data?.items?.length));
    const reconciled = await request('/api/admin/payments/reconcile', { token: admin.token });
    check('支付对账汇总', reconciled.status === 200 && reconciled.data?.summary?.length === 3 && reconciled.data?.totalPaidCount >= 2, JSON.stringify(reconciled.data?.summary));
    check('对账异常检测字段存在', Array.isArray(reconciled.data?.anomalies?.paidWithoutCompletedOrder) && Array.isArray(reconciled.data?.anomalies?.completedOrderWithoutPayment));
    check('对账结果生成持久化批次', reconciled.data?.batch?.batchNo?.startsWith('RECON-'), JSON.stringify(reconciled.data?.batch));

    const batches = await request('/api/admin/payments/batches', { token: admin.token });
    check('可查询历史对账批次', batches.status === 200 && batches.data?.items?.length >= 1, JSON.stringify(batches.data?.items?.length));

    /* 13. 幂等键：重复提交返回同一笔订单 */
    const idemKey = `pay-idem-${Date.now()}`;
    const idemBody = { materialId: m4.id, channel: 'wechat' };
    const idemFirst = await request('/api/orders', { method: 'POST', token: buyer.token, body: idemBody, idempotencyKey: idemKey });
    const idemSecond = await request('/api/orders', { method: 'POST', token: buyer.token, body: idemBody, idempotencyKey: idemKey });
    check('幂等键重复下单返回同一支付单',
      idemFirst.status === 201 && idemSecond.status === 201
        && idemFirst.data?.orderId === idemSecond.data?.orderId
        && idemFirst.data?.payment?.id === idemSecond.data?.payment?.id,
      `${JSON.stringify(idemFirst.data?.orderId)} / ${JSON.stringify(idemSecond.data?.orderId)}`);

    /* 14. 渠道账单导入与差异识别 */
    const nowDate = new Date();
    const day = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-${String(nowDate.getDate()).padStart(2, '0')}`;
    const bill = await request('/api/admin/payments/reconcile/bill', {
      method: 'POST',
      token: admin.token,
      body: {
        date: day,
        channel: 'wechat',
        items: [
          { paymentNo: pay1.paymentNo, tradeNo: 'BILL-MATCH', amountCents: pay1.amount },
          { paymentNo: 'PAY-NOT-EXIST', tradeNo: 'BILL-ONLY', amountCents: 100 }
        ]
      }
    });
    check('渠道账单导入成功', bill.status === 200 && bill.data?.imported === 2, JSON.stringify(bill.data));
    check('渠道单边账被识别', bill.data?.batch?.diffCount >= 1, JSON.stringify(bill.data?.batch));
    const billBatch = await request(`/api/admin/payments/batches/${bill.data?.batch?.id}`, { token: admin.token });
    check('对账差异明细可追溯',
      billBatch.status === 200 && (billBatch.data?.diffs || []).some((d) => d.type === 'CHANNEL_ONLY' && d.paymentNo === 'PAY-NOT-EXIST'),
      JSON.stringify(billBatch.data?.diffs));

    /* 15. 退款写入账本并保持平衡 */
    const cashBefore = (await request('/api/admin/finance/ledger', { token: admin.token })).data?.cashBalance;
    const refundReq = await request(`/api/orders/${created.data.orderId}/refund`, { method: 'POST', token: buyer.token, body: { reason: '支付流程测试退款' } });
    const refundOk = await request(`/api/admin/orders/${created.data.orderId}/refund`, { method: 'POST', token: admin.token, body: { action: 'approve' } });
    check('退款流程可完成', refundReq.status === 200 && refundOk.status === 200, `${refundReq.status}/${refundOk.status}`);
    const ledgerAfterRefund = await request('/api/admin/finance/ledger', { token: admin.token });
    check('退款后账本仍借贷平衡', ledgerAfterRefund.data?.trial?.balanced === true, JSON.stringify(ledgerAfterRefund.data?.trial));
    check('退款后渠道资金按原额扣减',
      Number(cashBefore) - Number(ledgerAfterRefund.data?.cashBalance) === pay1.amount,
      `${cashBefore} -> ${ledgerAfterRefund.data?.cashBalance}`);

    const deniedAdmin = await request('/api/admin/payments', { token: buyer.token });
    check('普通用户不可访问后台对账', deniedAdmin.status === 403, String(deniedAdmin.status));
  } finally {
    child.kill();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n测试执行失败：${err.message}\n`);
  process.exitCode = 1;
});
