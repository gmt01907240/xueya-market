'use strict';

/**
 * 运行时配置：环境模式、功能开关、内测邀请码、代理信任与后台来源限制。
 * 所有配置都通过环境变量注入，默认值保持开发/测试可用。
 */

const { run, now } = require('./db');
const net = require('node:net');

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

function envFlag(name, fallback = true) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

// 公开演示部署：非生产模式对外提供完整功能，支付保留模拟并明确标注。
// 通过 DEPLOY_PROFILE=public-demo 或 PUBLIC_DEMO=true 开启。
const DEPLOY_PROFILE = String(process.env.DEPLOY_PROFILE || '').trim().toLowerCase();
const PUBLIC_DEMO = DEPLOY_PROFILE === 'public-demo' || envFlag('PUBLIC_DEMO', false);
// 公开演示下默认自动通过实名认证，避免新用户注册后被人工审核阻塞完整交易链路。
const AUTO_VERIFY = envFlag('AUTO_VERIFY', PUBLIC_DEMO);

const FEATURES = {
  registration: envFlag('FEATURE_REGISTRATION'),
  upload: envFlag('FEATURE_UPLOAD'),
  payments: envFlag('FEATURE_PAYMENTS'),
  plan: envFlag('FEATURE_PLAN'),
  bargain: envFlag('FEATURE_BARGAIN'),
  aiSupport: envFlag('FEATURE_AI_SUPPORT'),
  tickets: envFlag('FEATURE_TICKETS')
};

const SEED_DEMO = process.env.SEED_DEMO === 'true'
  ? true
  : process.env.SEED_DEMO === 'false'
    ? false
    : !IS_PRODUCTION;

const TRUST_PROXY = envFlag('TRUST_PROXY', false);

function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '').trim();
}

/** IPv4/IPv6 地址转 BigInt，用于 CIDR 匹配 */
function ipToBigInt(ip) {
  const value = normalizeIp(ip);
  const version = net.isIP(value);
  if (version === 4) {
    return value.split('.').reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n);
  }
  if (version === 6) {
    const [head, tail] = value.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const missing = Math.max(0, 8 - headParts.length - tailParts.length);
    const groups = [...headParts, ...Array(missing).fill('0'), ...tailParts];
    return groups.reduce((acc, part) => (acc << 16n) + BigInt(parseInt(part || '0', 16)), 0n);
  }
  return null;
}

function parseAllowEntry(entry) {
  const raw = String(entry || '').trim();
  if (!raw) return null;
  const [address, bitsRaw] = raw.split('/');
  const ip = normalizeIp(address);
  const version = net.isIP(ip);
  if (!version) return null;
  const maxBits = version === 4 ? 32 : 128;
  const bits = bitsRaw === undefined || bitsRaw === '' ? maxBits : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) return null;
  const base = ipToBigInt(ip);
  if (base === null) return null;
  const shift = BigInt(maxBits - bits);
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << shift;
  return { version, network: base & mask, mask };
}

function ipInCidr(ip, rule) {
  const value = normalizeIp(ip);
  if (net.isIP(value) !== rule.version) return false;
  const target = ipToBigInt(value);
  return target !== null && (target & rule.mask) === rule.network;
}

const ADMIN_IPS = String(process.env.ADMIN_IP_ALLOWLIST || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

// 未配置白名单时仅放行本机与私网，避免后台暴露在公网
const DEFAULT_ADMIN_NETWORKS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::1/128',
  'fc00::/7'
];

const ADMIN_RULES = ADMIN_IPS.map(parseAllowEntry).filter(Boolean);
const DEFAULT_ADMIN_RULES = DEFAULT_ADMIN_NETWORKS.map(parseAllowEntry).filter(Boolean);

function parseInvites(raw) {
  return String(raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [code, max] = entry.split(':');
      const limit = Number(max);
      return {
        code: code.trim().toUpperCase(),
        max: Number.isInteger(limit) && limit > 0 ? limit : 1000
      };
    })
    .filter((item) => /^[A-Z0-9_-]{4,32}$/.test(item.code));
}

const INVITES = parseInvites(process.env.INVITE_CODES);

function features() {
  return { ...FEATURES };
}

function feature(name) {
  return FEATURES[name] !== false;
}

function publicFeatures() {
  return features();
}

function registrationOpen() {
  return feature('registration');
}

function inviteRequired() {
  return INVITES.length > 0;
}

function consumeInvite(code) {
  if (!inviteRequired()) return { ok: true, code: '' };
  const normalized = String(code || '').trim().toUpperCase();
  const entry = INVITES.find((item) => item.code === normalized);
  if (!entry) return { ok: false, reason: '邀请码无效，请联系内测管理员获取' };

  const stamp = now();
  const info = run(
    `INSERT INTO invite_usage (code, used, updated_at) VALUES (?, 1, ?)
     ON CONFLICT(code) DO UPDATE SET used = used + 1, updated_at = excluded.updated_at
     WHERE used < ?`,
    normalized, stamp, entry.max
  );
  if (!info.changes) return { ok: false, reason: '该邀请码使用次数已达上限' };
  return { ok: true, code: normalized };
}

function adminAllowed(ip) {
  const value = normalizeIp(ip);
  if (!net.isIP(value)) return false;
  const rules = ADMIN_RULES.length ? ADMIN_RULES : DEFAULT_ADMIN_RULES;
  return rules.some((rule) => ipInCidr(value, rule));
}

function info() {
  return {
    nodeEnv: NODE_ENV,
    production: IS_PRODUCTION,
    deployProfile: DEPLOY_PROFILE || (PUBLIC_DEMO ? 'public-demo' : ''),
    publicDemo: PUBLIC_DEMO,
    autoVerify: AUTO_VERIFY,
    seedDemo: SEED_DEMO,
    trustProxy: TRUST_PROXY,
    inviteRequired: inviteRequired(),
    adminAllowlist: ADMIN_IPS.length > 0,
    features: features()
  };
}

module.exports = {
  NODE_ENV,
  IS_PRODUCTION,
  DEPLOY_PROFILE,
  PUBLIC_DEMO,
  AUTO_VERIFY,
  SEED_DEMO,
  TRUST_PROXY,
  ADMIN_IPS,
  features,
  feature,
  publicFeatures,
  registrationOpen,
  inviteRequired,
  consumeInvite,
  adminAllowed,
  normalizeIp,
  info
};
