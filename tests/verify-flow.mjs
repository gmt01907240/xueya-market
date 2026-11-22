/**
 * 学涯集市 · 学号（实名与高校）认证全链路测试
 *
 * 覆盖：认证状态查询、合法/非法学号校验、重复提交、学号唯一性、
 *       管理员审核通过与驳回、驳回原因回显、认证后院校锁定与权限联动。
 *
 * 运行：npm run test:verify
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adminLogin } from './admin-login-helper.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.VERIFY_TEST_PORT || 3407);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-verify-'));

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
  try { data = await res.json(); } catch { /* 二进制或空响应 */ }
  return { status: res.status, data };
}

const output = { text: '' };
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR, SEED_DEMO: 'true' },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (b) => { output.text += b.toString(); });
child.stderr.on('data', (b) => { output.text += b.toString(); });

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务启动失败：${output.text}`);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`服务启动超时：${output.text}`);
}

function cleanup() {
  if (child.exitCode === null) child.kill('SIGTERM');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

try {
  await waitForServer();

  const stamp = Date.now().toString().slice(-8);
  const pwd = 'Verify123456';
  const email = `verify${stamp}@xueya.cn`;
  const username = `verify${stamp}`;

  const reg = await request('/api/auth/register', {
    method: 'POST',
    body: { nickname: '认证测试', username, email, password: pwd, school: '武汉大学' }
  });
  const token = reg.data?.token;
  const userId = reg.data?.user?.id;
  check('注册普通用户', reg.status === 201 && !!token, `status=${reg.status}`);

  const st = await request('/api/verify/status', { token });
  check(
    '认证状态为 none 且返回院校库',
    st.status === 200 && st.data?.user?.verifyStatus === 'none' && (st.data?.schools?.length || 0) > 400,
    JSON.stringify({ status: st.data?.user?.verifyStatus, schools: st.data?.schools?.length })
  );

  const dl0 = await request('/api/materials/1/download', { token });
  check('未认证不能下载资料（403）', dl0.status === 403, `status=${dl0.status}`);

  const badName = await request('/api/verify/submit', {
    method: 'POST', token, body: { realName: '林', school: '武汉大学', studentNo: '20231234' }
  });
  check('姓名过短被拒（400）', badName.status === 400, `status=${badName.status}`);

  const badSchool = await request('/api/verify/submit', {
    method: 'POST', token, body: { realName: '林知遥', school: '不存在大学', studentNo: '20231234' }
  });
  check('非法院校被拒（400）', badSchool.status === 400, `status=${badSchool.status}`);

  const badShort = await request('/api/verify/submit', {
    method: 'POST', token, body: { realName: '林知遥', school: '武汉大学', studentNo: '12345' }
  });
  check('学号过短被拒（400）', badShort.status === 400, `status=${badShort.status}`);

  const badChars = await request('/api/verify/submit', {
    method: 'POST', token, body: { realName: '林知遥', school: '武汉大学', studentNo: '2023-1234' }
  });
  check('学号含非法字符被拒（400）', badChars.status === 400, `status=${badChars.status}`);

  const studentNoA = `20${stamp}01`;
  const ok = await request('/api/verify/submit', {
    method: 'POST', token, body: { realName: '林知遥', school: '武汉大学', studentNo: studentNoA }
  });
  check('合法学号提交进入待审核', ok.status === 200 && ok.data?.user?.verifyStatus === 'pending', `status=${ok.status}`);

  const dup = await request('/api/verify/submit', {
    method: 'POST', token, body: { realName: '林知遥', school: '武汉大学', studentNo: studentNoA }
  });
  check('审核中重复提交被拒（409）', dup.status === 409, `status=${dup.status}`);

  const dl1 = await request('/api/materials/1/download', { token });
  check('审核中仍不能下载（403）', dl1.status === 403, `status=${dl1.status}`);

  const adminAuth = await adminLogin(BASE);
  const adminToken = adminAuth.token;
  check('管理员专属入口完成密码+MFA登录', adminAuth.ok === true && !!adminToken, JSON.stringify(adminAuth.data || {}));

  const userToList = await request('/api/admin/verifications?status=pending', { token });
  check('普通用户访问审核列表被拒（403）', userToList.status === 403, `status=${userToList.status}`);

  const list = await request('/api/admin/verifications?status=pending', { token: adminToken });
  const target = list.data?.items?.find((u) => u.username === username);
  check(
    '后台待审核列表包含该用户',
    list.status === 200 && !!target && target.studentNo === studentNoA,
    JSON.stringify(target || {}).slice(0, 120)
  );

  const approve = await request(`/api/admin/verifications/${userId}/review`, {
    method: 'POST', token: adminToken, body: { action: 'approve' }
  });
  check('管理员审核通过', approve.status === 200, `status=${approve.status}`);

  const me = await request('/api/auth/me', { token });
  check(
    '认证后状态为 verified',
    me.status === 200 && me.data?.user?.verified === true && me.data?.user?.verifyStatus === 'verified',
    JSON.stringify(me.data?.user?.verifyStatus)
  );

  const again = await request('/api/verify/submit', {
    method: 'POST', token, body: { realName: '林知遥', school: '武汉大学', studentNo: studentNoA }
  });
  check('已认证后重复提交被拒（409）', again.status === 409, `status=${again.status}`);

  const patch = await request('/api/auth/me', {
    method: 'PATCH', token, body: { nickname: '认证测试', school: '北京大学', bio: '' }
  });
  check('认证后院校被锁定', patch.status === 200 && patch.data?.user?.school === '武汉大学', JSON.stringify(patch.data?.user?.school));

  const dl2 = await request('/api/materials/1/download', { token });
  check(
    '认证后通过认证闸门（转为购买校验）',
    dl2.status === 403 && /购买/.test(JSON.stringify(dl2.data || '')),
    `status=${dl2.status} body=${JSON.stringify(dl2.data)}`
  );

  /* ---- 学号唯一性：同学号仅可绑定一个账号 ---- */
  const reg2 = await request('/api/auth/register', {
    method: 'POST',
    body: { nickname: '冲突测试', username: `conflict${stamp}`, email: `conflict${stamp}@xueya.cn`, password: pwd, school: '武汉大学' }
  });
  const token2 = reg2.data?.token;
  const userId2 = reg2.data?.user?.id;

  const occupied = await request('/api/verify/submit', {
    method: 'POST', token: token2, body: { realName: '周子安', school: '武汉大学', studentNo: studentNoA }
  });
  check('同院校学号已被占用时拒绝（409）', occupied.status === 409, `status=${occupied.status}`);

  const crossSchool = await request('/api/verify/submit', {
    method: 'POST', token: token2, body: { realName: '周子安', school: '北京大学', studentNo: studentNoA }
  });
  check('不同院校允许使用相同号码', crossSchool.status === 200 && crossSchool.data?.user?.verifyStatus === 'pending', `status=${crossSchool.status}`);

  const rejectNoNote = await request(`/api/admin/verifications/${userId2}/review`, {
    method: 'POST', token: adminToken, body: { action: 'reject' }
  });
  check('驳回未填写原因被拒（400）', rejectNoNote.status === 400, `status=${rejectNoNote.status}`);

  const reject = await request(`/api/admin/verifications/${userId2}/review`, {
    method: 'POST', token: adminToken, body: { action: 'reject', note: '学号与院校不匹配，请核对后重新提交' }
  });
  check('填写原因后驳回成功', reject.status === 200, `status=${reject.status}`);

  const me2 = await request('/api/auth/me', { token: token2 });
  check(
    '驳回后状态与原因对用户可见',
    me2.data?.user?.verifyStatus === 'rejected' && String(me2.data?.user?.verifyNote || '').includes('学号'),
    JSON.stringify(me2.data?.user?.verifyNote)
  );

  const resubmit = await request('/api/verify/submit', {
    method: 'POST', token: token2, body: { realName: '周子安', school: '北京大学', studentNo: `20${stamp}02` }
  });
  check('驳回后可修改学号重新提交', resubmit.status === 200 && resubmit.data?.user?.verifyStatus === 'pending', `status=${resubmit.status}`);

  const exceptionLines = output.text.split('\n').filter((l) => /unhandled|TypeError|ReferenceError|SyntaxError/i.test(l));
  check('服务端无异常日志', exceptionLines.length === 0, exceptionLines.slice(0, 3).join(' | '));
} catch (err) {
  failed += 1;
  console.error('测试执行失败：', err.message);
} finally {
  cleanup();
}

console.log(`\n${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed === 0 ? 0 : 1);
