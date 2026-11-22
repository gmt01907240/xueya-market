'use strict';

/**
 * 支付宝开放平台适配器（当面付预下单 / 查询 / 关单 / 退款 / 异步通知验签）
 *
 * 依赖环境变量：
 *   ALIPAY_APP_ID / ALIPAY_APP_PRIVATE_KEY_PATH / ALIPAY_PUBLIC_KEY_PATH
 *   ALIPAY_NOTIFY_URL / ALIPAY_GATEWAY / ALIPAY_SIGN_TYPE（默认 RSA2）
 *
 * 签名算法：RSA2（SHA256withRSA），参数按 key 字典序拼接。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function readFileSafe(pathname) {
  try {
    return fs.readFileSync(pathname, 'utf8');
  } catch {
    return '';
  }
}

function config() {
  return {
    appId: env('ALIPAY_APP_ID'),
    privateKeyPath: env('ALIPAY_APP_PRIVATE_KEY_PATH'),
    publicKeyPath: env('ALIPAY_PUBLIC_KEY_PATH'),
    notifyUrl: env('ALIPAY_NOTIFY_URL'),
    gateway: env('ALIPAY_GATEWAY', 'https://openapi.alipay.com/gateway.do'),
    signType: env('ALIPAY_SIGN_TYPE', 'RSA2')
  };
}

function normalizePem(text) {
  if (!text) return '';
  if (text.includes('-----BEGIN')) return text;
  const body = text.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') || '';
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

function privateKey() {
  const pem = readFileSafe(config().privateKeyPath);
  if (!pem) throw Object.assign(new Error('支付宝应用私钥未配置'), { code: 'ALIPAY_KEY_MISSING' });
  return crypto.createPrivateKey(pem.includes('-----BEGIN') ? pem : normalizePem(pem));
}

function publicKey() {
  const pem = readFileSafe(config().publicKeyPath);
  if (!pem) throw Object.assign(new Error('支付宝公钥未配置'), { code: 'ALIPAY_PUBLIC_KEY_MISSING' });
  return crypto.createPublicKey(pem.includes('-----BEGIN') ? pem : normalizePem(pem));
}

function validateConfig() {
  const cfg = config();
  const missing = [];
  if (!cfg.appId) missing.push('ALIPAY_APP_ID');
  if (!cfg.privateKeyPath) missing.push('ALIPAY_APP_PRIVATE_KEY_PATH');
  if (!cfg.publicKeyPath) missing.push('ALIPAY_PUBLIC_KEY_PATH');
  if (!cfg.notifyUrl) missing.push('ALIPAY_NOTIFY_URL');
  const errors = [];
  if (cfg.privateKeyPath) {
    try {
      crypto.createPrivateKey(readFileSafe(cfg.privateKeyPath));
    } catch {
      errors.push('支付宝应用私钥不可读或格式非法');
    }
  }
  if (cfg.publicKeyPath) {
    try {
      crypto.createPublicKey(normalizePem(readFileSafe(cfg.publicKeyPath)));
    } catch {
      errors.push('支付宝公钥不可读或格式非法');
    }
  }
  return { ok: missing.length === 0 && errors.length === 0, missing, errors, config: cfg };
}

function isConfigured() {
  return validateConfig().ok;
}

function canonical(params, excluded = []) {
  return Object.keys(params)
    .filter((key) => !excluded.includes(key) && params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

function signParams(params) {
  const content = canonical(params, ['sign']);
  return crypto.sign('RSA-SHA256', Buffer.from(content, 'utf8'), privateKey()).toString('base64');
}

function verifyParams(params, excluded = ['sign']) {
  if (!params.sign) return false;
  const content = canonical(params, excluded);
  try {
    return crypto.verify('RSA-SHA256', Buffer.from(content, 'utf8'), publicKey(), Buffer.from(params.sign, 'base64'));
  } catch {
    return false;
  }
}

/** 从响应原文中截取指定节点的原始 JSON，支付宝按该原文验签 */
function extractNodeRaw(text, key) {
  const marker = `"${key}"`;
  const start = text.indexOf(marker);
  if (start < 0) return '';
  const colon = text.indexOf(':', start + marker.length);
  if (colon < 0) return '';
  let i = colon + 1;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  const begin = i;
  if (text[i] !== '{') return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(begin, i + 1);
    }
  }
  return '';
}

function timestampNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function call(method, bizContent, extra = {}) {
  const cfg = config();
  const params = {
    app_id: cfg.appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: cfg.signType,
    timestamp: timestampNow(),
    version: '1.0',
    biz_content: JSON.stringify(bizContent),
    ...extra
  };
  params.sign = signParams(params);
  const body = new URLSearchParams(params).toString();
  const response = await fetch(cfg.gateway, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body,
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('支付宝返回非 JSON 报文'), { code: 'ALIPAY_BAD_RESPONSE' });
  }
  const key = `${method.replace(/\./g, '_')}_response`;
  const node = data[key] || data.error_response;
  if (!node) throw Object.assign(new Error('支付宝响应缺少业务节点'), { code: 'ALIPAY_BAD_RESPONSE' });
  if (data.sign) {
    const raw = extractNodeRaw(text, key);
    const verified = raw
      ? crypto.verify('RSA-SHA256', Buffer.from(raw, 'utf8'), publicKey(), Buffer.from(data.sign, 'base64'))
      : false;
    if (!verified) throw Object.assign(new Error('支付宝响应验签失败'), { code: 'ALIPAY_RESPONSE_SIGN_ERROR' });
  }
  if (node.code && node.code !== '10000') {
    throw Object.assign(new Error(node.sub_msg || node.msg || `支付宝接口错误 ${node.code}`), {
      code: node.code,
      detail: node
    });
  }
  return node;
}

async function createOrder({ paymentNo, amountCents, subject, expireMinutes = 15 }) {
  const cfg = config();
  const node = await call('alipay.trade.precreate', {
    out_trade_no: paymentNo,
    total_amount: (amountCents / 100).toFixed(2),
    subject: subject || `学习资料订单 ${paymentNo}`,
    timeout_express: `${expireMinutes}m`
  }, { notify_url: cfg.notifyUrl });
  return { codeUrl: node.qr_code, raw: node };
}

async function queryOrder(paymentNo) {
  return call('alipay.trade.query', { out_trade_no: paymentNo });
}

async function closeOrder(paymentNo) {
  return call('alipay.trade.close', { out_trade_no: paymentNo });
}

async function refund({ paymentNo, refundNo, refundCents, reason = '' }) {
  return call('alipay.trade.refund', {
    out_trade_no: paymentNo,
    refund_amount: (refundCents / 100).toFixed(2),
    out_request_no: refundNo,
    refund_reason: reason || '用户申请退款'
  });
}

/** 异步通知验签：排除 sign 与 sign_type 后按字典序验签 */
function parseNotify({ body = {} } = {}) {
  const cfg = config();
  if (!body || typeof body !== 'object') return { ok: false, code: 'PARAM_ERROR', message: '回调参数为空' };
  if (String(body.app_id || '') !== cfg.appId) {
    return { ok: false, code: 'APP_ID_MISMATCH', message: '回调 app_id 与配置不一致' };
  }
  if (!verifyParams(body, ['sign', 'sign_type'])) {
    return { ok: false, code: 'SIGN_ERROR', message: '支付宝回调签名校验失败' };
  }
  const status = String(body.trade_status || '').toUpperCase();
  const amountYuan = Number(body.total_amount || 0);
  return {
    ok: true,
    paymentNo: String(body.out_trade_no || ''),
    tradeNo: String(body.trade_no || ''),
    amountCents: Math.round(amountYuan * 100),
    status: status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED' ? 'SUCCESS' : 'FAIL',
    tradeStatus: status,
    nonce: String(body.notify_id || ''),
    payload: body
  };
}

function selfTest() {
  const key = privateKey();
  const message = `selftest\n${Date.now()}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(message), key);
  return crypto.verify('RSA-SHA256', Buffer.from(message), crypto.createPublicKey(key), signature);
}

module.exports = {
  code: 'alipay',
  config,
  validateConfig,
  isConfigured,
  createOrder,
  queryOrder,
  closeOrder,
  refund,
  parseNotify,
  selfTest,
  signParams,
  verifyParams
};
