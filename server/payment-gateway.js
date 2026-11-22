'use strict';

/**
 * 支付网关（通道抽象层）
 *
 * 设计目标：
 * 1. 统一支付方式配置、限额、时效与结算说明；
 * 2. 统一支付单生命周期（pending → paid / failed / closed）；
 * 3. 回调签名校验、时间戳防重放、金额校验与幂等处理；
 * 4. 演示环境支持模拟支付，生产环境替换为各渠道官方实现。
 *
 * 环境变量：
 *   PAYMENT_MODE          mock（默认）| live
 *   PAYMENT_LIVE_ENABLED  真实支付总开关，默认 false；live 模式必须显式开启
 *   PAYMENT_MOCK_SECRET   模拟环境回调签名密钥
 *   WECHAT_APP_ID / WECHAT_MCH_ID / WECHAT_MCH_SERIAL_NO / WECHAT_API_V3_KEY
 *   WECHAT_MCH_PRIVATE_KEY_PATH / WECHAT_PLATFORM_CERT_PATH / WECHAT_NOTIFY_URL
 *   ALIPAY_APP_ID / ALIPAY_APP_PRIVATE_KEY_PATH / ALIPAY_PUBLIC_KEY_PATH / ALIPAY_NOTIFY_URL
 *   UNIONPAY_MER_ID / UNIONPAY_SIGN_METHOD / UNIONPAY_PRIVATE_KEY_PATH / UNIONPAY_CERT_ID
 *   UNIONPAY_PUBLIC_CERT_PATH / UNIONPAY_BACK_URL
 */

const crypto = require('node:crypto');
const { all, get, run, tx, now } = require('./db');
const settlements = require('./settlements');
const ledger = require('./ledger');
const reconciliation = require('./reconciliation');
const channels = require('./channels');

const IS_PRODUCTION = (process.env.NODE_ENV || 'development') === 'production';
const MODE = process.env.PAYMENT_MODE === 'live' ? 'live' : 'mock';
// 真实支付总开关：默认关闭，必须显式开启并配置渠道参数后才允许收款
const LIVE_ENABLED = ['1', 'true', 'on', 'yes'].includes(String(process.env.PAYMENT_LIVE_ENABLED || '').trim().toLowerCase());
// 未显式配置时使用进程内随机密钥，避免源码中的固定密钥被用于伪造回调
const MOCK_SECRET = process.env.PAYMENT_MOCK_SECRET || crypto.randomBytes(24).toString('hex');
const NOTIFY_TOLERANCE = 5 * 60 * 1000;

const STATUS_TEXT = {
  pending: '待支付',
  paid: '已支付',
  failed: '支付失败',
  closed: '已关闭',
  refunded: '已退款'
};

const CHANNELS = [
  {
    code: 'wechat',
    name: '微信支付',
    short: '微信',
    badge: '微',
    flow: 'qrcode',
    minCents: 1,
    maxCents: 5000000,
    expireMinutes: 15,
    settle: 'T+1',
    eta: '扫码后实时到账，次日清算',
    limitsText: '单笔 ¥0.01—¥50,000',
    feeNote: '通道费率约 0.6%，由平台承担',
    description: '使用微信扫描二维码完成支付，适合移动端用户。',
    secretEnv: ['WECHAT_APP_ID', 'WECHAT_MCH_ID', 'WECHAT_MCH_SERIAL_NO', 'WECHAT_API_V3_KEY', 'WECHAT_MCH_PRIVATE_KEY_PATH', 'WECHAT_PLATFORM_CERT_PATH'],
    notifyEnv: 'WECHAT_NOTIFY_URL'
  },
  {
    code: 'alipay',
    name: '支付宝支付',
    short: '支付宝',
    badge: '支',
    flow: 'qrcode',
    minCents: 1,
    maxCents: 5000000,
    expireMinutes: 15,
    settle: 'T+1',
    eta: '扫码后实时到账，次日清算',
    limitsText: '单笔 ¥0.01—¥50,000',
    feeNote: '通道费率约 0.6%，由平台承担',
    description: '使用支付宝扫描二维码完成支付，支持花呗等付款方式。',
    secretEnv: ['ALIPAY_APP_ID', 'ALIPAY_APP_PRIVATE_KEY_PATH', 'ALIPAY_PUBLIC_KEY_PATH'],
    notifyEnv: 'ALIPAY_NOTIFY_URL'
  },
  {
    code: 'bankcard',
    name: '银行卡支付',
    short: '银行卡',
    badge: '银',
    flow: 'transfer',
    minCents: 100,
    maxCents: 5000000,
    expireMinutes: 30,
    settle: 'T+1',
    eta: '转账后 1—5 分钟到账',
    limitsText: '单笔 ¥1—¥50,000',
    feeNote: '对公转账，单笔手续费以银行实际收取为准',
    description: '通过网银或手机银行转账至平台收款账户，附言填写支付单号。',
    secretEnv: ['UNIONPAY_MER_ID', 'UNIONPAY_SIGN_METHOD', 'UNIONPAY_PRIVATE_KEY_PATH', 'UNIONPAY_CERT_ID', 'UNIONPAY_PUBLIC_CERT_PATH'],
    notifyEnv: 'UNIONPAY_BACK_URL'
  }
];

