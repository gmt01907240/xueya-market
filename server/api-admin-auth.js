'use strict';

/**
 * 管理员专属认证接口
 * 密码阶段 → TOTP 二次验证 → 管理员 token（2 小时）
 * 以及密码修改、账号安全状态、安全事件/告警/审计查询。
 */

const { get, run, all, now } = require('./db');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./auth');
const { sendJson, fail } = require('./http');
const runtime = require('./runtime-config');
const rateLimit = require('./rate-limit');
const security = require('./admin-security');

const MFA_TOKEN_TTL = 5 * 60 * 1000;
const PWD_TOKEN_TTL = 10 * 60 * 1000;
const ADMIN_TOKEN_TTL = 2 * 3600 * 1000;

function requestIp(req) {
  return rateLimit.clientIp(req);
}

function requestUa(req) {
  return String(req.headers['user-agent'] || '').slice(0, 255);
}

function publicAdmin(user) {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    email: user.email,
    role: user.role
  };
}

function lockRemaining(user) {
  const until = Number((user && user.admin_lock_until) || 0);
  return until > Date.now() ? until - Date.now() : 0;
}

function lockedResponse(res, remainingMs) {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return sendJson(res, 423, {
    error: `账号已临时锁定，请 ${Math.ceil(seconds / 60)} 分钟后再试`,
    retryAfter: seconds,
    locked: true
  });
}

function lockAccount(user, ip, ua, reason) {
  const until = Date.now() + security.LOCK_MS;
  run('UPDATE users SET admin_lock_until = ? WHERE id = ?', until, user.id);
  security.recordEvent(user.id, 'account_locked', { ip, ua, detail: { reason } });
  security.raiseAlert(user.id, 'account_locked', `管理员账号因${reason}被临时锁定 15 分钟`, {
    level: 'critical', ip, ua, detail: { reason }
  });
  return until - Date.now();
}

function authenticate(req, scopes) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || !scopes.includes(payload.adm)) return null;
  const user = get('SELECT * FROM users WHERE id = ?', payload.uid);
  if (!user || user.role !== 'admin' || user.status !== 'active') return null;
  if (Number(payload.v || 0) !== Number(user.token_version || 0)) return null;
  return { user, payload };
}

function pageParams(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function parseDetail(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return String(text);
  }
}

function login(ctx) {
  const ip = requestIp(ctx.req);
  const ua = requestUa(ctx.req);
  if (!runtime.adminAllowed(ip)) {
    security.recordEvent(null, 'login_blocked_ip', { ip, ua });
    return fail(ctx.res, 403, '当前网络不允许访问管理员登录');
  }
  const account = String(ctx.body.account || '').trim().toLowerCase();
  const password = String(ctx.body.password || '');
  if (!account || !password) return fail(ctx.res, 400, '请输入管理员账号和密码');

  const user = get(
    "SELECT * FROM users WHERE role = 'admin' AND (email = ? OR username = ?) ORDER BY id LIMIT 1",
    account, account
  );
  const remaining = lockRemaining(user);
  if (remaining > 0) return lockedResponse(ctx.res, remaining);

  if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
    if (user) {
      const count = Number(user.admin_fail_count || 0) + 1;
      if (count >= security.FAIL_LIMIT) {
        run('UPDATE users SET admin_fail_count = ? WHERE id = ?', count, user.id);
        const wait = lockAccount(user, ip, ua, '连续密码错误');
        security.recordEvent(user.id, 'login_locked', { ip, ua, detail: { count } });
        return lockedResponse(ctx.res, wait);
      }
      run('UPDATE users SET admin_fail_count = ? WHERE id = ?', count, user.id);
      security.recordEvent(user.id, 'login_failed', { ip, ua, detail: { count } });
    } else {
      security.recordEvent(null, 'login_failed_unknown', { ip, ua, detail: { account } });
    }
    return fail(ctx.res, 401, '账号或密码不正确');
  }

  if (user.status !== 'active') return fail(ctx.res, 403, '该管理员账号已被停用');

  run('UPDATE users SET admin_fail_count = 0, admin_lock_until = 0 WHERE id = ?', user.id);

  // 风险识别：新设备 / 新网络段（MFA 仍必须完成）
  const prefix = security.ipPrefix(ip);
  const fingerprint = security.deviceFingerprint(user.id, ua, ip);
  const knownDevice = get('SELECT id FROM admin_devices WHERE admin_id = ? AND fingerprint = ?', user.id, fingerprint);
  const knownNetwork = get('SELECT id FROM admin_devices WHERE admin_id = ? AND ip_prefix = ?', user.id, prefix);
  if (!knownDevice) {
    security.recordEvent(user.id, 'new_device', { ip, ua, detail: { prefix } });
    security.raiseAlert(user.id, 'new_device', '检测到管理员账号从新设备登录', {
      level: 'warning', ip, ua, detail: { prefix, ua }
    });
  }
  if (!knownNetwork) {
    security.recordEvent(user.id, 'new_network', { ip, ua, detail: { prefix } });
    security.raiseAlert(user.id, 'new_network', '检测到管理员账号从新的网络段登录', {
      level: 'warning', ip, ua, detail: { prefix }
    });
  }

  let secret = String(user.admin_mfa_secret || '').trim();
  let enroll = false;
  if (!secret) {
    const preset = String(process.env.ADMIN_MFA_SECRET || '').trim();
    // 生产环境必须预置密钥，避免首次登录者自行绑定 TOTP 绕过既定的双因素策略
    if (!preset && runtime.IS_PRODUCTION) {
      return fail(ctx.res, 500, '管理员 MFA 密钥未预置，请配置 ADMIN_MFA_SECRET 后重试');
    }
    secret = preset || security.generateMfaSecret();
    run('UPDATE users SET admin_mfa_secret = ? WHERE id = ?', secret, user.id);
    enroll = !user.admin_mfa_enabled_at;
  }

  security.recordEvent(user.id, 'password_verified', { ip, ua, stage: enroll ? 'enroll' : 'mfa' });
  const mfaToken = signToken({ uid: user.id, adm: 'mfa', v: user.token_version || 0 }, MFA_TOKEN_TTL);
  const payload = {
    stage: enroll ? 'enroll' : 'mfa',
    mfaToken,
    expiresIn: Math.round(MFA_TOKEN_TTL / 1000)
  };
  if (enroll) {
    payload.secret = secret;
    payload.otpauth = security.otpauthUrl({ account: user.email, secret });
  }
  return sendJson(ctx.res, 200, payload);
}

