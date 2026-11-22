/**
 * 管理员认证加固测试
 * 覆盖：专属入口、普通登录拒绝管理员、IP 白名单、密码锁定、MFA 锁定与重放、
 *       密码策略与历史、token 版本失效、设备告警、审计日志、首次绑定流程。
 *
 * 运行：npm run test:admin
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  adminLogin,
  totp,
  postJson,
  getJson,
  sleep,
  ADMIN_PASSWORD,
  ADMIN_MFA_SECRET
} from './admin-login-helper.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT_A = Number(process.env.ADMIN_SEC_TEST_PORT || 3411);
const PORT_B = PORT_A + 1;
const PORT_C = PORT_A + 2;
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;
const BASE_C = `http://127.0.0.1:${PORT_C}`;
const DIR_A = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-admsec-a-'));
const DIR_B = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-admsec-b-'));
const DIR_C = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-admsec-c-'));

const children = [];
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

function startServer(port, dataDir, env = {}) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      SEED_DEMO: 'true',
      NODE_ENV: 'test',
      ADMIN_LOGIN_PATH: '/ops-login',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(child);
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitHealth(base) {
  for (let index = 0; index < 80; index += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      // 服务尚未启动
    }
    await sleep(250);
  }
  return false;
}

function withDb(dataDir, fn) {
  const db = new DatabaseSync(path.join(dataDir, 'xueya.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function unlockAdmin(dataDir) {
  withDb(dataDir, (db) => {
    db.exec("UPDATE users SET admin_lock_until = 0, admin_fail_count = 0, admin_mfa_fail_count = 0 WHERE role = 'admin'");
  });
}

async function fetchText(base, pathname) {
  const res = await fetch(base + pathname);
  return { res, text: await res.text() };
}

async function main() {
  startServer(PORT_A, DIR_A, {
    ADMIN_IP_ALLOWLIST: '127.0.0.1/32',
    ADMIN_MFA_SECRET
  });
  startServer(PORT_B, DIR_B, {
    ADMIN_IP_ALLOWLIST: '10.9.8.7/32',
    ADMIN_MFA_SECRET
  });
  startServer(PORT_C, DIR_C, {});

  const readyA = await waitHealth(BASE_A);
  const readyB = await waitHealth(BASE_B);
  const readyC = await waitHealth(BASE_C);
  check('测试服务启动', readyA && readyB && readyC, `A=${readyA} B=${readyB} C=${readyC}`);
  if (!readyA || !readyB || !readyC) return;

  /* 1. 专属入口与隔离 */
  const page = await fetchText(BASE_A, '/ops-login');
  check('专属入口返回独立页面', page.res.status === 200 && page.text.includes('管理员安全登录'));
  check('专属入口禁止搜索引擎收录', (page.res.headers.get('x-robots-tag') || '').includes('noindex')
    && page.text.includes('noindex'));
  check('专属页面无站内导航链接', !page.text.includes('href="/#/') && !page.text.includes('href="/materials'));

  /* 2. 普通登录入口拒绝管理员 */
  const normalAdmin = await postJson(BASE_A, '/api/auth/login', {
    account: 'admin@xueya.cn', password: ADMIN_PASSWORD
  });
  check('普通登录拒绝管理员账号', normalAdmin.status === 403, `status=${normalAdmin.status}`);
  check('拒绝信息不泄露专属入口路径', !JSON.stringify(normalAdmin.data || {}).includes('/ops-login'));

  /* 3. 密码错误锁定 */
  let lastFail = null;
  for (let index = 0; index < 5; index += 1) {
    lastFail = await postJson(BASE_A, '/api/admin/auth/login', {
      account: 'admin@xueya.cn',
      password: `WrongPass@${index}`
    });
  }
  check('连续 5 次密码错误触发锁定', lastFail.status === 423 && lastFail.data?.retryAfter > 0,
    `status=${lastFail.status} body=${JSON.stringify(lastFail.data)}`);
  unlockAdmin(DIR_A);

  /* 4. 密码阶段与 MFA 阶段隔离 */
  const firstLogin = await postJson(BASE_A, '/api/admin/auth/login', {
    account: 'admin@xueya.cn', password: ADMIN_PASSWORD
  });
  check('正确密码进入 MFA 阶段', firstLogin.status === 200 && firstLogin.data?.stage === 'mfa',
    JSON.stringify(firstLogin.data));
  check('密码阶段不签发后台 token', !firstLogin.data?.token);
  check('响应不包含动态码字段', !('demoCode' in (firstLogin.data || {})) && !('code' in (firstLogin.data || {})));
  const mfaToken = firstLogin.data?.mfaToken;
  check('密码阶段签发短时 mfaToken', typeof mfaToken === 'string' && mfaToken.split('.').length === 2);

  const wrongCode = totp(ADMIN_MFA_SECRET, Date.now() + 10 * 60 * 1000);
  let lastMfaFail = null;
  for (let index = 0; index < 3; index += 1) {
    lastMfaFail = await postJson(BASE_A, '/api/admin/auth/mfa', { mfaToken, code: wrongCode });
  }
  check('连续 3 次动态码错误触发锁定', lastMfaFail.status === 423,
    `status=${lastMfaFail.status} body=${JSON.stringify(lastMfaFail.data)}`);
  unlockAdmin(DIR_A);

  const code = totp(ADMIN_MFA_SECRET);
  const mfaOk = await postJson(BASE_A, '/api/admin/auth/mfa', { mfaToken, code });
  check('正确动态码完成登录', mfaOk.status === 200 && mfaOk.data?.stage === 'ok' && Boolean(mfaOk.data?.token),
    JSON.stringify(mfaOk.data));
  check('MFA 成功响应不含动态码字段', !('demoCode' in (mfaOk.data || {})) && !('code' in (mfaOk.data || {})));
  const adminToken = mfaOk.data?.token || '';

  const mfaPayloadTry = await getJson(BASE_A, '/api/admin/overview', mfaToken);
  check('mfaToken 不能访问后台', mfaPayloadTry.status === 403, `status=${mfaPayloadTry.status}`);

  const replay = await postJson(BASE_A, '/api/admin/auth/mfa', { mfaToken, code });
  check('动态码重放被拒绝', replay.status === 401, `status=${replay.status} body=${JSON.stringify(replay.data)}`);

  /* 5. 后台访问与审计 */
  const overview = await getJson(BASE_A, '/api/admin/overview', adminToken);
  check('管理员 token 可访问后台', overview.status === 200, `status=${overview.status}`);
  await getJson(BASE_A, '/api/admin/materials?pageSize=1', adminToken);
  const audit = await getJson(BASE_A, '/api/admin/security/audit?pageSize=20', adminToken);
  const auditHit = (audit.data?.items || []).find((item) => item.path === '/api/admin/overview');
  check('后台操作写入审计日志', Boolean(auditHit) && auditHit.ip === '127.0.0.1' && auditHit.method === 'GET',
    JSON.stringify(auditHit || {}));
  check('审计日志包含设备信息', Boolean(auditHit?.ua && auditHit.ua.includes('xueya-admin-test')));

  /* 6. 普通用户 token 越权 */
  const student = await postJson(BASE_A, '/api/auth/login', {
    account: 'student@xueya.cn', password: 'Student123456'
  });
  const studentToken = student.data?.token || '';
  check('普通用户登录正常', student.status === 200 && Boolean(studentToken), `status=${student.status}`);
  const forbidden = await getJson(BASE_A, '/api/admin/overview', studentToken);
  check('普通用户 token 访问后台被拒绝', forbidden.status === 403, `status=${forbidden.status}`);

  /* 7. 新设备告警 */
  const mobileLogin = await adminLogin(BASE_A, { ua: 'xueya-admin-mobile/2.0', codeOffset: 1 });
  check('新设备仍可完成 MFA 登录', mobileLogin.ok === true && mobileLogin.stage === 'ok', JSON.stringify(mobileLogin.data || {}));
  const alerts = await getJson(BASE_A, '/api/admin/security/alerts?pageSize=50', adminToken);
  const deviceAlert = (alerts.data?.items || []).find((item) => item.type === 'new_device');
  check('新设备登录产生告警', Boolean(deviceAlert), JSON.stringify(alerts.data || {}));
  const lockAlert = (alerts.data?.items || []).find((item) => item.type === 'account_locked');
  check('锁定行为产生告警', Boolean(lockAlert));

  /* 8. 密码策略与历史 */
  const currentCode = totp(ADMIN_MFA_SECRET);
  const weak = await postJson(BASE_A, '/api/admin/auth/password', {
    oldPassword: ADMIN_PASSWORD, newPassword: 'Admin123456', code: currentCode
  }, adminToken);
  check('弱密码被拒绝', weak.status === 400, `status=${weak.status} body=${JSON.stringify(weak.data)}`);
  const withAccount = await postJson(BASE_A, '/api/admin/auth/password', {
    oldPassword: ADMIN_PASSWORD, newPassword: 'Admin@2026#Xueyaa', code: currentCode
  }, adminToken);
  check('包含账号片段的密码被拒绝', withAccount.status === 400, JSON.stringify(withAccount.data));
  const reused = await postJson(BASE_A, '/api/admin/auth/password', {
    oldPassword: ADMIN_PASSWORD, newPassword: ADMIN_PASSWORD, code: currentCode
  }, adminToken);
  check('历史密码不可复用', reused.status === 400, JSON.stringify(reused.data));

  const NEW_PASSWORD = 'N3wOps@2027#Secure';
  const changed = await postJson(BASE_A, '/api/admin/auth/password', {
    oldPassword: ADMIN_PASSWORD, newPassword: NEW_PASSWORD, code: currentCode
  }, adminToken);
  check('强密码修改成功', changed.status === 200 && changed.data?.relogin === true, JSON.stringify(changed.data));

  const stale = await getJson(BASE_A, '/api/admin/overview', adminToken);
  check('改密后旧 token 立即失效', stale.status === 401, `status=${stale.status}`);

  const oldPasswordLogin = await postJson(BASE_A, '/api/admin/auth/login', {
    account: 'admin@xueya.cn', password: ADMIN_PASSWORD
  });
  check('旧密码不能再登录', oldPasswordLogin.status === 401, `status=${oldPasswordLogin.status}`);

  // 等待跨过两个 TOTP 时间步，确保动态码步长大于上一步（新设备登录使用了未来步长）
  await sleep(60000 - (Date.now() % 30000) + 300);
  const relogin = await adminLogin(BASE_A, { password: NEW_PASSWORD });
  check('新密码可完成密码+MFA 登录', relogin.ok === true && relogin.stage === 'ok', JSON.stringify(relogin.data || {}));

  /* 9. IP 白名单 */
  const blockedLogin = await postJson(BASE_B, '/api/admin/auth/login', {
    account: 'admin@xueya.cn', password: ADMIN_PASSWORD
  });
  check('非白名单 IP 无法进入管理员登录', blockedLogin.status === 403, `status=${blockedLogin.status}`);
  const blockedMfa = await postJson(BASE_B, '/api/admin/auth/mfa', { mfaToken: 'x.y', code: '000000' });
  check('非白名单 IP 无法提交动态码', blockedMfa.status === 403, `status=${blockedMfa.status}`);

  /* 10. 首次绑定流程 */
  const enrollLogin = await postJson(BASE_C, '/api/admin/auth/login', {
    account: 'admin@xueya.cn', password: ADMIN_PASSWORD
  });
  check('首次登录返回绑定阶段', enrollLogin.status === 200 && enrollLogin.data?.stage === 'enroll',
    JSON.stringify(enrollLogin.data));
  check('绑定响应提供 secret 但不提供动态码', Boolean(enrollLogin.data?.secret) && !('demoCode' in enrollLogin.data));
  const bindCode = totp(enrollLogin.data?.secret || '');
  const bound = await postJson(BASE_C, '/api/admin/auth/mfa', {
    mfaToken: enrollLogin.data?.mfaToken, code: bindCode
  });
  check('使用绑定 secret 可完成首次登录', bound.status === 200 && bound.data?.stage === 'ok', JSON.stringify(bound.data));
  const secondLogin = await postJson(BASE_C, '/api/admin/auth/login', {
    account: 'admin@xueya.cn', password: ADMIN_PASSWORD
  });
  check('绑定后不再返回 secret', secondLogin.data?.stage === 'mfa' && !('secret' in (secondLogin.data || {})),
    JSON.stringify(secondLogin.data));
}

main()
  .catch((err) => {
    failed += 1;
    console.error('测试执行异常:', err);
  })
  .finally(async () => {
    for (const child of children) {
      child.kill('SIGTERM');
    }
    await sleep(300);
    for (const dir of [DIR_A, DIR_B, DIR_C]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 忽略清理失败
      }
    }
    console.log(`\n管理员安全测试：${passed} 通过，${failed} 失败`);
    if (failed > 0) process.exitCode = 1;
  });
