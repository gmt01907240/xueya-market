const runtime = require('./runtime-config');

/**
 * 轻量级接口限流（单进程内存实现）
 *
 * 用于登录、注册、支付模拟、AI 客服等高风险接口的暴力尝试与滥用防护。
 * 多实例部署时应替换为 Redis 等共享存储。
 */

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const RULES = [
  {
    id: 'login',
    limit: envInt('RATE_LIMIT_LOGIN', 20),
    windowMs: 60 * 1000,
    test: (method, path) => method === 'POST' && path === '/api/auth/login'
  },
  {
    id: 'register',
    limit: envInt('RATE_LIMIT_REGISTER', 10),
    windowMs: 10 * 60 * 1000,
    test: (method, path) => method === 'POST' && path === '/api/auth/register'
  },
  {
    id: 'password',
    limit: envInt('RATE_LIMIT_PASSWORD', 10),
    windowMs: 5 * 60 * 1000,
    test: (method, path) => method === 'POST' && (path === '/api/auth/password'
      || path === '/api/auth/password/forgot' || path === '/api/auth/password/reset')
  },
  {
    id: 'sms',
    limit: envInt('RATE_LIMIT_SMS', 10),
    windowMs: 60 * 1000,
    test: (method, path) => method === 'POST' && path === '/api/auth/sms/send'
  },
  {
    id: 'phone-register',
    limit: envInt('RATE_LIMIT_PHONE_REGISTER', 10),
    windowMs: 10 * 60 * 1000,
    test: (method, path) => method === 'POST' && path === '/api/auth/register/phone'
  },
  {
    id: 'phone-login',
    limit: envInt('RATE_LIMIT_PHONE_LOGIN', 20),
    windowMs: 60 * 1000,
    test: (method, path) => method === 'POST' && path === '/api/auth/login/phone'
  },
  {
    id: 'admin-login',
    limit: envInt('RATE_LIMIT_ADMIN_LOGIN', 10),
    windowMs: 60 * 1000,
    test: (method, path) => method === 'POST' && path === '/api/admin/auth/login'
  },
  {
    id: 'admin-mfa',
    limit: envInt('RATE_LIMIT_ADMIN_MFA', 10),
    windowMs: 60 * 1000,
    test: (method, path) => method === 'POST' && path === '/api/admin/auth/mfa'
  },
  {
    id: 'admin-password',
    limit: envInt('RATE_LIMIT_ADMIN_PASSWORD', 5),
    windowMs: 5 * 60 * 1000,
    test: (method, path) => method === 'POST' && path === '/api/admin/auth/password'
  },
  {
    id: 'ai',
    limit: envInt('RATE_LIMIT_AI', 60),
    windowMs: 60 * 1000,
    test: (method, path) => method === 'POST' && path === '/api/support/ai'
  },
  {
    id: 'plan',
    limit: envInt('RATE_LIMIT_PLAN', 30),
    windowMs: 60 * 1000,
    test: (method, path) => method === 'POST' && path === '/api/plan/generate'
  },
  {
    id: 'plan-save',
    limit: envInt('RATE_LIMIT_PLAN_SAVE', 20),
    windowMs: 60 * 1000,
    test: (method, path) => method === 'POST' && (path === '/api/plan/save' || /^\/api\/plan\/\d+\/check$/.test(path))
  },
  {
    id: 'pay-simulate',
    limit: envInt('RATE_LIMIT_PAY', 30),
    windowMs: 60 * 1000,
    test: (method, path) => method === 'POST' && /^\/api\/payments\/\d+\/simulate$/.test(path)
  },
  {
    id: 'upload',
    limit: envInt('RATE_LIMIT_UPLOAD', 20),
    windowMs: 60 * 60 * 1000,
    test: (method, path) => method === 'POST' && path === '/api/materials'
  },
  {
    id: 'review',
    limit: envInt('RATE_LIMIT_REVIEW', 20),
    windowMs: 60 * 60 * 1000,
    test: (method, path) => method === 'POST' && /^\/api\/materials\/\d+\/reviews$/.test(path)
  },
  {
    id: 'ticket',
    limit: envInt('RATE_LIMIT_TICKET', 10),
    windowMs: 60 * 60 * 1000,
    test: (method, path) => method === 'POST' && path === '/api/tickets'
  },
  {
    id: 'bargain-assist',
    limit: envInt('RATE_LIMIT_BARGAIN_ASSIST', 60),
    windowMs: 60 * 1000,
    test: (method, path) => method === 'POST' && /^\/api\/bargains\/\d+\/assist$/.test(path)
  }
];

const buckets = new Map();

// 受信反向代理层数：仅在 TRUST_PROXY 开启时生效，从右向左取代理追加的真实来源。
const TRUST_PROXY_HOPS = envInt('TRUST_PROXY_HOPS', 1);

function clientIp(req) {
  // 仅在明确配置了受信反向代理时读取 X-Forwarded-For，避免客户端伪造 IP 绕过限流。
  // 取最右侧（由最近一跳代理追加）的地址：客户端自行添加的左侧条目不可信。
  if (runtime.TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const hops = String(forwarded).split(',').map((item) => item.trim()).filter(Boolean);
      if (hops.length) {
        const index = Math.max(0, hops.length - TRUST_PROXY_HOPS);
        return runtime.normalizeIp(hops[index]);
      }
    }
  }
  return runtime.normalizeIp(req.socket.remoteAddress || 'unknown');
}

function check(req, method, pathname) {
  const rule = RULES.find((r) => r.test(method, pathname));
  if (!rule) return { allowed: true };

  const key = `${rule.id}:${clientIp(req)}`;
  const current = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= current) {
    bucket = { count: 0, resetAt: current + rule.windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > rule.limit) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - current) / 1000)),
      message: '操作过于频繁，请稍后再试'
    };
  }
  return { allowed: true };
}

setInterval(() => {
  const current = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= current) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

module.exports = { check, clientIp, RULES };
