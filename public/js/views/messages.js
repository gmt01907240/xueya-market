import { api } from '../api.js';
import { esc, dateAgo, dateShort } from '../util.js';
import { icon, avatar, toast, openModal, emptyState, loadingBlock } from '../components.js';
import { refreshUser, refreshMessageUnread } from '../layout.js';

const FALLBACK_SCENES = [
  { key: 'consult', text: '资料咨询', desc: '内容、版本与适用范围', quickReplies: ['这份资料包含最新年份吗？', '资料大概多少页？', '是否包含完整答案或解析？'] },
  { key: 'price', text: '价格与优惠', desc: '价格、打包与优惠', quickReplies: ['可以小刀吗？', '买多份有优惠吗？', '价格包含后续更新吗？'] },
  { key: 'delivery', text: '交付与下载', desc: '文件格式、下载与更新', quickReplies: ['是 PDF 还是可编辑源文件？', '购买后可以立即下载吗？', '后续更新会免费提供吗？'] },
  { key: 'after_sale', text: '售后问题', desc: '文件异常、内容不符', quickReplies: ['下载后文件打不开怎么办？', '内容和描述不一致，怎么处理？', '可以申请退款吗？'] },
  { key: 'free', text: '自由沟通', desc: '不限话题的日常沟通', quickReplies: ['同学你好，想咨询一下～', '还有其他相关资料推荐吗？', '好的，谢谢你的解答。'] }
];

let chatMetaCache = null;

export async function loadChatMeta(force = false) {
  if (chatMetaCache && !force) return chatMetaCache;
  try {
    const data = await api.get('/api/threads/meta');
    chatMetaCache = {
      scenes: (data.scenes || []).map((s) => ({
        ...s,
        quickReplies: (data.quickReplies && data.quickReplies[s.key]) || []
      }))
    };
  } catch {
    chatMetaCache = { scenes: FALLBACK_SCENES };
  }
  return chatMetaCache;
}

function sceneOf(meta, key) {
  return meta.scenes.find((s) => s.key === key) || meta.scenes[meta.scenes.length - 1];
}

function perspectiveMeta(perspective) {
  if (perspective === 'sell') return { text: '我是卖家', cls: 'seller' };
  if (perspective === 'buy') return { text: '我是买家', cls: 'buyer' };
  return { text: '同学', cls: '' };
}

export async function renderMessages(root, ctx) {
  const threadId = Number(ctx.query.thread) || 0;
  const perspective = ['sell', 'buy', 'peer'].includes(ctx.query.perspective) ? ctx.query.perspective : '';
  const listHref = `#/messages${perspective ? `?perspective=${perspective}` : ''}`;
  const threadHref = (id) => `#/messages?${perspective ? `perspective=${perspective}&` : ''}thread=${id}`;
  root.innerHTML = `<div class="loading-wrap">${loadingBlock('正在加载消息…')}</div>`;

  let threads;
  let meta;
  let detail = null;
  try {
    [threads, meta] = await Promise.all([
      api.get(`/api/threads${perspective ? `?perspective=${perspective}` : ''}`),
      loadChatMeta()
    ]);
    if (threadId) detail = await api.get(`/api/threads/${threadId}`);
  } catch (err) {
    root.innerHTML = emptyState({ iconName: 'alertCircle', title: '消息加载失败', text: err.message });
    return;
  }
  if (threadId) {
    refreshMessageUnread();
    refreshUser();
  }

  const items = threads.items || [];
  const listHtml = items.length ? items.map((t) => {
    const rm = perspectiveMeta(t.perspective);
    return `<a class="thread-item ${t.id === threadId ? 'active' : ''}" href="${threadHref(t.id)}">
      ${avatar(t.other.nickname)}
      <div class="thread-main">
        <div class="thread-top">
          <b>${esc(t.other.nickname)}</b>
          <span>${dateAgo(t.lastMessageAt)}</span>
        </div>
        <div class="thread-preview">${t.lastMessage ? `${t.lastMessage.mine ? '我：' : ''}${esc(t.lastMessage.content)}` : '还没有消息'}</div>
        <div class="thread-tags">
          <span class="thread-tag ${rm.cls}">${rm.text}</span>
          <span class="thread-tag">${t.context.type === 'material' ? icon('file') : t.context.type === 'want' ? icon('message') : icon('user')}${esc(t.context.title)}</span>
          <span class="thread-tag accent">${esc(t.sceneText)}</span>
        </div>
      </div>
      ${t.unread > 0 ? `<span class="unread-badge">${t.unread}</span>` : ''}
    </a>`;
  }).join('') : `<div class="empty" style="padding:40px 18px">
      <div class="empty-icon">${icon('message')}</div>
      <h4>还没有会话</h4>
      <p>在资料详情页点击「联系卖家」，或从求购广场联系同学，会话都会统一出现在这里</p>
      <a class="btn btn-primary btn-sm" href="#/market">去逛资料市场</a>
    </div>`;

  const perspectiveTabs = [
    ['', '全部会话'],
    ['buy', '我是买家'],
    ['sell', '我是卖家']
  ];

  root.innerHTML = `<div class="view-enter">
    <div class="page-hero">
      <div class="row-between wrap">
        <div>
          <h1>消息中心</h1>
          <p>卖家咨询、求购沟通与历史私信已合并为统一会话，咨询场景与快捷回复同步保留</p>
        </div>
        <div class="support-hero-tags">
          <span class="badge ${threads.unread ? 'accent' : 'gray'}">${threads.unread ? `${threads.unread} 条未读` : '暂无未读'}</span>
          <span class="badge gray">${items.length} 个会话</span>
        </div>
      </div>
    </div>
    <div class="tabs" style="margin-top:20px">
      ${perspectiveTabs.map(([key, text]) => `<a class="tab ${perspective === key ? 'active' : ''}" href="#/messages${key ? `?perspective=${key}` : ''}">${text}</a>`).join('')}
    </div>
    <div class="panel chat-layout ${threadId ? 'mobile-detail' : ''}">
      <div class="chat-side">
        <div class="chat-side-head row-between">
          <h3>会话</h3>
          <span class="small muted">${items.length} 个</span>
        </div>
        <div class="thread-list">${listHtml}</div>
      </div>
      <div class="chat-main">
        ${detail ? chatDetail(detail, meta, listHref) : `<div class="chat-empty">
          <div>
            <div class="empty-icon" style="margin:0 auto 14px">${icon('message')}</div>
            <h4 style="color:var(--ink)">选择一个会话开始聊天</h4>
            <p class="small">卖家咨询与自由沟通已统一，历史记录随时可查</p>
          </div>
        </div>`}
      </div>
    </div>
  </div>`;

  if (detail) bindChat(root, ctx, detail, meta, listHref);
}

