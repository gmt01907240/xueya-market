import { api } from './api.js';
import { esc, money, moneyPlain } from './util.js';
import { icon, openModal, toast } from './components.js';

let channelsCache = null;

export async function getChannels(force = false) {
  if (!channelsCache || force) {
    channelsCache = await api.get('/api/payments/channels');
  }
  return channelsCache;
}

/* 用支付串生成确定性的示意二维码（演示环境不依赖外部二维码库） */
function qrMarkup(text) {
  let seed = 0;
  for (let i = 0; i < String(text).length; i++) seed = (seed * 31 + String(text).charCodeAt(i)) >>> 0;
  const isFinder = (r, c) => [[0, 0], [0, 14], [14, 0]].some(([zr, zc]) => {
    const dr = r - zr;
    const dc = c - zc;
    if (dr < 0 || dc < 0 || dr > 6 || dc > 6) return false;
    return dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
  });
  const cells = [];
  for (let r = 0; r < 21; r++) {
    for (let c = 0; c < 21; c++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const on = isFinder(r, c) || (seed >>> 16) % 100 < 46;
      cells.push(`<i class="${on ? 'on' : ''}"></i>`);
    }
  }
  return `<div class="pay-qr" aria-label="支付二维码示意图">${cells.join('')}</div>`;
}

function money2(cents) {
  return `¥${moneyPlain(cents)}`;
}

/**
 * 统一支付弹窗。调用方通过 createCharge(channel) 创建外部渠道支付单：
 *   返回 { payment, payPayload, mockMode }
 */
