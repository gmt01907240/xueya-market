import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const ADMIN_PASSWORD = process.env.ADMIN_TEST_PASSWORD || 'XyOps@2026#Secure';
export const ADMIN_MFA_SECRET = process.env.ADMIN_MFA_SECRET || 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = B32.indexOf(char);
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

export function totp(secret, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(binary % 1000000).padStart(6, '0');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function postJson(base, path, body, token, ua = 'xueya-admin-test/1.0') {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': ua };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

export async function getJson(base, path, token, ua = 'xueya-admin-test/1.0') {
  const headers = { 'User-Agent': ua };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { headers });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * 走完整的“密码 + TOTP”管理员登录流程。
 * codeOffset 用于换一个时间步的动态码，避免同一步被重放保护拦截。
 */
export async function adminLogin(base, options = {}) {
  const {
    account = 'admin@xueya.cn',
    password = ADMIN_PASSWORD,
    secret = ADMIN_MFA_SECRET,
    codeOffset = 0,
    ua = 'xueya-admin-test/1.0'
  } = options;

  const login = await postJson(base, '/api/admin/auth/login', { account, password }, null, ua);
  if (!login.ok) {
    return { ok: false, stage: 'login', status: login.status, data: login.data };
  }
  let activeSecret = secret;
  let code;
  if (login.data.stage === 'enroll') {
    activeSecret = login.data.secret || secret;
    code = totp(activeSecret);
  } else {
    code = totp(activeSecret, Date.now() + codeOffset * 30000);
  }
  let mfa = await postJson(base, '/api/admin/auth/mfa', { mfaToken: login.data.mfaToken, code }, null, ua);
  // 共享服务场景下同一步长可能已被其他测试使用，等下一个时间窗口再取新码重试。
  if (!mfa.ok && mfa.status === 401 && /已使用/.test(String(mfa.data?.error || ''))) {
    await sleep(60000 - (Date.now() % 30000) + 300);
    mfa = await postJson(
      base, '/api/admin/auth/mfa',
      { mfaToken: login.data.mfaToken, code: totp(activeSecret) },
      null, ua
    );
  }
  if (!mfa.ok) {
    return { ok: false, stage: 'mfa', status: mfa.status, data: mfa.data };
  }
  return {
    ok: true,
    stage: mfa.data.stage,
    token: mfa.data.token,
    user: mfa.data.user,
    secret: activeSecret,
    data: mfa.data
  };
}
