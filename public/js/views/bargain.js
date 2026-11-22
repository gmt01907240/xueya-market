import { api } from '../api.js';
import { esc, money, dateAgo, catIndex, CAT_GLYPHS } from '../util.js';
import { icon, avatar, toast, emptyState, loadingBlock, openModal } from '../components.js';
import { openPayModal } from '../pay.js';
import { state, requireLogin, refreshUser, openAuthModal } from '../layout.js';

const STATUS_BADGE = { active: 'accent', success: 'green', expired: 'gray', cancelled: 'gray' };

let timers = [];
function clearTimers() {
  timers.forEach((t) => clearInterval(t));
  timers = [];
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function timeText(seconds) {
  const sec = Math.max(0, Number(seconds) || 0);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  return days > 0
    ? `${days} 天 ${pad2(hours)}:${pad2(mins)}:${pad2(secs)}`
    : `${pad2(hours)}:${pad2(mins)}:${pad2(secs)}`;
}

function newRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function progressBar(percent, small = false) {
  return `<div class="bargain-progress${small ? ' sm' : ''}"><b style="width:${Math.max(0, Math.min(100, percent))}%"></b></div>`;
}

function shareLink(id) {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}#/bargain/${id}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('砍价链接已复制，发给好友即可助力');
    return;
  } catch { /* 回退 */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
    toast('砍价链接已复制，发给好友即可助力');
  } catch {
    toast('复制失败，请手动复制页面地址', 'error');
  } finally {
    area.remove();
  }
}

