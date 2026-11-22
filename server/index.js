'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const { init, get, db } = require('./db');
const { verifyToken } = require('./auth');
const { sendJson, fail, readBody, parseQuery, serveStatic } = require('./http');
const authApi = require('./api-auth');
const materialsApi = require('./api-materials');
const ordersApi = require('./api-orders');
const communityApi = require('./api-community');
const adminApi = require('./api-admin');
const adminAuthApi = require('./api-admin-auth');
const adminSecurity = require('./admin-security');
const pricingApi = require('./api-pricing');
const ticketsApi = require('./api-tickets');
const verifyApi = require('./api-verify');
const paymentsApi = require('./api-payments');
const auditApi = require('./api-audit');
const bargainsApi = require('./api-bargains');
const catalogApi = require('./api-catalog');
const planApi = require('./api-plan');
const aiSupport = require('./ai-support');
const contentAudit = require('./content-audit');
const gateway = require('./payment-gateway');
const settlements = require('./settlements');
const settlementsApi = require('./api-settlements');
const ledger = require('./ledger');
const rateLimit = require('./rate-limit');
const runtime = require('./runtime-config');
const metrics = require('./metrics');
const fs = require('node:fs');
const { UPLOAD_DIR } = require('./paths');

init();
contentAudit.init();
settlements.backfill();
ledger.backfill();

// 生产环境支付未就绪时拒绝启动，避免以模拟支付对外提供真实交易
if (runtime.IS_PRODUCTION && runtime.feature('payments')) {
  const readiness = gateway.readiness();
  if (!readiness.ready) {
    console.error('\n  [启动中止] 生产环境支付通道未就绪：');
    for (const item of readiness.blockers) console.error(`    - ${item.code}: ${item.message}`);
    console.error('  请配置 PAYMENT_MODE=live、PAYMENT_LIVE_ENABLED=true 及对应渠道参数后重试。\n');
    process.exit(1);
  }
}

/* 启动自检：数据库可用、上传目录可写，任一不满足即拒绝启动，避免带病对外服务 */
(function startupSelfCheck() {
  const issues = [];
  try {
    get('SELECT 1 AS ok');
  } catch (err) {
    issues.push(`数据库不可用：${err.message}`);
  }
  try {
    fs.accessSync(UPLOAD_DIR, fs.constants.W_OK);
  } catch {
    issues.push(`上传目录不可写：${UPLOAD_DIR}`);
  }
  if (issues.length) {
    console.error('\n  [启动中止] 启动自检未通过：');
    for (const item of issues) console.error(`    - ${item}`);
    process.exit(1);
  }
})();

const routes = [];
function add(method, pattern, handler, opts = {}) {
  routes.push({ method, pattern, handler, auth: !!opts.auth, admin: !!opts.admin });
}

/* ---- 认证 ---- */
add('POST', '/api/auth/register', authApi.register);
add('POST', '/api/auth/login', authApi.login);
add('POST', '/api/auth/sms/send', authApi.smsSend);
add('POST', '/api/auth/register/phone', authApi.phoneRegister);
add('POST', '/api/auth/login/phone', authApi.phoneLogin);
add('POST', '/api/auth/password/forgot', authApi.passwordForgot);
add('POST', '/api/auth/password/reset', authApi.passwordReset);
add('GET', '/api/auth/me', authApi.me, { auth: true });
add('PATCH', '/api/auth/me', authApi.updateMe, { auth: true });
add('POST', '/api/auth/password', authApi.changePassword, { auth: true });

/* ---- 公共信息 ---- */
add('GET', '/api/health', (ctx) => {
  let database = 'ok';
  try {
    get('SELECT 1 AS ok');
  } catch {
    database = 'error';
  }
  sendJson(ctx.res, database === 'ok' ? 200 : 503, {
    status: database === 'ok' ? 'ok' : 'degraded',
    service: 'xueya-market',
    version: require('../package.json').version,
    database,
    paymentMode: gateway.mode(),
    paymentReady: gateway.readiness().ready,
    uptime: Math.round(process.uptime()),
    time: new Date().toISOString()
  });
});
/* 运行指标：仅返回聚合计数，不含任何用户身份信息，供外部探针与监控读取 */
add('GET', '/api/metrics', (ctx) => {
  sendJson(ctx.res, 200, { ...metrics.snapshot(), environment: runtime.info() });
});
add('GET', '/api/meta', authApi.meta);
add('GET', '/api/sellers/:id', authApi.sellerProfile);

