import { bus, setRouteSignal } from './api.js';
import { parseHash } from './util.js';
import { state, bootSession, loadMeta, renderHeader, renderFooter, renderTabbar, openAuthModal, renderSupportFab, refreshSupportUnread, refreshMessageUnread } from './layout.js';
import { icon, toast, emptyState, closeAllModals } from './components.js';
import { renderHome } from './views/home.js';
import { renderMarket } from './views/market.js';
import { renderCatalog } from './views/catalog.js';
import { renderMaterial } from './views/material.js';
import { renderBargain, renderBargains } from './views/bargain.js';
import { renderUpload } from './views/upload.js';
import { renderWants } from './views/wants.js';
import { renderMessages } from './views/messages.js';
import { renderMe, renderSellerPublic } from './views/me.js';
import { renderSeller } from './views/seller.js';
import { renderAdmin } from './views/admin.js';
import { renderInfo } from './views/info.js';
import { renderSupport } from './views/support.js';
import { renderPlan } from './views/plan.js';

const ROUTES = [
  { path: '/', view: renderHome, active: 'home', tab: 'home', title: '首页' },
  { path: '/market', view: renderMarket, active: 'market', tab: 'market', title: '资料市场' },
  { path: '/catalog', view: renderCatalog, active: 'catalog', tab: 'market', title: '院校资源库' },
  { path: '/plan', view: renderPlan, active: 'plan', tab: 'market', title: 'AI 学习规划' },
  { path: '/material/:id', view: renderMaterial, active: 'market', tab: 'market', title: '资料详情' },
  { path: '/bargain/:id', view: renderBargain, active: 'market', tab: 'market', title: '好友砍价' },
  { path: '/bargains', view: renderBargains, tab: 'me', title: '我的砍价', auth: true },
  { path: '/upload', view: renderUpload, active: 'seller', tab: 'me', title: '上传资料', auth: true },
  { path: '/wants', view: renderWants, active: 'wants', tab: 'wants', title: '求购广场' },
  { path: '/messages', view: renderMessages, tab: 'me', title: '消息中心', auth: true },
  { path: '/me', view: renderMe, tab: 'me', title: '个人中心', auth: true },
  { path: '/seller', view: renderSeller, active: 'seller', tab: 'me', title: '卖家中心', auth: true },
  { path: '/admin', view: renderAdmin, title: '管理后台', auth: true, admin: true },
  { path: '/support', view: renderSupport, active: 'support', tab: 'me', title: '客服中心' },
  { path: '/u/:id', view: renderSellerPublic, title: '卖家主页' },
  { path: '/about', view: renderInfo, title: '关于我们' },
  { path: '/terms', view: renderInfo, title: '用户协议' },
  { path: '/privacy', view: renderInfo, title: '隐私政策' },
  { path: '/refund', view: renderInfo, title: '退款规则' },
  { path: '/rules', view: renderInfo, title: '交易规则' },
  { path: '/copyright', view: renderInfo, title: '版权保护' },
  { path: '/help', view: renderInfo, title: '帮助中心' }
];

const app = document.getElementById('app');
let lastPath = '';
let routeAbort = null;
let routeSeq = 0;
let currentCleanup = null;

function match(pattern, segments) {
  const p = pattern.split('/').filter(Boolean);
  if (p.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = segments[i];
    else if (p[i] !== segments[i]) return null;
  }
  return params;
}

function gate({ iconName, title, text, action }) {
  app.innerHTML = `<div class="panel gate-wrap view-enter">
    ${emptyState({ iconName, title, text, action })}
  </div>`;
}

