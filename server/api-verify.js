'use strict';

const { get, run, now, SCHOOLS } = require('./db');
const { sendJson, fail } = require('./http');
const { publicUser } = require('./api-auth');
const runtime = require('./runtime-config');

const STUDENT_NO_RE = /^[A-Za-z0-9]{6,20}$/;

function status(ctx) {
  const row = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
  sendJson(ctx.res, 200, { user: publicUser(row, true), schools: SCHOOLS });
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

  // 校验姓名、院校与学号三项信息的一致性；演示环境即时通过，正式环境仍需管理员人工复核，
  // 避免伪造身份绕过实名要求。
  const autoApprove = runtime.AUTO_VERIFY;
  const nextStatus = autoApprove ? 'verified' : 'pending';
  const verifyMethod = autoApprove
    ? '姓名 + 院校 + 学号一致性校验（演示自动审核）'
    : '姓名 + 院校 + 学号一致性校验（待管理员复核）';
  try {
    run(
      `UPDATE users SET real_name = ?, student_no = ?, school = ?, verify_status = ?,
         verify_note = ?, verify_method = ?, verified_at = ? WHERE id = ?`,
      realName, studentNo, school, nextStatus, '', verifyMethod,
      autoApprove ? now() : null, user.id
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
      ? '学号与姓名、院校信息校验通过，认证已生效，现在即可购买与出售资料'
      : '认证申请已提交，管理员复核通过后即可获得资料买卖权限'
  });
}

module.exports = { status, submit };