/* ---- 资料 ---- */
add('GET', '/api/materials', materialsApi.list);
add('GET', '/api/materials/mine', materialsApi.mine, { auth: true });
add('GET', '/api/materials/favorites', materialsApi.favorites, { auth: true });
add('GET', '/api/materials/:id', materialsApi.detail);
add('GET', '/api/materials/:id/preview', materialsApi.preview);
add('GET', '/api/materials/:id/download', materialsApi.download, { auth: true });
add('POST', '/api/materials', materialsApi.create, { auth: true });
add('PATCH', '/api/materials/:id', materialsApi.update, { auth: true });
add('DELETE', '/api/materials/:id', materialsApi.remove, { auth: true });
add('POST', '/api/materials/:id/favorite', materialsApi.toggleFavorite, { auth: true });
add('POST', '/api/materials/:id/report', materialsApi.report, { auth: true });
add('POST', '/api/materials/:id/reviews', materialsApi.addReview, { auth: true });

/* ---- 订单 ---- */
add('POST', '/api/orders', ordersApi.create, { auth: true });
add('GET', '/api/orders/mine', ordersApi.mine, { auth: true });
add('GET', '/api/orders/sales', ordersApi.sales, { auth: true });
add('POST', '/api/orders/:id/refund', ordersApi.refund, { auth: true });

/* ---- 支付 ---- */
add('GET', '/api/payments/channels', paymentsApi.channels);
add('GET', '/api/payments/mine', paymentsApi.mine, { auth: true });
add('POST', '/api/payments/callback/:channel', paymentsApi.notify);
add('GET', '/api/payments/:id', paymentsApi.detail, { auth: true });
add('POST', '/api/payments/:id/simulate', paymentsApi.simulate, { auth: true });

/* ---- 砍价 ---- */
add('POST', '/api/bargains', bargainsApi.createOrder, { auth: true });
add('GET', '/api/bargains/mine', bargainsApi.mine, { auth: true });
add('GET', '/api/bargains/material/:materialId', bargainsApi.materialActivity);
add('GET', '/api/bargains/:id', bargainsApi.detail);
add('POST', '/api/bargains/:id/assist', bargainsApi.assist, { auth: true });
add('POST', '/api/bargains/:id/purchase', bargainsApi.purchase, { auth: true });

/* ---- 卖家 ---- */
add('GET', '/api/seller/overview', ordersApi.sellerOverview, { auth: true });
add('GET', '/api/seller/settlements', settlementsApi.seller, { auth: true });

/* ---- 求购与私信 ---- */add('GET', '/api/wants', communityApi.listWants);
add('POST', '/api/wants', communityApi.createWant, { auth: true });
add('POST', '/api/wants/:id/close', communityApi.closeWant, { auth: true });
add('GET', '/api/threads', communityApi.listThreads, { auth: true });
add('GET', '/api/threads/meta', communityApi.chatMeta, { auth: true });
add('GET', '/api/threads/unread', communityApi.threadUnread, { auth: true });
add('POST', '/api/threads', communityApi.openThread, { auth: true });
add('GET', '/api/threads/:id', communityApi.threadDetail, { auth: true });
add('PATCH', '/api/threads/:id', communityApi.updateThread, { auth: true });
add('POST', '/api/threads/:id/messages', communityApi.sendMessage, { auth: true });

/* ---- 定价标准库 ---- */
add('GET', '/api/pricing/standards', pricingApi.listStandards);
add('GET', '/api/pricing/recommend', pricingApi.recommend);

/* ---- 实名与高校认证 ---- */
add('GET', '/api/verify/status', verifyApi.status, { auth: true });
add('POST', '/api/verify/submit', verifyApi.submit, { auth: true });

