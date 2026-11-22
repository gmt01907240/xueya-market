import { api, auth, bus } from './api.js';
import { esc, moneyPlain, initials } from './util.js';
import { icon, avatar, toast, openModal } from './components.js';
import { attachSelectSearch } from './list-search.js';
import { SITE_INFO } from './site.js';

export const state = { user: null, meta: null, supportUnread: 0, messageUnread: 0 };

export async function bootSession() {
  if (!auth.token) return;
  try {
    const data = await api.get('/api/auth/me');
    state.user = data.user;
  } catch (err) {
    // 仅 401 视为登录态失效（api.js 已清理 token）；网络异常时保留本地登录态，等待重试
    if (err && err.status === 401) state.user = null;
  }
}

export async function loadMeta(force = false) {
  if (state.meta && !force) return state.meta;
  state.meta = await api.get('/api/meta');
  return state.meta;
}

export async function refreshUser() {
  if (!auth.token) { state.user = null; return null; }
  try {
    const data = await api.get('/api/auth/me');
    state.user = data.user;
  } catch {
    state.user = null;
  }
  renderHeader();
  renderTabbar();
  await Promise.all([refreshSupportUnread(), refreshMessageUnread()]);
  return state.user;
}

const NAV = [
  { key: 'home', href: '#/', text: '首页' },
  { key: 'market', href: '#/market', text: '资料市场' },
  { key: 'catalog', href: '#/catalog', text: '资源库' },
  { key: 'plan', href: '#/plan', text: 'AI 规划' },
  { key: 'wants', href: '#/wants', text: '求购广场' },
  { key: 'seller', href: '#/seller', text: '卖家中心' },
  { key: 'support', href: '#/support', text: '客服中心' }
];

function paintSupportDots() {
  document.querySelectorAll('[data-support-dot]').forEach((el) => {
    el.classList.toggle('hidden', !state.supportUnread);
  });
}

export async function refreshSupportUnread() {
  if (!auth.token) {
    state.supportUnread = 0;
  } else {
    try {
      const data = await api.get('/api/tickets/unread');
      state.supportUnread = (data.user || 0) + (data.staff || 0);
    } catch (err) {
      // 路由切换取消或网络抖动时保留上一次结果，避免未读角标被误清空
      if (err && (err.name === 'AbortError' || !err.status)) {
        // 保持原值
      } else {
        state.supportUnread = 0;
      }
    }
  }
  paintSupportDots();
  return state.supportUnread;
}

function paintMessageDots() {
  document.querySelectorAll('[data-message-dot]').forEach((el) => {
    el.classList.toggle('hidden', !state.messageUnread);
  });
}

export async function refreshMessageUnread() {
  if (!auth.token) {
    state.messageUnread = 0;
  } else {
    try {
      const data = await api.get('/api/threads/unread');
      state.messageUnread = data.total || 0;
    } catch (err) {
      // 路由切换取消或网络抖动时保留上一次结果，避免未读角标被误清空
      if (err && (err.name === 'AbortError' || !err.status)) {
        // 保持原值
      } else {
        state.messageUnread = 0;
      }
    }
  }
  if (state.user) state.user.unread = state.messageUnread;
  paintMessageDots();
  return state.messageUnread;
}

export function renderSupportFab() {
  if (document.getElementById('support-fab')) return;
  const wrap = document.createElement('div');
  wrap.id = 'support-fab';
  wrap.className = 'support-fab';
  wrap.innerHTML = `
    <div class="support-fab-menu hidden" data-fab-menu>
      <a href="#/support?tab=ai">${icon('bot')}<span>AI 智能客服</span></a>
      <a href="#/support?tab=new">${icon('receipt')}<span>提交反馈</span></a>
      <a href="#/support?tab=mine">${icon('clipboard')}<span>我的工单</span></a>
      <a href="#/support">${icon('headphones')}<span>官方客服</span></a>
    </div>
    <button class="support-fab-btn" type="button" aria-label="客服与反馈">
      ${icon('headphones')}
      <span class="support-fab-dot hidden" data-support-dot></span>
    </button>`;
  document.body.appendChild(wrap);
  const btn = wrap.querySelector('button');
  const menu = wrap.querySelector('[data-fab-menu]');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => menu.classList.add('hidden'));
  paintSupportDots();
}

