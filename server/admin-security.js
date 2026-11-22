'use strict';

/**
 * 管理员安全基础能力
 * - TOTP（RFC 6238）动态令牌
 * - 管理员密码策略与历史校验
 * - 设备/IP 指纹、风险事件、告警与审计写入
 *
 * 仅依赖 node:crypto；数据库在运行时延迟加载，避免与 db.js 形成循环依赖。
 */

const crypto = require('node:crypto');

const ADMIN_PASSWORD = 'XyOps@2026#Secure';
const ISSUER = '学涯集市';
const MFA_STEP = 30;
const MFA_DIGITS = 6;
const MFA_WINDOW = 1;
const FAIL_LIMIT = 5;
const MFA_FAIL_LIMIT = 3;
const LOCK_MS = 15 * 60 * 1000;
const PASSWORD_HISTORY = 5;
const PASSWORD_HISTORY_KEEP = 20;
const PASSWORD_MAX_AGE_DAYS = 90;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const WEAK_PASSWORDS = new Set([
  'admin123456', 'admin123456!', 'admin@123456', 'admin1234567', 'admin888888',
  'password', 'password123', 'password123!', 'passw0rd!', 'p@ssw0rd123',
  '123456789012', '12345678aA!', 'qwerty123456', 'qwertyuiop123', 'qwerty@123456',
  'abc123456789', 'letmein12345', 'welcome12345', 'iloveyou123', 'administrator',
  'adminadmin123', 'xueya123456', 'xueya@123456', 'xueyaadmin123', 'root12345678'
]);

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateMfaSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(binary % 10 ** MFA_DIGITS).padStart(MFA_DIGITS, '0');
}

function totpStep(timestamp = Date.now(), step = MFA_STEP) {
  return Math.floor(timestamp / 1000 / step);
}

function totp(secret, timestamp = Date.now(), step = MFA_STEP) {
  return hotp(secret, totpStep(timestamp, step));
}

function verifyTotp(secret, code, options = {}) {
  const value = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(value)) return { ok: false, step: 0 };
  const window = options.window === undefined ? MFA_WINDOW : Number(options.window);
  const step = options.step || MFA_STEP;
  const current = totpStep(options.timestamp || Date.now(), step);
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = current + offset;
    if (counter < 0) continue;
    const expected = hotp(secret, counter);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(value))) {
      return { ok: true, step: counter };
    }
  }
  return { ok: false, step: 0 };
}

function otpauthUrl({ account, secret, issuer = ISSUER }) {
  const label = encodeURIComponent(`${issuer}:${account || 'admin'}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${MFA_STEP}`;
}

function adminPasswordProblem(password, { username = '', email = '' } = {}) {
  const value = String(password || '');
  if (value.length < 12) return '管理员密码至少 12 位';
  if (value.length > 72) return '管理员密码不得超过 72 位';
  if (!/[a-z]/.test(value)) return '密码需包含小写字母';
  if (!/[A-Z]/.test(value)) return '密码需包含大写字母';
  if (!/\d/.test(value)) return '密码需包含数字';
  if (!/[^A-Za-z0-9]/.test(value)) return '密码需包含特殊符号';
  if (WEAK_PASSWORDS.has(value.toLowerCase())) return '该密码属于常见弱密码，请更换';
  if (/(.)\1{3,}/.test(value)) return '密码不能包含 4 个及以上连续重复字符';
  const lower = value.toLowerCase();
  const fragments = [username, String(email || '').split('@')[0]]
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((item) => item.length >= 3);
  if (fragments.some((item) => lower.includes(item))) return '密码不能包含账号或邮箱前缀';
  return '';
}

function passwordExpired(changedAt, nowMs = Date.now()) {
  if (!changedAt) return true;
  const stamp = Date.parse(String(changedAt).replace(' ', 'T'));
  if (!Number.isFinite(stamp)) return true;
  return nowMs - stamp > PASSWORD_MAX_AGE_DAYS * 24 * 3600 * 1000;
}

function passwordDaysLeft(changedAt) {
  if (!changedAt) return 0;
  const stamp = Date.parse(String(changedAt).replace(' ', 'T'));
  if (!Number.isFinite(stamp)) return 0;
  const ms = stamp + PASSWORD_MAX_AGE_DAYS * 24 * 3600 * 1000 - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 3600 * 1000)));
}