async function router() {
  const { path, segments, query } = parseHash();

  // 先收尾上一页：执行卸载钩子、取消在途请求、关闭跨页弹窗
  if (currentCleanup) {
    try { currentCleanup(); } catch { /* 卸载失败不阻断导航 */ }
    currentCleanup = null;
  }
  if (routeAbort) routeAbort.abort();
  const controller = new AbortController();
  routeAbort = controller;
  setRouteSignal(controller.signal);
  closeAllModals();

  let matched = null;
  let params = {};
  for (const route of ROUTES) {
    const m = match(route.path, segments);
    if (m) { matched = route; params = m; break; }
  }

  renderHeader(matched ? matched.active : '');
  renderTabbar(matched ? matched.tab : '');
  document.title = `${matched ? matched.title : '页面不存在'} · 学涯集市`;

  const shouldScroll = path !== lastPath;
  lastPath = path;
  if (shouldScroll) window.scrollTo({ top: 0, behavior: 'auto' });

  if (!matched) {
    gate({
      iconName: 'alertCircle', title: '页面不存在', text: '链接可能已失效，回到首页继续逛逛吧',
      action: '<a class="btn btn-primary" href="#/">返回首页</a>'
    });
    return;
  }

  if (matched.auth && !state.user) {
    gate({
      iconName: 'lock', title: '需要登录后才能继续', text: '登录后即可上传资料、查看订单与消息',
      action: '<button class="btn btn-primary" type="button" data-gate-login>登录 / 注册</button>'
    });
    app.querySelector('[data-gate-login]')?.addEventListener('click', () => openAuthModal('login'));
    return;
  }

  if (matched.admin && state.user.role !== 'admin') {
    gate({
      iconName: 'shield', title: '仅管理员可访问', text: '当前账号没有管理后台权限',
      action: '<a class="btn btn-primary" href="#/">返回首页</a>'
    });
    return;
  }

  // 每次导航使用独立根节点：旧页面即使请求晚到，也只会写入已脱离文档的节点
  const seq = ++routeSeq;
  const viewRoot = document.createElement('div');
  viewRoot.className = 'route-root';
  app.replaceChildren(viewRoot);
  try {
    const cleanup = await matched.view(viewRoot, { params, query, segments, path });
    if (seq !== routeSeq || controller.signal.aborted) return;
    if (typeof cleanup === 'function') currentCleanup = cleanup;
    app.classList.remove('view-enter');
    void app.offsetWidth;
    app.classList.add('view-enter');
  } catch (err) {
    if (seq !== routeSeq || controller.signal.aborted || err.name === 'AbortError') return;
    console.error(err);
    gate({
      iconName: 'alertCircle', title: '页面加载失败', text: err.message,
      action: '<button class="btn btn-primary" type="button" data-action="reload">刷新页面</button>'
    });
  }
}

async function boot() {
  await bootSession();
  try { await loadMeta(); } catch { /* 网络异常时由各页面提示 */ }
  renderFooter();
  renderHeader();
  renderTabbar();
  renderSupportFab();
  await Promise.all([refreshSupportUnread(), refreshMessageUnread()]);
  await router();

  window.addEventListener('hashchange', router);
  bus.addEventListener('auth:changed', async () => {
    renderHeader();
    renderTabbar();
    await Promise.all([refreshSupportUnread(), refreshMessageUnread()]);
    router();
  });
  bus.addEventListener('session-expired', () => {
    state.user = null;
    renderHeader();
    renderTabbar();
    toast('登录状态已过期，请重新登录', 'error');
    openAuthModal('login');
  });
}

document.addEventListener('click', (e) => {
  // CSP 禁止内联事件处理器，重载按钮统一走事件委托
  if (e.target.closest('[data-action="reload"]')) {
    e.preventDefault();
    location.reload();
    return;
  }
  // 跳转主内容：只移动焦点，不能改动 hash（否则会被当成站内路由）
  if (e.target.closest('.skip-link')) {
    e.preventDefault();
    const main = document.getElementById('app');
    if (main) {
      main.focus({ preventScroll: true });
      main.scrollIntoView({ block: 'start' });
    }
    return;
  }
  const link = e.target.closest('a[href^="#/"]');
  if (!link) return;
  const href = link.getAttribute('href');
  if (window.location.hash === href) {
    e.preventDefault();
    router();
  }
});

// 路由切换会主动取消旧请求，这里吞掉对应的 AbortError，避免无意义的未处理异常
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason && e.reason.name === 'AbortError') e.preventDefault();
});
window.addEventListener('error', (e) => {
  if (e.error) console.error(e.error);
});

boot();
