import { api, downloadFile } from '../api.js';
import { esc, money, dateAgo, fileSize, fileExt, catIndex } from '../util.js';
import { icon, avatar, stars, materialCard, openModal, toast, emptyState, loadingBlock } from '../components.js';
import { openPayModal } from '../pay.js';
import { state, requireLogin, refreshUser } from '../layout.js';
import { openChatComposer } from './messages.js';

export async function renderMaterial(root, ctx) {
  const id = Number(ctx.params.id);
  root.innerHTML = `<div class="loading-wrap">${loadingBlock('正在打开资料…')}</div>`;
  let data;
  try {
    data = await api.get(`/api/materials/${id}`);
  } catch (err) {
    root.innerHTML = emptyState({
      iconName: 'alertCircle', title: '资料不存在或已下架', text: err.message,
      action: '<a class="btn btn-primary" href="#/market">返回资料市场</a>'
    });
    return;
  }
  const m = data.material;
  let bargainInfo = null;
  if (m.price > 0) {
    try { bargainInfo = await api.get(`/api/bargains/material/${m.id}`); } catch { /* 砍价信息加载失败不影响主流程 */ }
  }
  const isOwner = !!(state.user && m.seller && state.user.id === m.seller.id);
  const isAdmin = !!(state.user && state.user.role === 'admin');
  const purchased = data.purchased;
  const idx = catIndex(m.category);

  const bargainActivity = bargainInfo?.activity || null;
  const myBargain = bargainInfo?.myOrder || null;
  let bargainAction = '';
  if (!isOwner && !purchased && m.price > 0) {
    if (myBargain) {
      const label = myBargain.status === 'active'
        ? `继续砍价 · 已砍至 ${money(myBargain.currentPrice)}`
        : myBargain.status === 'success'
          ? `砍价成功 · ${money(myBargain.currentPrice)} 购买`
          : '查看我的砍价单';
      bargainAction = `<a class="btn btn-soft btn-block" href="#/bargain/${myBargain.id}">${icon('gift')} ${label}</a>`;
    } else if (bargainActivity) {
      bargainAction = `<button class="btn btn-soft btn-block" type="button" data-bargain>${icon('gift')} 发起砍价 · 最低 ${money(bargainActivity.floorPrice)}</button>`;
    }
  }

  const priceHtml = m.price === 0
    ? '<span class="num free">免费</span><span class="unit">· 登录后即可下载</span>'
    : `<span class="num">${money(m.price)}</span><span class="unit">/ 份 · 一次购买永久下载</span>`;

  let primaryAction;
  if (isOwner) {
    primaryAction = `<a class="btn btn-soft btn-block btn-lg" href="#/seller">${icon('settings')} 管理我的资料</a>`;
  } else if (purchased) {
    primaryAction = `<button class="btn btn-accent btn-block btn-lg" type="button" data-download>${icon('download')} 下载资料</button>`;
  } else {
    primaryAction = `<button class="btn btn-accent btn-block btn-lg" type="button" data-buy>${icon('bag')} 立即购买</button>`;
  }

  root.innerHTML = `<div class="view-enter">
    <div class="breadcrumb">
      <a href="#/">首页</a>${icon('chevronRight')}
      <a href="#/market?category=${encodeURIComponent(m.category)}">${esc(m.category)}</a>${icon('chevronRight')}
      <span>${esc(m.title)}</span>
    </div>
    <div class="detail-grid">
      <div class="panel detail-main">
        <div class="detail-tags">
          <span class="badge">${esc(m.category)}</span>
          ${m.school ? `<span class="badge gray">${esc(m.school)}</span>` : ''}
          ${m.subject ? `<span class="badge gray">学科 · ${esc(m.subject)}</span>` : ''}
          ${m.teacher ? `<span class="badge gray">老师 · ${esc(m.teacher)}</span>` : ''}
          ${m.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
          ${purchased && !isOwner ? '<span class="badge green">已购买</span>' : ''}
          ${m.status !== 'approved' ? `<span class="badge gold">${m.status === 'pending' ? '待审核' : m.status === 'rejected' ? '未通过审核' : '已下架'}</span>` : ''}
        </div>
        <h1>${esc(m.title)}</h1>
        <div class="detail-meta">
          <span>${icon('user')} ${esc(m.seller.nickname)}</span>
          <span>${icon('school')} ${esc(m.school || '未填写院校')}</span>
          <span>${icon('download')} ${m.downloads} 次下载</span>
          <span>${icon('eye')} ${m.views} 次浏览</span>
          <span>${icon('clock')} 更新于 ${dateAgo(m.updatedAt)}</span>
        </div>

        <div class="detail-section">
          <h3>资料预览 <span class="badge gray">前 ${m.previewRatio || 15}% 试读</span></h3>
          <div class="preview-box">
            <div class="preview-file">
              <span class="file-icon">${esc(fileExt(m.fileName))}</span>
              <div>
                <b>${esc(m.fileName)}</b>
                <span>${fileSize(m.fileSize)} · ${purchased || isOwner ? '已解锁，可下载原文件' : '完整文件需购买后下载'}</span>
              </div>
            </div>
            <div class="preview-toolbar">
              <span class="badge ${purchased || isOwner ? 'green' : 'gold'}">${purchased || isOwner ? '已解锁完整内容' : '试读片段 · 禁止复制与下载'}</span>
              <span class="small muted" data-preview-count>正在加载试读内容…</span>
            </div>
            <div class="preview-paper" data-preview-paper aria-readonly="true">
              <div class="preview-loading">正在加载试读内容…</div>
              <div class="preview-watermark">学涯集市 · 试读片段</div>
            </div>
            ${purchased || isOwner
              ? `<div class="preview-unlocked">${icon('checkCircle')} 你已解锁这份资料，可在右侧下载完整文件。</div>`
              : `<div class="preview-lock">${icon('lock')} 预览仅展示前 ${m.previewRatio || 15}% 内容，已禁用复制、右键与下载，仅用于购买决策参考。</div>`}
          </div>
        </div>

        <div class="detail-section">
          <h3>资料介绍</h3>
          <p class="prose">${esc(m.description)}</p>
        </div>

        <div class="detail-section">
          <h3>购买须知</h3>
          <p class="prose">· 本资料为虚拟商品，购买后可在「我的订单」中随时下载，不限制次数。
· 平台对资料进行人工审核，但不对资料内容的完整性作绝对担保，请结合介绍与评价判断。
· 若资料与描述严重不符，可在订单完成后 7 天内申请退款，由平台介入核实。
· 请勿将购买的资料二次传播或转售，共同维护校园资料的版权环境。</p>
        </div>

        <div class="detail-section" id="reviews">
          <h3>同学评价 <span class="muted small" style="font-family:var(--sans);font-weight:400">${m.ratingCount} 条</span></h3>
          ${m.ratingCount ? `<div class="rating-summary">
            <div class="rating-big">
              <b>${m.rating.toFixed(1)}</b>
              ${stars(m.rating)}
              <span>${m.ratingCount} 位同学评价</span>
            </div>
            <div class="rating-bars">
              ${[5, 4, 3, 2, 1].map((star) => {
                const count = data.distribution[star] || 0;
                const pct = m.ratingCount ? Math.round((count / m.ratingCount) * 100) : 0;
                return `<div class="rating-bar"><span>${star} 星</span><i><b style="width:${pct}%"></b></i><span>${count}</span></div>`;
              }).join('')}
            </div>
          </div>` : ''}
          ${data.reviews.length ? data.reviews.map((r) => `<div class="review">
            <div class="review-head">
              ${avatar(r.user.nickname, 'sm')}
              <b>${esc(r.user.nickname)}</b>
              ${stars(r.rating)}
              <span>${dateAgo(r.createdAt)}</span>
            </div>
            <p>${esc(r.content || '这位同学没有留下文字评价')}</p>
          </div>`).join('') : `<p class="muted small" style="padding:8px 0 14px">还没有评价，购买后可以成为第一个分享感受的人。</p>`}

          ${data.canReview ? `<form class="review-form" data-review-form>
            <div class="label" style="margin-bottom:8px">给这份资料打个分</div>
            <div class="star-input" data-star-input>
              ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" class="on" aria-label="${n} 星">${icon('star')}</button>`).join('')}
            </div>
            <div class="field" style="margin-top:12px">
              <textarea class="textarea" name="content" maxlength="300" placeholder="说说资料的质量、排版或对你的帮助（选填）" style="min-height:88px"></textarea>
            </div>
            <div class="row" style="margin-top:12px;justify-content:flex-end">
              <button class="btn btn-primary btn-sm" type="submit">发布评价</button>
            </div>
          </form>` : (!isOwner && !purchased ? `<p class="muted small">购买并下载后，就可以在这里发表评价。</p>` : '')}
        </div>
      </div>

      <aside>
        <div class="panel buy-card">
          <div class="buy-price">${priceHtml}</div>
          <div class="buy-note">${purchased ? '你已拥有这份资料，可随时下载' : '虚拟资料 · 购买后立即解锁下载'}</div>
          ${bargainActivity ? `<div class="bargain-promo">${icon('users')} 邀请好友助力，最低可砍至 <b>${money(bargainActivity.floorPrice)}</b></div>` : ''}
          <div class="buy-actions">
            ${primaryAction}
            ${bargainAction}
            <button class="btn btn-ghost btn-block" type="button" data-favorite>
              ${icon('heart')} ${data.favorited ? '已收藏' : '收藏资料'}
            </button>
            <button class="btn btn-soft btn-block" type="button" data-contact-seller>${icon('message')} 联系卖家</button>
          </div>
          <div class="seller-box">
            ${avatar(m.seller.nickname)}
            <div style="min-width:0">
              <b>${esc(m.seller.nickname)}</b>
              <span>${esc(m.seller.school || '学涯集市卖家')}</span>
            </div>
            <a class="btn btn-ghost btn-xs" href="#/u/${m.seller.id}">主页</a>
          </div>
          <div class="guarantee-list">
            <div class="guarantee">${icon('shield')} 平台人工审核后上架</div>
            <div class="guarantee">${icon('lock')} 仅购买者可下载原文件</div>
            <div class="guarantee">${icon('refresh')} 描述不符可申请退款</div>
            <div class="guarantee">${icon('flag')} 侵权举报 48 小时内处理</div>
          </div>
          <div class="report-link"><button type="button" data-report>举报该资料</button></div>
        </div>
      </aside>
    </div>

    ${data.related.length ? `<section class="section">
      <div class="section-head"><div><div class="section-kicker">RELATED</div><h2>相关推荐</h2></div></div>
      <div class="material-grid cols-4">${data.related.map(materialCard).join('')}</div>
    </section>` : ''}
  </div>`;

  root.querySelector('[data-favorite]')?.addEventListener('click', async (e) => {
    if (!requireLogin()) return;
    const btn = e.currentTarget;
    try {
      const res = await api.post(`/api/materials/${m.id}/favorite`);
      btn.innerHTML = `${icon('heart')} ${res.favorited ? '已收藏' : '收藏资料'}`;
      btn.classList.toggle('btn-soft', res.favorited);
      toast(res.message);
    } catch (err) { toast(err.message, 'error'); }
  });

  root.querySelector('[data-download]')?.addEventListener('click', async (e) => {
    if (!requireLogin()) return;
    const btn = e.currentTarget;
    btn.setAttribute('aria-busy', 'true');
    try {
      await downloadFile(m.id);
      toast('下载已开始');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.removeAttribute('aria-busy');
    }
  });

  root.querySelector('[data-buy]')?.addEventListener('click', async () => {
    if (!requireLogin()) return;
    if (!state.user.verified) {
      openVerifyGate();
      return;
    }
    openPayModal({
      title: '购买资料',
      subtitle: m.title,
      amountCents: m.price,
      createCharge: (channel) => api.post('/api/orders', { materialId: m.id, channel }),
      onPaid: async () => {
        await refreshUser();
        await renderMaterial(root, ctx);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  });

  root.querySelector('[data-bargain]')?.addEventListener('click', async (e) => {
    if (!requireLogin()) return;
    const btn = e.currentTarget;
    btn.setAttribute('aria-busy', 'true');
    try {
      const res = await api.post('/api/bargains', { materialId: m.id });
      toast(res.message);
      window.location.hash = `#/bargain/${res.orderId}`;
    } catch (err) {
      toast(err.message, 'error');
      btn.removeAttribute('aria-busy');
    }
  });

  root.querySelector('[data-contact-seller]')?.addEventListener('click', () => {
    if (!requireLogin()) return;
    if (isOwner) return toast('这是你自己上传的资料', 'error');
    openChatComposer({
      toUserId: m.seller.id,
      toName: m.seller.nickname,
      materialId: m.id,
      materialTitle: m.title,
      scene: 'consult'
    });
  });

  loadPreview(root, m);

  root.querySelector('[data-report]')?.addEventListener('click', () => {
    if (!requireLogin()) return;
    openReportModal(m.id);
  });

  const starBox = root.querySelector('[data-star-input]');
  if (starBox) {
    let rating = 5;
    const paint = () => {
      starBox.querySelectorAll('[data-star]').forEach((btn) => {
        btn.classList.toggle('on', Number(btn.dataset.star) <= rating);
      });
    };
    starBox.querySelectorAll('[data-star]').forEach((btn) => {
      btn.addEventListener('click', () => { rating = Number(btn.dataset.star); paint(); });
    });
    root.querySelector('[data-review-form]').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submit = e.target.querySelector('button[type="submit"]');
      const content = new FormData(e.target).get('content');
      submit.setAttribute('aria-busy', 'true');
      try {
        const res = await api.post(`/api/materials/${m.id}/reviews`, { rating, content });
        toast(res.message);
        await renderMaterial(root, ctx);
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        submit.removeAttribute('aria-busy');
      }
    });
  }
}

async function loadPreview(root, m) {
  const paper = root.querySelector('[data-preview-paper]');
  if (!paper) return;
  try {
    const data = await api.get(`/api/materials/${m.id}/preview`);
    paper.innerHTML = `<pre class="preview-text">${esc(data.text)}</pre>
      <div class="preview-fade"></div>
      <div class="preview-watermark">${esc(data.watermark)}</div>`;
    const count = root.querySelector('[data-preview-count]');
    if (count) count.textContent = `试读前 ${data.ratio}% · 约 ${data.chars} 字 · 不可复制下载`;
  } catch (err) {
    paper.innerHTML = `<div class="preview-loading">试读内容加载失败：${esc(err.message)}</div>`;
  }
  protectPreview(paper);
}

function protectPreview(paper) {
  const block = (e) => e.preventDefault();
  ['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart'].forEach((evt) => {
    paper.addEventListener(evt, block);
  });
  paper.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && ['c', 'x', 'a', 's', 'p', 'u'].includes(key)) e.preventDefault();
  });
}

