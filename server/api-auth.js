'use strict';

const crypto = require('node:crypto');
const { get, run, all, now } = require('./db');
const { hashPassword, verifyPassword, signToken } = require('./auth');
const { sendJson, fail } = require('./http');
const runtime = require('./runtime-config');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^1[3-9]\d{9}$/;
const PHONE_EMAIL_DOMAIN = 'phone.xueya.local';
const PHONE_PURPOSES = new Set(['register', 'login', 'reset']);
const CODE_TTL = 5 * 60 * 1000;
const CODE_COOLDOWN = 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const RESET_TTL = 10 * 60 * 1000;
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_FAIL_WINDOW = 10 * 60 * 1000;
const loginFails = new Map();

function passwordProblem(password) {
  if (password.length < 8 || password.length > 72) return '密码需为 8—72 位';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return '密码需同时包含字母和数字';
  return '';
}

function normalizePhone(value) {
  return String(value || '').replace(/[\s-]/g, '');
}

function maskPhone(phone) {
  return String(phone || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
}

function isPhonePlaceholderEmail(email) {
  return String(email || '').endsWith(`@${PHONE_EMAIL_DOMAIN}`);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function codeHash(phone, purpose, code) {
  return sha256(`${phone}|${purpose}|${code}`);
}

function clientIp(ctx) {
  return String(ctx.req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function touchLogin(user, ip) {
  const previousIp = user.last_login_ip || '';
  let notice = '';
  if (previousIp && ip && previousIp !== ip) {
    notice = '本次登录来自新的网络环境，如非本人操作请及时修改密码';
  }
  run('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?', now(), ip, user.id);
  return notice;
}

/** 校验并消费短信验证码（一次性、5 分钟有效、最多尝试 5 次） */
function consumeCode(phone, purpose, code) {
  const value = String(code || '').trim();
  if (!/^\d{6}$/.test(value)) return { ok: false, message: '请输入 6 位数字验证码' };
  const row = get(
    'SELECT * FROM sms_codes WHERE phone = ? AND purpose = ? AND used = 0 ORDER BY id DESC LIMIT 1',
    phone, purpose
  );
  if (!row) return { ok: false, message: '请先获取验证码' };
  if (row.expires_at < Date.now()) return { ok: false, message: '验证码已过期，请重新获取' };
  if (row.attempts >= CODE_MAX_ATTEMPTS) return { ok: false, message: '验证码错误次数过多，请重新获取' };
  if (row.code_hash !== codeHash(phone, purpose, value)) {
    run('UPDATE sms_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    return { ok: false, message: '验证码不正确' };
  }
  run('UPDATE sms_codes SET used = 1 WHERE id = ?', row.id);
  return { ok: true };
}

setInterval(() => {
  const stamp = Date.now();
  for (const [key, entry] of loginFails) {
    if (entry.lockUntil && entry.lockUntil <= stamp && stamp - entry.firstAt > LOGIN_FAIL_WINDOW) loginFails.delete(key);
  }
}, 5 * 60 * 1000).unref();


function publicUser(row, includePrivate = false) {
  if (!row) return null;
  const data = {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    school: row.school,
    bio: row.bio,
    role: row.role,
    verified: row.role === 'admin' || row.verify_status === 'verified',
    createdAt: row.created_at
  };
  if (includePrivate) {
    data.email = isPhonePlaceholderEmail(row.email) ? '' : row.email;
    data.phone = row.phone || '';
    data.balance = row.balance_cents;
    data.status = row.status;
    data.realName = row.real_name || '';
    data.studentNo = row.student_no || '';
    data.schoolEmail = row.school_email || '';
    data.verifyMethod = row.verify_method || '';
    data.verifyStatus = row.verify_status || 'none';
    data.verifyNote = row.verify_note || '';
    data.verifiedAt = row.verified_at || null;
    data.unread = get(
      `SELECT COUNT(*) AS c FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.sender_id != ? AND m.read_at IS NULL AND (t.user_a = ? OR t.user_b = ?)`,
      row.id, row.id, row.id
    ).c;
    data.favorites = get('SELECT COUNT(*) AS c FROM favorites WHERE user_id = ?', row.id).c;
  }
  return data;
}

function register(ctx) {
  if (!runtime.registrationOpen()) return fail(ctx.res, 403, '注册暂未开放，请关注平台公告');
  const { body } = ctx;
  const username = String(body.username || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const nickname = String(body.nickname || '').trim() || username;
  const school = String(body.school || '').trim();

  if (username.length < 3 || username.length > 20) return fail(ctx.res, 400, '用户名需为 3—20 个字符');
  if (!EMAIL_RE.test(email)) return fail(ctx.res, 400, '请输入有效的邮箱地址');
  const weak = passwordProblem(password);
  if (weak) return fail(ctx.res, 400, weak);
  if (get('SELECT id FROM users WHERE email = ?', email)) return fail(ctx.res, 409, '该邮箱已注册');
  if (get('SELECT id FROM users WHERE username = ?', username)) return fail(ctx.res, 409, '该用户名已被占用');

  const invite = runtime.consumeInvite(body.inviteCode);
  if (!invite.ok) return fail(ctx.res, 400, invite.reason);

  const { hash, salt } = hashPassword(password);
  const info = run(
    `INSERT INTO users (username, email, password_hash, salt, nickname, school, bio, role, status, balance_cents, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '', 'user', 'active', 0, ?)`,
    username, email, hash, salt, nickname, school, now()
  );
  const user = get('SELECT * FROM users WHERE id = ?', Number(info.lastInsertRowid));
  sendJson(ctx.res, 201, { token: signToken(user.id), user: publicUser(user, true) });
}

function login(ctx) {
  const account = String(ctx.body.account || ctx.body.email || '').trim().toLowerCase();
  const password = String(ctx.body.password || '');
  if (!account || !password) return fail(ctx.res, 400, '请输入账号和密码');
  const user = get('SELECT * FROM users WHERE email = ? OR username = ?', account, account);
  if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
    return fail(ctx.res, 401, '账号或密码不正确');
  }
  if (user.status === 'banned') return fail(ctx.res, 403, '该账号已被限制使用，请联系平台管理员');
  if (user.role === 'admin') return fail(ctx.res, 403, '管理员账号请通过内部安全入口登录');
  const notice = touchLogin(user, clientIp(ctx));
  sendJson(ctx.res, 200, {
    token: signToken(user.id),
    user: publicUser(user, true),
    ...(notice ? { securityNotice: notice } : {})
  });
}

function smsSend(ctx) {
  const phone = normalizePhone(ctx.body.phone);
  const purpose = String(ctx.body.purpose || '').trim();
  if (!PHONE_RE.test(phone)) return fail(ctx.res, 400, '请输入有效的 11 位手机号');
  if (!PHONE_PURPOSES.has(purpose)) return fail(ctx.res, 400, '验证码用途不正确');
  const existing = get('SELECT id FROM users WHERE phone = ?', phone);
  if (purpose === 'register' && existing) return fail(ctx.res, 409, '该手机号已注册，请直接登录');
  if (purpose !== 'register' && !existing) return fail(ctx.res, 404, '该手机号尚未注册');

  const stamp = Date.now();
  const recent = get(
    'SELECT created_at FROM sms_codes WHERE phone = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
    phone, purpose
  );
  if (recent && stamp - recent.created_at < CODE_COOLDOWN) {
    const wait = Math.ceil((CODE_COOLDOWN - (stamp - recent.created_at)) / 1000);
    return fail(ctx.res, 429, `验证码发送过于频繁，请 ${wait} 秒后再试`);
  }
  const daily = get('SELECT COUNT(*) AS c FROM sms_codes WHERE phone = ? AND created_at > ?', phone, stamp - 24 * 3600 * 1000).c;
  if (daily >= 10) return fail(ctx.res, 429, '该手机号今日验证码发送次数已达上限，请明天再试');

  const code = String(crypto.randomInt(100000, 1000000));
  run(
    `INSERT INTO sms_codes (phone, purpose, code_hash, attempts, used, expires_at, created_at)
     VALUES (?, ?, ?, 0, 0, ?, ?)`,
    phone, purpose, codeHash(phone, purpose, code), stamp + CODE_TTL, stamp
  );
  run('DELETE FROM sms_codes WHERE phone = ? AND purpose = ? AND used = 1', phone, purpose);
  console.log(JSON.stringify({
    level: 'info', event: 'sms_code', phone: maskPhone(phone), purpose, time: new Date().toISOString()
  }));

  const payload = {
    message: '验证码已发送，5 分钟内有效',
    phone: maskPhone(phone),
    expiresIn: Math.round(CODE_TTL / 1000)
  };
  // 演示 / 开发环境没有真实短信通道，返回验证码便于联调；生产环境不返回
  if (!runtime.IS_PRODUCTION) payload.devCode = code;
  sendJson(ctx.res, 200, payload);
}

function phoneRegister(ctx) {
  if (!runtime.registrationOpen()) return fail(ctx.res, 403, '注册暂未开放，请关注平台公告');
  const phone = normalizePhone(ctx.body.phone);
  const password = String(ctx.body.password || '');
  if (!PHONE_RE.test(phone)) return fail(ctx.res, 400, '请输入有效的 11 位手机号');
  const weak = passwordProblem(password);
  if (weak) return fail(ctx.res, 400, weak);
  if (get('SELECT id FROM users WHERE phone = ?', phone)) return fail(ctx.res, 409, '该手机号已注册，请直接登录');

  const checked = consumeCode(phone, 'register', ctx.body.code);
  if (!checked.ok) return fail(ctx.res, 400, checked.message);

  const invite = runtime.consumeInvite(ctx.body.inviteCode);
  if (!invite.ok) return fail(ctx.res, 400, invite.reason);

  const nickname = String(ctx.body.nickname || '').trim().slice(0, 20) || `用户${phone.slice(-4)}`;
  let username = String(ctx.body.username || '').trim();
  if (username) {
    if (username.length < 3 || username.length > 20) return fail(ctx.res, 400, '用户名需为 3—20 个字符');
    if (get('SELECT id FROM users WHERE username = ?', username)) return fail(ctx.res, 409, '该用户名已被占用');
  } else {
    username = `u${phone}`;
    let index = 1;
    while (get('SELECT id FROM users WHERE username = ?', username)) {
      username = `u${phone.slice(-6)}${index++}`;
    }
  }

  const email = `p${phone}@${PHONE_EMAIL_DOMAIN}`;
  const school = String(ctx.body.school || '').trim();
  const { hash, salt } = hashPassword(password);
  const info = run(
    `INSERT INTO users (username, email, password_hash, salt, nickname, school, bio, role, status, balance_cents, phone, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '', 'user', 'active', 0, ?, ?)`,
    username, email, hash, salt, nickname, school, phone, now()
  );
  const user = get('SELECT * FROM users WHERE id = ?', Number(info.lastInsertRowid));
  touchLogin(user, clientIp(ctx));
  sendJson(ctx.res, 201, { token: signToken(user.id), user: publicUser(user, true) });
}

function phoneLogin(ctx) {
  const phone = normalizePhone(ctx.body.phone);
  const password = String(ctx.body.password || '');
  const code = String(ctx.body.code || '').trim();
  if (!PHONE_RE.test(phone)) return fail(ctx.res, 400, '请输入有效的 11 位手机号');
  if (!password && !code) return fail(ctx.res, 400, '请输入密码或验证码');

  const ip = clientIp(ctx);
  const key = `${ip}:${phone}`;
  const stamp = Date.now();
  const entry = loginFails.get(key);
  if (entry && entry.lockUntil > stamp) {
    const wait = Math.ceil((entry.lockUntil - stamp) / 60000);
    return fail(ctx.res, 429, `密码错误次数过多，账号已临时锁定，请 ${wait} 分钟后再试`);
  }

  const user = get('SELECT * FROM users WHERE phone = ?', phone);
  if (!user) return fail(ctx.res, 404, '该手机号尚未注册');
  if (user.status === 'banned') return fail(ctx.res, 403, '该账号已被限制使用，请联系平台管理员');
  if (user.role === 'admin') return fail(ctx.res, 403, '管理员账号请通过内部安全入口登录');

  if (code) {
    const checked = consumeCode(phone, 'login', code);
    if (!checked.ok) return fail(ctx.res, 401, checked.message);
  } else if (!verifyPassword(password, user.salt, user.password_hash)) {
    const next = (!entry || stamp - entry.firstAt > LOGIN_FAIL_WINDOW)
      ? { count: 0, firstAt: stamp, lockUntil: 0 }
      : entry;
    next.count += 1;
    if (next.count >= LOGIN_FAIL_LIMIT) next.lockUntil = stamp + LOGIN_FAIL_WINDOW;
    loginFails.set(key, next);
    if (next.lockUntil) return fail(ctx.res, 429, '密码错误次数过多，账号已临时锁定 10 分钟');
    return fail(ctx.res, 401, `密码不正确，还可尝试 ${LOGIN_FAIL_LIMIT - next.count} 次`);
  }

  loginFails.delete(key);
  const notice = touchLogin(user, ip);
  sendJson(ctx.res, 200, {
    token: signToken(user.id),
    user: publicUser(user, true),
    ...(notice ? { securityNotice: notice } : {})
  });
}

function passwordForgot(ctx) {
  const phone = normalizePhone(ctx.body.phone);
  if (!PHONE_RE.test(phone)) return fail(ctx.res, 400, '请输入有效的 11 位手机号');
  const user = get('SELECT * FROM users WHERE phone = ?', phone);
  if (!user) return fail(ctx.res, 404, '该手机号尚未注册');
  const checked = consumeCode(phone, 'reset', ctx.body.code);
  if (!checked.ok) return fail(ctx.res, 400, checked.message);

  const token = crypto.randomBytes(24).toString('hex');
  const stamp = Date.now();
  run('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0', user.id);
  run(
    'INSERT INTO password_resets (user_id, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)',
    user.id, sha256(token), stamp + RESET_TTL, stamp
  );
  sendJson(ctx.res, 200, {
    message: '手机号验证通过，请设置新密码',
    resetToken: token,
    phone: maskPhone(phone),
    expiresIn: Math.round(RESET_TTL / 1000)
  });
}

function passwordReset(ctx) {
  const token = String(ctx.body.resetToken || '').trim();
  const password = String(ctx.body.password || '');
  const confirm = String(ctx.body.confirmPassword ?? '');
  if (!token) return fail(ctx.res, 400, '重置凭证无效，请重新验证手机号');
  if (!confirm) return fail(ctx.res, 400, '请再次输入新密码');
  if (password !== confirm) return fail(ctx.res, 400, '两次输入的密码不一致');
  const weak = passwordProblem(password);
  if (weak) return fail(ctx.res, 400, weak);

  const row = get('SELECT * FROM password_resets WHERE token_hash = ?', sha256(token));
  if (!row || row.used) return fail(ctx.res, 400, '重置凭证已失效，请重新验证手机号');
  if (row.expires_at < Date.now()) return fail(ctx.res, 400, '重置凭证已过期，请重新验证手机号');
  const user = get('SELECT * FROM users WHERE id = ?', row.user_id);
  if (!user) return fail(ctx.res, 400, '账号不存在');
  if (verifyPassword(password, user.salt, user.password_hash)) return fail(ctx.res, 400, '新密码不能与原密码相同');

  const { hash, salt } = hashPassword(password);
  run('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', hash, salt, user.id);
  run('UPDATE password_resets SET used = 1 WHERE id = ?', row.id);
  loginFails.delete(`${clientIp(ctx)}:${user.phone}`);
  sendJson(ctx.res, 200, { message: '密码重置成功，请使用新密码登录' });
}

function me(ctx) {
  const row = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
  sendJson(ctx.res, 200, { user: publicUser(row, true) });
}

function updateMe(ctx) {
  const body = ctx.body;
  const nickname = String(body.nickname || '').trim();
  const school = ctx.user.verify_status === 'verified'
    ? ctx.user.school
    : String(body.school || '').trim();
  const bio = String(body.bio || '').trim();
  if (nickname && (nickname.length < 2 || nickname.length > 20)) return fail(ctx.res, 400, '昵称需为 2—20 个字符');
  if (bio.length > 200) return fail(ctx.res, 400, '个人简介不能超过 200 字');
  run(
    'UPDATE users SET nickname = COALESCE(NULLIF(?, \'\'), nickname), school = ?, bio = ? WHERE id = ?',
    nickname, school, bio, ctx.user.id
  );
  const row = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
  sendJson(ctx.res, 200, { user: publicUser(row, true) });
}

function changePassword(ctx) {
  if (ctx.user.role === 'admin') return fail(ctx.res, 403, '管理员请通过专属安全入口修改密码');
  const story = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
  if (!verifyPassword(String(ctx.body.oldPassword || ''), story.salt, story.password_hash)) {
    return fail(ctx.res, 400, '原密码不正确');
  }
  const next = String(ctx.body.newPassword || '');
  const weak = passwordProblem(next);
  if (weak) return fail(ctx.res, 400, weak);
  const { hash, salt } = hashPassword(next);
  run('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', hash, salt, ctx.user.id);
  sendJson(ctx.res, 200, { message: '密码已更新' });
}

function meta(ctx) {
  const announcements = all('SELECT * FROM announcements WHERE active = 1 ORDER BY created_at DESC LIMIT 5');
  const stats = {
    materials: get(`SELECT COUNT(*) AS c FROM materials WHERE status = 'approved'`).c,
    downloads: get('SELECT SUM(downloads) AS c FROM materials').c || 0,
    users: get('SELECT COUNT(*) AS c FROM users').c,
    schools: get('SELECT COUNT(*) AS c FROM schools').c,
    majors: get('SELECT COUNT(*) AS c FROM majors').c
  };
  const hot = all(
    `SELECT m.id, m.title, m.downloads FROM materials m WHERE m.status = 'approved' ORDER BY m.downloads DESC LIMIT 6`
  );
  const categoryStats = all(
    `SELECT category, COUNT(*) AS count FROM materials WHERE status = 'approved' GROUP BY category`
  );
  const schools = all(
    `SELECT school, COUNT(*) AS count FROM materials WHERE status = 'approved' AND school != '' GROUP BY school ORDER BY count DESC LIMIT 10`
  );
  const subjects = all(
    `SELECT subject, COUNT(*) AS count FROM materials WHERE status = 'approved' AND subject != '' GROUP BY subject ORDER BY count DESC LIMIT 30`
  );
  const teachers = all(
    `SELECT teacher, COUNT(*) AS count FROM materials WHERE status = 'approved' AND teacher != '' GROUP BY teacher ORDER BY count DESC LIMIT 30`
  );
  sendJson(ctx.res, 200, {
    categories: require('./db').CATEGORIES,
    subjects: require('./db').SUBJECTS,
    schools: require('./db').SCHOOLS,
    schoolStats: schools,
    subjectStats: subjects,
    teacherStats: teachers,
    categoryStats,
    announcements,
    stats,
    hot,
    support: {
      // 真实客服邮箱由部署方配置；未配置时前端回退到 site.js 的显式占位提示
      email: String(process.env.SUPPORT_EMAIL || '').trim(),
      ai: { available: runtime.feature('aiSupport'), hours: '7×24 小时', name: 'AI 智能客服' },
      human: { schedule: '暂未设置固定服务时间，后续将在公告中更新' },
      responseText: 'AI 客服实时响应 · 人工工单按序处理',
      faq: [
        { q: '如何获得买卖权限？', a: '在「个人中心 → 实名认证」中提交真实姓名、所在高校、学号与校园邮箱；演示环境通过邮箱验证码与学号唯一性校验后即时通过，正式环境由管理员人工审核。' },
        { q: '资料预览可以复制或下载吗？', a: '预览内容仅用于购买决策参考，系统已禁用复制、右键与下载，购买后可获得完整文件。' },
        { q: '推荐定价是如何计算的？', a: '平台根据院校公开资料与同类成交价建立官方价格标准库，上传时按院校、学科和类型自动匹配推荐价，卖家可在参考区间内调整。' },
        { q: '院校、学科和教师资源库怎么用？', a: '顶部导航进入「资源库」，三个模块各自支持关键词模糊搜索，结果实时返回，并可一键跳转资料市场查看对应资料。' },
        { q: 'AI 智能客服可以处理哪些问题？', a: 'AI 客服 7×24 小时在线，可解答认证、支付、下载、退款、上传审核、定价、砍价与资源库使用等问题；需要人工处理时可提交工单。' }
      ]
    },
    serviceFee: 0.1,
    environment: {
      production: runtime.IS_PRODUCTION,
      demo: runtime.SEED_DEMO,
      deployProfile: runtime.info().deployProfile,
      publicDemo: runtime.PUBLIC_DEMO,
      autoVerify: runtime.AUTO_VERIFY,
      paymentMode: require('./payment-gateway').mode(),
      registration: runtime.registrationOpen(),
      inviteRequired: runtime.inviteRequired(),
      features: runtime.publicFeatures()
    },
    settlement: {
      auto: true,
      cycle: 'T+1',
      feeRate: 0.1,
      note: '卖家成交收益扣除 10% 平台服务费后，按 T+1 自动结算至收款账户；平台不提供站内充值与提现。'
    }
  });
}

function sellerProfile(ctx) {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM users WHERE id = ?', id);
  if (!row) return fail(ctx.res, 404, '用户不存在');
  const materials = all(
    `SELECT * FROM materials WHERE seller_id = ? AND status = 'approved' ORDER BY downloads DESC LIMIT 12`, id
  );
  const stats = get(
    `SELECT COUNT(*) AS count, COALESCE(SUM(downloads),0) AS downloads, COALESCE(AVG(NULLIF(rating_avg,0)),0) AS rating
     FROM materials WHERE seller_id = ? AND status = 'approved'`, id
  );
  sendJson(ctx.res, 200, {
    seller: publicUser(row),
    materials: materials.map((m) => ({
      id: m.id, title: m.title, category: m.category, price: m.price_cents, downloads: m.downloads,
      rating: Math.round(m.rating_avg * 10) / 10, ratingCount: m.rating_count, school: m.school
    })),
    stats
  });
}

module.exports = {
  register, login, smsSend, phoneRegister, phoneLogin, passwordForgot, passwordReset,
  me, updateMe, changePassword, meta, sellerProfile, publicUser
};