/* ---- 院校 / 学科 / 教师资源库 ---- */
add('GET', '/api/catalog/overview', catalogApi.overview);
add('GET', '/api/catalog/search', catalogApi.search);
add('GET', '/api/plan/options', planApi.options);
add('POST', '/api/plan/generate', planApi.generate);
add('GET', '/api/plan/mine', planApi.mine, { auth: true });
add('POST', '/api/plan/save', planApi.save, { auth: true });
add('GET', '/api/plan/:id', planApi.detail, { auth: true });
add('POST', '/api/plan/:id/check', planApi.check, { auth: true });
add('DELETE', '/api/plan/:id', planApi.remove, { auth: true });

/* ---- AI 智能客服 ---- */
add('GET', '/api/support/ai', aiSupport.info);
add('POST', '/api/support/ai', aiSupport.chat);

/* ---- 客服工单 ---- */
add('GET', '/api/tickets', ticketsApi.list, { auth: true });
add('GET', '/api/tickets/unread', ticketsApi.unread, { auth: true });
add('POST', '/api/tickets', ticketsApi.create, { auth: true });
add('GET', '/api/tickets/:id', ticketsApi.detail, { auth: true });
add('POST', '/api/tickets/:id/replies', ticketsApi.reply, { auth: true });
add('POST', '/api/tickets/:id/status', ticketsApi.updateStatus, { auth: true });

