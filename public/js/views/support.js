import { api } from '../api.js';
import { esc, dateAgo, ticketStatusMeta, TICKET_TYPE_TEXT, verifyMeta } from '../util.js';
import { icon, toast, openModal, emptyState, loadingBlock } from '../components.js';
import { state, requireLogin, refreshSupportUnread } from '../layout.js';
import { SITE_INFO } from '../site.js';

const TABS = [
  ['ai', 'AI 智能客服', 'bot'],
  ['new', '提交反馈', 'receipt'],
  ['mine', '我的工单', 'clipboard'],
  ['faq', '常见问题', 'help']
];

const AI_WELCOME = '你好，我是学涯集市 AI 智能客服，7×24 小时在线。认证、支付、下载、退款、上传审核、定价、砍价、资源库搜索等问题都可以直接问我。';
const AI_HOT = ['如何完成实名认证？', '支持哪些支付方式？', '购买后怎么下载资料？', '怎么申请退款？', '院校 / 学科 / 教师怎么搜索？'];
const aiSession = {
  messages: [{ role: 'assistant', text: AI_WELCOME, suggestions: AI_HOT.slice(0, 3) }],
  loading: false
};

const OFFICIAL_TYPES = [
  ['bug', 'Bug 报错', '功能异常、页面报错、下载失败等'],
  ['suggestion', '功能建议', '希望新增或优化的功能'],
  ['complaint', '交易投诉', '资料与描述不符、卖家服务问题'],
  ['other', '其他咨询', '认证、定价、账号等其他问题']
];

export async function renderSupport(root, ctx) {
  // 记录当前挂载根节点，供 reload 复用，避免直接操作全局 #app
  ctx = { ...ctx, root };
  const tab = TABS.some((t) => t[0] === ctx.query.tab) ? ctx.query.tab : 'ai';
  const user = state.user;
  root.innerHTML = `<div class="loading-wrap">${loadingBlock('正在加载客服中心…')}</div>`;

  let mine = { items: [], counts: {} };
  if (user) {
    try {
      mine = await api.get('/api/tickets?scope=mine');
    } catch {
      /* 列表失败不阻断反馈入口 */
    }
  }
  const support = (state.meta && state.meta.support) || {};
  const mineUnread = mine.items.reduce((sum, t) => sum + (t.unread || 0), 0);

  root.innerHTML = `<div class="view-enter">
    <div class="page-hero support-hero">
      <div class="row-between wrap">
        <div>
          <div class="section-kicker">SUPPORT CENTER</div>
          <h1>客服与反馈中心</h1>
          <p>AI 智能客服 7×24 小时在线，自动实时解答认证、交易、下载与资源库问题；需要人工处理时可提交工单，与卖家的沟通统一在「消息中心」。</p>
        </div>
        <div class="support-hero-tags">
          <span class="badge green">${icon('bot')} AI 客服 7×24 小时在线</span>
          <span class="badge gray">${esc(support.responseText || 'AI 客服实时响应 · 人工工单按序处理')}</span>
        </div>
      </div>
    </div>

    <div class="support-channels">
      <div class="panel channel-card">
        <span class="channel-icon accent">${icon('bot')}</span>
        <div>
          <b>AI 智能客服 · 7×24 小时</b>
          <p>自动实时解答认证、支付、下载、退款、上传、定价与资源库使用问题，无需登录。</p>
          <a class="link small" href="#/support?tab=ai">立即咨询 ${icon('chevronRight')}</a>
        </div>
      </div>
      <div class="panel channel-card">
        <span class="channel-icon">${icon('headphones')}</span>
        <div>
          <b>平台人工客服 · 工单受理</b>
          <p>账号、认证、交易与售后问题可提交工单；人工客服暂未设置固定服务时间，处理进展通过工单与站内消息同步。</p>
          <span class="small muted">${esc(support.email || SITE_INFO.email)}</span>
        </div>
      </div>
      <div class="panel channel-card">
        <span class="channel-icon gold">${icon('message')}</span>
        <div>
          <b>卖家沟通 · 统一入口</b>
          <p>资料咨询、价格与售后沟通均在「消息中心」统一处理，支持咨询场景与快捷回复。</p>
          <a class="link small" href="#/messages">前往消息中心 ${icon('chevronRight')}</a>
        </div>
      </div>
    </div>

    <div class="tabs" style="margin-top:20px">
      ${TABS.map(([key, text]) => {
        const badge = key === 'mine' && mineUnread ? `<span class="count">${mineUnread}</span>` : '';
        return `<a class="tab ${tab === key ? 'active' : ''}" href="#/support?tab=${key}">${esc(text)}${badge}</a>`;
      }).join('')}
    </div>

    <div data-support-body>
      ${tab === 'ai' ? aiTab() : ''}
      ${tab === 'new' ? newTab(user) : ''}
      ${tab === 'mine' ? listTab(mine, user, '你还没有提交过工单') : ''}
      ${tab === 'faq' ? faqTab(support) : ''}
    </div>
  </div>`;

  if (tab === 'ai') bindAi(root);
  if (tab === 'new') bindNew(root, ctx);
  if (tab === 'mine') bindList(root, ctx);
  root.querySelectorAll('[data-ticket]').forEach((el) => {
    el.addEventListener('click', () => openTicketModal(Number(el.dataset.ticket), () => reload(ctx)));
  });
}

