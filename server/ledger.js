'use strict';

/**
 * 复式记账账本
 *
 * 规则：
 * 1. 每笔资金变动生成一个凭证（ledger_transactions）与至少两条分录（ledger_entries）；
 * 2. 分录必须借贷平衡，金额为正整数（分），账本只追加、不修改、不删除；
 * 3. 凭证号全局唯一，重复提交按幂等处理，不会重复入账；
 * 4. 平台现金、平台服务费收入、卖家应付款分别独立核算，支持试算平衡与余额核对。
 */

const { all, get, run, tx, now } = require('./db');

const SELLER_PREFIX = 'seller:payable:';

const PLATFORM_ACCOUNTS = {
  cash: { code: 'platform:cash', name: '渠道待清算资金', type: 'asset' },
  commission: { code: 'platform:commission', name: '平台服务费收入', type: 'income' },
  opening: { code: 'platform:opening-equity', name: '期初余额调整', type: 'equity' }
};

/** 资产/费用为借方余额，负债/收入/权益为贷方余额 */
const DEBIT_NORMAL = new Set(['asset', 'expense']);

function accountNormalBalance(type) {
  return DEBIT_NORMAL.has(type) ? 'debit' : 'credit';
}

function sellerAccount(sellerId) {
  return {
    code: `${SELLER_PREFIX}${sellerId}`,
    name: `卖家 #${sellerId} 应付款`,
    type: 'liability',
    ownerType: 'seller',
    ownerId: Number(sellerId)
  };
}

function normalizeAccount(account) {
  if (typeof account === 'string') {
    if (PLATFORM_ACCOUNTS[account]) return PLATFORM_ACCOUNTS[account];
    if (account.startsWith(SELLER_PREFIX)) {
      return sellerAccount(account.slice(SELLER_PREFIX.length));
    }
    return { code: account, name: account, type: 'asset' };
  }
  if (!account || !account.code) throw new Error('账本科目缺少 code');
  return {
    code: String(account.code),
    name: String(account.name || account.code),
    type: String(account.type || 'asset'),
    ownerType: String(account.ownerType || 'platform'),
    ownerId: account.ownerId === undefined ? null : account.ownerId
  };
}

