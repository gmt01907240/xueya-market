'use strict';

/**
 * 银联全渠道网关适配器（二维码主扫 / 查询 / 退款 / 后台通知验签）
 *
 * 说明：银联体系存在「银联全渠道」「银联商务开放平台」等多条产品线，字段与签名
 * 细节以签约时渠道下发的接口文档为准。本适配器按银联全渠道 5.1.0 报文规范实现，
 * 可通过环境变量切换 MD5（01）/ SHA256+RSA（11）两种签名方式。
 *
 * 依赖环境变量：
 *   UNIONPAY_MER_ID / UNIONPAY_SIGN_METHOD / UNIONPAY_BACK_URL / UNIONPAY_FRONT_URL
 *   UNIONPAY_PRIVATE_KEY_PATH / UNIONPAY_CERT_ID / UNIONPAY_PUBLIC_CERT_PATH（签名方式 11）
 *   UNIONPAY_MD5_KEY（签名方式 01）
 *   UNIONPAY_API_BASE 默认 https://gateway.95516.com/gateway/api
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
    merId: env('UNIONPAY_MER_ID'),
    signMethod: env('UNIONPAY_SIGN_METHOD', '11'),
    privateKeyPath: env('UNIONPAY_PRIVATE_KEY_PATH'),
    certId: env('UNIONPAY_CERT_ID'),
    publicCertPath: env('UNIONPAY_PUBLIC_CERT_PATH'),
    md5Key: env('UNIONPAY_MD5_KEY'),
    backUrl: env('UNIONPAY_BACK_URL'),
    frontUrl: env('UNIONPAY_FRONT_URL'),
    apiBase: env('UNIONPAY_API_BASE', 'https://gateway.95516.com/gateway/api').replace(/\/$/, '')
  };
}

function privateKey() {
  const pem = readFileSafe(config().privateKeyPath);
  if (!pem) throw Object.assign(new Error('银联商户私钥未配置'), { code: 'UNIONPAY_KEY_MISSING' });
  return crypto.createPrivateKey(pem);
}

function unionpayPublicKey() {
  const pem = readFileSafe(config().publicCertPath);
  if (!pem) throw Object.assign(new Error('银联公钥证书未配置'), { code: 'UNIONPAY_CERT_MISSING' });
  if (pem.includes('-----BEGIN CERTIFICATE')) return new crypto.X509Certificate(pem).publicKey;
  return crypto.createPublicKey(pem);
}

function validateConfig() {
  const cfg = config();
  const missing = [];
  if (!cfg.merId) missing.push('UNIONPAY_MER_ID');
  if (!cfg.backUrl) missing.push('UNIONPAY_BACK_URL');
  if (cfg.signMethod === '11') {
    if (!cfg.privateKeyPath) missing.push('UNIONPAY_PRIVATE_KEY_PATH');
    if (!cfg.certId) missing.push('UNIONPAY_CERT_ID');
    if (!cfg.publicCertPath) missing.push('UNIONPAY_PUBLIC_CERT_PATH');
  } else if (cfg.signMethod === '01') {
    if (!cfg.md5Key) missing.push('UNIONPAY_MD5_KEY');
  } else {
    return { ok: false, missing, errors: ['UNIONPAY_SIGN_METHOD 仅支持 01 或 11'], config: cfg };
  }
  const errors = [];
  if (cfg.signMethod === '11' && cfg.privateKeyPath) {
    try {
      crypto.createPrivateKey(readFileSafe(cfg.privateKeyPath));
    } catch {
      errors.push('银联商户私钥不可读或格式非法');
    }
  }
  if (cfg.signMethod === '11' && cfg.publicCertPath) {
    try {
      unionpayPublicKey();
    } catch {
      errors.push('银联公钥证书不可读或格式非法');
    }
  }
  return { ok: missing.length === 0 && errors.length === 0, missing, errors, config: cfg };
}

function isConfigured() {
  return validateConfig().ok;
}

function canonical(params, excluded = ['signature']) {
  return Object.keys(params)
    .filter((key) => !excluded.includes(key) && params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

function signParams(params) {
  const cfg = config();
  const content = canonical(params);
  if (cfg.signMethod === '01') {
    return crypto.createHash('md5').update(`${content}&${cfg.md5Key}`, 'utf8').digest('hex').toUpperCase();
  }
  return crypto.sign('RSA-SHA256', Buffer.from(content, 'utf8'), privateKey()).toString('hex').toUpperCase();
}

function verifyParams(params) {
  const cfg = config();
  const signature = String(params.signature || '');
  if (!signature) return false;
  const content = canonical(params);
  if (cfg.signMethod === '01') {
    const expected = crypto.createHash('md5').update(`${content}&${cfg.md5Key}`, 'utf8').digest('hex').toUpperCase();
    return expected === signature.toUpperCase();
  }
  try {
    return crypto.verify('RSA-SHA256', Buffer.from(content, 'utf8'), unionpayPublicKey(), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

function txnTimeNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function baseParams(extra) {
  const cfg = config();
  const params = {
    version: '5.1.0',
    encoding: 'UTF-8',
    signMethod: cfg.signMethod,
    merId: cfg.merId,
    ...extra
  };
  if (cfg.signMethod === '11') params.certId = cfg.certId;
  return params;
}

async function post(params) {
  const cfg = config();
  const signed = { ...params };
  signed.signature = signParams(signed);
  const response = await fetch(`${cfg.apiBase}/backTransReq.do`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams(signed).toString(),
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const parsed = {};
    for (const [key, value] of new URLSearchParams(text).entries()) parsed[key] = value;
    data = parsed;
  }
  if (data.respCode && data.respCode !== '00') {
    throw Object.assign(new Error(data.respMsg || `银联返回 ${data.respCode}`), { code: data.respCode, detail: data });
  }
  return data;
}

/** 二维码主扫下单：txnType=01，txnSubType=07，channelType=07 */
async function createOrder({ paymentNo, amountCents, description, expireMinutes = 15 }) {
  const cfg = config();
  const txnTime = txnTimeNow();
  const params = baseParams({
    txnType: '01',
    txnSubType: '07',
    bizType: '000000',
    channelType: '07',
    accessType: '0',
    orderId: paymentNo,
    txnTime,
    txnAmt: String(amountCents),
    currencyCode: '156',
    backUrl: cfg.backUrl,
    frontUrl: cfg.frontUrl || undefined,
    payTimeout: (() => {
      const d = new Date(Date.now() + expireMinutes * 60 * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    })(),
    orderDesc: description || `学习资料订单 ${paymentNo}`
  });
  const data = await post(params);
  const codeUrl = data.qrCode || data.qr_code || data.payUrl || '';
  if (!codeUrl) throw Object.assign(new Error('银联未返回二维码地址'), { code: 'UNIONPAY_NO_QRCODE', detail: data });
  return { codeUrl, raw: data, payload: { txnTime } };
}

async function queryOrder(paymentNo, txnTime) {
  return post(baseParams({
    txnType: '00',
    txnSubType: '00',
    bizType: '000000',
    orderId: paymentNo,
    txnTime: txnTime || txnTimeNow()
  }));
}

async function refund({ paymentNo, refundNo, refundCents, queryId, txnTime }) {
  if (!queryId) throw Object.assign(new Error('银联退款缺少原交易查询号 queryId'), { code: 'UNIONPAY_QUERY_ID_MISSING' });
  return post(baseParams({
    txnType: '04',
    txnSubType: '00',
    bizType: '000000',
    orderId: refundNo,
    origQryId: queryId,
    txnTime: txnTime || txnTimeNow(),
    txnAmt: String(refundCents),
    backUrl: config().backUrl
  }));
}

/** 后台通知验签：respCode=00 视为支付成功 */
function parseNotify({ body = {} } = {}) {
  const cfg = config();
  if (!body || typeof body !== 'object') return { ok: false, code: 'PARAM_ERROR', message: '回调参数为空' };
  if (String(body.merId || '') !== cfg.merId) {
    return { ok: false, code: 'MER_ID_MISMATCH', message: '回调商户号与配置不一致' };
  }
  if (!verifyParams(body)) return { ok: false, code: 'SIGN_ERROR', message: '银联回调验签失败' };
  return {
    ok: true,
    paymentNo: String(body.orderId || ''),
    tradeNo: String(body.queryId || ''),
    amountCents: Number(body.txnAmt || 0),
    status: String(body.respCode || '') === '00' ? 'SUCCESS' : 'FAIL',
    nonce: String(body.txnTime || ''),
    payload: body
  };
}

function selfTest() {
  const cfg = config();
  const message = `selftest=${Date.now()}`;
  const signature = signParams({ message });
  if (cfg.signMethod === '01') {
    const expected = crypto.createHash('md5').update(`message=${message}&${cfg.md5Key}`, 'utf8').digest('hex').toUpperCase();
    return expected === signature;
  }
  const key = privateKey();
  return crypto.verify('RSA-SHA256', Buffer.from(`message=${message}`, 'utf8'), crypto.createPublicKey(key), Buffer.from(signature, 'hex'));
}

module.exports = {
  code: 'unionpay',
  config,
  validateConfig,
  isConfigured,
  createOrder,
  queryOrder,
  refund,
  parseNotify,
  selfTest,
  signParams,
  verifyParams
};