function reload(ctx) {
  renderSupport(ctx.root || document.getElementById('app'), { ...ctx, query: { tab: ctx.query.tab || 'ai' } });
  refreshSupportUnread();
}

function aiTab() {
  return `<div class="split-2 ai-support-grid">
    <div class="panel ai-chat">
      <div class="ai-chat-head">
        <span class="ai-avatar">${icon('bot')}</span>
        <div class="ai-chat-title">
          <b>AI 智能客服</b>
          <span class="small muted"><i class="ai-online"></i>7×24 小时在线 · 自动实时回复</span>
        </div>
        <span class="badge green">在线</span>
      </div>
      <div class="ai-chat-body" data-ai-body></div>
      <form class="ai-chat-input" data-ai-form>
        <input class="input" name="message" maxlength="500" autocomplete="off" placeholder="输入你的问题，例如：怎么完成实名认证？" aria-label="咨询 AI 智能客服">
        <button class="btn btn-primary" type="submit">${icon('send')} 发送</button>
      </form>
      <p class="ai-chat-tip small muted">AI 客服可即时解答常见问题；需要人工处理时请提交工单。人工客服暂未设置固定服务时间，也不提供客服热线。</p>
    </div>
    <div class="stack" style="gap:16px">
      <div class="panel panel-pad">
        <h4 style="font-size:16px;margin-bottom:10px">${icon('sparkles')} 可以这样问</h4>
        <div class="ai-quick">
          ${AI_HOT.map((q) => `<button class="chip ghost" type="button" data-ai-ask="${esc(q)}">${esc(q)}</button>`).join('')}
        </div>
      </div>
      <div class="panel panel-pad">
        <h4 style="font-size:16px;margin-bottom:10px">服务说明</h4>
        <div class="stack" style="gap:10px">
          <div class="guarantee">${icon('clock')} 服务时间：7×24 小时全天候在线</div>
          <div class="guarantee">${icon('lock')} 无需登录即可咨询，问题仅用于即时回复</div>
          <div class="guarantee">${icon('receipt')} 需要人工处理时，转交「提交反馈」工单</div>
          <div class="guarantee">${icon('headphones')} 人工客服暂未设置固定服务时间，后续另行配置</div>
        </div>
      </div>
    </div>
  </div>`;
}

function formatAi(text) {
  return esc(text).replace(/\n/g, '<br>');
}

function paintAi(root) {
  const body = root.querySelector('[data-ai-body]');
  if (!body) return;
  body.innerHTML = aiSession.messages.map((m) => {
    if (m.role === 'user') {
      return `<div class="ai-msg user"><div class="ai-bubble"><p>${formatAi(m.text)}</p></div></div>`;
    }
    const suggestions = (m.suggestions || []).length
      ? `<div class="ai-suggest">${m.suggestions.map((q) => `<button class="chip ghost" type="button" data-ai-suggest="${esc(q)}">${esc(q)}</button>`).join('')}</div>`
      : '';
    return `<div class="ai-msg bot">
      <span class="ai-msg-avatar">${icon('bot')}</span>
      <div class="ai-bubble"><p>${formatAi(m.text)}</p>${suggestions}</div>
    </div>`;
  }).join('') + (aiSession.loading
    ? `<div class="ai-msg bot"><span class="ai-msg-avatar">${icon('bot')}</span><div class="ai-bubble ai-typing"><i></i><i></i><i></i></div></div>`
    : '');
  body.scrollTop = body.scrollHeight;
}