function ensureAccount(account) {
  const normalized = normalizeAccount(account);
  const existing = get('SELECT * FROM ledger_accounts WHERE code = ?', normalized.code);
  if (existing) return existing;
  run(
    `INSERT INTO ledger_accounts (code, name, type, owner_type, owner_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    normalized.code, normalized.name, normalized.type, normalized.ownerType, normalized.ownerId, now()
  );
  return get('SELECT * FROM ledger_accounts WHERE code = ?', normalized.code);
}

/**
 * 写入一张平衡凭证。重复的 txnNo 直接返回已有凭证，保证幂等。
 * lines: [{ account, direction: 'debit'|'credit', amount, memo? }]
 */
function post({ txnNo, bizType, bizId = '', memo = '', lines = [] }) {
  if (!txnNo) throw new Error('账本凭证号不能为空');
  if (!bizType) throw new Error('账本业务类型不能为空');
  const normalizedLines = lines
    .map((line) => ({
      account: normalizeAccount(line.account),
      direction: String(line.direction || '').toLowerCase(),
      amount: Number(line.amount),
      memo: String(line.memo || '')
    }))
    .filter((line) => line.amount > 0);

  if (normalizedLines.length < 2) throw new Error('账本凭证至少需要两条有效分录');
  let debit = 0;
  let credit = 0;
  for (const line of normalizedLines) {
    if (!['debit', 'credit'].includes(line.direction)) throw new Error(`非法记账方向：${line.direction}`);
    if (!Number.isInteger(line.amount) || line.amount <= 0) throw new Error('分录金额必须为正整数（分）');
    if (line.direction === 'debit') debit += line.amount;
    else credit += line.amount;
  }
  if (debit !== credit) throw new Error(`账本分录不平衡：借方 ${debit} 分，贷方 ${credit} 分`);

  return tx(() => {
    const existing = get('SELECT * FROM ledger_transactions WHERE txn_no = ?', txnNo);
    if (existing) {
      return { duplicated: true, txnId: existing.id, amount: existing.amount_cents };
    }
    const info = run(
      `INSERT INTO ledger_transactions (txn_no, biz_type, biz_id, memo, amount_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      txnNo, bizType, String(bizId || ''), memo, debit, now()
    );
    const txnId = Number(info.lastInsertRowid);
    const createdAt = now();
    for (const line of normalizedLines) {
      const account = ensureAccount(line.account);
      run(
        `INSERT INTO ledger_entries (txn_id, account_id, direction, amount_cents, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        txnId, account.id, line.direction, line.amount, createdAt
      );
    }
    return { duplicated: false, txnId, amount: debit };
  });
}

/** 订单支付成功：借渠道资金，贷卖家应付款 + 平台服务费 */
function recordOrderPaid(order, payment) {
  if (!order || !order.id) throw new Error('缺少订单信息');
  const amount = Number(order.amount_cents);
  const commission = Number(order.commission_cents);
  const net = amount - commission;
  return post({
    txnNo: `PAY-${payment.payment_no}`,
    bizType: 'order_paid',
    bizId: String(order.id),
    memo: `订单 #${order.id} 支付成功`,
    lines: [
      { account: PLATFORM_ACCOUNTS.cash, direction: 'debit', amount },
      { account: sellerAccount(order.seller_id), direction: 'credit', amount: net },
      { account: PLATFORM_ACCOUNTS.commission, direction: 'credit', amount: commission }
    ]
  });
}

/** 订单退款：借卖家应付款 + 冲减平台服务费，贷渠道资金 */
function recordOrderRefund(order) {
  if (!order || !order.id) throw new Error('缺少订单信息');
  const amount = Number(order.amount_cents);
  const commission = Number(order.commission_cents);
  const net = amount - commission;
  return post({
    txnNo: `REFUND-${order.id}`,
    bizType: 'order_refund',
    bizId: String(order.id),
    memo: `订单 #${order.id} 退款`,
    lines: [
      { account: sellerAccount(order.seller_id), direction: 'debit', amount: net },
      { account: PLATFORM_ACCOUNTS.commission, direction: 'debit', amount: commission },
      { account: PLATFORM_ACCOUNTS.cash, direction: 'credit', amount }
    ]
  });
}

function accountBalance(code) {
  const account = get('SELECT * FROM ledger_accounts WHERE code = ?', code);
  if (!account) return { code, debit: 0, credit: 0, balance: 0, type: '' };
  const sum = get(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_cents ELSE 0 END), 0) AS debit,
            COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_cents ELSE 0 END), 0) AS credit
     FROM ledger_entries WHERE account_id = ?`,
    account.id
  );
  const normal = accountNormalBalance(account.type);
  const balance = normal === 'debit' ? sum.debit - sum.credit : sum.credit - sum.debit;
  return { code: account.code, name: account.name, type: account.type, debit: sum.debit, credit: sum.credit, balance };
}

function sellerBalance(sellerId) {
  return accountBalance(sellerAccount(sellerId).code).balance;
}

function cashBalance() {
  return accountBalance(PLATFORM_ACCOUNTS.cash.code).balance;
}

/** 试算平衡：全部借方发生额必须等于全部贷方发生额 */
function trialBalance() {
  const totals = get(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_cents ELSE 0 END), 0) AS debit,
            COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_cents ELSE 0 END), 0) AS credit
     FROM ledger_entries`
  );
  const rows = all(
    `SELECT a.code, a.name, a.type,
            COALESCE(SUM(CASE WHEN e.direction = 'debit' THEN e.amount_cents ELSE 0 END), 0) AS debit,
            COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_cents ELSE 0 END), 0) AS credit
     FROM ledger_accounts a
     LEFT JOIN ledger_entries e ON e.account_id = a.id
     GROUP BY a.id ORDER BY a.code`
  );
  const accounts = rows.map((row) => {
    const normal = accountNormalBalance(row.type);
    return {
      code: row.code,
      name: row.name,
      type: row.type,
      debit: row.debit,
      credit: row.credit,
      balance: normal === 'debit' ? row.debit - row.credit : row.credit - row.debit
    };
  });
  return {
    balanced: totals.debit === totals.credit,
    totalDebit: totals.debit,
    totalCredit: totals.credit,
    accounts
  };
}

