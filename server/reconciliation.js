'use strict';

/**
 * 渠道对账
 *
 * 平台侧数据：payments 表（支付单、渠道流水号、金额、状态）。
 * 渠道侧数据：通过管理端导入的渠道账单（channel_bill_items）。
 *
 * 差异类型：
 *   PAID_WITHOUT_ORDER       平台已支付但订单状态异常
 *   ORDER_WITHOUT_PAYMENT    订单已完成但缺少已支付流水
 *   CHANNEL_ONLY             渠道有账单、平台无对应支付单
 *   PLATFORM_ONLY            平台已支付、渠道账单缺失
 *   AMOUNT_MISMATCH          两边金额不一致
 *
 * 每次对账按自然日生成一个批次，差异持久化，便于复核与留痕。
 */

const { all, get, run, tx, now } = require('./db');

const CHANNEL_META = [
  { code: 'wechat', name: '微信支付', settle: 'T+1' },
  { code: 'alipay', name: '支付宝支付', settle: 'T+1' },
  { code: 'bankcard', name: '银行卡支付', settle: 'T+1' }
];

const CHANNEL_CODES = CHANNEL_META.map((item) => item.code);

const DIFF_TEXT = {
  PAID_WITHOUT_ORDER: '平台已支付但订单状态异常',
  ORDER_WITHOUT_PAYMENT: '订单已完成但缺少支付流水',
  CHANNEL_ONLY: '渠道有账单、平台无支付单',
  PLATFORM_ONLY: '平台已支付、渠道账单缺失',
  AMOUNT_MISMATCH: '平台与渠道金额不一致'
};

function today() {
  return now().slice(0, 10);
}

function validDate(text) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(text || ''));
}

function batchNoOf(day) {
  return `RECON-${day}`;
}

function ensureBatch(day) {
  const batchNo = batchNoOf(day);
  const existing = get('SELECT * FROM recon_batches WHERE batch_no = ?', batchNo);
  if (existing) return existing;
  run(
    `INSERT INTO recon_batches (batch_no, channel, bill_date, status, created_at)
     VALUES (?, 'all', ?, 'open', ?)`,
    batchNo, day, now()
  );
  return get('SELECT * FROM recon_batches WHERE batch_no = ?', batchNo);
}

