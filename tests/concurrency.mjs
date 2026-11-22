/**
 * 学涯集市 · 多用户并发交易与数据一致性测试
 *
 * 覆盖：并发注册认证 / 并发下单 / 同一支付单重复回调幂等 / 并发退款申请，
 * 并在服务运行中直接读取 SQLite 校验：订单与支付一一对应、复式账本借贷平衡、
 * 结算唯一、卖家余额与账本一致。
 *
 * 运行：npm run test:concurrency
 * 说明：使用独立临时数据目录与端口，不污染现有数据。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.CONC_TEST_PORT || 3409);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-conc-'));
const BUYERS = 6;

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
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data };
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

async function pickMaterials(count) {
  const items = [];
  for (let page = 1; page <= 3; page++) {
    const list = await request(`/api/materials?pageSize=24&page=${page}`);
    items.push(...(list.data?.items || []));
    if (page >= (list.data?.pages || 1)) break;
  }
  const picked = [];
  const seen = new Set();
  for (const item of items) {
    if (item.price < 100 || seen.has(item.id)) continue;
    seen.add(item.id);
    picked.push(item);
    if (picked.length >= count) break;
  }
  return picked;
}

async function main() {
  console.log(`\n学涯集市并发交易一致性测试 · ${BASE}\n`);

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      SEED_DEMO: 'true',
      AUTO_VERIFY: 'true',
      PAYMENT_MODE: 'mock',
      PAYMENT_MOCK_SECRET: 'xueya-conc-secret',
      SETTLEMENT_DELAY_HOURS: '0',
      RATE_LIMIT_REGISTER: '60'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (buf) => process.stderr.write(`[server] ${buf}`));

  let db = null;
  try {
    await waitForServer(child);

    /* 1. 并发注册 + 自动认证 */
    const tag = String(Date.now()).slice(-6);
    const buyers = await Promise.all(Array.from({ length: BUYERS }, async (_, i) => {
      const reg = await request('/api/auth/register', {
        method: 'POST',
        body: {
          username: `conc${tag}${i}`,
          email: `conc${tag}${i}@xueya.test`,
          password: 'Conctest123456',
          nickname: `并发买家${i + 1}`,
          school: '武汉大学'
        }
      });
      if (!reg.data?.token) throw new Error(`注册失败：${JSON.stringify(reg.data)}`);
      const verify = await request('/api/verify/submit', {
        method: 'POST',
        token: reg.data.token,
        body: { realName: `并发${i + 1}`, school: '武汉大学', studentNo: `C${tag}${i}` }
      });
      return { token: reg.data.token, id: reg.data.user.id, verified: verify.data?.user?.verified === true };
    }));
    check(`并发注册 ${BUYERS} 个用户成功`, buyers.every((b) => b.id > 0));
    check('公开演示自动认证立即生效', buyers.every((b) => b.verified));

    /* 2. 并发下单 */
    const materials = await pickMaterials(BUYERS);
    check(`准备 ${BUYERS} 份可购买资料`, materials.length >= BUYERS, `仅找到 ${materials.length} 份`);

    const orders = await Promise.all(buyers.map((buyer, i) =>
      request('/api/orders', {
        method: 'POST', token: buyer.token, body: { materialId: materials[i].id, channel: 'wechat' }
      })
    ));
    check('并发下单全部成功', orders.every((o) => o.status === 201 && o.data?.payment?.id > 0),
      JSON.stringify(orders.map((o) => o.status)));
    check('并发下单生成不同订单', new Set(orders.map((o) => o.data?.orderId)).size === BUYERS);

    /* 3. 同一支付单并发重复回调（幂等） */
    const doubles = await Promise.all(orders.flatMap((o) => [0, 1].map(() =>
      request(`/api/payments/${o.data.payment.id}/simulate`, {
        method: 'POST', token: buyers[orders.indexOf(o)].token, body: { result: 'success' }
      })
    )));
    check('重复回调无 5xx', doubles.every((r) => r.status < 500), JSON.stringify(doubles.map((r) => r.status)));

    const details = await Promise.all(orders.map((o, i) =>
      request(`/api/payments/${o.data.payment.id}`, { token: buyers[i].token })
    ));
    check('全部支付单最终为已支付', details.every((d) => d.data?.payment?.status === 'paid'),
      JSON.stringify(details.map((d) => d.data?.payment?.status)));
    check('全部订单最终为已完成', details.every((d) => d.data?.order?.status === 'completed'),
      JSON.stringify(details.map((d) => d.data?.order?.status)));

    /* 4. 并发退款申请（仅允许一次生效） */
    const target = orders[0].data.orderId;
    const refunds = await Promise.all([0, 1].map(() =>
      request(`/api/orders/${target}/refund`, { method: 'POST', token: buyers[0].token })
    ));
    check('并发退款申请仅一次生效', refunds.filter((r) => r.status === 200).length === 1,
      JSON.stringify(refunds.map((r) => r.status)));

    /* 5. 直接读取数据库校验一致性 */
    await new Promise((r) => setTimeout(r, 200));
    db = new DatabaseSync(path.join(DATA_DIR, 'xueya.db'));
    const one = (sql, ...params) => db.prepare(sql).get(...params);
    const many = (sql, ...params) => db.prepare(sql).all(...params);

    const paidPerOrder = orders.map((o) => one('SELECT COUNT(*) AS c FROM payments WHERE order_id = ? AND status = ?', o.data.orderId, 'paid').c);
    check('每个订单恰好一笔已支付流水', paidPerOrder.every((c) => c === 1), JSON.stringify(paidPerOrder));

    const dupPayments = many("SELECT order_id, COUNT(*) AS c FROM payments WHERE status = 'paid' GROUP BY order_id HAVING c > 1");
    check('不存在重复已支付流水', dupPayments.length === 0, JSON.stringify(dupPayments));

    const paidTxns = one("SELECT COUNT(*) AS c FROM ledger_transactions WHERE biz_type = 'order_paid'").c;
    check('支付凭证数量与订单一致', paidTxns === BUYERS, `ledger=${paidTxns}`);

    const dupTxns = many('SELECT txn_no, COUNT(*) AS c FROM ledger_transactions GROUP BY txn_no HAVING c > 1');
    check('账本凭证号唯一', dupTxns.length === 0, JSON.stringify(dupTxns));

    const trial = one(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_cents ELSE 0 END), 0) AS debit,
              COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_cents ELSE 0 END), 0) AS credit
       FROM ledger_entries`
    );
    check('复式账本借贷平衡', trial.debit === trial.credit, `借 ${trial.debit} / 贷 ${trial.credit}`);

    const orderIds = orders.map((o) => o.data.orderId);
    const settlementCount = one(
      'SELECT COUNT(*) AS c FROM settlements WHERE order_id IN (' + orderIds.map(() => '?').join(',') + ')',
      ...orderIds
    ).c;
    check('每笔成交生成唯一结算记录', settlementCount === BUYERS, `settlements=${settlementCount}`);

    const mismatches = many(
      `SELECT u.id, u.balance_cents,
              COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_cents ELSE -e.amount_cents END), 0) AS ledger_balance
       FROM users u
       JOIN ledger_accounts a ON a.owner_type = 'seller' AND a.owner_id = u.id
       LEFT JOIN ledger_entries e ON e.account_id = a.id
       GROUP BY u.id`
    ).filter((row) => Number(row.balance_cents) !== Number(row.ledger_balance));
    check('卖家余额与账本完全一致', mismatches.length === 0, JSON.stringify(mismatches));

    const orderStatus = many('SELECT id, status FROM orders WHERE id IN (' + orders.map(() => '?').join(',') + ')',
      ...orders.map((o) => o.data.orderId));
    check('除退款申请单外订单均为已完成',
      orderStatus.filter((o) => o.status === 'completed').length === BUYERS - 1
        && orderStatus.some((o) => o.id === target && o.status === 'refund_requested'),
      JSON.stringify(orderStatus));

    /* 6. 指标端点 */
    const metrics = await request('/api/metrics');
    check('运行指标端点可用', metrics.status === 200 && metrics.data?.requests?.total > 0, JSON.stringify(metrics.data?.requests));
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n并发一致性测试：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