export async function renderBargain(root, ctx) {
  clearTimers();
  const id = Number(ctx.params.id);
  root.innerHTML = `<div class="loading-wrap">${loadingBlock('正在加载砍价详情…')}</div>`;
  let data;
  try {
    data = await api.get(`/api/bargains/${id}`);
  } catch (err) {
    root.innerHTML = emptyState({
      iconName: 'gift', title: '砍价单不存在或已失效', text: err.message,
      action: '<a class="btn btn-primary" href="#/market">去资料市场看看</a>'
    });
    return;
  }

  const o = data.order;
  const isOwner = !!state.user && state.user.id === o.owner.id;
  const idx = catIndex(o.material.category);
  const badge = STATUS_BADGE[o.status] || 'gray';
  const remaining = Math.max(0, o.currentPrice - o.floorPrice);

  const actions = [];
  if (o.status === 'active') {
    if (!state.user) {
      actions.push(`<button class="btn btn-primary btn-block btn-lg" type="button" data-login>${icon('users')} 登录后帮 TA 砍一刀</button>`);
    } else if (o.canAssist) {
      actions.push(`<button class="btn btn-primary btn-block btn-lg" type="button" data-assist>${icon('gift')} 帮 TA 砍一刀</button>`);
    } else {
      actions.push(`<button class="btn btn-ghost btn-block" type="button" disabled>${esc(o.assistHint || '暂时无法助力')}</button>`);
    }
    if (isOwner) {
      actions.push(`<button class="btn btn-accent btn-block" type="button" data-share>${icon('send')} 一键分享邀请好友</button>`);
    }
  } else if (o.status === 'success') {
    if (isOwner && o.purchased) {
      actions.push(`<a class="btn btn-accent btn-block btn-lg" href="#/material/${o.material.id}">${icon('download')} 已购买 · 前往下载</a>`);
    } else if (isOwner && o.canPurchase) {
      actions.push(`<button class="btn btn-accent btn-block btn-lg" type="button" data-purchase>${icon('bag')} 立即购买 ${money(o.currentPrice)}</button>`);
    } else if (!isOwner) {
      actions.push(`<div class="bargain-tip">${icon('checkCircle')} 这份资料已被砍到底价，等待发起人下单</div>`);
    }
  } else if (o.status === 'expired' && isOwner) {
    actions.push(`<button class="btn btn-primary btn-block" type="button" data-restart>${icon('refresh')} 重新发起砍价</button>`);
    actions.push(`<a class="btn btn-soft btn-block" href="#/material/${o.material.id}">${icon('bag')} 按原价购买</a>`);
  } else if (o.status === 'expired') {
    actions.push(`<div class="bargain-tip">${icon('clock')} 这个砍价已过期，让发起人重新发起吧</div>`);
  }

  root.innerHTML = `<div class="view-enter">
    <div class="breadcrumb">
      <a href="#/">首页</a>${icon('chevronRight')}
      <a href="#/market?category=${encodeURIComponent(o.material.category)}">${esc(o.material.category)}</a>${icon('chevronRight')}
      <a href="#/material/${o.material.id}">${esc(o.material.title)}</a>${icon('chevronRight')}
      <span>好友砍价</span>
    </div>

    <div class="bargain-layout">
      <div class="panel bargain-hero">
        <div class="bargain-head">
          <div>
            <div class="section-kicker">BARGAIN · 好友助力</div>
            <h1>${isOwner ? '邀请好友，一起砍到底价' : '帮 TA 砍一刀，离底价更近一步'}</h1>
          </div>
          <span class="badge ${badge}">${esc(o.statusText)}</span>
        </div>

        <a class="bargain-material" href="#/material/${o.material.id}">
          <span class="thumb cover-${idx}">${CAT_GLYPHS[idx]}</span>
          <span class="bargain-material-main">
            <b>${esc(o.material.title)}</b>
            <span>${esc(o.material.category)} · ${esc(o.material.school || '学涯集市')} · 发起人 ${esc(o.owner.nickname)}</span>
          </span>
          ${icon('chevronRight')}
        </a>

        <div class="bargain-price-row">
          <div class="bargain-price">
            <span class="now">${money(o.currentPrice)}</span>
            <span class="origin">原价 ${money(o.startPrice)}</span>
            <span class="floor">底价 ${money(o.floorPrice)}</span>
          </div>
          <div class="bargain-saved">已砍 <b>${money(o.saved)}</b></div>
        </div>

        ${progressBar(o.progress)}
        <div class="bargain-progress-labels">
          <span>进度 ${o.progress}%</span>
          <span>${remaining > 0 ? `距离底价还差 ${money(remaining)}` : '已到达底价'}</span>
        </div>

        <div class="bargain-meta">
          <div>
            <span>剩余时间</span>
            <b data-countdown>${o.status === 'active' ? timeText(o.expiresIn) : '—'}</b>
          </div>
          <div>
            <span>已助力好友</span>
            <b>${o.helperCount} / ${o.maxHelpers} 人</b>
          </div>
          <div>
            <span>我的助力次数</span>
            <b>${state.user ? `${o.myCutCount} / ${o.maxCutsPerUser} 次` : `每人 ${o.maxCutsPerUser} 次`}</b>
          </div>
          <div>
            <span>助力人数上限</span>
            <b>${o.maxHelpers} 人</b>
          </div>
        </div>

        <div class="bargain-actions">${actions.join('')}</div>
        <p class="bargain-note">${icon('lock')} 砍价金额与成交价均由服务端实时计算，分享链接仅供好友助力，无法篡改价格。</p>
      </div>

      <aside class="bargain-side">
        <div class="panel panel-pad">
          <div class="bargain-side-head">
            <h3>助力记录</h3>
            <span class="badge gray">${o.helpers.length} 次</span>
          </div>
          ${o.helpers.length ? `<div class="bargain-helpers">
            ${o.helpers.map((h) => `<div class="bargain-helper">
              ${avatar(h.nickname, 'sm')}
              <div class="bargain-helper-main">
                <b>${esc(h.nickname)}${h.mine ? ' <span class="badge gray">我</span>' : ''}</b>
                <span>${esc(h.school || '学涯集市用户')} · ${dateAgo(h.at)}</span>
              </div>
              <span class="bargain-cut">-${money(h.cut)}</span>
            </div>`).join('')}
          </div>` : `<div class="bargain-empty-helpers">${icon('users')} 还没有好友助力，${isOwner ? '把链接分享出去吧' : '来砍第一刀'}</div>`}
        </div>

        <div class="panel panel-pad bargain-rules">
          <h3>砍价规则</h3>
          <ul>
            <li>${icon('clock')} 活动有效期 ${o.durationHours} 小时，过期后自动结束</li>
            <li>${icon('users')} 最多 ${o.maxHelpers} 位好友助力，最后一位好友直接砍到底价</li>
            <li>${icon('gift')} 每位好友最多可助力 ${o.maxCutsPerUser} 次，金额随机</li>
            <li>${icon('shieldCheck')} 发起人不能给自己助力，同一请求重复提交只生效一次</li>
            <li>${icon('bag')} 砍到底价后，发起人可按砍价金额直接购买</li>
          </ul>
        </div>
      </aside>
    </div>
  </div>`;

  bindDetail(root, ctx, o, isOwner);

  if (o.status === 'active') {
    const countdown = root.querySelector('[data-countdown]');
    let left = o.expiresIn;
    timers.push(setInterval(() => {
      if (!document.body.contains(root) || !window.location.hash.startsWith(`#/bargain/${o.id}`)) return clearTimers();
      left = Math.max(0, left - 1);
      if (countdown) countdown.textContent = timeText(left);
      if (left <= 0) {
        clearTimers();
        renderBargain(root, ctx);
      }
    }, 1000));

    const sync = setInterval(async () => {
      if (!document.body.contains(root) || !window.location.hash.startsWith(`#/bargain/${o.id}`)) return clearTimers();
      try {
        const fresh = await api.get(`/api/bargains/${o.id}`);
        if (fresh.order.updatedAt !== o.updatedAt || fresh.order.status !== o.status) {
          clearTimers();
          renderBargain(root, ctx);
        }
      } catch { /* 网络波动时保持当前展示 */ }
    }, 5000);
    timers.push(sync);
  }
}