function platformSummary(day) {
  return CHANNEL_META.map((meta) => {
    const paid = get(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS amount FROM payments
       WHERE channel = ? AND status = 'paid' AND substr(COALESCE(paid_at, created_at), 1, 10) = ?`,
      meta.code, day
    );
    const pending = get(
      `SELECT COUNT(*) AS count FROM payments WHERE channel = ? AND status = 'pending' AND substr(created_at, 1, 10) = ?`,
      meta.code, day
    );
    const failed = get(
      `SELECT COUNT(*) AS count FROM payments WHERE channel = ? AND status IN ('failed','closed') AND substr(created_at, 1, 10) = ?`,
      meta.code, day
    );
    return {
      channel: meta.code,
      name: meta.name,
      paidCount: paid.count,
      paidAmount: paid.amount,
      pendingCount: pending.count,
      failedCount: failed.count,
      settle: meta.settle
    };
  });
}

function orderAnomalies(day) {
  const paidWithoutOrder = all(
    `SELECT p.payment_no, p.order_id, p.amount_cents, o.status AS order_status
     FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE p.status = 'paid' AND p.purpose = 'order' AND o.status NOT IN ('completed','refund_requested','refunded')`
  );
  const orderWithoutPayment = all(
    `SELECT o.id, o.payment_channel, o.amount_cents FROM orders o
     WHERE o.status IN ('completed','refund_requested') AND o.payment_channel != ''
       AND substr(o.created_at, 1, 10) = ?
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'paid')`,
    day
  );
  return { paidWithoutOrder, orderWithoutPayment };
}

/** 平台与已导入渠道账单的逐笔比对 */
function billDiffs(batchId, day) {
  const diffs = [];
  for (const channel of CHANNEL_CODES) {
    const bill = all(
      `SELECT * FROM channel_bill_items WHERE batch_id = ? AND channel = ? ORDER BY id`,
      batchId, channel
    );
    if (!bill.length) continue;
    const platform = all(
      `SELECT payment_no, channel_trade_no, amount_cents FROM payments
       WHERE channel = ? AND status = 'paid' AND substr(COALESCE(paid_at, created_at), 1, 10) = ?`,
      channel, day
    );
    const byNo = new Map(platform.map((row) => [row.payment_no, row]));
    for (const item of bill) {
      const match = byNo.get(item.payment_no);
      if (!match) {
        diffs.push({
          type: 'CHANNEL_ONLY',
          paymentNo: item.payment_no,
          channelTradeNo: item.channel_trade_no,
          platformAmount: 0,
          channelAmount: item.amount_cents,
          detail: `${channel} 账单存在但平台无已支付流水`
        });
        continue;
      }
      byNo.delete(item.payment_no);
      if (Number(match.amount_cents) !== Number(item.amount_cents)) {
        diffs.push({
          type: 'AMOUNT_MISMATCH',
          paymentNo: item.payment_no,
          channelTradeNo: item.channel_trade_no || match.channel_trade_no,
          platformAmount: match.amount_cents,
          channelAmount: item.amount_cents,
          detail: `${channel} 平台 ${match.amount_cents} 分，渠道 ${item.amount_cents} 分`
        });
      }
    }
    for (const leftover of byNo.values()) {
      diffs.push({
        type: 'PLATFORM_ONLY',
        paymentNo: leftover.payment_no,
        channelTradeNo: leftover.channel_trade_no,
        platformAmount: leftover.amount_cents,
        channelAmount: 0,
        detail: `${channel} 平台已支付但渠道账单缺失`
      });
    }
  }
  return diffs;
}

function persist(day, summary, anomalies) {
  const batch = ensureBatch(day);
  const bill = get(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS amount
     FROM channel_bill_items WHERE batch_id = ?`,
    batch.id
  );
  const diffs = [];
  for (const row of anomalies.paidWithoutOrder) {
    diffs.push({
      type: 'PAID_WITHOUT_ORDER',
      paymentNo: row.payment_no,
      channelTradeNo: '',
      platformAmount: row.amount_cents,
      channelAmount: 0,
      detail: `订单 #${row.order_id} 状态为 ${row.order_status}`
    });
  }
  for (const row of anomalies.orderWithoutPayment) {
    diffs.push({
      type: 'ORDER_WITHOUT_PAYMENT',
      paymentNo: '',
      channelTradeNo: '',
      platformAmount: row.amount_cents,
      channelAmount: 0,
      detail: `订单 #${row.id}（${row.payment_channel}）缺少已支付流水`
    });
  }
  diffs.push(...billDiffs(batch.id, day));

  const diffAmount = diffs.reduce((sum, item) => sum + Math.abs(item.platformAmount - item.channelAmount), 0);
  const status = diffs.length === 0 ? 'balanced' : 'diff';
  const platformCount = summary.reduce((sum, row) => sum + row.paidCount, 0);
  const platformAmount = summary.reduce((sum, row) => sum + row.paidAmount, 0);

  tx(() => {
    run('DELETE FROM recon_diffs WHERE batch_id = ?', batch.id);
    for (const item of diffs) {
      run(
        `INSERT INTO recon_diffs (batch_id, diff_type, payment_no, channel_trade_no,
           platform_amount, channel_amount, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        batch.id, item.type, item.paymentNo || '', item.channelTradeNo || '',
        item.platformAmount, item.channelAmount, item.detail || '', now()
      );
    }
    run(
      `UPDATE recon_batches SET status = ?, channel_count = ?, channel_amount = ?,
         platform_count = ?, platform_amount = ?, diff_count = ?, diff_amount = ?,
         finished_at = ?
       WHERE id = ?`,
      status, bill.count, bill.amount, platformCount, platformAmount, diffs.length, diffAmount, now(), batch.id
    );
  });

  return {
    id: batch.id,
    batchNo: batch.batch_no,
    status,
    statusText: status === 'balanced' ? '账实相符' : '存在差异',
    channelCount: bill.count,
    channelAmount: bill.amount,
    platformCount,
    platformAmount,
    diffCount: diffs.length,
    diffAmount
  };
}

function run_(date) {
  const day = validDate(date) ? date : today();
  const summary = platformSummary(day);
  const anomalies = orderAnomalies(day);
  const batch = persist(day, summary, anomalies);
  return {
    date: day,
    summary,
    anomalies: {
      paidWithoutCompletedOrder: anomalies.paidWithoutOrder,
      completedOrderWithoutPayment: anomalies.orderWithoutPayment
    },
    totalPaidAmount: summary.reduce((sum, row) => sum + row.paidAmount, 0),
    totalPaidCount: summary.reduce((sum, row) => sum + row.paidCount, 0),
    batch
  };
}

/** 导入渠道账单并立即重算差异；同一批次同一渠道重复导入按覆盖处理 */
function importBill({ date, channel, items }) {
  const day = validDate(date) ? date : '';
  if (!day) return { error: '日期格式应为 YYYY-MM-DD', status: 400 };
  if (!CHANNEL_CODES.includes(channel)) return { error: '未知的支付渠道', status: 400 };
  if (!Array.isArray(items) || !items.length) return { error: '渠道账单不能为空', status: 400 };
  const normalized = [];
  for (const item of items) {
    const paymentNo = String(item.paymentNo || '').trim();
    const amount = Number(item.amountCents);
    if (!paymentNo) return { error: '账单明细缺少 paymentNo', status: 400 };
    if (!Number.isInteger(amount) || amount < 0) return { error: `账单金额不合法：${paymentNo}`, status: 400 };
    normalized.push({
      paymentNo,
      tradeNo: String(item.tradeNo || '').trim(),
      amount,
      status: String(item.status || 'SUCCESS').toUpperCase(),
      fee: Number.isInteger(Number(item.feeCents)) ? Number(item.feeCents) : 0
    });
  }
  const batch = ensureBatch(day);
  tx(() => {
    run('DELETE FROM channel_bill_items WHERE batch_id = ? AND channel = ?', batch.id, channel);
    for (const item of normalized) {
      run(
        `INSERT INTO channel_bill_items (batch_id, channel, bill_date, payment_no, channel_trade_no,
           amount_cents, status, fee_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        batch.id, channel, day, item.paymentNo, item.tradeNo, item.amount, item.status, item.fee, now()
      );
    }
  });
  const result = run_(day);
  return { ...result, imported: normalized.length, channel };
}

function listBatches(limit = 20) {
  const rows = all('SELECT * FROM recon_batches ORDER BY bill_date DESC, id DESC LIMIT ?', limit);
  return rows.map((row) => ({
    id: row.id,
    batchNo: row.batch_no,
    channel: row.channel,
    billDate: row.bill_date,
    status: row.status,
    statusText: row.status === 'balanced' ? '账实相符' : (row.status === 'diff' ? '存在差异' : '进行中'),
    channelCount: row.channel_count,
    channelAmount: row.channel_amount,
    platformCount: row.platform_count,
    platformAmount: row.platform_amount,
    diffCount: row.diff_count,
    diffAmount: row.diff_amount,
    note: row.note,
    createdAt: row.created_at,
    finishedAt: row.finished_at
  }));
}

function batchDetail(id) {
  const batch = get('SELECT * FROM recon_batches WHERE id = ?', Number(id));
  if (!batch) return null;
  const diffs = all('SELECT * FROM recon_diffs WHERE batch_id = ? ORDER BY id', batch.id).map((row) => ({
    id: row.id,
    type: row.diff_type,
    typeText: DIFF_TEXT[row.diff_type] || row.diff_type,
    paymentNo: row.payment_no,
    channelTradeNo: row.channel_trade_no,
    platformAmount: row.platform_amount,
    channelAmount: row.channel_amount,
    detail: row.detail,
    resolved: !!row.resolved,
    createdAt: row.created_at
  }));
  const bills = get(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS amount,
            COALESCE(SUM(fee_cents), 0) AS fee
     FROM channel_bill_items WHERE batch_id = ?`,
    batch.id
  );
  return {
    id: batch.id,
    batchNo: batch.batch_no,
    billDate: batch.bill_date,
    status: batch.status,
    platformCount: batch.platform_count,
    platformAmount: batch.platform_amount,
    channelCount: bills.count,
    channelAmount: bills.amount,
    feeAmount: bills.fee,
    diffCount: batch.diff_count,
    diffAmount: batch.diff_amount,
    createdAt: batch.created_at,
    finishedAt: batch.finished_at,
    diffs
  };
}

module.exports = {
  CHANNEL_META,
  DIFF_TEXT,
  run: run_,
  importBill,
  listBatches,
  batchDetail
};