/* ---- 管理后台 ---- */
/* 管理员专属认证：密码 + TOTP 两步，路由内部完成鉴权与 IP 白名单校验 */
add('POST', '/api/admin/auth/login', adminAuthApi.login);
add('POST', '/api/admin/auth/mfa', adminAuthApi.mfa);
add('POST', '/api/admin/auth/password', adminAuthApi.changePassword);
add('GET', '/api/admin/auth/status', adminAuthApi.status);
add('GET', '/api/admin/security/overview', adminAuthApi.securityOverview);
add('GET', '/api/admin/security/events', adminAuthApi.listEvents);
add('GET', '/api/admin/security/alerts', adminAuthApi.listAlerts);
add('POST', '/api/admin/security/alerts/:id/ack', adminAuthApi.acknowledgeAlert);
add('GET', '/api/admin/security/audit', adminAuthApi.listAudit);
add('GET', '/api/admin/overview', adminApi.overview, { auth: true, admin: true });
add('GET', '/api/admin/bargains', bargainsApi.adminList, { auth: true, admin: true });
add('POST', '/api/admin/bargains', bargainsApi.adminCreate, { auth: true, admin: true });
add('PATCH', '/api/admin/bargains/:id', bargainsApi.adminUpdate, { auth: true, admin: true });
add('DELETE', '/api/admin/bargains/:id', bargainsApi.adminDelete, { auth: true, admin: true });
add('GET', '/api/admin/materials', adminApi.materials, { auth: true, admin: true });
add('POST', '/api/admin/materials/:id/review', adminApi.reviewMaterial, { auth: true, admin: true });
add('PATCH', '/api/admin/materials/:id/price', adminApi.adjustMaterialPrice, { auth: true, admin: true });
add('GET', '/api/admin/users', adminApi.users, { auth: true, admin: true });
add('POST', '/api/admin/users/:id/status', adminApi.setUserStatus, { auth: true, admin: true });
add('GET', '/api/admin/verifications', adminApi.verifications, { auth: true, admin: true });
add('POST', '/api/admin/verifications/:id/review', adminApi.reviewVerification, { auth: true, admin: true });
add('GET', '/api/admin/tickets', ticketsApi.adminList, { auth: true, admin: true });
add('GET', '/api/admin/pricing', pricingApi.adminList, { auth: true, admin: true });
add('POST', '/api/admin/pricing', pricingApi.adminCreate, { auth: true, admin: true });
add('PATCH', '/api/admin/pricing/:id', pricingApi.adminUpdate, { auth: true, admin: true });
add('DELETE', '/api/admin/pricing/:id', pricingApi.adminDelete, { auth: true, admin: true });
add('GET', '/api/admin/reports', adminApi.reports, { auth: true, admin: true });
add('POST', '/api/admin/reports/:id/resolve', adminApi.resolveReport, { auth: true, admin: true });
add('GET', '/api/admin/refunds', adminApi.refunds, { auth: true, admin: true });
add('GET', '/api/admin/payments/reconcile', paymentsApi.adminReconcile, { auth: true, admin: true });
add('GET', '/api/admin/payments/batches', paymentsApi.adminBatches, { auth: true, admin: true });
add('GET', '/api/admin/payments/batches/:id', paymentsApi.adminBatchDetail, { auth: true, admin: true });
add('POST', '/api/admin/payments/reconcile/bill', paymentsApi.adminImportBill, { auth: true, admin: true });
add('GET', '/api/admin/finance/ledger', paymentsApi.adminLedger, { auth: true, admin: true });
add('GET', '/api/admin/payments', paymentsApi.adminList, { auth: true, admin: true });
add('POST', '/api/admin/payments/:id/confirm', paymentsApi.adminConfirm, { auth: true, admin: true });
add('GET', '/api/admin/settlements', settlementsApi.admin, { auth: true, admin: true });
add('POST', '/api/admin/orders/:id/refund', adminApi.resolveRefund, { auth: true, admin: true });
add('GET', '/api/admin/audit/overview', auditApi.overview, { auth: true, admin: true });
add('GET', '/api/admin/audit/rules', auditApi.rules, { auth: true, admin: true });
add('POST', '/api/admin/audit/rules/test', auditApi.testRule, { auth: true, admin: true });
add('POST', '/api/admin/audit/rules/reload', auditApi.reload, { auth: true, admin: true });
add('POST', '/api/admin/audit/rules', auditApi.createRule, { auth: true, admin: true });
add('PATCH', '/api/admin/audit/rules/:id', auditApi.updateRule, { auth: true, admin: true });
add('DELETE', '/api/admin/audit/rules/:id', auditApi.deleteRule, { auth: true, admin: true });
add('GET', '/api/admin/audit/logs', auditApi.logs, { auth: true, admin: true });
add('GET', '/api/admin/audit/settings', auditApi.settings, { auth: true, admin: true });
add('PATCH', '/api/admin/audit/settings', auditApi.updateSettings, { auth: true, admin: true });
add('GET', '/api/admin/announcements', adminApi.announcements, { auth: true, admin: true });
add('POST', '/api/admin/announcements', adminApi.createAnnouncement, { auth: true, admin: true });
add('PATCH', '/api/admin/announcements/:id', adminApi.updateAnnouncement, { auth: true, admin: true });
add('DELETE', '/api/admin/announcements/:id', adminApi.deleteAnnouncement, { auth: true, admin: true });