function featureOn(key) {
  const env = state.meta && state.meta.environment;
  if (!env || !env.features) return true;
  return env.features[key] !== false;
}

function navVisible(item) {
  if (item.key === 'plan') return featureOn('plan');
  if (item.key === 'support') return featureOn('tickets') || featureOn('aiSupport');
  return true;
}

export function renderHeader(active = '') {
  const header = document.getElementById('site-header');
  if (!header) return;
  const user = state.user;
  const navHtml = NAV.filter(navVisible).map((item) =>
    `<a href="${item.href}" class="${active === item.key ? 'active' : ''}">${item.text}</a>`
  ).join('');

  const supportBtn = `<a class="icon-btn" href="#/support" title="客服与工单" aria-label="客服与工单">
      ${icon('headphones')}<span class="unread-dot ${state.supportUnread ? '' : 'hidden'}" data-support-dot></span>
    </a>`;

  const tools = user ? `
    <a class="balance-pill" href="#/me?tab=wallet" title="账户收益">收益 <b>¥${moneyPlain(user.balance)}</b></a>
    ${supportBtn}
    <a class="icon-btn" href="#/messages" title="消息中心" aria-label="消息中心">
      ${icon('message')}<span class="unread-dot ${state.messageUnread ? '' : 'hidden'}" data-message-dot></span>
    </a>
    ${featureOn('upload') ? `<a class="btn btn-primary btn-sm btn-header-upload" href="#/upload">${icon('upload')} 上传资料</a>` : ''}
    <div class="user-menu">
      <button class="user-trigger" type="button" data-user-trigger aria-haspopup="true">
        ${avatar(user.nickname)}
        <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="dropdown hidden" data-user-menu>
        <div class="dropdown-head">
          <b>${esc(user.nickname)}</b>
          <span>${esc(user.school || '未填写院校')} · ${user.role === 'admin' ? '平台管理员' : '个人用户'} · ${user.verified ? '已认证' : '未认证'}</span>
        </div>
        <a href="#/me">${icon('user')} 个人中心</a>
        <a href="#/me?tab=orders">${icon('bag')} 我的订单</a>
        ${featureOn('bargain') ? `<a href="#/bargains">${icon('gift')} 我的砍价</a>` : ''}
        <a href="#/me?tab=verify">${icon('shieldCheck')} 实名与高校认证 ${user.verified ? '<span class="badge green">已认证</span>' : '<span class="badge gold">待认证</span>'}</a>
        <a href="#/seller">${icon('chart')} 卖家中心</a>
        <a href="#/messages">${icon('message')} 消息中心 ${state.messageUnread ? `<span class="badge accent">${state.messageUnread}</span>` : ''}</a>
        <a href="#/support">${icon('headphones')} 客服与工单 ${state.supportUnread ? `<span class="badge accent">${state.supportUnread}</span>` : ''}</a>
        ${user.role === 'admin' ? `<a href="#/admin">${icon('shield')} 管理后台</a>` : ''}
        <div class="sep"></div>
        <button type="button" data-logout>${icon('logOut')} 退出登录</button>
      </div>
    </div>` : `
    ${supportBtn}
    <button class="btn btn-ghost btn-sm" type="button" data-open-auth="login">登录</button>
    ${featureOn('registration') ? '<button class="btn btn-primary btn-sm" type="button" data-open-auth="register">免费注册</button>' : ''}`;

  header.innerHTML = `<div class="header-inner">
    <a class="brand" href="#/" aria-label="学涯集市首页">
      <span class="brand-mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="#f6f2ea" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 5h6a3 3 0 0 1 3 3v11a3 3 0 0 0-3-3H3z"/><path d="M21 5h-6a3 3 0 0 0-3 3v11a3 3 0 0 1 3-3h6z"/>
        </svg>
      </span>
      <span class="brand-text">
        <span class="brand-name">学涯集市</span>
        <span class="brand-sub">XUEYA MARKET</span>
      </span>
    </a>
    <nav class="nav">${navHtml}</nav>
    <div class="header-tools">
      <form class="header-search" data-header-search>
        ${icon('search')}
        <input type="search" name="q" placeholder="搜索资料、课程…" aria-label="搜索资料">
      </form>
      ${tools}
    </div>
  </div>`;

  header.querySelector('[data-header-search]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = new FormData(e.target).get('q');
    window.location.hash = value ? `#/market?q=${encodeURIComponent(value)}` : '#/market';
  });

  header.querySelectorAll('[data-open-auth]').forEach((btn) => {
    btn.addEventListener('click', () => openAuthModal(btn.dataset.openAuth));
  });

  const trigger = header.querySelector('[data-user-trigger]');
  const menu = header.querySelector('[data-user-menu]');
  if (trigger && menu) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });
    document.addEventListener('click', () => menu.classList.add('hidden'), { once: true });
  }
  header.querySelector('[data-logout]')?.addEventListener('click', () => {
    auth.clear();
    state.user = null;
    state.supportUnread = 0;
    state.messageUnread = 0;
    renderHeader();
    renderTabbar();
    toast('已退出登录');
    window.location.hash = '#/';
    bus.dispatchEvent(new Event('auth:changed'));
  });
}

