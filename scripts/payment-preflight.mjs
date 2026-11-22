#!/usr/bin/env node
/**
 * 生产支付切换预检
 *
 * 用法：
 *   node scripts/payment-preflight.mjs
 *   node scripts/payment-preflight.mjs --env-file=.env.production
 *   node scripts/payment-preflight.mjs --env-file=.env.production --remote
 *   node scripts/payment-preflight.mjs --json
 *
 * 检查项：
 *   1. 生产模式与资金安全闸门（NODE_ENV / PAYMENT_MODE / PAYMENT_LIVE_ENABLED）
 *   2. 各渠道必填参数与证书/私钥可读性
 *   3. 密钥配对与签名自检（微信、支付宝、银联）
 *   4. 回调地址格式、DNS 解析、公网可达性（--remote）
 *   5. 渠道网关连通性与本机时钟偏差（--remote）
 *
 * 退出码：0 = 全部通过（允许 WARN），1 = 存在 FAIL。
 */

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const remote = args.includes('--remote');
const envArg = args.find((item) => item.startsWith('--env-file='));
const envFile = envArg ? envArg.slice('--env-file='.length) : '';

function loadEnv(file) {
  if (!file) return false;
  const target = path.isAbsolute(file) ? file : path.join(root, file);
  if (!fs.existsSync(target)) return false;
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(target);
    return true;
  }
  for (const line of fs.readFileSync(target, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

const results = [];
function record(level, area, name, detail = '') {
  results.push({ level, area, name, detail });
}
const pass = (area, name, detail) => record('PASS', area, name, detail);
const warn = (area, name, detail) => record('WARN', area, name, detail);
const fail = (area, name, detail) => record('FAIL', area, name, detail);

function truthy(value) {
  return ['1', 'true', 'on', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const m = host.match(/^172\.(\d+)\./);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

async function checkCallback(area, urlText, expectedPath) {
  if (!urlText) return;
  let url;
  try {
    url = new URL(urlText);
  } catch {
    fail(area, '回调地址格式', `${urlText} 不是合法 URL`);
    return;
  }
  if (url.protocol !== 'https:') fail(area, '回调地址协议', '必须使用 HTTPS');
  else pass(area, '回调地址协议', 'HTTPS');
  if (isPrivateHost(url.hostname)) fail(area, '回调地址公网属性', `${url.hostname} 为内网/本地地址`);
  else pass(area, '回调地址公网属性', url.hostname);
  if (expectedPath && !url.pathname.startsWith(expectedPath)) fail(area, '回调路径', `应匹配 ${expectedPath}`);
  else pass(area, '回调路径', url.pathname);

  try {
    const addresses = await dns.lookup(url.hostname, { all: true });
    pass(area, '回调域名解析', addresses.map((item) => item.address).join(', '));
  } catch (err) {
    fail(area, '回调域名解析', err.message);
    return;
  }
  if (!remote) return;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(6000)
    });
    pass(area, '回调公网可达', `HTTP ${response.status}（空报文应被拒绝，能响应即证明链路可达）`);
    const date = response.headers.get('date');
    if (date) {
      const skew = Math.abs(Date.now() - new Date(date).getTime());
      if (skew > 5 * 60 * 1000) warn(area, '本机时钟偏差', `与服务器相差约 ${Math.round(skew / 1000)} 秒，微信签名要求 5 分钟内`);
      else pass(area, '本机时钟偏差', `${Math.round(skew / 1000)} 秒`);
    }
  } catch (err) {
    fail(area, '回调公网可达', err.message);
  }
}

async function main() {
  const loaded = loadEnv(envFile);
  if (envFile && !loaded) fail('环境文件', '加载配置', `未找到 ${envFile}`);
  else if (loaded) pass('环境文件', '加载配置', envFile);

  /* 1. 安全闸门 */
  if (String(process.env.NODE_ENV || '') !== 'production') fail('安全闸门', 'NODE_ENV', `当前为 ${process.env.NODE_ENV || '未设置'}，切换前必须为 production`);
  else pass('安全闸门', 'NODE_ENV', 'production');
  if (String(process.env.PAYMENT_MODE || '') !== 'live') fail('安全闸门', 'PAYMENT_MODE', '必须显式设置为 live');
  else pass('安全闸门', 'PAYMENT_MODE', 'live');
  if (!truthy(process.env.PAYMENT_LIVE_ENABLED)) fail('安全闸门', 'PAYMENT_LIVE_ENABLED', '必须显式设置为 true');
  else pass('安全闸门', 'PAYMENT_LIVE_ENABLED', 'true');
  if (String(process.env.PAYMENT_MODE || '') === 'live' && !truthy(process.env.PAYMENT_LIVE_ENABLED)) {
    warn('安全闸门', '回退保护', '总开关关闭时服务会拒绝收款，不会回退模拟支付');
  }

  const adapters = {
    wechat: require('../server/channels/wechat-pay'),
    alipay: require('../server/channels/alipay'),
    bankcard: require('../server/channels/unionpay')
  };
  const enabled = String(process.env.PAYMENT_CHANNELS || 'wechat,alipay,bankcard')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  let configuredCount = 0;
  for (const code of enabled) {
    const adapter = adapters[code];
    if (!adapter) {
      fail('渠道参数', code, '未知渠道编码');
      continue;
    }
    const result = adapter.validateConfig();
    if (result.missing.length) fail('渠道参数', code, `缺少 ${result.missing.join(', ')}`);
    for (const error of result.errors) fail('渠道参数', code, error);
    if (!result.ok) continue;
    configuredCount += 1;
    pass('渠道参数', code, '必填参数与文件校验通过');
    try {
      const ok = adapter.selfTest();
      if (ok) pass('签名自检', code, '密钥配对与签名/验签通过');
      else fail('签名自检', code, '签名自检失败，请核对私钥与证书是否匹配');
    } catch (err) {
      fail('签名自检', code, err.message);
    }
    const cfg = adapter.config();
    const notifyUrl = code === 'wechat' ? cfg.notifyUrl : (code === 'alipay' ? cfg.notifyUrl : cfg.backUrl);
    await checkCallback(code, notifyUrl, `/api/payments/callback/${code}`);
    if (remote) {
      const gatewayUrl = code === 'alipay' ? cfg.gateway : (code === 'bankcard' ? cfg.apiBase : cfg.apiBase);
      try {
        await fetch(gatewayUrl, { method: 'GET', signal: AbortSignal.timeout(6000) });
        pass('网关连通', code, gatewayUrl);
      } catch (err) {
        fail('网关连通', code, `${gatewayUrl} 不可达：${err.message}`);
      }
    }
  }
  if (configuredCount === 0) fail('渠道参数', '至少一个渠道', '没有任何渠道完成配置，生产环境将拒绝启动');

  /* 2. 输出 */
  const counts = results.reduce((acc, item) => {
    acc[item.level] = (acc[item.level] || 0) + 1;
    return acc;
  }, {});
  if (jsonOutput) {
    console.log(JSON.stringify({ ok: !counts.FAIL, counts, results }, null, 2));
  } else {
    const icons = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL' };
    console.log('\n生产支付切换预检\n');
    for (const item of results) {
      console.log(`  ${icons[item.level]}  [${item.area}] ${item.name}${item.detail ? ` · ${item.detail}` : ''}`);
    }
    console.log(`\n结果：${counts.PASS || 0} 通过，${counts.WARN || 0} 警告，${counts.FAIL || 0} 失败\n`);
  }
  process.exit(counts.FAIL ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