/** 安全的路径段解码：非法百分号编码返回 null，避免 URIError 逃逸到请求处理器外层 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function matchRoute(pattern, pathname) {
  const p = pattern.split('/').filter(Boolean);
  const s = pathname.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) {
      const decoded = safeDecode(s[i]);
      if (decoded === null) return null;
      params[p[i].slice(1)] = decoded;
    } else if (p[i] !== s[i]) return null;
  }
  return params;
}

function resolveAuth(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = get('SELECT * FROM users WHERE id = ?', payload.uid);
  if (!user || user.status === 'banned') return null;
  return { user, payload };
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

const ADMIN_LOGIN_PATH = (() => {
  const raw = String(process.env.ADMIN_LOGIN_PATH || '/ops-login').trim() || '/ops-login';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, '') || '/ops-login';
})();

/* 进程级兜底：未捕获异常记录结构化日志后退出，避免进程带病运行或静默消失 */
process.on('unhandledRejection', (err) => {
  console.error(JSON.stringify({
    level: 'fatal',
    event: 'unhandledRejection',
    message: err && err.message ? err.message : String(err)
  }));
});
process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({
    level: 'fatal',
    event: 'uncaughtException',
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack
  }));
  try { db.close(); } catch { /* 已关闭 */ }
  process.exit(1);
});

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return fail(res, 400, '请求地址无效');
  }
  const pathname = url.pathname;
  const isApi = pathname.startsWith('/api/');
  const requestId = crypto.randomUUID();
  const startedAt = process.hrtime.bigint();
  let actorId = null;
  res.setHeader('X-Request-Id', requestId);
  if (isApi) {
    res.on('finish', () => {
      metrics.recordRequest(res.statusCode);
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      console.log(JSON.stringify({
        time: new Date().toISOString(),
        requestId,
        method: req.method,
        path: pathname,
        status: res.statusCode,
        ms: Math.round(ms),
        ip: rateLimit.clientIp(req),
        userId: actorId
      }));
    });
  }

  // 生产环境不对外暴露离线演示页，避免与真实经营场景混淆
  if (runtime.IS_PRODUCTION && pathname === '/demo.html') {
    return fail(res, 404, '页面不存在');
  }

  // 单文件离线演示包含内联脚本，单独放行；其余页面启用严格 CSP
  if (pathname !== '/demo.html') res.setHeader('Content-Security-Policy', CSP);

  // 管理员专属入口：独立页面，不参与站点静态回退，也不在站内导航中出现
  if (pathname === ADMIN_LOGIN_PATH || pathname === `${ADMIN_LOGIN_PATH}/`) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return serveStatic(req, res, '/admin-login.html');
  }

  if (!pathname.startsWith('/api/')) {
    return serveStatic(req, res, pathname);
  }
  const query = parseQuery(url);
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  const limited = rateLimit.check(req, method, pathname);
  if (!limited.allowed) {
    res.setHeader('Retry-After', String(limited.retryAfter));
    return fail(res, 429, limited.message);
  }

  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchRoute(route.pattern, pathname);
    if (!params) continue;

    const auth = resolveAuth(req);
    const user = auth ? auth.user : null;
    if (route.auth && !user) return fail(res, 401, '请先登录');
    actorId = user ? user.id : null;
    if (route.admin) {
      if (!runtime.adminAllowed(rateLimit.clientIp(req))) {
        return fail(res, 403, '后台仅允许受信网络访问');
      }
      if (user.role !== 'admin') return fail(res, 403, '仅管理员可访问');
      if (!auth.payload || auth.payload.adm !== 1) {
        return fail(res, 403, '请通过管理员专属入口登录');
      }
      if (Number(auth.payload.v || 0) !== Number(user.token_version || 0)) {
        return fail(res, 401, '登录状态已失效，请重新登录');
      }
    }

    let body = {};
    if (method !== 'GET' && method !== 'DELETE') {
      try {
        body = await readBody(req, 32 * 1024 * 1024);
      } catch (err) {
        return fail(res, err.status || 400, err.message || '请求解析失败');
      }
    }

    if (route.admin) {
      const auditUser = user;
      res.on('finish', () => {
        adminSecurity.writeAudit(auditUser.id, auditUser.username, {
          method,
          path: pathname,
          status: res.statusCode,
          ip: rateLimit.clientIp(req),
          ua: String(req.headers['user-agent'] || ''),
          durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
          detail: { query, params, body }
        });
      });
    }

    try {
      return await route.handler({ req, res, params, query, body, user });
    } catch (err) {
      console.error(JSON.stringify({ requestId, level: 'error', method, path: pathname, message: err.message, stack: err.stack }));
      if (res.headersSent) return res.end();
      return fail(res, 500, '服务器处理出错，请稍后重试');
    }
  }

  fail(res, 404, '接口不存在');
});

const PORT = Number(process.env.PORT) || 3300;
const HOST = String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';