export function renderTabbar(active = '') {
  const bar = document.getElementById('mobile-tabbar');
  if (!bar) return;
  const items = [
    { key: 'home', href: '#/', text: '首页', iconName: 'home' },
    { key: 'market', href: '#/market', text: '市场', iconName: 'grid' },
    { key: 'wants', href: '#/wants', text: '求购', iconName: 'message' },
    { key: 'me', href: state.user ? '#/me' : '#/market', text: '我的', iconName: 'user' }
  ];
  bar.innerHTML = items.map((item) =>
    `<a href="${item.href}" class="${active === item.key ? 'active' : ''}">${icon(item.iconName)}<span>${item.text}</span></a>`
  ).join('');
}

export function renderFooter() {
  const footer = document.getElementById('site-footer');
  if (!footer) return;
  footer.innerHTML = `<div class="site-footer">
    <div class="footer-inner">
      <div class="footer-brand">
        <a class="brand" href="#/">
          <span class="brand-mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="#f6f2ea" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 5h6a3 3 0 0 1 3 3v11a3 3 0 0 0-3-3H3z"/><path d="M21 5h-6a3 3 0 0 0-3 3v11a3 3 0 0 1 3-3h6z"/>
            </svg>
          </span>
          <span class="brand-text"><span class="brand-name">学涯集市</span><span class="brand-sub">XUEYA MARKET</span></span>
        </a>
        <p>让每一份认真整理的笔记，都能遇到需要它的人。我们连接同校同专业的同学，用审核、托管与版权保护，让知识分享更安心。</p>
      </div>
      <div class="footer-col">
        <h5>逛一逛</h5>
        <a href="#/market">资料市场</a>
        <a href="#/catalog">院校资源库</a>
        <a href="#/market?sort=new">最新上架</a>
        <a href="#/market?price=free">免费专区</a>
        <a href="#/wants">求购广场</a>
      </div>
      <div class="footer-col">
        <h5>参与共建</h5>
        <a href="#/upload">上传资料</a>
        <a href="#/seller">卖家中心</a>
        <a href="#/me?tab=orders">我的订单</a>
        <a href="#/bargains">我的砍价</a>
        <a href="#/messages">消息中心</a>
      </div>
      <div class="footer-col">
        <h5>平台与规则</h5>
        <a href="#/about">关于我们</a>
        <a href="#/rules">交易规则</a>
        <a href="#/refund">退款规则</a>
        <a href="#/copyright">版权保护</a>
        <a href="#/terms">用户协议</a>
        <a href="#/privacy">隐私政策</a>
        <a href="#/support">客服与反馈</a>
        <a href="#/help">帮助中心</a>
      </div>
    </div>
    <div class="footer-legal">
      <span>运营主体：${SITE_INFO.company}</span>
      <span>ICP 备案号：<a href="https://beian.miit.gov.cn" target="_blank" rel="noopener">${SITE_INFO.icp}</a></span>
      <span>客服邮箱：${SITE_INFO.email}</span>
      <span>客服电话：${SITE_INFO.phone}</span>
    </div>
    <div class="footer-bottom">
      <span>© 2026 ${SITE_INFO.company} · ${SITE_INFO.brand} · 高校学习资料交易平台</span>
      <span class="footer-badge">${icon('shield')} 平台审核 · 资金托管 · 版权保护</span>
    </div>
  </div>`;
}

