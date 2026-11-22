'use strict';

const { get } = require('./db');
const { sendJson, fail } = require('./http');
const runtime = require('./runtime-config');
const gateway = require('./payment-gateway');
const reconciliation = require('./reconciliation');
const ledger = require('./ledger');

function channels(ctx) {
  sendJson(ctx.res, 200, {
    mode: gateway.mode(),
    readiness: gateway.readiness(),
    channels: gateway.channelList()
  });
}

function validDate(text) {
  return !text || /^\d{4}-\d{2}-\d{2}$/.test(text);
}

function detail(ctx) {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM payments WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '支付单不存在');
  if (row.user_id !== ctx.user.id && ctx.user.role !== 'admin') return fail(ctx.res, 403, '无权查看该支付单');

  gateway.expirePending();
  const fresh = get('SELECT * FROM payments WHERE id = ?', id);
  let order = null;
  if (fresh.order_id) {
    const o = get('SELECT id, status, amount_cents, material_id FROM orders WHERE id = ?', fresh.order_id);
    if (o) order = { id: o.id, status: o.status, amount: o.amount_cents, materialId: o.material_id };
  }
  sendJson(ctx.res, 200, {
    payment: gateway.serialize(fresh),
    order,
    mockMode: gateway.mode() === 'mock'
  });
}

function simulate(ctx) {
  if (!runtime.feature('payments')) return fail(ctx.res, 403, '支付功能暂未开放，请关注平台公告');
  const id = Number(ctx.params.id);
  const result = ctx.body.result === 'fail' ? 'fail' : 'success';
  const outcome = gateway.simulate(id, ctx.user, result);
  if (outcome.error) return fail(ctx.res, outcome.status || 400, outcome.error);
  if (outcome.duplicated) {
    return sendJson(ctx.res, 200, {
      result: 'duplicate',
      duplicated: true,
      payment: gateway.serialize(outcome.payment),
      message: '该支付单已完成支付，无需重复操作'
    });
  }
  sendJson(ctx.res, 200, {
    result: outcome.result.code === 'SUCCESS' ? 'success' : 'failed',
    duplicated: !!outcome.duplicated,
    payment: gateway.serialize(outcome.payment),
    message: outcome.result.message
  });
}

async function notify(ctx) {
  const result = await gateway.handleNotify(ctx.params.channel, ctx.body, {
    headers: ctx.req.headers,
    rawBody: ctx.req.rawBody || ''
  });
  // 支付宝要求返回纯文本 success，银联要求 ok；微信接受 JSON
  if (result.httpStatus === 200 && (result.ack === 'success' || result.ack === 'ok')) {
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return ctx.res.end(result.ack);
  }
  sendJson(ctx.res, result.httpStatus, {
    code: result.code,
    message: result.message,
    duplicated: !!result.duplicated
  });
}

function mine(ctx) {
  sendJson(ctx.res, 200, { items: gateway.mine(ctx.user.id), mode: gateway.mode() });
}

function adminConfirm(ctx) {
  const id = Number(ctx.params.id);
  const outcome = gateway.confirmManual(id, ctx.user);
  if (outcome.error) return fail(ctx.res, outcome.status || 400, outcome.error);
  if (outcome.duplicated) {
    return sendJson(ctx.res, 200, {
      duplicated: true,
      payment: gateway.serialize(outcome.payment),
      message: '该支付单已确认到账，无需重复操作'
    });
  }
  sendJson(ctx.res, 200, {
    payment: gateway.serialize(outcome.payment),
    message: '已确认到账，订单完成并生成卖家结算记录'
  });
}

function adminList(ctx) {
  const status = String(ctx.query.status || '');
  const channel = String(ctx.query.channel || '');
  const date = String(ctx.query.date || '');
  if (!validDate(date)) return fail(ctx.res, 400, '日期格式应为 YYYY-MM-DD');
  const data = gateway.adminList({ status, channel, date });
  sendJson(ctx.res, 200, { ...data, mode: gateway.mode(), readiness: gateway.readiness() });
}

function adminReconcile(ctx) {
  const date = String(ctx.query.date || '');
  if (!validDate(date)) return fail(ctx.res, 400, '日期格式应为 YYYY-MM-DD');
  sendJson(ctx.res, 200, gateway.reconcile(date));
}

function adminBatches(ctx) {
  const limit = Math.min(100, Math.max(1, Number(ctx.query.limit) || 20));
  sendJson(ctx.res, 200, { items: reconciliation.listBatches(limit) });
}

function adminBatchDetail(ctx) {
  const detail = reconciliation.batchDetail(ctx.params.id);
  if (!detail) return fail(ctx.res, 404, '对账批次不存在');
  sendJson(ctx.res, 200, detail);
}

function adminImportBill(ctx) {
  const outcome = reconciliation.importBill({
    date: String(ctx.body.date || '').trim(),
    channel: String(ctx.body.channel || '').trim(),
    items: ctx.body.items
  });
  if (outcome.error) return fail(ctx.res, outcome.status || 400, outcome.error);
  sendJson(ctx.res, 200, {
    message: `已导入 ${outcome.imported} 条渠道账单并完成对账`,
    ...outcome
  });
}

function adminLedger(ctx) {
  const trial = ledger.trialBalance();
  const mismatches = ledger.balanceMismatches();
  sendJson(ctx.res, 200, {
    trial,
    mismatches,
    cashBalance: ledger.cashBalance(),
    sellerPayable: trial.accounts
      .filter((account) => account.type === 'liability' && account.code.startsWith('seller:payable:'))
      .reduce((sum, account) => sum + account.balance, 0),
    commission: ledger.accountBalance('platform:commission').balance,
    transactions: ledger.recentTransactions(30)
  });
}

module.exports = {
  channels,
  detail,
  simulate,
  notify,
  mine,
  adminConfirm,
  adminList,
  adminReconcile,
  adminBatches,
  adminBatchDetail,
  adminImportBill,
  adminLedger
};