/** 账本余额与 users.balance_cents 的差异，用于发现历史数据或绕过账本的写入 */
function balanceMismatches() {
  const rows = all(
    `SELECT u.id, u.nickname, u.balance_cents,
            COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_cents ELSE -e.amount_cents END), 0) AS ledger_balance
     FROM users u
     JOIN ledger_accounts a ON a.owner_type = 'seller' AND a.owner_id = u.id
     LEFT JOIN ledger_entries e ON e.account_id = a.id
     GROUP BY u.id`
  );
  return rows
    .filter((row) => Number(row.balance_cents) !== Number(row.ledger_balance))
    .map((row) => ({
      userId: row.id,
      nickname: row.nickname,
      balance: Number(row.balance_cents),
      ledgerBalance: Number(row.ledger_balance),
      diff: Number(row.balance_cents) - Number(row.ledger_balance)
    }));
}

function recentTransactions(limit = 50) {
  const rows = all(
    `SELECT t.*, COUNT(e.id) AS line_count
     FROM ledger_transactions t LEFT JOIN ledger_entries e ON e.txn_id = t.id
     GROUP BY t.id ORDER BY t.id DESC LIMIT ?`,
    limit
  );
  return rows.map((row) => ({
    id: row.id,
    txnNo: row.txn_no,
    bizType: row.biz_type,
    bizId: row.biz_id,
    memo: row.memo,
    amount: row.amount_cents,
    lineCount: row.line_count,
    createdAt: row.created_at
  }));
}

function entriesOf(txnId) {
  return all(
    `SELECT e.id, e.direction, e.amount_cents, e.created_at, a.code, a.name
     FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
     WHERE e.txn_id = ? ORDER BY e.id`,
    txnId
  ).map((row) => ({
    id: row.id,
    direction: row.direction,
    amount: row.amount_cents,
    account: row.code,
    accountName: row.name,
    createdAt: row.created_at
  }));
}

/**
 * 为已有支付流水补记凭证，保证升级后账本完整。
 * 只处理存在 payments 记录的真实交易，演示种子订单不会凭空入账。
 */
function backfill() {
  const paid = all(
    `SELECT p.payment_no, p.paid_at, o.* FROM payments p
     JOIN orders o ON o.id = p.order_id
     WHERE p.purpose = 'order' AND p.status IN ('paid', 'refunded') AND o.status IN ('completed', 'refund_requested', 'refunded')
     ORDER BY p.id`
  );
  for (const row of paid) {
    recordOrderPaid(row, { payment_no: row.payment_no });
  }
  const refunded = all(
    `SELECT o.* FROM orders o
     WHERE o.status = 'refunded'
       AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'refunded')
     ORDER BY o.id`
  );
  for (const row of refunded) {
    recordOrderRefund(row);
  }
  // 历史余额与账本差额作为期初余额入账，保证升级后余额可核对
  let opening = 0;
  for (const user of all('SELECT id, balance_cents FROM users')) {
    const diff = Number(user.balance_cents) - sellerBalance(user.id);
    if (!diff) continue;
    const txnNo = `OPEN-${user.id}`;
    if (get('SELECT 1 FROM ledger_transactions WHERE txn_no = ?', txnNo)) continue;
    const amount = Math.abs(diff);
    post({
      txnNo,
      bizType: 'opening_balance',
      bizId: String(user.id),
      memo: `用户 #${user.id} 期初余额调整`,
      lines: diff > 0
        ? [
            { account: PLATFORM_ACCOUNTS.opening, direction: 'debit', amount },
            { account: sellerAccount(user.id), direction: 'credit', amount }
          ]
        : [
            { account: sellerAccount(user.id), direction: 'debit', amount },
            { account: PLATFORM_ACCOUNTS.opening, direction: 'credit', amount }
          ]
    });
    opening += 1;
  }
  return { paid: paid.length, refunded: refunded.length, opening };
}

module.exports = {
  PLATFORM_ACCOUNTS,
  sellerAccount,
  post,
  recordOrderPaid,
  recordOrderRefund,
  accountBalance,
  sellerBalance,
  cashBalance,
  trialBalance,
  balanceMismatches,
  recentTransactions,
  entriesOf,
  backfill
};