function mfa(ctx) {
  const ip = requestIp(ctx.req);
  const ua = requestUa(ctx.req);
  if (!runtime.adminAllowed(ip)) {
    security.recordEvent(null, 'mfa_blocked_ip', { ip, ua });
    return fail(ctx.res, 403, '当前网络不允许访问管理员登录');
  }
  const payload = verifyToken(String(ctx.body.mfaToken || ''));
  if (!payload || payload.adm !== 'mfa') return fail(ctx.res, 401, '验证会话已失效，请重新登录');
  const user = get('SELECT * FROM users WHERE id = ?', payload.uid);
  if (!user || user.role !== 'admin' || Number(payload.v || 0) !== Number(user.token_version || 0)) {
    return fail(ctx.res, 401, '验证会话已失效，请重新登录');
  }
  const remaining = lockRemaining(user);
  if (remaining > 0) return lockedResponse(ctx.res, remaining);

  const secret = String(user.admin_mfa_secret || '').trim();
  if (!secret) return fail(ctx.res, 401, '动态令牌尚未绑定，请重新登录');

  const checked = security.verifyTotp(secret, ctx.body.code, { window: security.MFA_WINDOW });
  if (!checked.ok) {
    const count = Number(user.admin_mfa_fail_count || 0) + 1;
    if (count >= security.MFA_FAIL_LIMIT) {
      run('UPDATE users SET admin_mfa_fail_count = ? WHERE id = ?', count, user.id);
      const wait = lockAccount(user, ip, ua, '动态验证码连续错误');
      security.recordEvent(user.id, 'mfa_locked', { ip, ua, detail: { count } });
      return lockedResponse(ctx.res, wait);
    }
    run('UPDATE users SET admin_mfa_fail_count = ? WHERE id = ?', count, user.id);
    security.recordEvent(user.id, 'mfa_failed', { ip, ua, detail: { count } });
    return fail(ctx.res, 401, '动态验证码不正确');
  }
  if (checked.step <= Number(user.admin_mfa_last_step || 0)) {
    security.recordEvent(user.id, 'mfa_replay_blocked', { ip, ua, detail: { step: checked.step } });
    return fail(ctx.res, 401, '该动态验证码已使用，请等待下一组');
  }

  run(
    `UPDATE users SET admin_mfa_fail_count = 0, admin_fail_count = 0, admin_lock_until = 0,
       admin_mfa_last_step = ?, admin_mfa_enabled_at = COALESCE(admin_mfa_enabled_at, ?) WHERE id = ?`,
    checked.step, now(), user.id
  );

  const prefix = security.ipPrefix(ip);
  const fingerprint = security.deviceFingerprint(user.id, ua, ip);
  const device = get('SELECT id FROM admin_devices WHERE admin_id = ? AND fingerprint = ?', user.id, fingerprint);
  if (device) {
    run('UPDATE admin_devices SET last_seen = ?, ip = ?, ip_prefix = ? WHERE id = ?', now(), ip, prefix, device.id);
  } else {
    run(
      `INSERT INTO admin_devices (admin_id, fingerprint, ua, ip, ip_prefix, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      user.id, fingerprint, ua, ip, prefix, now(), now()
    );
  }
  run('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?', now(), ip, user.id);
  security.recordEvent(user.id, 'login_success', { ip, ua, stage: 'mfa' });

  if (security.passwordExpired(user.admin_password_changed_at)) {
    const token = signToken({ uid: user.id, adm: 'pwd', v: user.token_version || 0 }, PWD_TOKEN_TTL);
    security.recordEvent(user.id, 'password_expired', { ip, ua });
    return sendJson(ctx.res, 200, {
      stage: 'password_expired',
      token,
      expiresIn: Math.round(PWD_TOKEN_TTL / 1000),
      message: '管理员密码已超过 90 天有效期，请先修改密码'
    });
  }

  const token = signToken({ uid: user.id, adm: 1, v: user.token_version || 0 }, ADMIN_TOKEN_TTL);
  return sendJson(ctx.res, 200, {
    stage: 'ok',
    token,
    expiresIn: Math.round(ADMIN_TOKEN_TTL / 1000),
    user: publicAdmin(user)
  });
}

function changePassword(ctx) {
  const ip = requestIp(ctx.req);
  const ua = requestUa(ctx.req);
  if (!runtime.adminAllowed(ip)) return fail(ctx.res, 403, '当前网络不允许修改管理员密码');
  const auth = authenticate(ctx.req, ['pwd', 1]);
  if (!auth) return fail(ctx.res, 401, '请先通过管理员认证');
  const { user } = auth;

  const oldPassword = String(ctx.body.oldPassword || '');
  const newPassword = String(ctx.body.newPassword || '');
  const code = String(ctx.body.code || '');
  if (!oldPassword || !newPassword || !code) return fail(ctx.res, 400, '请填写原密码、新密码与动态验证码');
  if (!verifyPassword(oldPassword, user.salt, user.password_hash)) {
    security.recordEvent(user.id, 'password_change_failed', { ip, ua, detail: { reason: 'old_password' } });
    return fail(ctx.res, 400, '原密码不正确');
  }
  const checked = security.verifyTotp(user.admin_mfa_secret, code, { window: security.MFA_WINDOW });
  if (!checked.ok) {
    security.recordEvent(user.id, 'password_change_failed', { ip, ua, detail: { reason: 'mfa' } });
    return fail(ctx.res, 400, '动态验证码不正确');
  }
  const problem = security.adminPasswordProblem(newPassword, { username: user.username, email: user.email });
  if (problem) return fail(ctx.res, 400, problem);
  if (security.isPasswordReused(user.id, newPassword, user)) {
    return fail(ctx.res, 400, '新密码不能与当前密码或最近使用的密码相同');
  }

  const { hash, salt } = hashPassword(newPassword);
  run(
    `UPDATE users SET password_hash = ?, salt = ?, admin_password_changed_at = ?,
       token_version = token_version + 1, admin_fail_count = 0, admin_mfa_fail_count = 0, admin_lock_until = 0
     WHERE id = ?`,
    hash, salt, now(), user.id
  );
  run(
    'INSERT INTO admin_password_history (admin_id, password_hash, salt, created_at) VALUES (?, ?, ?, ?)',
    user.id, hash, salt, now()
  );
  run(
    `DELETE FROM admin_password_history WHERE admin_id = ? AND id NOT IN
       (SELECT id FROM admin_password_history WHERE admin_id = ? ORDER BY id DESC LIMIT ?)`,
    user.id, user.id, security.PASSWORD_HISTORY_KEEP
  );
  security.recordEvent(user.id, 'password_changed', { ip, ua });
  return sendJson(ctx.res, 200, {
    message: '管理员密码已更新，请使用新密码重新登录',
    relogin: true
  });
}

function status(ctx) {
  const auth = authenticate(ctx.req, [1]);
  if (!auth) return fail(ctx.res, 401, '请先通过管理员认证');
  const { user } = auth;
  const deviceCount = get('SELECT COUNT(*) AS c FROM admin_devices WHERE admin_id = ?', user.id).c;
  return sendJson(ctx.res, 200, {
    admin: publicAdmin(user),
    mfaEnabled: Boolean(user.admin_mfa_secret && user.admin_mfa_enabled_at),
    mfaBoundAt: user.admin_mfa_enabled_at || null,
    passwordChangedAt: user.admin_password_changed_at || null,
    passwordExpiresInDays: security.passwordDaysLeft(user.admin_password_changed_at),
    passwordExpired: security.passwordExpired(user.admin_password_changed_at),
    locked: lockRemaining(user) > 0,
    lockUntil: Number(user.admin_lock_until || 0) || null,
    knownDevices: deviceCount,
    lastLoginAt: user.last_login_at || null,
    lastLoginIp: user.last_login_ip || ''
  });
}

function securityOverview(ctx) {
  const auth = authenticate(ctx.req, [1]);
  if (!auth) return fail(ctx.res, 401, '请先通过管理员认证');
  const { user } = auth;
  const today = now().slice(0, 10);
  const recentAlerts = all('SELECT * FROM admin_alerts ORDER BY id DESC LIMIT 5').map((row) => ({
    ...row, detail: parseDetail(row.detail)
  }));
  const recentEvents = all('SELECT * FROM admin_security_events ORDER BY id DESC LIMIT 8').map((row) => ({
    ...row, detail: parseDetail(row.detail)
  }));
  return sendJson(ctx.res, 200, {
    admin: publicAdmin(user),
    mfaEnabled: Boolean(user.admin_mfa_secret && user.admin_mfa_enabled_at),
    passwordChangedAt: user.admin_password_changed_at || null,
    passwordExpiresInDays: security.passwordDaysLeft(user.admin_password_changed_at),
    passwordExpired: security.passwordExpired(user.admin_password_changed_at),
    counts: {
      alerts: get('SELECT COUNT(*) AS c FROM admin_alerts').c,
      openAlerts: get('SELECT COUNT(*) AS c FROM admin_alerts WHERE acknowledged = 0').c,
      events: get('SELECT COUNT(*) AS c FROM admin_security_events').c,
      eventsToday: get('SELECT COUNT(*) AS c FROM admin_security_events WHERE created_at LIKE ?', `${today}%`).c,
      audit: get('SELECT COUNT(*) AS c FROM admin_audit_logs').c,
      auditToday: get('SELECT COUNT(*) AS c FROM admin_audit_logs WHERE created_at LIKE ?', `${today}%`).c
    },
    recentAlerts,
    recentEvents
  });
}

function listEvents(ctx) {
  const auth = authenticate(ctx.req, [1]);
  if (!auth) return fail(ctx.res, 401, '请先通过管理员认证');
  const { page, pageSize, offset } = pageParams(ctx.query);
  const total = get('SELECT COUNT(*) AS c FROM admin_security_events').c;
  const items = all(
    'SELECT * FROM admin_security_events ORDER BY id DESC LIMIT ? OFFSET ?',
    pageSize, offset
  ).map((row) => ({ ...row, detail: parseDetail(row.detail) }));
  return sendJson(ctx.res, 200, { items, total, page, pageSize });
}

function listAlerts(ctx) {
  const auth = authenticate(ctx.req, [1]);
  if (!auth) return fail(ctx.res, 401, '请先通过管理员认证');
  const { page, pageSize, offset } = pageParams(ctx.query);
  const onlyOpen = String(ctx.query.status || '') === 'open';
  const where = onlyOpen ? 'WHERE acknowledged = 0' : '';
  const total = get(`SELECT COUNT(*) AS c FROM admin_alerts ${where}`).c;
  const items = all(
    `SELECT * FROM admin_alerts ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    pageSize, offset
  ).map((row) => ({ ...row, detail: parseDetail(row.detail) }));
  return sendJson(ctx.res, 200, { items, total, page, pageSize });
}

function acknowledgeAlert(ctx) {
  const auth = authenticate(ctx.req, [1]);
  if (!auth) return fail(ctx.res, 401, '请先通过管理员认证');
  const id = Number(ctx.params.id);
  const row = get('SELECT id FROM admin_alerts WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '告警不存在');
  run('UPDATE admin_alerts SET acknowledged = 1 WHERE id = ?', id);
  security.recordEvent(auth.user.id, 'alert_acknowledged', {
    ip: requestIp(ctx.req), ua: requestUa(ctx.req), detail: { alertId: id }
  });
  return sendJson(ctx.res, 200, { message: '告警已确认' });
}

function listAudit(ctx) {
  const auth = authenticate(ctx.req, [1]);
  if (!auth) return fail(ctx.res, 401, '请先通过管理员认证');
  const { page, pageSize, offset } = pageParams(ctx.query);
  const total = get('SELECT COUNT(*) AS c FROM admin_audit_logs').c;
  const items = all(
    'SELECT * FROM admin_audit_logs ORDER BY id DESC LIMIT ? OFFSET ?',
    pageSize, offset
  ).map((row) => ({ ...row, detail: parseDetail(row.detail) }));
  return sendJson(ctx.res, 200, { items, total, page, pageSize });
}

module.exports = {
  login,
  mfa,
  changePassword,
  status,
  securityOverview,
  listEvents,
  listAlerts,
  acknowledgeAlert,
  listAudit
};