export function openPayModal({
  title = '确认支付',
  subtitle = '',
  amountCents = 0,
  createCharge,
  onPaid
} = {}) {
  const state = {
    channel: '',
    payment: null,
    payPayload: null,
    mockMode: false,
    expiresAt: 0,
    tick: null,
    poll: null,
    closed: false
  };

  const modal = openModal({
    title,
    subtitle,
    wide: true,
    body: '<div class="loading-wrap" style="padding:26px 0">正在加载支付方式…</div>',
    footer: '',
    onClose: () => {
      state.closed = true;
      clearInterval(state.tick);
      clearInterval(state.poll);
    }
  });

  const body = modal.bodyEl;

  function setFooter(html) {
    let foot = modal.el.querySelector('.modal-foot');
    if (!foot) {
      foot = document.createElement('div');
      foot.className = 'modal-foot';
      modal.el.appendChild(foot);
    }
    foot.innerHTML = html;
    return foot;
  }

  function setSelected(code) {
    state.channel = code;
    body.querySelectorAll('[data-channel]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.channel === code);
    });
    const channel = (channelsCache.channels || []).find((c) => c.code === code);
    const hint = body.querySelector('[data-hint]');
    if (hint && channel) {
      hint.innerHTML = `<b>${esc(channel.name)}</b> · ${esc(channel.description)}<br>
        <span>限额 ${esc(channel.limits)} · ${esc(channel.eta)} · 结算 ${esc(channel.settle)}</span>`;
    }
  }

  function renderChannels() {
    const list = channelsCache.channels || [];
    const cards = list.map((ch) => {
      const disabled = !ch.available;
      const note = `${ch.limits} · ${ch.eta}`;
      return `<button type="button" class="pay-channel ${disabled ? 'disabled' : ''}" data-channel="${ch.code}" ${disabled ? 'disabled' : ''}>
        <span class="pay-badge ${ch.code}">${esc(ch.badge)}</span>
        <span class="pay-channel-main"><b>${esc(ch.name)}</b><span>${esc(note)}</span></span>
        <span class="pay-radio" aria-hidden="true"></span>
      </button>`;
    }).join('');

    body.innerHTML = `<div class="pay-amount">
        <span>应付金额</span>
        <b>${money(amountCents)}</b>
        ${channelsCache.mode === 'mock' ? '<span class="badge gold">演示支付 · 不产生真实扣款</span>' : ''}
      </div>
      <div class="pay-channels">${cards}</div>
      <div class="pay-hint" data-hint></div>`;

    const first = list.find((ch) => ch.available);
    if (first) setSelected(first.code);

    body.querySelectorAll('[data-channel]').forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener('click', () => setSelected(btn.dataset.channel));
    });

    const footer = setFooter(`<button class="btn btn-ghost" type="button" data-cancel>取消</button>
      <button class="btn btn-primary" type="button" data-confirm>${icon('creditCard')} 确认支付 ${money(amountCents)}</button>`);
    footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    footer.querySelector('[data-confirm]').addEventListener('click', confirmCharge);
  }

  async function confirmCharge() {
    if (!state.channel) return toast('请选择支付方式', 'error');
    const btn = modal.el.querySelector('[data-confirm]');
    if (btn) btn.setAttribute('aria-busy', 'true');
    try {
      const res = await createCharge(state.channel);
      state.payment = res.payment;
      state.payPayload = res.payPayload;
      state.mockMode = !!res.mockMode;
      state.expiresAt = Date.now() + (res.payment.expiresIn || 0) * 1000;
      renderPayPanel();
    } catch (err) {
      toast(err.message, 'error');
      if (btn) btn.removeAttribute('aria-busy');
    }
  }

  function finish(payload) {
    state.closed = true;
    clearInterval(state.tick);
    clearInterval(state.poll);
    modal.close();
    if (onPaid) Promise.resolve(onPaid(payload)).catch((err) => toast(err.message, 'error'));
  }

  function panelHead(channelName, badge, extra) {
    return `<div class="pay-panel-head">
      <span class="pay-badge ${state.payment.channel}">${esc(badge)}</span>
      <div><b>${esc(channelName)}</b><span>${money2(amountCents)}${extra}</span></div>
    </div>`;
  }

  function mockBlocks() {
    if (!state.mockMode) return `<p class="small muted">当前为正式支付环境，请完成支付后点击「刷新支付状态」。</p>`;
    return `<div class="pay-mock">
      <div class="small muted">演示支付：不产生真实扣款，可直接模拟渠道回调验证支付成功与失败链路。</div>
      <div class="row" style="gap:10px;margin-top:8px">
        <button class="btn btn-primary btn-sm" type="button" data-mock="success">${icon('checkCircle')} 模拟支付成功</button>
        <button class="btn btn-quiet btn-sm" type="button" data-mock="fail">模拟支付失败</button>
      </div>
    </div>`;
  }

  function renderPayPanel() {
    const p = state.payment;
    const payload = state.payPayload || {};
    const isQrcode = payload.mode === 'qrcode';

    body.innerHTML = `<div class="pay-panel">
      ${panelHead(p.channelName, p.channelBadge, ` · 剩余 <b data-countdown>--:--</b>`)}
      ${isQrcode
        ? `${qrMarkup(payload.qrText || p.paymentNo)}
           <p class="pay-note">${esc(payload.note || '请使用手机扫码完成支付')}</p>`
        : `<div class="pay-transfer">
            <div><span>收款银行</span><b>${esc(payload.bankName || '—')}</b></div>
            <div><span>收款户名</span><b>${esc(payload.accountName || '—')}</b></div>
            <div><span>收款账号</span><b class="mono">${esc(payload.accountNo || '—')}</b></div>
            <div><span>转账附言</span><b class="mono">${esc(payload.remark || p.paymentNo)}</b></div>
           </div>
           <p class="pay-note">${esc(payload.note || '请通过网银或手机银行转账，附言填写支付单号。')}</p>`}
      <div class="pay-meta">支付单号 <b class="mono">${esc(p.paymentNo)}</b> · ${esc(p.settle || '')} 结算 · ${esc(p.eta || '')}</div>
      ${mockBlocks()}
    </div>`;

    const footer = setFooter(`<button class="btn btn-ghost" type="button" data-cancel>关闭</button>
      <button class="btn btn-primary" type="button" data-refresh>${icon('refresh')} 刷新支付状态</button>`);
    footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    footer.querySelector('[data-refresh]').addEventListener('click', checkStatus);

    body.querySelectorAll('[data-mock]').forEach((btn) => {
      btn.addEventListener('click', () => simulate(btn.dataset.mock));
    });

    startCountdown();
    startPolling();
  }

  function startCountdown() {
    clearInterval(state.tick);
    const paint = () => {
      const left = Math.max(0, Math.floor((state.expiresAt - Date.now()) / 1000));
      const el = body.querySelector('[data-countdown]');
      if (el) {
        el.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
      }
      if (left === 0) {
        clearInterval(state.tick);
        showFailure('支付超时', '支付单已超时关闭，请重新发起支付。');
      }
    };
    paint();
    state.tick = setInterval(paint, 1000);
  }

  function startPolling() {
    clearInterval(state.poll);
    state.poll = setInterval(checkStatus, 3000);
  }

  async function checkStatus() {
    if (state.closed || !state.payment) return;
    try {
      const data = await api.get(`/api/payments/${state.payment.id}`);
      const p = data.payment;
      state.payment = p;
      if (p.status === 'paid') {
        toast('支付成功，正在更新订单状态');
        finish(p);
      } else if (p.status === 'failed' || p.status === 'closed' || p.status === 'refunded') {
        clearInterval(state.poll);
        clearInterval(state.tick);
        showFailure(p.statusText, p.failureMessage || '该支付单已结束，请重新发起支付。');
      } else if (p.expiresIn > 0) {
        state.expiresAt = Date.now() + p.expiresIn * 1000;
      }
    } catch {
      /* 轮询失败静默重试 */
    }
  }

  async function simulate(result) {
    if (state.closed) return;
    const btn = body.querySelector(`[data-mock="${result}"]`);
    if (btn) btn.setAttribute('aria-busy', 'true');
    try {
      const res = await api.post(`/api/payments/${state.payment.id}/simulate`, { result });
      state.payment = res.payment;
      if (res.payment.status === 'paid') {
        toast('模拟支付成功');
        finish(res.payment);
      } else {
        clearInterval(state.poll);
        clearInterval(state.tick);
        showFailure(res.payment.statusText, res.payment.failureMessage || '渠道返回支付失败');
      }
    } catch (err) {
      toast(err.message, 'error');
      if (btn) btn.removeAttribute('aria-busy');
    }
  }

  function showFailure(statusText, message) {
    clearInterval(state.poll);
    clearInterval(state.tick);
    body.innerHTML = `<div class="pay-result fail">
      <div class="pay-result-icon">${icon('alertCircle')}</div>
      <h3>${esc(statusText || '支付未完成')}</h3>
      <p>${esc(message || '支付单已结束，请重新发起支付。')}</p>
    </div>`;
    const footer = setFooter(`<button class="btn btn-ghost" type="button" data-cancel>关闭</button>
      <button class="btn btn-primary" type="button" data-retry>重新选择支付方式</button>`);
    footer.querySelector('[data-cancel]').addEventListener('click', modal.close);
    footer.querySelector('[data-retry]').addEventListener('click', () => {
      state.payment = null;
      state.payPayload = null;
      renderChannels();
    });
  }

  getChannels()
    .then(() => renderChannels())
    .catch((err) => {
      body.innerHTML = `<div class="pay-result fail"><div class="pay-result-icon">${icon('alertCircle')}</div>
        <h3>支付方式加载失败</h3><p>${esc(err.message)}</p></div>`;
      setFooter('<button class="btn btn-ghost" type="button" data-cancel>关闭</button>')
        .querySelector('[data-cancel]').addEventListener('click', modal.close);
    });

  return modal;
}
