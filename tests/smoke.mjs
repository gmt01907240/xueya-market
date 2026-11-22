/**
 * 学涯集市 · API 冒烟测试（只读）
 *
 * 用途：部署后快速确认核心接口、鉴权与新增模块是否可用。
 * 运行：先启动服务（npm start），再执行 npm test
 * 可选：BASE_URL=https://your-domain.com npm test
 */

const BASE = (process.env.BASE_URL || 'http://localhost:3300').replace(/\/$/, '');

import { adminLogin } from './admin-login-helper.mjs';

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

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, data };
}

async function login(account, password) {
  const res = await request('/api/auth/login', { method: 'POST', body: { account, password } });
  if (res.status !== 200 || !res.data?.token) throw new Error(`登录失败：${account}`);
  return res.data.token;
}

async function main() {
  console.log(`\n学涯集市 API 冒烟测试 · ${BASE}\n`);

  const health = await request('/api/health');
  check('健康检查 /api/health', health.status === 200 && health.data?.status === 'ok', String(health.status));

  const meta = await request('/api/meta');
  check('公共信息 /api/meta', meta.status === 200 && Array.isArray(meta.data?.schools));
  check('院校数据非空', (meta.data?.schools || []).length > 0);
  check('学科数据非空', (meta.data?.subjects || []).length > 0);

  const list = await request('/api/materials?pageSize=6');
  check('资料列表 /api/materials', list.status === 200 && Array.isArray(list.data?.items));
  const first = (list.data?.items || []).find((m) => m.price > 0) || list.data?.items?.[0];
  check('资料列表包含数据', !!first);

  if (first) {
    const detail = await request(`/api/materials/${first.id}`);
    check('资料详情 /api/materials/:id', detail.status === 200 && detail.data?.material?.id === first.id);
    const preview = await request(`/api/materials/${first.id}/preview`);
    check('资料试读 /api/materials/:id/preview', preview.status === 200 && typeof preview.data?.text === 'string');
    check('试读比例在 10%—20%', preview.data?.ratio >= 10 && preview.data?.ratio <= 20);
  }

  const rec = await request('/api/pricing/recommend?school=%E6%AD%A6%E6%B1%89%E5%A4%A7%E5%AD%A6&subject=%E8%AE%A1%E7%AE%97%E6%9C%BA%E7%A7%91%E5%AD%A6%E4%B8%8E%E6%8A%80%E6%9C%AF&category=%E6%9C%9F%E6%9C%AB%E7%9C%9F%E9%A2%98');
  check('定价推荐 /api/pricing/recommend', rec.status === 200 && rec.data?.recommendation?.suggestion > 0);

  const filtered = await request('/api/materials?school=%E6%AD%A6%E6%B1%89%E5%A4%A7%E5%AD%A6&pageSize=6');
  check('院校筛选过滤生效', filtered.status === 200 && (filtered.data?.items || []).every((m) => m.school === '武汉大学'));

  const denied = await request('/api/admin/overview');
  check('管理端鉴权（未登录返回 401）', denied.status === 401, String(denied.status));

  const student = await login('student@xueya.cn', 'Student123456');
  const verifyStatus = await request('/api/verify/status', { token: student });
  check('买家认证状态 /api/verify/status', verifyStatus.status === 200 && verifyStatus.data?.user?.verified === true);
  const unread = await request('/api/tickets/unread', { token: student });
  check('工单未读 /api/tickets/unread', unread.status === 200 && typeof unread.data?.total === 'number');
  const orders = await request('/api/orders/mine', { token: student });
  check('买家订单 /api/orders/mine', orders.status === 200 && Array.isArray(orders.data?.items));

  const adminAuth = await adminLogin(BASE);
  check('管理员专属入口密码+MFA 登录', adminAuth.ok === true && Boolean(adminAuth.token), JSON.stringify(adminAuth.data || {}));
  const admin = adminAuth.token;
  const overview = await request('/api/admin/overview', { token: admin });
  check('后台概览 /api/admin/overview', overview.status === 200 && !!overview.data?.stats);
  check('概览包含新增指标', overview.data?.stats?.pendingVerifications >= 0 && overview.data?.stats?.openTickets >= 0);
  const verifications = await request('/api/admin/verifications?status=pending', { token: admin });
  check('认证审核 /api/admin/verifications', verifications.status === 200 && Array.isArray(verifications.data?.items));
  const pricing = await request('/api/admin/pricing', { token: admin });
  check('价格标准库 /api/admin/pricing', pricing.status === 200 && Array.isArray(pricing.data?.items));
  const tickets = await request('/api/admin/tickets', { token: admin });
  check('客服工单 /api/admin/tickets', tickets.status === 200 && Array.isArray(tickets.data?.items));

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n测试执行失败：${err.message}\n`);
  process.exitCode = 1;
});
