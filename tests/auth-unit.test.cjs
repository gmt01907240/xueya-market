'use strict';

/**
 * 登录与权限模块单元测试
 *
 * 只测试纯函数，不启动 HTTP 服务、不连接正式数据库：
 * - 密码哈希与校验
 * - 登录 token 签发与校验（篡改、过期、畸形输入）
 * - 认证/权限判断（管理员与个人用户边界、交易前认证闸门）
 *
 * 运行：npm run test:unit
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 必须在加载 auth/paths 前隔离数据目录，避免写入项目 data 目录
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-auth-unit-'));
process.env.DATA_DIR = DATA_DIR;

const { hashPassword, verifyPassword, signToken, verifyToken } = require('../server/auth');
const { isVerified, requireVerified } = require('../server/guard');

after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readSecret() {
  return fs.readFileSync(path.join(DATA_DIR, 'secret.key'), 'utf8').trim();
}

function signRawPayload(payloadText) {
  const payload = b64url(payloadText);
  const sig = crypto.createHmac('sha256', readSecret()).update(payload).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${payload}.${sig}`;
}

function mockResponse() {
  return {
    status: 0,
    body: '',
    req: { headers: {} },
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; }
  };
}

describe('密码哈希与校验', () => {
  test('返回哈希与随机盐，且不保存明文', () => {
    const { hash, salt } = hashPassword('Student123456');
    assert.equal(typeof hash, 'string');
    assert.equal(typeof salt, 'string');
    assert.equal(hash.length, 128);
    assert.equal(salt.length, 32);
    assert.notEqual(hash, 'Student123456');
  });

  test('正确密码校验通过', () => {
    const { hash, salt } = hashPassword('Seller123456');
    assert.equal(verifyPassword('Seller123456', salt, hash), true);
  });

  test('错误密码校验失败', () => {
    const { hash, salt } = hashPassword('Seller123456');
    assert.equal(verifyPassword('Seller123457', salt, hash), false);
    assert.equal(verifyPassword('', salt, hash), false);
  });

  test('指定盐时结果可复现', () => {
    const a = hashPassword('Admin123456', 'fixed-salt');
    const b = hashPassword('Admin123456', 'fixed-salt');
    assert.deepEqual(a, b);
    assert.equal(verifyPassword('Admin123456', 'fixed-salt', a.hash), true);
  });

  test('相同密码使用不同盐生成不同哈希', () => {
    const a = hashPassword('Admin123456');
    const b = hashPassword('Admin123456');
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.hash, b.hash);
  });

  test('支持中文与特殊字符密码', () => {
    const password = '学涯#2026！';
    const { hash, salt } = hashPassword(password);
    assert.equal(verifyPassword(password, salt, hash), true);
    assert.equal(verifyPassword('学涯#2026', salt, hash), false);
  });
});

describe('登录 token 签发与校验', () => {
  test('签发包含 payload 与签名两段', () => {
    const token = signToken(1);
    assert.equal(token.split('.').length, 2);
    assert.ok(token.length > 20);
  });

  test('校验通过并还原用户 ID', () => {
    const payload = verifyToken(signToken(42));
    assert.ok(payload);
    assert.equal(payload.uid, 42);
  });

  test('有效期约为 7 天', () => {
    const before = Date.now();
    const payload = verifyToken(signToken(1));
    const after = Date.now();
    const sevenDays = 7 * 24 * 3600 * 1000;
    assert.ok(payload.exp >= before + sevenDays);
    assert.ok(payload.exp <= after + sevenDays + 1000);
  });

  test('不同用户的 token 相互独立', () => {
    const tokenA = signToken(10);
    const tokenB = signToken(20);
    assert.notEqual(tokenA, tokenB);
    assert.equal(verifyToken(tokenA).uid, 10);
    assert.equal(verifyToken(tokenB).uid, 20);
  });

  test('空值与畸形 token 返回 null', () => {
    for (const token of [null, undefined, '', 'abc', 'a.b.c', 123, {}, []]) {
      assert.equal(verifyToken(token), null, `token=${String(token)}`);
    }
  });

  test('篡改 payload 后校验失败', () => {
    const [payload, sig] = signToken(7).split('.');
    const forgedPayload = b64url(JSON.stringify({ uid: 999, exp: Date.now() + 3600e3 }));
    assert.equal(verifyToken(`${forgedPayload}.${sig}`), null);
    assert.notEqual(forgedPayload, payload);
  });

  test('篡改签名后校验失败', () => {
    const [payload, sig] = signToken(7).split('.');
    const badSig = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
    assert.equal(verifyToken(`${payload}.${badSig}`), null);
  });

  test('合法签名但已过期返回 null', () => {
    const expired = signRawPayload(JSON.stringify({ uid: 1, exp: Date.now() - 1000 }));
    assert.equal(verifyToken(expired), null);
  });

  test('合法签名但缺少 uid 返回 null', () => {
    const token = signRawPayload(JSON.stringify({ exp: Date.now() + 3600e3 }));
    assert.equal(verifyToken(token), null);
  });

  test('合法签名但内容不是 JSON 返回 null', () => {
    const token = signRawPayload('not-json');
    assert.equal(verifyToken(token), null);
  });

  test('同一 token 可重复校验，结果稳定', () => {
    const token = signToken(88);
    const first = verifyToken(token);
    const second = verifyToken(token);
    assert.equal(first.uid, 88);
    assert.equal(second.uid, 88);
    assert.equal(first.exp, second.exp);
  });
});

describe('角色与认证权限判断', () => {
  test('未登录用户不具备认证权限', () => {
    assert.equal(isVerified(null), false);
    assert.equal(isVerified(undefined), false);
  });

  test('已认证个人用户具备交易权限', () => {
    assert.equal(isVerified({ role: 'user', verify_status: 'verified' }), true);
  });

  test('未认证个人用户不具备交易权限', () => {
    assert.equal(isVerified({ role: 'user', verify_status: 'none' }), false);
    assert.equal(isVerified({ role: 'user', verify_status: 'pending' }), false);
  });

  test('管理员无需实名认证即具备全部权限', () => {
    assert.equal(isVerified({ role: 'admin', verify_status: 'none' }), true);
  });

  test('认证闸门对已认证用户放行且不写响应', () => {
    const res = mockResponse();
    const allowed = requireVerified({ user: { role: 'user', verify_status: 'verified' }, res });
    assert.equal(allowed, true);
    assert.equal(res.status, 0);
    assert.equal(res.body, '');
  });

  test('认证闸门对未认证用户返回 403 与提示', () => {
    const res = mockResponse();
    const allowed = requireVerified({ user: { role: 'user', verify_status: 'none' }, res }, '购买资料');
    assert.equal(allowed, false);
    assert.equal(res.status, 403);
    const payload = JSON.parse(res.body);
    assert.match(payload.error, /实名认证/);
    assert.match(payload.error, /购买资料/);
  });

  test('认证闸门对管理员直接放行', () => {
    const res = mockResponse();
    assert.equal(requireVerified({ user: { role: 'admin', verify_status: 'none' }, res }), true);
    assert.equal(res.status, 0);
  });
});