function pad(n) {
  return String(n).padStart(2, '0');
}
function stamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function parseStamp(text) {
  if (!text) return null;
  const m = String(text).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function channelSecret(channel) {
  if (MODE === 'mock') return MOCK_SECRET;
  const env = { wechat: 'WECHAT_API_V3_KEY', alipay: 'ALIPAY_APP_SECRET', bankcard: 'BANK_MERCHANT_KEY' }[channel.code];
  return env ? process.env[env] || '' : '';
}

function isConfigured(channel) {
  if (MODE === 'mock') return true;
  const adapter = channels.get(channel.code);
  return !!adapter && adapter.isConfigured();
}

/**
 * 支付安全闸门：返回阻断原因，null 表示当前允许创建真实交易。
 * 生产环境禁止 mock；live 模式必须显式开启总开关且至少配置一个渠道。
 */
function paymentBlock() {
  if (MODE === 'mock' && IS_PRODUCTION) {
    return { code: 'MOCK_IN_PRODUCTION', message: '生产环境禁止使用模拟支付，请配置 PAYMENT_MODE=live 与真实渠道参数' };
  }
  if (MODE === 'live' && !LIVE_ENABLED) {
    return { code: 'LIVE_DISABLED', message: '真实支付总开关未开启（PAYMENT_LIVE_ENABLED=true）' };
  }
  return null;
}

function readiness() {
  const blockers = [];
  const gate = paymentBlock();
  if (gate) blockers.push(gate);
  const channelStates = CHANNELS.map((channel) => ({
    code: channel.code,
    name: channel.name,
    configured: isConfigured(channel)
  }));
  if (MODE === 'live') {
    for (const item of channels.status()) {
      if (!item.ok) {
        const detail = [...item.missing, ...item.errors].join('；');
        blockers.push({ code: 'CHANNEL_CONFIG_INVALID', message: `${item.channel}：${detail}` });
      }
    }
    if (!channelStates.some((item) => item.configured)) {
      blockers.push({ code: 'NO_CHANNEL_CONFIGURED', message: '未配置任何真实支付渠道参数，无法收款' });
    }
  }
  return {
    mode: MODE,
    production: IS_PRODUCTION,
    liveEnabled: LIVE_ENABLED,
    ready: blockers.length === 0,
    blockers,
    channels: channelStates
  };
}

function channelList() {
  return CHANNELS.map((channel) => ({
    code: channel.code,
    name: channel.name,
    short: channel.short,
    badge: channel.badge,
    flow: channel.flow,
    minAmount: channel.minCents,
    maxAmount: channel.maxCents,
    expireMinutes: channel.expireMinutes,
    settle: channel.settle,
    eta: channel.eta,
    limits: channel.limitsText,
    feeNote: channel.feeNote,
    description: channel.description,
    notifyUrl: channel.notifyEnv ? process.env[channel.notifyEnv] || `/api/payments/callback/${channel.code}` : '',
    params: (channel.secretEnv || []).map((key) => ({ key, configured: !!process.env[key] })),
    available: isConfigured(channel)
  }));
}

function getChannel(code) {
  return CHANNELS.find((c) => c.code === code) || null;
}

function generatePaymentNo() {
  const d = new Date();
  const base = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `PAY${base}${crypto.randomInt(100000, 999999)}`;
}

function signPayload(channel, payload) {
  const secret = channelSecret(channel);
  const canonical = [
    payload.paymentNo,
    payload.tradeNo || '',
    payload.amountCents,
    payload.status,
    payload.timestamp,
    payload.nonce
  ].join('|');
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

function verifySign(channel, payload) {
  const expected = signPayload(channel, payload);
  const actual = String(payload.sign || '');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function secondsLeft(row) {
  const expires = parseStamp(row.expires_at);
  if (!expires || row.status !== 'pending') return 0;
  return Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000));
}

function expirePending() {
  const rows = all("SELECT * FROM payments WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?", now());
  if (!rows.length) return 0;
  tx(() => {
    for (const row of rows) {
      run("UPDATE payments SET status = 'closed', failure_code = 'EXPIRED', failure_message = '支付超时未完成' WHERE id = ? AND status = 'pending'", row.id);
      if (row.order_id) {
        run("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending_payment'", row.order_id);
      }
    }
  });
  return rows.length;
}

function serialize(row) {
  const channel = getChannel(row.channel);
  return {
    id: row.id,
    paymentNo: row.payment_no,
    orderId: row.order_id,
    purpose: row.purpose,
    channel: row.channel,
    channelName: channel ? channel.name : row.channel,
    channelBadge: channel ? channel.badge : '?',
    amount: row.amount_cents,
    status: row.status,
    statusText: STATUS_TEXT[row.status] || row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    expiresIn: secondsLeft(row),
    paidAt: row.paid_at,
    channelTradeNo: row.channel_trade_no,
    failureMessage: row.failure_message,
    settle: channel ? channel.settle : '',
    eta: channel ? channel.eta : ''
  };
}

function payPayload(row) {
  const channel = getChannel(row.channel);
  const expiresIn = secondsLeft(row);
  if (row.channel === 'wechat') {
    return {
      mode: 'qrcode',
      qrText: `weixin://wxpay/bizpayurl?pr=${row.payment_no.slice(-12)}`,
      title: '微信扫码支付',
      note: '请使用微信「扫一扫」完成支付，支付成功后自动解锁资料。'
    };
  }
  if (row.channel === 'alipay') {
    return {
      mode: 'qrcode',
      qrText: `https://qr.alipay.com/${row.payment_no.slice(-10)}`,
      title: '支付宝扫码支付',
      note: '请使用支付宝「扫一扫」完成支付，支付成功后自动解锁资料。'
    };
  }
  // 仅 PAYMENT_MODE=mock 的开发环境会走到这里；不写入任何虚构银行账户
  return {
    mode: 'transfer',
    title: '银行卡转账',
    bankName: '【待配置】收款银行',
    accountName: '【待配置】对公账户户名',
    accountNo: '【待配置】对公银行账号',
    remark: row.payment_no,
    note: '当前为开发环境模拟转账信息，未接入真实对公账户；生产环境请通过银联签约渠道完成收款。'
  };
}

function livePayload(channel, channelOrder, row) {
  return {
    mode: 'qrcode',
    qrText: channelOrder.codeUrl,
    title: `${channel.name}扫码支付`,
    note: '请使用对应 App 扫描二维码完成支付，支付成功后自动解锁资料。',
    expiresIn: secondsLeft(row),
    expiresAt: row.expires_at
  };
}

async function createPayment({ userId, orderId, purpose, channelCode, amountCents }) {
  const blocked = paymentBlock();
  if (blocked) return { error: blocked.message, code: blocked.code };
  const channel = getChannel(channelCode);
  if (!channel) return { error: '不支持的支付方式' };
  if (!isConfigured(channel)) return { error: '该支付方式暂未开通', code: 'CHANNEL_NOT_CONFIGURED' };
  if (!Number.isInteger(amountCents) || amountCents < channel.minCents) return { error: `单笔金额不得低于 ¥${(channel.minCents / 100).toFixed(2)}` };
  if (amountCents > channel.maxCents) return { error: `单笔金额不得超过 ¥${(channel.maxCents / 100).toFixed(2)}` };

  const createdAt = new Date();
  const expiresAt = channel.expireMinutes
    ? stamp(new Date(createdAt.getTime() + channel.expireMinutes * 60 * 1000))
    : null;
  const paymentNo = generatePaymentNo();

  // 真实模式先向渠道下单，成功后再落库，避免渠道单与本地支付单不一致
  let channelOrder = null;
  if (MODE === 'live') {
    try {
      channelOrder = await channels.createOrder(channel.code, {
        paymentNo,
        amountCents,
        description: `学涯集市订单 ${paymentNo}`,
        expireMinutes: channel.expireMinutes
      });
    } catch (err) {
      return {
        error: `支付渠道下单失败：${err.message}`,
        code: err.code || 'CHANNEL_CREATE_FAILED',
        status: 502
      };
    }
  }

  const info = run(
    `INSERT INTO payments (payment_no, user_id, order_id, purpose, channel, amount_cents, status,
       channel_order_id, channel_payload, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    paymentNo, userId, orderId || null, purpose, channel.code, amountCents,
    channelOrder ? String(channelOrder.raw?.prepay_id || channelOrder.raw?.trade_no || channelOrder.raw?.queryId || '') : '',
    channelOrder ? JSON.stringify(channelOrder.payload || {}) : '',
    stamp(createdAt), expiresAt
  );
  const row = get('SELECT * FROM payments WHERE id = ?', Number(info.lastInsertRowid));
  return {
    row,
    channel,
    payload: MODE === 'live' ? livePayload(channel, channelOrder, row) : payPayload(row)
  };
}

function applyPaid(payment, { tradeNo, nonce }) {
  const order = payment.order_id ? get('SELECT * FROM orders WHERE id = ?', payment.order_id) : null;
  return tx(() => {
    // 仅当支付单仍为 pending 时完成落账，防止并发回调或重复请求重复增加卖家余额
    const updated = run(
      `UPDATE payments SET status = 'paid', channel_trade_no = ?, paid_at = ?, last_notify_nonce = ?, failure_code = '', failure_message = ''
       WHERE id = ? AND status = 'pending'`,
      tradeNo, now(), nonce || '', payment.id
    );
    if (!updated.changes) return false;
    if (payment.purpose === 'order' && order) {
      run("UPDATE orders SET status = 'completed' WHERE id = ? AND status = 'pending_payment'", order.id);
      const income = order.amount_cents - order.commission_cents;
      // 余额为兼容字段，真实资金归属以复式账本为准
      run('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?', income, order.seller_id);
      ledger.recordOrderPaid(order, payment);
      settlements.recordForOrder(order, now());
    }
    return true;
  });
}

/** 银行卡转账等无法自动回调的场景，由管理员核对到账后人工确认 */
function confirmManual(paymentId, admin) {
  if (!admin || admin.role !== 'admin') return { error: '仅管理员可执行该操作', status: 403 };
  const blocked = paymentBlock();
  if (blocked) return { error: blocked.message, code: blocked.code, status: 403 };
  if (MODE === 'live') return { error: '生产环境由渠道回调自动确认到账，禁止人工确认', status: 400 };
  const payment = get('SELECT * FROM payments WHERE id = ?', paymentId);
  if (!payment) return { error: '支付单不存在', status: 404 };
  if (payment.channel !== 'bankcard') return { error: '仅银行卡转账支持人工确认到账', status: 400 };
  if (payment.status === 'paid') {
    return { duplicated: true, payment: get('SELECT * FROM payments WHERE id = ?', paymentId) };
  }
  if (payment.status !== 'pending') {
    return { error: `支付单状态为${STATUS_TEXT[payment.status] || payment.status}`, status: 400 };
  }
  if (secondsLeft(payment) === 0) {
    expirePending();
    return { error: '支付单已超时关闭，请让买家重新下单', status: 400 };
  }
  applyPaid(payment, { tradeNo: `MANUAL${Date.now()}`, nonce: '' });
  return { payment: get('SELECT * FROM payments WHERE id = ?', paymentId) };
}

/**
 * 统一回调处理。所有渠道回调均转换为：
 * { paymentNo, tradeNo, amountCents, status: 'SUCCESS' | 'FAIL', nonce }
 */
function applyNotify(channel, payload, ack) {
  const payment = get('SELECT * FROM payments WHERE payment_no = ?', payload.paymentNo);
  if (!payment) return { httpStatus: 404, code: 'NOT_FOUND', message: '支付单不存在', ack };
  if (payment.channel !== channel.code) {
    return { httpStatus: 400, code: 'CHANNEL_MISMATCH', message: '支付渠道不匹配', ack };
  }
  if (payment.status === 'paid') {
    return { httpStatus: 200, code: 'SUCCESS', message: '重复通知，已忽略', duplicated: true, ack };
  }
  if (payment.status !== 'pending') {
    return { httpStatus: 400, code: 'PAYMENT_CLOSED', message: `支付单状态为${STATUS_TEXT[payment.status] || payment.status}`, ack };
  }
  if (secondsLeft(payment) === 0) {
    expirePending();
    return { httpStatus: 400, code: 'PAYMENT_EXPIRED', message: '支付单已超时关闭', ack };
  }
  if (payload.amountCents !== payment.amount_cents) {
    run("UPDATE payments SET failure_code = 'AMOUNT_MISMATCH', failure_message = ? WHERE id = ?", `回调金额 ${payload.amountCents} 与订单金额 ${payment.amount_cents} 不一致`, payment.id);
    return { httpStatus: 400, code: 'AMOUNT_MISMATCH', message: '回调金额与支付单金额不一致', ack };
  }

  if (payload.status === 'FAIL') {
    tx(() => {
      run("UPDATE payments SET status = 'failed', channel_trade_no = ?, failure_code = 'CHANNEL_FAIL', failure_message = ?, last_notify_nonce = ? WHERE id = ?", payload.tradeNo, '渠道返回支付失败', payload.nonce || '', payment.id);
      if (payment.order_id) {
        run("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending_payment'", payment.order_id);
      }
    });
    return { httpStatus: 200, code: 'SUCCESS', message: '已记录支付失败', ack };
  }

  applyPaid(payment, { tradeNo: payload.tradeNo, nonce: payload.nonce });
  return { httpStatus: 200, code: 'SUCCESS', message: '支付成功', ack };
}

function handleMockNotify(channel, body) {
  const payload = {
    paymentNo: String(body.paymentNo || ''),
    tradeNo: String(body.tradeNo || ''),
    amountCents: Number(body.amountCents ?? body.amount ?? 0),
    status: String(body.status || '').toUpperCase(),
    timestamp: Number(body.timestamp || 0),
    nonce: String(body.nonce || ''),
    sign: String(body.sign || '')
  };
  if (!payload.paymentNo || !payload.tradeNo || !payload.nonce || !payload.status) {
    return { httpStatus: 400, code: 'PARAM_ERROR', message: '回调参数不完整' };
  }
  if (!['SUCCESS', 'FAIL'].includes(payload.status)) {
    return { httpStatus: 400, code: 'STATUS_ERROR', message: '回调状态不合法' };
  }
  if (!payload.timestamp || Math.abs(Date.now() - payload.timestamp) > NOTIFY_TOLERANCE) {
    return { httpStatus: 400, code: 'TIMESTAMP_EXPIRED', message: '回调时间戳超出允许范围' };
  }
  if (!channelSecret(channel)) {
    return { httpStatus: 400, code: 'NOT_CONFIGURED', message: '支付渠道未配置签名密钥' };
  }
  if (!verifySign(channel, payload)) {
    return { httpStatus: 400, code: 'SIGN_ERROR', message: '回调签名校验失败' };
  }
  return applyNotify(channel, payload, 'json');
}

function handleLiveNotify(channel, { headers, rawBody, body }) {
  const result = channels.parseNotify(channel.code, { headers, rawBody, body });
  if (!result.ok) return { httpStatus: 400, code: result.code, message: result.message };
  const ack = channel.code === 'alipay' ? 'success' : (channel.code === 'bankcard' ? 'ok' : 'json');
  return applyNotify(channel, result, ack);
}

async function handleNotify(channelCode, body, ctx = {}) {
  if (MODE === 'mock' && IS_PRODUCTION) {
    return { httpStatus: 403, code: 'MOCK_IN_PRODUCTION', message: '生产环境禁止模拟支付回调' };
  }
  const channel = getChannel(channelCode);
  if (!channel) return { httpStatus: 400, code: 'CHANNEL_ERROR', message: '未知的支付渠道' };
  if (MODE === 'live') {
    return handleLiveNotify(channel, {
      headers: ctx.headers || {},
      rawBody: ctx.rawBody || '',
      body
    });
  }
  return handleMockNotify(channel, body);
}

function simulate(paymentId, user, result) {
  if (MODE !== 'mock' || IS_PRODUCTION) return { error: '生产环境不允许模拟支付', status: 403 };
  const payment = get('SELECT * FROM payments WHERE id = ?', paymentId);
  if (!payment) return { error: '支付单不存在', status: 404 };
  if (payment.user_id !== user.id && user.role !== 'admin') return { error: '无权操作该支付单', status: 403 };
  if (payment.status === 'paid') return { payment: get('SELECT * FROM payments WHERE id = ?', paymentId), duplicated: true };
  if (payment.status !== 'pending') return { error: `支付单状态为${STATUS_TEXT[payment.status] || payment.status}`, status: 400 };
  if (secondsLeft(payment) === 0) {
    expirePending();
    return { error: '支付单已超时关闭，请重新发起支付', status: 400 };
  }

  const channel = getChannel(payment.channel);
  const payload = {
    paymentNo: payment.payment_no,
    tradeNo: `MOCK${Date.now()}${crypto.randomInt(1000, 9999)}`,
    amountCents: payment.amount_cents,
    status: result === 'fail' ? 'FAIL' : 'SUCCESS',
    timestamp: Date.now(),
    nonce: crypto.randomBytes(8).toString('hex')
  };
  payload.sign = signPayload(channel, payload);
  const res = handleNotify(payment.channel, payload);
  return {
    result: res,
    payment: get('SELECT * FROM payments WHERE id = ?', paymentId),
    httpStatus: res.httpStatus
  };
}

function mine(userId) {
  expirePending();
  const rows = all('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', userId);
  return rows.map(serialize);
}

function adminList({ status = '', channel = '', date = '' } = {}) {
  expirePending();
  const where = [];
  const params = [];
  if (status) {
    where.push('p.status = ?');
    params.push(status);
  }
  if (channel) {
    where.push('p.channel = ?');
    params.push(channel);
  }
  if (date) {
    where.push('substr(p.created_at, 1, 10) = ?');
    params.push(date);
  }
  const sql = `SELECT p.*, u.nickname, u.email FROM payments p JOIN users u ON u.id = p.user_id
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY p.created_at DESC LIMIT 200`;
  const rows = all(sql, ...params);
  const got = all(
    `SELECT status, COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS amount FROM payments
     ${date ? 'WHERE substr(created_at, 1, 10) = ?' : ''} GROUP BY status`,
    ...(date ? [date] : [])
  );
  const totals = {
    pending: { count: 0, amount: 0 },
    paid: { count: 0, amount: 0 },
    failed: { count: 0, amount: 0 },
    closed: { count: 0, amount: 0 },
    refunded: { count: 0, amount: 0 }
  };
  for (const row of got) {
    totals[row.status] = { count: row.count, amount: row.amount };
  }
  return {
    items: rows.map((row) => ({ ...serialize(row), user: { id: row.user_id, nickname: row.nickname, email: row.email } })),
    totals
  };
}

function reconcile(date) {
  expirePending();
  return reconciliation.run(date);
}

function mode() {
  return MODE;
}

module.exports = {
  MODE,
  LIVE_ENABLED,
  CHANNELS,
  STATUS_TEXT,
  channelList,
  getChannel,
  createPayment,
  handleNotify,
  confirmManual,
  simulate,
  serialize,
  payPayload,
  expirePending,
  mine,
  adminList,
  reconcile,
  readiness,
  paymentBlock,
  mode,
  secondsLeft,
  signPayload
};