function openVerifyGate() {
  const modal = openModal({
    title: '完成认证后即可购买',
    subtitle: '未认证账号仅可浏览平台公开内容',
    body: `<p class="prose">为了保障交易安全与校园身份真实，平台要求买家完成<strong>实名认证 + 高校认证</strong>后才能购买、下载资料。</p>
      <div class="steps" style="margin-top:14px">
        <div class="step"><b>1</b><div><strong>填写真实姓名与学号</strong><span>选择你所在的高校并提交学号</span></div></div>
        <div class="step"><b>2</b><div><strong>等待管理员审核</strong><span>通常在 1 个工作日内完成</span></div></div>
        <div class="step"><b>3</b><div><strong>认证后自动进入本校专区</strong><span>即可购买、下载与出售资料</span></div></div>
      </div>`,
    footer: `<button class="btn btn-ghost" data-cancel>稍后再说</button>
             <a class="btn btn-primary" href="#/me?tab=verify" data-go-verify>${icon('badgeCheck')} 前往认证</a>`
  });
  modal.el.querySelector('[data-cancel]').addEventListener('click', modal.close);
  modal.el.querySelector('[data-go-verify]').addEventListener('click', modal.close);
}

function openReportModal(materialId) {
  const reasons = ['疑似侵权', '描述不符', '内容质量低', '含有违规内容', '重复上架'];
  const modal = openModal({
    title: '举报资料',
    subtitle: '平台将在 48 小时内核实处理',
    body: `<div class="field" style="margin-bottom:14px">
        <label class="label">举报原因</label>
        <select class="select" data-reason>${reasons.map((r) => `<option>${r}</option>`).join('')}</select>
      </div>
      <div class="field">
        <label class="label">补充说明</label>
        <textarea class="textarea" data-detail maxlength="300" placeholder="请描述具体情况，便于我们核实" style="min-height:90px"></textarea>
      </div>`,
    footer: `<button class="btn btn-ghost" data-cancel>取消</button>
             <button class="btn btn-danger" data-submit>提交举报</button>`
  });
  modal.el.querySelector('[data-cancel]').addEventListener('click', modal.close);
  modal.el.querySelector('[data-submit]').addEventListener('click', async () => {
    try {
      const res = await api.post(`/api/materials/${materialId}/report`, {
        reason: modal.el.querySelector('[data-reason]').value,
        detail: modal.el.querySelector('[data-detail]').value.trim()
      });
      modal.close();
      toast(res.message);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
