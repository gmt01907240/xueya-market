'use strict';

/**
 * 微信支付 APIv3 直连适配器（Native 扫码 / 查询 / 关单 / 退款 / 回调验签解密）
 *
 * 依赖环境变量：
 *   WECHAT_APP_ID / WECHAT_MCH_ID / WECHAT_MCH_SERIAL_NO / WECHAT_API_V3_KEY
 *   WECHAT_MCH_PRIVATE_KEY_PATH  apiclient_key.pem
 *   WECHAT_PLATFORM_CERT_PATH   微信支付平台证书（wechatpay_*.pem）
 *   WECHAT_NOTIFY_URL           https 公网回调地址
 *   WECHAT_API_BASE             默认 https://api.mch.weixin.qq.com
 *
 * 仅使用 node:crypto 与全局 fetch，无第三方依赖。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

const NOTIFY_TOLERANCE = 5 * 60 * 1000;

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
    appId: env('WECHAT_APP_ID'),
    mchId: env('WECHAT_MCH_ID'),
    serialNo: env('WECHAT_MCH_SERIAL_NO'),
    apiV3Key: env('WECHAT_API_V3_KEY'),
    privateKeyPath: env('WECHAT_MCH_PRIVATE_KEY_PATH'),
    platformCertPath: env('WECHAT_PLATFORM_CERT_PATH'),
    notifyUrl: env('WECHAT_NOTIFY_URL'),
    apiBase: env('WECHAT_API_BASE', 'https://api.mch.weixin.qq.com').replace(/\/$/, '')
  };
}

function validateConfig() {
  const cfg = config();
  const missing = [];
  if (!cfg.appId) missing.push('WECHAT_APP_ID');
  if (!cfg.mchId) missing.push('WECHAT_MCH_ID');
  if (!cfg.serialNo) missing.push('WECHAT_MCH_SERIAL_NO');
  if (!cfg.apiV3Key) missing.push('WECHAT_API_V3_KEY');
  if (!cfg.privateKeyPath) missing.push('WECHAT_MCH_PRIVATE_KEY_PATH');
  if (!cfg.platformCertPath) missing.push('WECHAT_PLATFORM_CERT_PATH');
  if (!cfg.notifyUrl) missing.push('WECHAT_NOTIFY_URL');
  const errors = [];
  if (cfg.apiV3Key && Buffer.byteLength(cfg.apiV3Key) !== 32) errors.push('WECHAT_API_V3_KEY 必须为 32 字节');
  if (cfg.privateKeyPath) {
    const pem = readFileSafe(cfg.privateKeyPath);
    if (!pem) errors.push(`商户私钥不可读：${cfg.privateKeyPath}`);
    else {
      try {
        crypto.createPrivateKey(pem);
      } catch {
        errors.push('商户私钥不是合法的 PEM 私钥');
      }
    }
  }
  if (cfg.platformCertPath) {
    const pem = readFileSafe(cfg.platformCertPath);
    if (!pem) errors.push(`平台证书不可读：${cfg.platformCertPath}`);
    else {
      try {
        if (pem.includes('-----BEGIN CERTIFICATE')) new crypto.X509Certificate(pem);
        else crypto.createPublicKey(pem);
      } catch {
        errors.push('平台证书不是合法的 X.509 证书或公钥 PEM');
      }
    }
  }
  return { ok: missing.length === 0 && errors.length === 0, missing, errors, config: cfg };
}

function isConfigured() {
  return validateConfig().ok;
}

function privateKey() {
  const pem = readFileSafe(config().privateKeyPath);
  if (!pem) throw Object.assign(new Error('微信支付商户私钥未配置'), { code: 'WECHAT_KEY_MISSING' });
  return crypto.createPrivateKey(pem);
}

function platformPublicKey() {
  const pem = readFileSafe(config().platformCertPath);
  if (!pem) throw Object.assign(new Error('微信支付平台证书未配置'), { code: 'WECHAT_CERT_MISSING' });
  if (pem.includes('-----BEGIN CERTIFICATE')) return new crypto.X509Certificate(pem).publicKey;
  return crypto.createPublicKey(pem);
}

function buildAuthorization(method, pathWithQuery, body) {
  const cfg = config();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = `${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${body || ''}\n`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(message), privateKey()).toString('base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${cfg.serialNo}"`;
}

async function api(method, pathWithQuery, bodyObject) {
  const cfg = config();
  const body = bodyObject === undefined ? '' : JSON.stringify(bodyObject);
  const response = await fetch(`${cfg.apiBase}${pathWithQuery}`, {
    method,
    headers: {
      Authorization: buildAuthorization(method, pathWithQuery, body),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'xueya-campus-market/1.0'
    },
    body: body || undefined,
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw Object.assign(new Error(data.message || `微信支付接口返回 ${response.status}`), {
      code: data.code || 'WECHAT_API_ERROR',
      status: response.status,
      detail: data
    });
  }
  return data;
}

/** Native 扫码下单，返回 code_url */
async function createOrder({ paymentNo, amountCents, description, attach = '' }) {
  const cfg = config();
  const data = await api('POST', '/v3/pay/transactions/native', {
    appid: cfg.appId,
    mchid: cfg.mchId,
    description: description || `学习资料订单 ${paymentNo}`,
    out_trade_no: paymentNo,
    notify_url: cfg.notifyUrl,
    attach: attach || undefined,
    amount: { total: amountCents, currency: 'CNY' }
  });
  return { codeUrl: data.code_url, raw: data };
}