const DEMO = [
  { role: '个人用户', email: 'student@xueya.cn', password: 'Student123456' }
];

export function openAuthModal(mode = 'login', preset = {}) {
  const schools = (state.meta && state.meta.schools) || [];
  const env = (state.meta && state.meta.environment) || {};
  const registration = env.registration !== false;
  const inviteRequired = env.inviteRequired === true;
  const demoVisible = env.demo !== false;
  if (mode === 'register' && !registration) mode = 'login';
  const modal = openModal({
    title: mode === 'login' ? '欢迎回到学涯集市' : '加入学涯集市',
    subtitle: mode === 'login' ? '登录后可购买、下载与上传资料' : '完成实名与高校认证后即可交易',
    body: `
      <div class="auth-tabs">
        <button type="button" data-tab="login" class="${mode === 'login' ? 'active' : ''}">登录</button>
        ${registration ? `<button type="button" data-tab="register" class="${mode === 'register' ? 'active' : ''}">注册</button>` : ''}
      </div>
      <form class="auth-form" data-auth-form>
        <div data-login-fields class="${mode === 'login' ? '' : 'hidden'}">
          <div class="field" style="margin-bottom:14px">
            <label class="label">用户名 / 手机号<span class="req">*</span></label>
            <input class="input" name="account" autocomplete="username" maxlength="72" placeholder="请输入用户名或 11 位手机号">
          </div>
          <div class="field">
            <label class="label">密码<span class="req">*</span></label>
            <input class="input" name="loginPassword" type="password" autocomplete="current-password" maxlength="72" placeholder="请输入密码">
          </div>
          <div class="auth-forgot-row"><button type="button" class="link-btn" data-forgot>忘记密码？</button></div>
        </div>
        <div data-register-fields class="${mode === 'register' ? '' : 'hidden'}">
          <div class="auth-mode-switch" data-register-mode-switch>
            <button type="button" data-register-mode="account" class="active">邮箱注册</button>
            <button type="button" data-register-mode="phone">手机号注册</button>
          </div>
          <div data-email-register>
            <div class="form-grid" style="gap:14px">
              <div class="field"><label class="label">昵称<span class="req">*</span></label><input class="input" name="nickname" placeholder="例如：林知遥">
                <div class="field-hint">展示名称：会出现在资料页、评价和站内消息中，可使用中文，2—20 个字符。</div>
              </div>
              <div class="field"><label class="label">用户名<span class="req">*</span></label><input class="input" name="username" placeholder="3—20 个字符">
                <div class="field-hint">登录账号：用于登录并作为唯一标识，3—20 个字符，建议使用字母、数字或下划线，注册后不可修改。</div>
              </div>
              <div class="field"><label class="label">邮箱<span class="req">*</span></label><input class="input" name="email" type="email" placeholder="you@example.com"></div>
              <div class="field"><label class="label">所在院校</label>
                <select class="select" name="school">
                  <option value="">暂不填写</option>
                  ${schools.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
                </select>
              </div>
              <div class="field full"><label class="label">密码<span class="req">*</span></label><input class="input" name="registerPassword" type="password" autocomplete="new-password" placeholder="8—72 位，需包含字母和数字"></div>
              ${inviteRequired ? '<div class="field full"><label class="label">内测邀请码<span class="req">*</span></label><input class="input" name="inviteCode" placeholder="请输入内测邀请码" autocomplete="off"></div>' : ''}
            </div>
          </div>
          <div data-phone-register class="hidden">
            <div class="form-grid" style="gap:14px">
              <div class="field full"><label class="label">手机号<span class="req">*</span></label><input class="input" name="registerPhone" type="tel" maxlength="11" autocomplete="tel" placeholder="请输入 11 位手机号"></div>
              <div class="field full"><label class="label">短信验证码<span class="req">*</span></label>
                <div class="code-row">
                  <input class="input" name="registerCode" inputmode="numeric" maxlength="6" placeholder="6 位验证码">
                  <button class="btn btn-ghost btn-sm" type="button" data-send-code="register">获取验证码</button>
                </div>
                <div class="field-hint" data-code-hint>验证码 5 分钟内有效</div>
              </div>
              <div class="field full"><label class="label">昵称</label><input class="input" name="registerNickname" maxlength="20" placeholder="不填将自动生成，如：用户8866"></div>
              <div class="field full"><label class="label">设置密码<span class="req">*</span></label><input class="input" name="registerPhonePassword" type="password" autocomplete="new-password" placeholder="8—72 位，需包含字母和数字">
                <div class="field-hint">密码需同时包含字母与数字，用于手机号密码登录。</div>
              </div>
              ${inviteRequired ? '<div class="field full"><label class="label">内测邀请码<span class="req">*</span></label><input class="input" name="phoneInviteCode" placeholder="请输入内测邀请码" autocomplete="off"></div>' : ''}
            </div>
          </div>
        </div>
        <div class="error-text hidden" data-auth-error></div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">${mode === 'login' ? '登录' : '注册'}</button>
      </form>
      ${demoVisible ? `<div class="demo-accounts">
        <div class="small muted">个人用户登录后可同时使用买家与卖家全部功能；管理员请使用内部安全入口</div>
        <div class="demo-row">
          ${DEMO.map((d) => `<button class="demo-chip" type="button" data-demo="${d.email}" data-password="${d.password}">${d.role} · ${d.email}</button>`).join('')}
        </div>
      </div>` : ''}`,
    wide: true
  });

  const form = modal.el.querySelector('[data-auth-form]');
  const loginFields = modal.el.querySelector('[data-login-fields]');
  const registerFields = modal.el.querySelector('[data-register-fields]');
  const emailRegister = modal.el.querySelector('[data-email-register]');
  const phoneRegister = modal.el.querySelector('[data-phone-register]');
  const errorBox = modal.el.querySelector('[data-auth-error]');
  let current = mode;
  let registerMode = 'account';

  const submitBtn = form.querySelector('button[type="submit"]');
  const submitLabel = () => {
    if (current === 'register') return registerMode === 'phone' ? '手机号注册' : '注册';
    return '登录';
  };
  const refreshSubmit = () => { submitBtn.textContent = submitLabel(); };

  const setRegisterMode = (next) => {
    registerMode = next;
    modal.el.querySelectorAll('[data-register-mode]').forEach((b) => b.classList.toggle('active', b.dataset.registerMode === next));
    if (emailRegister) emailRegister.classList.toggle('hidden', next !== 'account');
    if (phoneRegister) phoneRegister.classList.toggle('hidden', next !== 'phone');
    errorBox.classList.add('hidden');
    refreshSubmit();
  };

  const switchTab = (next) => {
    current = next;
    modal.el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === next));
    loginFields.classList.toggle('hidden', next !== 'login');
    registerFields.classList.toggle('hidden', next !== 'register');
    refreshSubmit();
    errorBox.classList.add('hidden');
  };
  modal.el.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  modal.el.querySelectorAll('[data-register-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setRegisterMode(btn.dataset.registerMode));
  });
  modal.el.querySelectorAll('[data-send-code]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = form.elements.registerPhone;
      requestSmsCode(String(target?.value || '').trim(), btn.dataset.sendCode, btn, btn.closest('.field')?.querySelector('[data-code-hint]'));
    });
  });
  modal.el.querySelectorAll('[data-forgot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const account = String(form.elements.account?.value || '').trim();
      modal.close();
      openForgotPasswordModal(/^1[3-9]\d{9}$/.test(account) ? account : '');
    });
  });

  modal.el.querySelectorAll('[data-demo]').forEach((chip) => {
    chip.addEventListener('click', () => {
      switchTab('login');
      form.elements.account.value = chip.dataset.demo;
      form.elements.loginPassword.value = chip.dataset.password;
      form.requestSubmit();
    });
  });

  if (form.elements.school) {
    attachSelectSearch(form.elements.school, { placeholder: '搜索院校，如「清华」「师范」' });
  }

  setRegisterMode('account');
  if (preset.phone && form.elements.account) form.elements.account.value = String(preset.phone);
  refreshSubmit();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    errorBox.classList.add('hidden');
    submitBtn.setAttribute('aria-busy', 'true');
    try {
      let result;
      if (current === 'login') {
        const account = String(data.get('account') || '').trim();
        const password = String(data.get('loginPassword') || '');
        if (!account) throw new Error('请输入用户名或手机号');
        if (!password) throw new Error('请输入密码');
        // 手机号走手机号登录接口，用户名 / 邮箱走账号登录接口
        result = /^1[3-9]\d{9}$/.test(account)
          ? await api.post('/api/auth/login/phone', { phone: account, password })
          : await api.post('/api/auth/login', { account, password });
      } else if (registerMode === 'phone') {
        result = await api.post('/api/auth/register/phone', {
          phone: data.get('registerPhone'),
          code: data.get('registerCode'),
          password: data.get('registerPhonePassword'),
          nickname: data.get('registerNickname'),
          inviteCode: data.get('phoneInviteCode') || ''
        });
      } else {
        result = await api.post('/api/auth/register', {
          nickname: data.get('nickname'),
          username: data.get('username'),
          email: data.get('email'),
          school: data.get('school'),
          password: data.get('registerPassword'),
          inviteCode: data.get('inviteCode') || ''
        });
      }
      auth.setToken(result.token);
      state.user = result.user;
      modal.close();
      renderHeader();
      renderTabbar();
      toast(current === 'register' ? '注册成功，请完成实名与高校认证后开始交易' : `欢迎回来，${result.user.nickname}`);
      if (result.securityNotice) setTimeout(() => toast(result.securityNotice, 'error'), 1000);
      await Promise.all([refreshSupportUnread(), refreshMessageUnread()]);
      bus.dispatchEvent(new Event('auth:changed'));
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove('hidden');
    } finally {
      submitBtn.removeAttribute('aria-busy');
    }
  });
  return modal;
}