function bindDetail(root, ctx, o, isOwner) {
  root.querySelector('[data-login]')?.addEventListener('click', () => openAuthModal('login'));

  root.querySelector('[data-assist]')?.addEventListener('click', async (e) => {
    if (!requireLogin()) return;
    const btn = e.currentTarget;
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    try {
      const res = await api.post(`/api/bargains/${o.id}/assist`, { requestId: newRequestId() });
      toast(res.message, 'success');
      await renderBargain(root, ctx);
    } catch (err) {
      toast(err.message, 'error');
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
    }
  });

  root.querySelector('[data-share]')?.addEventListener('click', async () => {
    const url = shareLink(o.id);
    const text = `我在学涯集市砍价「${o.material.title}」，已砍到 ${money(o.currentPrice)}，快来帮我砍一刀！`;
    if (navigator.share) {
      try {
        await navigator.share({ title: '学涯集市 · 好友砍价', text, url });
        return;
      } catch { /* 用户取消或不支持时回退复制 */ }
    }
    await copyText(url);
  });

  root.querySelector('[data-purchase]')?.addEventListener('click', () => {
    if (!requireLogin()) return;
    if (!state.user.verified) {
      openVerifyGate();
      return;
    }
    openPayModal({
      title: '砍价专享价购买',
      subtitle: o.material.title,
      amountCents: o.currentPrice,
      createCharge: (channel) => api.post(`/api/bargains/${o.id}/purchase`, { channel }),
      onPaid: async () => {
        await refreshUser();
        toast('支付成功，资料已解锁');
        await renderBargain(root, ctx);
      }
    });
  });

  root.querySelector('[data-restart]')?.addEventListener('click', async (e) => {
    if (!requireLogin()) return;
    const btn = e.currentTarget;
    btn.setAttribute('aria-busy', 'true');
    try {
      const res = await api.post('/api/bargains', { materialId: o.material.id });
      toast(res.message);
      window.location.hash = `#/bargain/${res.orderId}`;
    } catch (err) {
      toast(err.message, 'error');
      btn.removeAttribute('aria-busy');
    }
  });
}