function chatDetail(detail, meta, listHref) {
  const t = detail.thread;
  const scenes = meta.scenes;
  return `<div class="chat-head">
      <a class="btn btn-quiet btn-sm chat-back" href="${listHref}" aria-label="返回会话列表">${icon('arrowLeft')}</a>
      ${avatar(t.other.nickname)}
      <div style="min-width:0">
        <b>${esc(t.other.nickname)}</b>
        <span>${esc(t.other.school || '学涯集市同学')} · ${perspectiveMeta(t.perspective).text}</span>
      </div>
      ${t.material ? `<a class="chat-context" href="#/material/${t.material.id}">${icon('file')} ${esc(t.material.title)}</a>` : ''}
      ${!t.material && t.want ? `<span class="chat-context">${icon('message')} ${esc(t.want.title)}</span>` : ''}
      ${!t.material && !t.want ? '<span class="chat-context">自由沟通</span>' : ''}
      <label class="chat-scene">
        <span>场景</span>
        <select class="select" data-scene-select>
          ${scenes.map((s) => `<option value="${s.key}" ${s.key === t.scene ? 'selected' : ''}>${esc(s.text)}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="chat-messages">
      ${detail.messages.length ? detail.messages.map((m) => `<div class="msg ${m.mine ? 'mine' : ''}">
        ${!m.mine ? avatar(m.sender.nickname, 'sm') : ''}
        <div>
          <div class="msg-bubble">${esc(m.content)}</div>
        </div>
        <span class="msg-time">${dateShort(m.createdAt)}</span>
      </div>`).join('') : '<div class="chat-empty"><p class="small">还没有消息，打个招呼吧</p></div>'}
    </div>
    <div class="quick-replies" data-quick-row>
      ${(detail.quickReplies || []).map((q) => `<button class="chip" type="button" data-quick="${esc(q)}">${esc(q)}</button>`).join('')}
    </div>
    <div class="chat-input">
      <textarea data-chat-input maxlength="1000" placeholder="输入消息，Enter 发送，Shift + Enter 换行" rows="1"></textarea>
      <button class="btn btn-primary" type="button" data-chat-send>${icon('send')} 发送</button>
    </div>`;
}

function bindChat(root, ctx, detail, meta, listHref) {
  const box = root.querySelector('.chat-messages');
  if (box) box.scrollTop = box.scrollHeight;

  const input = root.querySelector('[data-chat-input]');
  root.querySelectorAll('[data-quick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.quick;
      input.focus();
    });
  });

  const send = async () => {
    const content = input.value.trim();
    if (!content) return;
    const btn = root.querySelector('[data-chat-send]');
    btn.setAttribute('aria-busy', 'true');
    try {
      await api.post(`/api/threads/${detail.thread.id}/messages`, { content, scene: detail.thread.scene });
      input.value = '';
      await refreshMessageUnread();
      await renderMessages(root, ctx);
    } catch (err) {
      toast(err.message, 'error');
      btn.removeAttribute('aria-busy');
    }
  };
  root.querySelector('[data-chat-send]')?.addEventListener('click', send);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  root.querySelector('[data-scene-select]')?.addEventListener('change', async (e) => {
    const scene = e.target.value;
    try {
      const res = await api.patch(`/api/threads/${detail.thread.id}`, { scene });
      toast(res.message);
      await renderMessages(root, { ...ctx, query: { ...ctx.query, perspective: ctx.query.perspective || '' } });
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/**
 * 统一的「联系卖家 / 联系同学」入口：选择咨询场景、使用快捷回复后发送，
 * 消息直接进入统一会话，发送完成跳转到消息中心继续沟通。
 */
export async function openChatComposer(options = {}) {
  const {
    toUserId, toName = '卖家', materialId = null, materialTitle = '',
    wantId = null, wantTitle = '', scene = '', title = '联系卖家'
  } = options;
  if (!toUserId) return;
  const meta = await loadChatMeta();
  const scenes = meta.scenes;
  const initial = scenes.some((s) => s.key === scene) ? scene : (materialId ? 'consult' : 'free');
  let current = initial;
  const contextLabel = materialTitle
    ? `关联资料：${materialTitle}`
    : wantTitle
      ? `关联求购：${wantTitle}`
      : '';

  const modal = openModal({
    title,
    subtitle: `${toName} · 消息统一保存在消息中心`,
    wide: true,
    body: `${contextLabel ? `<div class="chat-context-line">${icon(materialId ? 'file' : 'message')}<span>${esc(contextLabel)}</span></div>` : ''}
      <div class="field" style="margin:14px 0 12px">
        <label class="label">咨询场景</label>
        <div class="scene-picker" data-scene-picker>
          ${scenes.map((s) => `<button type="button" class="chip ${s.key === current ? 'active' : ''}" data-scene="${s.key}">${esc(s.text)}</button>`).join('')}
        </div>
        <div class="hint" data-scene-desc>${esc(sceneOf(meta, current).desc)}</div>
      </div>
      <div class="quick-replies compact" data-quick-row>
        ${quickButtons(sceneOf(meta, current))}
      </div>
      <div class="field" style="margin-top:12px">
        <label class="label">消息内容</label>
        <textarea class="textarea" data-chat-msg maxlength="1000" style="min-height:120px" placeholder="请描述你想了解的问题，自由沟通也可以直接输入…"></textarea>
      </div>
      <p class="small muted">发送后可在「消息中心」继续沟通，未读状态与历史记录会自动同步。</p>`,
    footer: `<button class="btn btn-ghost" data-cancel>取消</button>
             <button class="btn btn-primary" data-send>${icon('send')} 发送消息</button>`
  });

  const msg = modal.el.querySelector('[data-chat-msg]');
  const paintScene = (key) => {
    current = key;
    const active = sceneOf(meta, key);
    modal.el.querySelectorAll('[data-scene]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scene === key);
    });
    const desc = modal.el.querySelector('[data-scene-desc]');
    if (desc) desc.textContent = active.desc;
    const row = modal.el.querySelector('[data-quick-row]');
    if (row) row.innerHTML = quickButtons(active);
    bindQuick(row, msg);
  };
  const bindQuick = (row, textarea) => {
    row?.querySelectorAll('[data-quick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        textarea.value = btn.dataset.quick;
        textarea.focus();
      });
    });
  };
  modal.el.querySelectorAll('[data-scene]').forEach((btn) => {
    btn.addEventListener('click', () => paintScene(btn.dataset.scene));
  });
  bindQuick(modal.el.querySelector('[data-quick-row]'), msg);

  modal.el.querySelector('[data-cancel]').addEventListener('click', modal.close);
  modal.el.querySelector('[data-send]').addEventListener('click', async (e) => {
    const content = msg.value.trim();
    if (!content) return toast('请输入消息内容', 'error');
    if (content.length > 1000) return toast('单条消息不能超过 1000 字', 'error');
    const btn = e.currentTarget;
    btn.setAttribute('aria-busy', 'true');
    try {
      const res = await api.post('/api/threads', {
        toUserId,
        materialId: materialId || undefined,
        wantId: wantId || undefined,
        content,
        scene: current
      });
      await refreshMessageUnread();
      modal.close();
      toast('消息已发送');
      window.location.hash = `#/messages?thread=${res.threadId}`;
    } catch (err) {
      toast(err.message, 'error');
      btn.removeAttribute('aria-busy');
    }
  });
  return modal;
}

function quickButtons(scene) {
  return (scene.quickReplies || []).map((q) => `<button class="chip" type="button" data-quick="${esc(q)}">${esc(q)}</button>`).join('');
}