async function sendAi(text, root) {
  const message = String(text || '').trim();
  if (!message || aiSession.loading) return;
  aiSession.messages.push({ role: 'user', text: message });
  aiSession.loading = true;
  paintAi(root);
  try {
    const res = await api.post('/api/support/ai', { message });
    aiSession.messages.push({ role: 'assistant', text: res.reply, suggestions: res.suggestions || [] });
  } catch (err) {
    aiSession.messages.push({
      role: 'assistant',
      text: `抱歉，AI 客服暂时无法响应：${err.message}`,
      suggestions: AI_HOT.slice(0, 3)
    });
  } finally {
    aiSession.loading = false;
    paintAi(root);
  }
}

function bindAi(root) {
  paintAi(root);
  const body = root.querySelector('[data-ai-body]');
  const form = root.querySelector('[data-ai-form]');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = form.querySelector('input[name="message"]');
    const value = input.value;
    input.value = '';
    sendAi(value, root);
  });
  root.querySelectorAll('[data-ai-ask]').forEach((btn) => {
    btn.addEventListener('click', () => sendAi(btn.dataset.aiAsk, root));
  });
  body?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ai-suggest]');
    if (btn) sendAi(btn.dataset.aiSuggest, root);
  });
}

function newTab(user) {
  if (!user) {
    return `<div class="panel panel-pad">${emptyState({
      iconName: 'headphones', title: '登录后即可提交反馈',
      text: '官方客服与工单系统面向所有注册用户开放，登录后可追踪处理进度',
      action: '<button class="btn btn-primary" type="button" data-support-login>登录 / 注册</button>'
    })}</div>`;
  }
  return `<div class="split-2 support-form-grid">
    <form class="panel panel-pad" data-ticket-form>
      <h3 style="font-size:18px;margin-bottom:6px">提交反馈工单</h3>
      <p class="small muted" style="margin-bottom:16px">请尽量描述清楚问题出现的页面、操作步骤与期望结果，便于客服快速定位。</p>
      <div class="field" style="margin-bottom:14px">
        <label class="label">问题类型</label>
        <select class="select" name="type">
          ${OFFICIAL_TYPES.map(([value, label, desc]) => `<option value="${value}">${label} · ${desc}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="margin-bottom:14px">
        <label class="label">标题 <span class="muted small">（选填，留空将按类型自动生成）</span></label>
        <input class="input" name="title" maxlength="80" placeholder="例如：购买后下载按钮无响应">
      </div>
      <div class="field" style="margin-bottom:16px">
        <label class="label">详细描述 <span class="req">*</span></label>
        <textarea class="textarea" name="content" maxlength="2000" style="min-height:150px" placeholder="请描述具体问题、复现步骤，以及你使用的设备或浏览器…"></textarea>
      </div>
      <div class="row" style="justify-content:flex-end">
        <button class="btn btn-primary" type="submit">${icon('send')} 提交工单</button>
      </div>
    </form>
    <div class="stack" style="gap:16px">
      <div class="panel panel-pad">
        <h4 style="font-size:16px;margin-bottom:10px">处理流程</h4>
        <div class="steps">
          <div class="step"><b>1</b><div><strong>提交诉求</strong><span>选择类型并描述问题，系统生成工单编号</span></div></div>
          <div class="step"><b>2</b><div><strong>客服受理</strong><span>提交后进入人工工单队列，处理进展通过站内消息与工单状态同步</span></div></div>
          <div class="step"><b>3</b><div><strong>状态追踪</strong><span>工单在「我的工单」中实时显示待处理 / 处理中 / 已解决</span></div></div>
          <div class="step"><b>4</b><div><strong>回复通知</strong><span>客服回复后，顶部客服入口与悬浮按钮会显示未读提醒</span></div></div>
        </div>
      </div>
      <div class="panel panel-pad">
        <h4 style="font-size:16px;margin-bottom:10px">${icon('shieldCheck')} 认证提示</h4>
        <p class="small muted">当前账号：${verifyBadge(user)}</p>
        <p class="small muted" style="margin-top:8px">认证用户可正常买卖资料；未认证用户仍可提交反馈与咨询客服。</p>
      </div>
    </div>
  </div>`;
}

function verifyBadge(user) {
  const meta = verifyMeta(user.verifyStatus);
  return `<span class="badge ${meta.cls}">${meta.text}</span> ${esc(user.school || '未选择院校')}`;
}

function listTab(data, user, emptyText) {
  if (!user) {
    return `<div class="panel panel-pad">${emptyState({
      iconName: 'clipboard', title: '登录后查看工单',
      text: '登录后可查看工单处理进度与客服回复',
      action: '<button class="btn btn-primary" type="button" data-support-login>登录 / 注册</button>'
    })}</div>`;
  }
  if (!data.items.length) {
    return `<div class="panel panel-pad">${emptyState({ iconName: 'inbox', title: emptyText, text: '有新问题随时提交，客服会尽快响应' })}</div>`;
  }
  return `<div class="panel panel-pad ticket-list">
    ${data.items.map((t) => {
      const meta = ticketStatusMeta(t.status);
      return `<div class="ticket-item ${t.unread ? 'unread' : ''}" data-ticket="${t.id}" role="button" tabindex="0">
        <span class="ticket-icon">${icon('receipt')}</span>
        <div class="ticket-main">
          <div class="ticket-top">
            <b>${esc(t.title)}</b>
            <span class="badge ${meta.cls}">${meta.text}</span>
            ${t.unread ? '<span class="unread-dot"></span>' : ''}
          </div>
          <p class="ticket-snippet">${esc(t.content)}</p>
          <div class="ticket-meta">
            <span>#${t.id}</span>
            <span>${TICKET_TYPE_TEXT[t.type] || '其他'}</span>
            <span>平台官方客服</span>
            <span>${dateAgo(t.updatedAt)}</span>
            <span>${t.replyCount} 条回复</span>
          </div>
        </div>
        <span class="ticket-arrow">${icon('chevronRight')}</span>
      </div>`;
    }).join('')}
  </div>`;
}

function faqTab(support) {
  const faq = support.faq || [];
  return `<div class="split-2">
    <div class="panel panel-pad">
      <h3 style="font-size:18px;margin-bottom:14px">常见问题</h3>
      ${faq.length ? faq.map((item) => `<details class="faq-item">
        <summary>${esc(item.q)}</summary>
        <p>${esc(item.a)}</p>
      </details>`).join('') : '<p class="muted small">暂无常见问题</p>'}
    </div>
    <div class="panel panel-pad">
      <h3 style="font-size:18px;margin-bottom:12px">联系官方客服</h3>
      <div class="stack" style="gap:12px">
        <div class="guarantee">${icon('bot')} AI 智能客服：7×24 小时在线，实时自动回复</div>
        <div class="guarantee">${icon('mail')} 邮箱：${esc(support.email || SITE_INFO.email)}</div>
        <div class="guarantee">${icon('receipt')} 人工客服：通过工单受理，暂未设置固定服务时间</div>
        <div class="guarantee">${icon('shieldCheck')} 交易投诉会在 48 小时内给出处理结论</div>
      </div>
      <p class="small muted" style="margin-top:16px">常见问题可先询问 AI 客服；需要人工跟进时，提交工单并选择「交易投诉」，平台会优先处理。</p>
      <a class="btn btn-soft btn-sm" style="margin-top:12px" href="#/support?tab=ai">${icon('bot')} 去问 AI 客服</a>
    </div>
  </div>`;
}

function bindNew(root, ctx) {
  const loginBtn = root.querySelector('[data-support-login]');
  loginBtn?.addEventListener('click', () => requireLogin());
  const form = root.querySelector('[data-ticket-form]');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!requireLogin()) return;
    const data = new FormData(form);
    const submit = form.querySelector('button[type="submit"]');
    submit.setAttribute('aria-busy', 'true');
    try {
      const res = await api.post('/api/tickets', {
        kind: 'official',
        type: data.get('type'),
        title: data.get('title'),
        content: data.get('content')
      });
      toast(res.message);
      form.reset();
      await refreshSupportUnread();
      window.location.hash = '#/support?tab=mine';
      reload({ ...ctx, query: { tab: 'mine' } });
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      submit.removeAttribute('aria-busy');
    }
  });
}

function bindList(root, ctx) {
  root.querySelector('[data-support-login]')?.addEventListener('click', () => requireLogin());
}

export function openTicketModal(id, onChange) {
  const modal = openModal({
    title: '工单详情',
    subtitle: '正在加载…',
    body: `<div class="loading-wrap">${loadingBlock('正在加载工单…')}</div>`,
    footer: `<button class="btn btn-ghost" data-cancel>关闭</button>`,
    wide: true
  });
  modal.el.querySelector('[data-cancel]').addEventListener('click', modal.close);

  const draw = async () => {
    let data;
    try {
      data = await api.get(`/api/tickets/${id}`);
    } catch (err) {
      modal.bodyEl.innerHTML = '<p class="muted">工单加载失败，请稍后重试。</p>';
      return toast(err.message, 'error');
    }
    const t = data.ticket;
    const isOwner = state.user && t.user.id === state.user.id;
    const meta = ticketStatusMeta(t.status);
    const subtitle = modal.el.querySelector('.modal-head p');
    if (subtitle) subtitle.textContent = `#${t.id} · 官方工单 · ${meta.text}`;
    modal.bodyEl.innerHTML = `
      <div class="ticket-detail-head">
        <div>
          <h3>${esc(t.title)}</h3>
          <div class="ticket-meta">
            <span class="badge ${meta.cls}">${meta.text}</span>
            <span>${TICKET_TYPE_TEXT[t.type] || '其他'}</span>
            <span>${dateAgo(t.createdAt)} 提交</span>
            ${t.materialTitle ? `<span>关联资料：${esc(t.materialTitle)}</span>` : ''}
          </div>
        </div>
        <div class="ticket-detail-actions">
          ${(isOwner && t.status !== 'closed') ? '<button class="btn btn-quiet btn-sm" data-close-ticket>关闭工单</button>' : ''}
          ${(!isOwner && t.status !== 'closed') ? `<button class="btn btn-ghost btn-sm" data-status="processing">标记处理中</button>
            <button class="btn btn-soft btn-sm" data-status="resolved">标记已解决</button>` : ''}
        </div>
      </div>

      <div class="ticket-thread">
        <div class="ticket-msg">
          <div class="ticket-msg-head"><b>${esc(t.user.nickname)}</b><span>${esc(t.user.school || '用户')} · ${dateAgo(t.createdAt)}</span></div>
          <p>${esc(t.content)}</p>
        </div>
        ${data.replies.map((r) => `<div class="ticket-msg ${r.role === 'admin' ? 'staff' : ''}">
          <div class="ticket-msg-head">
            <b>${esc(r.author.nickname)}</b>
            <span>${r.role === 'admin' ? '平台官方客服' : '用户'} · ${dateAgo(r.createdAt)}</span>
          </div>
          <p>${esc(r.content)}</p>
        </div>`).join('')}
      </div>

      ${t.status === 'closed' ? '<p class="muted small" style="margin-top:14px">该工单已关闭，无法继续回复。</p>' : `<div class="field" style="margin-top:16px">
        <label class="label">追加回复</label>
        <textarea class="textarea" data-ticket-reply maxlength="2000" style="min-height:88px" placeholder="补充说明或回复客服…"></textarea>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:10px">
        <button class="btn btn-primary" data-send-reply>${icon('send')} 发送回复</button>
      </div>`}
    `;

    modal.el.querySelectorAll('[data-status]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const res = await api.post(`/api/tickets/${id}/status`, { status: btn.dataset.status });
          toast(res.message);
          await refreshSupportUnread();
          onChange && onChange();
          await draw();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
    modal.el.querySelector('[data-close-ticket]')?.addEventListener('click', async () => {
      try {
        const res = await api.post(`/api/tickets/${id}/status`, { status: 'closed' });
        toast(res.message);
        onChange && onChange();
        await draw();
      } catch (err) { toast(err.message, 'error'); }
    });
    modal.el.querySelector('[data-send-reply]')?.addEventListener('click', async (e) => {
      const content = modal.el.querySelector('[data-ticket-reply]').value.trim();
      if (!content) return toast('请输入回复内容', 'error');
      const btn = e.currentTarget;
      btn.setAttribute('aria-busy', 'true');
      try {
        const res = await api.post(`/api/tickets/${id}/replies`, { content });
        toast(res.message);
        await refreshSupportUnread();
        onChange && onChange();
        await draw();
      } catch (err) {
        toast(err.message, 'error');
        btn.removeAttribute('aria-busy');
      }
    });
  };
  draw();
  return modal;
}