/** 发送短信验证码，60 秒倒计时防连点；开发环境展示演示验证码 */
async function requestSmsCode(phone, purpose, button, hintEl) {
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    toast('请输入有效的 11 位手机号', 'error');
    return;
  }
  const original = button.textContent;
  button.disabled = true;
  try {
    const res = await api.post('/api/auth/sms/send', { phone, purpose });
    if (res.devCode) {
      if (hintEl) hintEl.textContent = `演示环境验证码：${res.devCode}（5 分钟内有效）`;
      toast(`验证码已发送：${res.devCode}`);
    } else {
      toast(res.message);
    }
    let left = 60;
    button.textContent = `${left}s 后重发`;
    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        button.disabled = false;
        button.textContent = original;
      } else {
        button.textContent = `${left}s 后重发`;
      }
    }, 1000);
  } catch (err) {
    button.disabled = false;
    button.textContent = original;
    toast(err.message, 'error');
  }
}

/** 忘记密码：手机号 + 验证码校验 → 设置新密码 → 返回登录 */
function openForgotPasswordModal(prefillPhone = '') {
  const modal = openModal({
    title: '找回密码',
    subtitle: '验证注册手机号后设置新密码，完成后自动返回登录',
    body: `<div class="stack" style="gap:14px">
      <div data-step="verify">
        <div class="field">
          <label class="label">手机号</label>
          <input class="input" name="forgotPhone" type="tel" maxlength="11" autocomplete="tel" value="${esc(prefillPhone)}" placeholder="请输入注册手机号">
        </div>
        <div class="field">
          <label class="label">短信验证码</label>
          <div class="code-row">
            <input class="input" name="forgotCode" inputmode="numeric" maxlength="6" placeholder="6 位验证码">
            <button class="btn btn-ghost btn-sm" type="button" data-forgot-code>获取验证码</button>
          </div>
          <div class="field-hint" data-forgot-hint>验证码 5 分钟内有效，请勿泄露给他人</div>
        </div>
        <div class="error-text hidden" data-forgot-error></div>
        <button class="btn btn-primary btn-block" type="button" data-forgot-next>验证并继续</button>
      </div>
      <div data-step="reset" class="hidden">
        <div class="field-hint" style="margin-bottom:10px" data-reset-phone></div>
        <div class="field">
          <label class="label">新密码</label>
          <input class="input" name="newPassword" type="password" autocomplete="new-password" placeholder="8—72 位，需包含字母和数字">
          <div class="field-hint">新密码需同时包含字母和数字，且不能与原密码相同。</div>
        </div>
        <div class="field">
          <label class="label">确认新密码</label>
          <input class="input" name="confirmPassword" type="password" autocomplete="new-password" placeholder="请再次输入新密码">
        </div>
        <div class="error-text hidden" data-reset-error></div>
        <button class="btn btn-primary btn-block" type="button" data-reset-submit>确认重置</button>
      </div>
    </div>`,
    footer: '<button class="btn btn-ghost" data-cancel>取消</button>'
  });

  const el = modal.el;
  const phoneInput = el.querySelector('[name="forgotPhone"]');
  const codeInput = el.querySelector('[name="forgotCode"]');
  const verifyStep = el.querySelector('[data-step="verify"]');
  const resetStep = el.querySelector('[data-step="reset"]');
  const verifyError = el.querySelector('[data-forgot-error]');
  const resetError = el.querySelector('[data-reset-error]');
  let resetToken = '';

  el.querySelector('[data-cancel]').addEventListener('click', modal.close);
  el.querySelector('[data-forgot-code]').addEventListener('click', () => {
    requestSmsCode(String(phoneInput.value || '').trim(), 'reset', el.querySelector('[data-forgot-code]'), el.querySelector('[data-forgot-hint]'));
  });

  el.querySelector('[data-forgot-next]').addEventListener('click', async () => {
    const btn = el.querySelector('[data-forgot-next]');
    verifyError.classList.add('hidden');
    btn.setAttribute('aria-busy', 'true');
    try {
      const res = await api.post('/api/auth/password/forgot', {
        phone: String(phoneInput.value || '').trim(),
        code: String(codeInput.value || '').trim()
      });
      resetToken = res.resetToken;
      verifyStep.classList.add('hidden');
      resetStep.classList.remove('hidden');
      el.querySelector('[data-reset-phone]').textContent = `已通过手机号 ${res.phone} 验证，请在 ${Math.round(res.expiresIn / 60)} 分钟内设置新密码。`;
      el.querySelector('[name="newPassword"]').focus();
    } catch (err) {
      verifyError.textContent = err.message;
      verifyError.classList.remove('hidden');
    } finally {
      btn.removeAttribute('aria-busy');
    }
  });

  el.querySelector('[data-reset-submit]').addEventListener('click', async () => {
    const btn = el.querySelector('[data-reset-submit]');
    const password = String(el.querySelector('[name="newPassword"]').value || '');
    const confirm = String(el.querySelector('[name="confirmPassword"]').value || '');
    resetError.classList.add('hidden');
    if (password !== confirm) {
      resetError.textContent = '两次输入的密码不一致';
      resetError.classList.remove('hidden');
      return;
    }
    btn.setAttribute('aria-busy', 'true');
    try {
      const res = await api.post('/api/auth/password/reset', { resetToken, password, confirmPassword: confirm });
      modal.close();
      toast(res.message);
      openAuthModal('login', { phone: String(phoneInput.value || '').trim() });
    } catch (err) {
      resetError.textContent = err.message;
      resetError.classList.remove('hidden');
    } finally {
      btn.removeAttribute('aria-busy');
    }
  });
}

export function requireLogin() {
  if (state.user) return true;
  toast('请先登录后再继续', 'error');
  openAuthModal('login');
  return false;
}
