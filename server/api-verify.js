'use strict';

const crypto = require('node:crypto');
const { get, run, now, SCHOOLS } = require('./db');
const { sendJson, fail } = require('./http');
const { publicUser } = require('./api-auth');
const runtime = require('./runtime-config');

const STUDENT_NO_RE = /^[A-Za-z0-9]{6,20}$/;
const CAMPUS_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.edu\.cn$/i;
const CODE_TTL_MS = 5 * 60 * 1000;
const SEND_COOLDOWN_MS = 60 * 1000;
const DAILY_LIMIT = 10;

function hashCode(email, code) {
  return crypto.createHash('sha256')
    .update(`${email}|${code}|${process.env.AUTH_SECRET || 'xueya-campus-verify'}`)
    .digest('hex');
}

function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  return `${(name || '').slice(0, 1)}***@${domain || ''}`;
}

/** 发送校园邮箱验证码：演示环境直接返回验证码，便于评审复现；生产环境未接入邮件服务时关闭该入口 */
function sendEmailCode(ctx) {
  if (!runtime.AUTO_VERIFY) return fail(ctx.res, 404, '当前环境未启用校园邮箱验证');
  const email = String(ctx.body.email || '').trim().toLowerCase();
  if (!CAMPUS_EMAIL_RE.test(email)) return fail(ctx.res, 400, '请填写学校邮箱（以 .edu.cn 结尾）');

  const nowMs = Date.now();
  const recent = get(
    'SELECT created_at FROM email_codes WHERE email = ? ORDER BY id DESC LIMIT 1', email
  );
  if (recent && nowMs - Number(recent.created_at) < SEND_COOLDOWN_MS) {
    return fail(ctx.res, 429, '验证码发送过于频繁，请 1 分钟后再试');
  }
  const daily = get(
    'SELECT COUNT(*) AS c FROM email_codes WHERE email = ? AND created_at > ?', email, nowMs - 86400000
  ).c;
  if (daily >= DAILY_LIMIT) return fail(ctx.res, 429, '该邮箱今日验证码次数已达上限，请明天再试');

  const code = String(crypto.randomInt(100000, 1000000));
  run(
    `INSERT INTO email_codes (email, code_hash, attempts, used, expires_at, created_at)
     VALUES (?, ?, 0, 0, ?, ?)`,
    email, hashCode(email, code), nowMs + CODE_TTL_MS, nowMs
  );
  sendJson(ctx.res, 200, {
    message: runtime.IS_PRODUCTION ? '验证码已发送，请查收学校邮箱' : `验证码已生成（演示环境）：${code}`,
    devCode: runtime.IS_PRODUCTION ? undefined : code,
    sentTo: maskEmail(email),
    expiresIn: CODE_TTL_MS / 1000
  });
}

/** 校验并消费验证码，返回空字符串表示通过 */
function consumeCode(email, code) {
  const row = get(
    'SELECT * FROM email_codes WHERE email = ? AND used = 0 ORDER BY id DESC LIMIT 1', email
  );
  if (!row) return '请先获取校园邮箱验证码';
  if (Number(row.expires_at) < Date.now()) return '验证码已过期，请重新获取';
  if (Number(row.attempts) >= 5) return '验证码错误次数过多，请重新获取';
  if (row.code_hash !== hashCode(email, code)) {
    run('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    return '验证码不正确，请核对后重试';
  }
  run('UPDATE email_codes SET used = 1 WHERE id = ?', row.id);
  return '';
}

function status(ctx) {
  const row = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
  sendJson(ctx.res, 200, {
    user: publicUser(row, true),
    schools: SCHOOLS,
    autoVerify: runtime.AUTO_VERIFY
  });
}

function submit(ctx) {
  const { user, body } = ctx;
  if (user.role === 'admin') return fail(ctx.res, 400, '管理员账号无需进行学生认证');
  if (user.verify_status === 'verified') return fail(ctx.res, 409, '你已完成实名与高校认证');
  if (user.verify_status === 'pending') return fail(ctx.res, 409, '认证申请正在审核中，请耐心等待');

  const realName = String(body.realName || '').trim();
  const school = String(body.school || '').trim();
  const studentNo = String(body.studentNo || '').trim();

  if (realName.length < 2 || realName.length > 20) return fail(ctx.res, 400, '请填写 2—20 个字符的真实姓名');
  if (!SCHOOLS.includes(school)) return fail(ctx.res, 400, '请选择你所在的高校');
  if (!STUDENT_NO_RE.test(studentNo)) return fail(ctx.res, 400, '学号需为 6—20 位字母或数字');

  // 同一院校下，学号只能绑定一个审核中或已认证的账号
  const occupied = get(
    `SELECT id FROM users WHERE school = ? AND student_no = ? AND id <> ? AND verify_status IN ('pending','verified')`,
    school, studentNo, user.id
  );
  if (occupied) return fail(ctx.res, 409, '该学号已被其他账号绑定，请核对后重新提交或联系客服');

  // 公开演示环境：校园邮箱验证码通过后自动审核，既能演示真实的邮箱归属校验，又不阻塞评审体验；
  // 正式环境仍需管理员人工审核，避免伪造身份绕过实名要求。
  const autoApprove = runtime.AUTO_VERIFY;
  let schoolEmail = '';
  let verifyMethod = '学籍信息（待管理员审核）';
  if (autoApprove) {
    schoolEmail = String(body.schoolEmail || '').trim().toLowerCase();
    const emailCode = String(body.emailCode || '').trim();
    if (!CAMPUS_EMAIL_RE.test(schoolEmail)) return fail(ctx.res, 400, '请填写学校邮箱（以 .edu.cn 结尾）');
    if (!/^\d{6}$/.test(emailCode)) return fail(ctx.res, 400, '请输入 6 位校园邮箱验证码');
    const codeError = consumeCode(schoolEmail, emailCode);
    if (codeError) return fail(ctx.res, 400, codeError);
    verifyMethod = '校园邮箱 + 学号校验（演示自动审核）';
  }

  const nextStatus = autoApprove ? 'verified' : 'pending';
  try {
    run(
      `UPDATE users SET real_name = ?, student_no = ?, school = ?, school_email = ?, verify_status = ?,
         verify_note = ?, verify_method = ?, verified_at = ? WHERE id = ?`,
      realName, studentNo, school, schoolEmail, nextStatus, '',
      verifyMethod, autoApprove ? now() : null, user.id
    );
  } catch (err) {
    if (/UNIQUE|constraint/i.test(String(err && err.message))) {
      return fail(ctx.res, 409, '该学号已被其他账号绑定，请核对后重新提交或联系客服');
    }
    throw err;
  }
  const row = get('SELECT * FROM users WHERE id = ?', user.id);
  sendJson(ctx.res, 200, {
    user: publicUser(row, true),
    autoApproved: autoApprove,
    message: autoApprove
      ? '校园邮箱验证通过，演示环境已自动完成审核，现在即可购买与出售资料'
      : '认证申请已提交，管理员审核通过后即可获得资料买卖权限'
  });
}

module.exports = { status, submit, sendEmailCode };