/* 列出本机可供其他设备访问的 IPv4 地址（跳过回环、链路本地与常见虚拟网卡） */
const VIRTUAL_ADAPTER_RE = /vEthernet|VMware|VirtualBox|Hyper-V|WSL|Tailscale|ZeroTier|Lanplay|UU加速|VPN/i;
function lanAddresses() {
  const list = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (VIRTUAL_ADAPTER_RE.test(name)) continue;
    for (const item of ifaces[name] || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      if (item.address.startsWith('169.254.')) continue;
      list.push({ name, address: item.address });
    }
  }
  return list;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  [启动失败] 端口 ${PORT} 已被占用。可换一个端口启动：PowerShell 执行 $env:PORT=3301; npm start，CMD 执行 set PORT=3301 && npm start。\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\n  [启动失败] 没有权限监听端口 ${PORT}，请改用 1024 以上的端口。\n`);
  } else {
    console.error(`\n  [启动失败] ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  学涯集市 · 高校学习资料交易平台');
  console.log(`  监听地址:  ${HOST}:${PORT}`);
  console.log(`  本地地址:  http://localhost:${PORT}`);
  console.log(`  部署模式:  ${runtime.PUBLIC_DEMO ? '公开演示（自动实名认证 · 模拟支付）' : runtime.IS_PRODUCTION ? '生产' : '开发'}`);
  console.log(`  管理员专属入口: http://localhost:${PORT}${ADMIN_LOGIN_PATH}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    const lan = lanAddresses();
    if (lan.length) {
      console.log('  局域网地址（同一网络下的其他电脑用这些地址访问）:');
      for (const item of lan) console.log(`             http://${item.address}:${PORT}  (${item.name})`);
    } else {
      console.log('  局域网地址: 未检测到可用的 IPv4 网络地址，请检查网络连接');
    }
  }
  if (runtime.SEED_DEMO) {
    console.log('  统一登录:  个人用户与管理员共用同一登录入口');
    console.log('  体验账号:  student@xueya.cn / Student123456  （个人用户，买家+卖家）');
    console.log('            seller@xueya.cn  / Seller123456   （个人用户，买家+卖家）');
    console.log('            judge@xueya.cn   / Judge123456    （个人用户，体验账号）');
    console.log(`    管理员登录: 请通过专属入口 http://localhost:${PORT}${ADMIN_LOGIN_PATH}（口令由 ADMIN_INITIAL_PASSWORD 注入，不在此处输出）`);
    if (runtime.IS_PRODUCTION) {
      console.warn('  [安全警告] 生产环境仍启用演示数据，请设置 SEED_DEMO=false 后重新初始化。');
    }
  } else {
    console.log('  演示数据:  未启用（生产模式）');
  }
  console.log(`  支付模式:  ${gateway.mode() === 'mock' ? 'mock（支持模拟支付）' : 'live（真实渠道）'}`);
  if (runtime.IS_PRODUCTION && gateway.mode() === 'mock') {
    console.warn('  [安全警告] 生产环境仍处于 mock 支付模式：模拟支付接口已禁用。请设置 PAYMENT_MODE=live 并配置渠道参数。');
  }
  console.log(`  功能开关:  注册 ${runtime.feature('registration') ? '开' : '关'} · 上传 ${runtime.feature('upload') ? '开' : '关'} · 支付 ${runtime.feature('payments') ? '开' : '关'} · 规划 ${runtime.feature('plan') ? '开' : '关'}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.log(`  其他电脑打不开时：用管理员权限执行 npm run firewall:open 放行 ${PORT} 端口`);
  }
  console.log('');
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] 收到 ${signal}，停止接收新请求`);
  const finish = () => {
    try { db.close(); } catch { /* 已关闭 */ }
    process.exit(0);
  };
  server.close(finish);
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  setTimeout(() => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    finish();
  }, 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* 定时执行到期收益结算，T+N 结算周期由 SETTLEMENT_DELAY_HOURS 控制 */
setInterval(() => {
  try {
    const done = settlements.settleDue();
    if (done) console.log(`[settlements] 已完成 ${done} 笔收益结算`);
  } catch (err) {
    console.error('[settlements] 自动结算失败', err);
  }
}, 5 * 60 * 1000).unref();

/* 每分钟关闭超时未支付的支付单，并同步取消对应订单 */
setInterval(() => {
  try {
    const closed = gateway.expirePending();
    if (closed) console.log(`[payments] 已关闭 ${closed} 笔超时支付单`);
  } catch (err) {
    console.error('[payments] 超时清理失败', err);
  }
}, 60 * 1000).unref();
