'use strict';

/**
 * 真实支付渠道注册表
 *
 * 内部渠道编码保持与历史数据一致：
 *   wechat   → 微信支付 APIv3
 *   alipay   → 支付宝开放平台
 *   bankcard → 银联全渠道（生产模式为银联二维码；演示模式仍为转账人工确认）
 */

const wechat = require('./wechat-pay');
const alipay = require('./alipay');
const unionpay = require('./unionpay');

const ADAPTERS = {
  wechat,
  alipay,
  bankcard: unionpay
};

function get(code) {
  return ADAPTERS[code] || null;
}

function status() {
  return Object.keys(ADAPTERS).map((code) => {
    const adapter = ADAPTERS[code];
    const result = adapter.validateConfig();
    return { channel: code, adapter: adapter.code, ok: result.ok, missing: result.missing, errors: result.errors };
  });
}

function notConfigured(code) {
  return Object.assign(new Error(`渠道 ${code} 未完成生产参数配置`), { code: 'CHANNEL_NOT_CONFIGURED' });
}

async function createOrder(code, options) {
  const adapter = get(code);
  if (!adapter || !adapter.isConfigured()) throw notConfigured(code);
  return adapter.createOrder(options);
}

async function queryOrder(code, ...args) {
  const adapter = get(code);
  if (!adapter || !adapter.isConfigured()) throw notConfigured(code);
  return adapter.queryOrder(...args);
}

async function closeOrder(code, ...args) {
  const adapter = get(code);
  if (!adapter || !adapter.isConfigured()) throw notConfigured(code);
  return adapter.closeOrder(...args);
}

async function refund(code, ...args) {
  const adapter = get(code);
  if (!adapter || !adapter.isConfigured()) throw notConfigured(code);
  return adapter.refund(...args);
}

function parseNotify(code, ctx) {
  const adapter = get(code);
  if (!adapter || !adapter.isConfigured()) return { ok: false, code: 'CHANNEL_NOT_CONFIGURED', message: `渠道 ${code} 未完成生产参数配置` };
  return adapter.parseNotify(ctx);
}

module.exports = { get, status, createOrder, queryOrder, closeOrder, refund, parseNotify, ADAPTERS };