async function queryOrder(paymentNo) {
  const cfg = config();
  return api('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(paymentNo)}?mchid=${encodeURIComponent(cfg.mchId)}`);
}

async function closeOrder(paymentNo) {
  const cfg = config();
  return api('POST', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(paymentNo)}/close`, { mchid: cfg.mchId });
}

async function refund({ paymentNo, refundNo, refundCents, totalCents, reason = '' }) {
  return api('POST', '/v3/refund/domestic/refunds', {
    out_trade_no: paymentNo,
    out_refund_no: refundNo,
    reason: reason || '用户申请退款',
    amount: { refund: refundCents, total: totalCents, currency: 'CNY' }
  });
}

function decryptResource(resource, apiV3Key) {
  const ciphertext = Buffer.from(resource.ciphertext, 'base64');
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(resource.nonce, 'utf8'));
  decipher.setAuthTag(authTag);
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

/** 校验回调签名（平台证书）并解密 resource */
function parseNotify({ headers = {}, rawBody = '', body = {} } = {}) {
  const cfg = config();
  const timestamp = String(headers['wechatpay-timestamp'] || '');
  const nonce = String(headers['wechatpay-nonce'] || '');
  const signature = String(headers['wechatpay-signature'] || '');
  if (!timestamp || !nonce || !signature) return { ok: false, code: 'SIGN_MISSING', message: '缺少微信支付签名头' };
  if (Math.abs(Date.now() - Number(timestamp) * 1000) > NOTIFY_TOLERANCE) {
    return { ok: false, code: 'TIMESTAMP_EXPIRED', message: '回调时间戳超出允许范围' };
  }
  const message = `${timestamp}\n${nonce}\n${rawBody || ''}\n`;
  let verified = false;
  try {
    verified = crypto.verify('RSA-SHA256', Buffer.from(message), platformPublicKey(), Buffer.from(signature, 'base64'));
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, code: 'SIGN_ERROR', message: '微信支付回调签名校验失败' };

  let resource = body.resource;
  if (!resource && typeof body === 'string') {
    try {
      resource = JSON.parse(body).resource;
    } catch {
      resource = null;
    }
  }
  if (!resource) return { ok: false, code: 'PARAM_ERROR', message: '回调缺少 resource' };
  let payload;
  try {
    payload = decryptResource(resource, cfg.apiV3Key);
  } catch {
    return { ok: false, code: 'DECRYPT_ERROR', message: '回调报文解密失败，请核对 APIv3 密钥' };
  }
  const state = String(payload.trade_state || '').toUpperCase();
  return {
    ok: true,
    paymentNo: String(payload.out_trade_no || ''),
    tradeNo: String(payload.transaction_id || ''),
    amountCents: Number(payload.amount?.total || 0),
    status: state === 'SUCCESS' ? 'SUCCESS' : 'FAIL',
    tradeState: state,
    nonce,
    payload
  };
}

/** 预检自检：用商户私钥签名，再用私钥导出的公钥验签 */
function selfTest() {
  const key = privateKey();
  const message = `selftest\n${Date.now()}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(message), key);
  return crypto.verify('RSA-SHA256', Buffer.from(message), crypto.createPublicKey(key), signature);
}

module.exports = {
  code: 'wechat',
  config,
  validateConfig,
  isConfigured,
  createOrder,
  queryOrder,
  closeOrder,
  refund,
  parseNotify,
  selfTest,
  buildAuthorization
};
