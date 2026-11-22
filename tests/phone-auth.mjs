/**
 * 学涯集市 · 手机号注册 / 登录 / 忘记密码 全链路测试
 *
 * 覆盖：验证码发送与校验、手机号注册、手机号+密码/验证码登录、
 *       登录失败锁定、忘记密码与重置（重复密码、两次不一致、凭证复用）、
 *       参数校验与防刷，以及原有邮箱登录兼容性。
 *
 * 运行：npm run test:phone
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PHONE_TEST_PORT || 3406);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-phone-'));

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function request(url, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, data };
}

async function waitForServer(child, output) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`服务启动失败，退出码 ${child.exitCode}\n${output()}`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`服务启动超时：${BASE}\n${output()}`);
}

function randomPhone() {
  const second = String.fromCharCode(51 + Math.floor(Math.random() * 7));
  const tail = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
  return `1${second}${tail}`;
}

async function sendCode(phone, purpose) {
  return request('/api/auth/sms/send', { method: 'POST', body: { phone, purpose } });
}

const capture = { out: '', err: '' };
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR, SEED_DEMO: 'true' },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (b) => { capture.out += b.toString(); });
child.stderr.on('data', (b) => { capture.err += b.toString(); });
const output = () => `--- stdout ---\n${capture.out}\n--- stderr ---\n${capture.err}`;

function cleanup() {
  if (child.exitCode === null) child.kill('SIGTERM');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

try {
  await waitForServer(child, output);

  const phone = randomPhone();
  const phone2 = randomPhone();
  const password = 'Phone123456';
  const newPassword = 'Phone654321';

  /* ---- 验证码发送与参数校验 ---- */
  const badPhone = await sendCode('12345', 'register');
  check('非法手机号发送验证码被拒绝（400）', badPhone.status === 400, `status=${badPhone.status}`);
  const badPurpose = await sendCode(phone, 'unknown');
  check('非法验证码用途被拒绝（400）', badPurpose.status === 400, `status=${badPurpose.status}`);
  const unknownPhone = await sendCode(phone, 'reset');
  check('未注册手机号请求重置验证码返回 404', unknownPhone.status === 404, `status=${unknownPhone.status}`);

  const regCode = await sendCode(phone, 'register');
  check('注册验证码发送成功', regCode.status === 200 && /^\d{6}$/.test(String(regCode.data?.devCode || '')), `status=${regCode.status}`);
  const cooldown = await sendCode(phone, 'register');
  check('60 秒内重复发送被限流（429）', cooldown.status === 429, `status=${cooldown.status}`);

  /* ---- 手机号注册 ---- */
  const wrongCodeReg = await request('/api/auth/register/phone', {
    method: 'POST',
    body: { phone, code: '000000', password }
  });
  check('错误验证码注册被拒绝（400）', wrongCodeReg.status === 400, `status=${wrongCodeReg.status}`);

  const weak = await request('/api/auth/register/phone', {
    method: 'POST',
    body: { phone, code: regCode.data?.devCode, password: '12345678' }
  });
  check('纯数字弱密码注册被拒绝（400）', weak.status === 400, `status=${weak.status}`);

  const reg = await request('/api/auth/register/phone', {
    method: 'POST',
    body: { phone, code: regCode.data?.devCode, password, nickname: '手机测试用户' }
  });
  check('手机号注册成功', reg.status === 201, `status=${reg.status} ${JSON.stringify(reg.data)}`);
  check('注册返回 token', typeof reg.data?.token === 'string' && reg.data.token.length > 10, 'token 缺失');
  check('账号绑定注册手机号', reg.data?.user?.phone === phone, String(reg.data?.user?.phone));
  check('手机号账号不暴露占位邮箱', reg.data?.user?.email === '', String(reg.data?.user?.email));

  const dup = await request('/api/auth/register/phone', {
    method: 'POST',
    body: { phone, code: '123456', password }
  });
  check('重复手机号注册被拒绝（409）', dup.status === 409, `status=${dup.status}`);

  const regCodeReuse = await request('/api/auth/register/phone', {
    method: 'POST',
    body: { phone, code: regCode.data?.devCode, password }
  });
  check('验证码不可重复使用', regCodeReuse.status === 409 || regCodeReuse.status === 400, `status=${regCodeReuse.status}`);

  /* ---- 手机号登录 ---- */
  const byPassword = await request('/api/auth/login/phone', {
    method: 'POST',
    body: { phone, password }
  });
  check('手机号 + 密码登录成功', byPassword.status === 200, `status=${byPassword.status}`);
  check('登录返回同一账号', byPassword.data?.user?.phone === phone, String(byPassword.data?.user?.phone));

  const loginCode = await sendCode(phone, 'login');
  check('登录验证码发送成功', loginCode.status === 200 && /^\d{6}$/.test(String(loginCode.data?.devCode || '')), `status=${loginCode.status}`);
  const byCode = await request('/api/auth/login/phone', {
    method: 'POST',
    body: { phone, code: loginCode.data?.devCode }
  });
  check('手机号 + 验证码登录成功', byCode.status === 200, `status=${byCode.status}`);
  const codeReuse = await request('/api/auth/login/phone', {
    method: 'POST',
    body: { phone, code: loginCode.data?.devCode }
  });
  check('登录验证码一次性使用', codeReuse.status === 401, `status=${codeReuse.status}`);

  const missing = await request('/api/auth/login/phone', {
    method: 'POST',
    body: { phone }
  });
  check('缺少密码与验证码被拒绝（400）', missing.status === 400, `status=${missing.status}`);
  const unregistered = await request('/api/auth/login/phone', {
    method: 'POST',
    body: { phone: randomPhone(), password }
  });
  check('未注册手机号登录返回 404', unregistered.status === 404, `status=${unregistered.status}`);

  const wrong = await request('/api/auth/login/phone', {
    method: 'POST',
    body: { phone, password: 'WrongPass123' }
  });
  check('错误密码被拒绝并提示剩余次数（401）', wrong.status === 401 && /还可尝试/.test(String(wrong.data?.error || '')), JSON.stringify(wrong.data));

  /* ---- 忘记密码与重置 ---- */
  const forgotCode = await sendCode(phone, 'reset');
  check('重置验证码发送成功', forgotCode.status === 200 && /^\d{6}$/.test(String(forgotCode.data?.devCode || '')), `status=${forgotCode.status}`);
  const forgotWrong = await request('/api/auth/password/forgot', {
    method: 'POST',
    body: { phone, code: '000000' }
  });
  check('错误验证码无法进入重置（400）', forgotWrong.status === 400, `status=${forgotWrong.status}`);

  const forgot = await request('/api/auth/password/forgot', {
    method: 'POST',
    body: { phone, code: forgotCode.data?.devCode }
  });
  check('手机号 + 验证码验证通过并下发重置凭证', forgot.status === 200 && typeof forgot.data?.resetToken === 'string', `status=${forgot.status}`);
  const resetToken = forgot.data?.resetToken;

  const mismatch = await request('/api/auth/password/reset', {
    method: 'POST',
    body: { resetToken, password: newPassword, confirmPassword: 'Phone000000' }
  });
  check('两次密码不一致被拒绝（400）', mismatch.status === 400, `status=${mismatch.status}`);

  const same = await request('/api/auth/password/reset', {
    method: 'POST',
    body: { resetToken, password, confirmPassword: password }
  });
  check('新密码与原密码相同被拒绝（400）', same.status === 400, `status=${same.status}`);

  const reset = await request('/api/auth/password/reset', {
    method: 'POST',
    body: { resetToken, password: newPassword, confirmPassword: newPassword }
  });
  check('密码重置成功', reset.status === 200, `status=${reset.status}`);

  const reuseToken = await request('/api/auth/password/reset', {
    method: 'POST',
    body: { resetToken, password: 'Phone777777', confirmPassword: 'Phone777777' }
  });
  check('重置凭证不可复用（400）', reuseToken.status === 400, `status=${reuseToken.status}`);

  const oldLogin = await request('/api/auth/login/phone', {
    method: 'POST',
    body: { phone, password }
  });
  check('原密码已失效（401）', oldLogin.status === 401, `status=${oldLogin.status}`);
  const newLogin = await request('/api/auth/login/phone', {
    method: 'POST',
    body: { phone, password: newPassword }
  });
  check('新密码可正常登录', newLogin.status === 200, `status=${newLogin.status}`);

  /* ---- 验证码错误次数上限 ---- */
  const reg2Code = await sendCode(phone2, 'register');
  const reg2 = await request('/api/auth/register/phone', {
    method: 'POST',
    body: { phone: phone2, code: reg2Code.data?.devCode, password }
  });
  check('第二个手机号注册成功', reg2.status === 201, `status=${reg2.status}`);
  const loginCode2 = await sendCode(phone2, 'login');
  let lastCodeAttempt = null;
  for (let i = 0; i < 5; i += 1) {
    lastCodeAttempt = await request('/api/auth/login/phone', {
      method: 'POST',
      body: { phone: phone2, code: '000000' }
    });
  }
  const tooMany = await request('/api/auth/login/phone', {
    method: 'POST',
    body: { phone: phone2, code: loginCode2.data?.devCode }
  });
  check('验证码连续错误 5 次后锁定（401/429）', tooMany.status === 401 || tooMany.status === 429, `status=${tooMany.status}`);

  /* ---- 密码错误锁定 ---- */
  let lockStatus = 0;
  for (let i = 0; i < 5; i += 1) {
    const res = await request('/api/auth/login/phone', {
      method: 'POST',
      body: { phone: phone2, password: 'WrongPass123' }
    });
    lockStatus = res.status;
  }
  check('密码连续错误 5 次触发临时锁定（429）', lockStatus === 429, `status=${lockStatus}`);
  const locked = await request('/api/auth/login/phone', {
    method: 'POST',
    body: { phone: phone2, password }
  });
  check('锁定期内正确密码同样被拦截（429）', locked.status === 429, `status=${locked.status}`);

  /* ---- 原有账号体系兼容 ---- */
  const emailLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { account: 'student@xueya.cn', password: 'Student123456' }
  });
  check('原有邮箱登录不受影响', emailLogin.status === 200, `status=${emailLogin.status}`);
  const judgeLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { account: 'judge@xueya.cn', password: 'Judge123456' }
  });
  check('原有体验账号登录不受影响', judgeLogin.status === 200, `status=${judgeLogin.status}`);
} catch (err) {
  failed += 1;
  console.error('测试执行失败：', err.message);
} finally {
  cleanup();
}

console.log(`\n${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed === 0 ? 0 : 1);