function openVerifyGate() {
  const modal = openModal({
    title: '完成认证后可购买',
    subtitle: '未认证账号仅可浏览与助力',
    body: `<p class="prose">为了保障交易安全，按砍价金额购买资料前需要完成<strong>实名认证 + 高校认证</strong>。</p>
      <div class="steps" style="margin-top:14px">
        <div class="step"><b>1</b><div><strong>填写真实姓名与学号</strong><span>选择所在高校并提交学号</span></div></div>
        <div class="step"><b>2</b><div><strong>等待管理员审核</strong><span>通常在 1 个工作日内完成</span></div></div>
        <div class="step"><b>3</b><div><strong>认证后即可购买下载</strong><span>同时解锁上传与出售资料</span></div></div>
      </div>`,
    footer: `<button class="btn btn-ghost" data-cancel>稍后再说</button>
             <a class="btn btn-primary" href="#/me?tab=verify" data-go-verify>${icon('badgeCheck')} 前往认证</a>`
  });
  modal.el.querySelector('[data-cancel]').addEventListener('click', modal.close);
  modal.el.querySelector('[data-go-verify]').addEventListener('click', modal.close);
}

export async function renderBargains(root) {
  clearTimers();
  root.innerHTML = `<div class="loading-wrap">${loadingBlock('正在加载我的砍价…')}</div>`;
  let data;
  try {
    data = await api.get('/api/bargains/mine');
  } catch (err) {
    root.innerHTML = emptyState({ iconName: 'alertCircle', title: '加载失败', text: err.message });
    return;
  }
  const items = data.items || [];
  const counts = data.counts || {};

  root.innerHTML = `<div class="view-enter">
    <div class="section-head bargain-list-head">
      <div>
        <div class="section-kicker">MY BARGAINS</div>
        <h2>我的砍价</h2>
        <p class="muted small">分享给好友助力，砍到底价后可按砍价金额直接购买。</p>
      </div>
      <div class="bargain-counts">
        <span class="chip">进行中 <b>${counts.active || 0}</b></span>
        <span class="chip">已成功 <b>${counts.success || 0}</b></span>
        <span class="chip">已过期 <b>${counts.expired || 0}</b></span>
      </div>
    </div>

    ${items.length ? `<div class="panel panel-pad bargain-list">
      ${items.map((o) => {
        const idx = catIndex(o.material.category);
        const badge = STATUS_BADGE[o.status] || 'gray';
        return `<a class="bargain-item" href="#/bargain/${o.id}">
          <span class="thumb cover-${idx}">${CAT_GLYPHS[idx]}</span>
          <span class="bargain-item-main">
            <span class="bargain-item-head">
              <b>${esc(o.material.title)}</b>
              <span class="badge ${badge}">${esc(o.statusText)}</span>
            </span>
            <span class="bargain-item-price">
              <b>${money(o.currentPrice)}</b>
              <s>${money(o.startPrice)}</s>
              <span>底价 ${money(o.floorPrice)}</span>
            </span>
            ${progressBar(o.progress, true)}
            <span class="bargain-item-foot">
              <span>${icon('users')} ${o.helperCount}/${o.maxHelpers} 人助力</span>
              <span>${icon('gift')} 已砍 ${o.progress}%</span>
              <span>${icon('clock')} ${o.status === 'active' ? `剩余 ${timeText(o.expiresIn)}` : esc(o.statusText)}</span>
            </span>
          </span>
        </a>`;
      }).join('')}
    </div>` : `<div class="panel panel-pad">${emptyState({
      iconName: 'gift', title: '还没有发起过砍价',
      text: '在资料详情页点击「发起砍价」，分享给好友即可享受更低价格',
      action: '<a class="btn btn-primary" href="#/market">去资料市场看看</a>'
    })}</div>`}
  </div>`;
}