function isPasswordReused(adminId, password, current = null) {
  const { get, all } = require('./db');
  const { verifyPassword } = require('./auth');
  if (current && current.salt && current.password_hash
    && verifyPassword(password, current.salt, current.password_hash)) {
    return true;
  }
  const rows = all(
    'SELECT password_hash, salt FROM admin_password_history WHERE admin_id = ? ORDER BY id DESC LIMIT ?',
    adminId, PASSWORD_HISTORY
  );
  if (rows.some((row) => verifyPassword(password, row.salt, row.password_hash))) return true;
  const stored = get('SELECT password_hash, salt FROM users WHERE id = ?', adminId);
  return Boolean(stored && verifyPassword(password, stored.salt, stored.password_hash));
}

function ipPrefix(ip) {
  const value = String(ip || '').replace(/^::ffff:/, '').trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return `${value.split('.').slice(0, 3).join('.')}.0/24`;
  }
  if (value.includes(':')) {
    const head = value.split(':').filter(Boolean).slice(0, 3).join(':');
    return `${head}::/48`;
  }
  return value;
}

function deviceFingerprint(adminId, ua, ip) {
  return crypto.createHash('sha256')
    .update(`${adminId}|${String(ua || '').slice(0, 255)}|${ipPrefix(ip)}`)
    .digest('hex');
}

function truncate(value, max) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sanitizeDetail(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[省略]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeDetail(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (/password|passwd|secret|token|code/i.test(key)) {
        output[key] = '[已脱敏]';
      } else {
        output[key] = sanitizeDetail(item, depth + 1);
      }
    }
    return output;
  }
  if (typeof value === 'string') return truncate(value, 300);
  return value;
}

function recordEvent(adminId, type, { ip = '', ua = '', stage = '', detail = null } = {}) {
  try {
    const { run, now } = require('./db');
    run(
      `INSERT INTO admin_security_events (admin_id, type, stage, ip, ua, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      adminId || null, type, stage, String(ip || ''), truncate(ua, 255),
      detail ? truncate(JSON.stringify(sanitizeDetail(detail)), 2000) : '', now()
    );
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', scope: 'admin-security', event: 'recordEvent', message: err.message }));
  }
}

function notifyWebhook(payload) {
  const url = String(process.env.ADMIN_ALERT_WEBHOOK || '').trim();
  if (!url) return;
  if (typeof fetch !== 'function') return;
  const body = {
    source: 'xueya-market',
    time: new Date().toISOString(),
    ...payload
  };
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch((err) => {
    console.error(JSON.stringify({ level: 'warn', scope: 'admin-security', event: 'alert_webhook', message: err.message }));
  });
}

function raiseAlert(adminId, type, message, { level = 'warning', ip = '', ua = '', detail = null } = {}) {
  try {
    const { run, get, now } = require('./db');
    const info = run(
      `INSERT INTO admin_alerts (admin_id, type, level, message, ip, ua, detail, acknowledged, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      adminId || null, type, level, truncate(message, 300), String(ip || ''),
      truncate(ua, 255), detail ? truncate(JSON.stringify(sanitizeDetail(detail)), 2000) : '', now()
    );
    const row = get('SELECT * FROM admin_alerts WHERE id = ?', Number(info.lastInsertRowid));
    notifyWebhook(row);
    return row;
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', scope: 'admin-security', event: 'raiseAlert', message: err.message }));
    return null;
  }
}

function writeAudit(adminId, adminName, { method = '', path = '', status = 0, ip = '', ua = '', durationMs = 0, detail = null } = {}) {
  try {
    const { run, now } = require('./db');
    run(
      `INSERT INTO admin_audit_logs (admin_id, admin_name, method, path, status, ip, ua, duration_ms, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      adminId, String(adminName || ''), String(method || ''), truncate(path, 300), Number(status) || 0,
      String(ip || ''), truncate(ua, 255), Math.round(Number(durationMs) || 0),
      detail ? truncate(JSON.stringify(sanitizeDetail(detail)), 2000) : '', now()
    );
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', scope: 'admin-security', event: 'writeAudit', message: err.message }));
  }
}

module.exports = {
  ADMIN_PASSWORD,
  ISSUER,
  MFA_STEP,
  MFA_DIGITS,
  MFA_WINDOW,
  FAIL_LIMIT,
  MFA_FAIL_LIMIT,
  LOCK_MS,
  PASSWORD_HISTORY,
  PASSWORD_HISTORY_KEEP,
  PASSWORD_MAX_AGE_DAYS,
  base32Encode,
  base32Decode,
  generateMfaSecret,
  hotp,
  totp,
  totpStep,
  verifyTotp,
  otpauthUrl,
  adminPasswordProblem,
  passwordExpired,
  passwordDaysLeft,
  isPasswordReused,
  ipPrefix,
  deviceFingerprint,
  sanitizeDetail,
  recordEvent,
  raiseAlert,
  writeAudit
};
