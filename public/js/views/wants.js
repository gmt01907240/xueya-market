import { api } from '../api.js';
import { esc, moneyPlain, dateAgo } from '../util.js';
import { icon, toast, openModal, emptyState, loadingBlock, confirmDialog, avatar } from '../components.js';
import { openChatComposer } from './messages.js';
import { state, requireLogin, loadMeta } from '../layout.js';
import { attachSelectSearch } from '../list-search.js';

export async function renderWants(root, ctx) {
  root.innerHTML = `<div class="loading-wrap">${loadingBlock('正在加载求购信息…')}</div>`;
  let meta;
  let data;
  try {
    const params = new URLSearchParams();
    if (ctx.query.category) params.set('category', ctx.query.category);
    if (ctx.query.school) params.set('school', ctx.query.school);
    [meta, data] = await Promise.all([loadMeta(), api.get(`/api/wants?${params}`)]);
  } catch (err) {
    root.innerHTML = emptyState({ iconName: 'alertCircle', title: '加载失败', text: err.message });
    return;
  }

  const activeCat = ctx.query.category || '';
  root.innerHTML = `<div class="view-enter">
    <div class="page-hero">
      <div class="row-between wrap">
        <div>
          <h1>求购广场</h1>
          <p>发起一条求购，让有资料的同学主动联系你；也可以看看大家在找什么</p>
        </div>
        <button class="btn btn-primary" type="button" data-post-want>${icon('plus')} 发布求购</button>
      </div>
    </div>
    <div class="market-toolbar" style="margin-top:20px">
      <div class="filter-chips">
        <a class="chip ${activeCat ? '' : 'active'}" href="#/wants">全部求购</a>
        ${meta.categories.map((c) => `<a class="chip ${activeCat === c ? 'active' : ''}" href="#/wants?category=${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}
      </div>
    </div>
    ${data.items.length ? `<div class="result-line"><span>当前有 <b>${data.items.length}</b> 条求购进行中</span><span class="small">按发布时间排序</span></div>
    <div class="want-list">
      ${data.items.map((w) => `<div class="panel want-card">
        <div class="want-budget"><b>¥${moneyPlain(w.budget)}</b><span>预算</span></div>
        <div class="want-body">
          <h4>${esc(w.title)} ${w.mine ? '<span class="badge gray">我的求购</span>' : ''}</h4>
          <p>${esc(w.description || '暂无补充说明')}</p>
          <div class="want-meta">
            <span>${icon('tag')} ${esc(w.category || '不限分类')}</span>
            <span>${icon('school')} ${esc(w.school || '不限院校')}</span>
            <span>${icon('clock')} ${dateAgo(w.createdAt)}</span>
            <span class="row" style="gap:6px">${avatar(w.user.nickname, 'sm')} ${esc(w.user.nickname)}</span>
          </div>
        </div>
        <div class="want-actions">
          ${w.mine
            ? `<span class="badge green">进行中</span><button class="btn btn-ghost btn-sm" data-close="${w.id}">关闭求购</button>`
            : `<button class="btn btn-primary btn-sm" data-contact="${w.id}" data-user="${w.user.id}" data-title="${esc(w.title)}">${icon('message')} 联系 TA</button>`}
        </div>
      </div>`).join('')}
    </div>` : emptyState({
      iconName: 'message', title: '还没有相关求购', text: '发布一条求购，让同学来帮你找资料',
      action: '<button class="btn btn-primary" data-post-want>发布求购</button>'
    })}
  </div>`;

  root.querySelectorAll('[data-post-want]').forEach((btn) => btn.addEventListener('click', () => {
    if (!requireLogin()) return;
    openPostModal(meta, () => renderWants(root, ctx));
  }));

  root.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: '关闭这条求购？', text: '关闭后不再展示在求购广场，已开始的会话不受影响。', confirmText: '关闭求购', danger: true });
      if (!ok) return;
      try {
        const res = await api.post(`/api/wants/${btn.dataset.close}/close`);
        toast(res.message);
        await renderWants(root, ctx);
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  root.querySelectorAll('[data-contact]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!requireLogin()) return;
      openChatComposer({
        toUserId: Number(btn.dataset.user),
        toName: '求购同学',
        wantId: Number(btn.dataset.contact),
        wantTitle: btn.dataset.title,
        scene: 'free',
        title: '联系求购同学'
      });
    });
  });
}

function openPostModal(meta, onDone) {
  const modal = openModal({
    title: '发布求购',
    subtitle: '写清资料名称、院校和预算，更容易收到回复',
    wide: true,
    body: `<form class="stack" data-want-form style="gap:14px">
      <div class="field">
        <label class="label">求购标题<span class="req">*</span></label>
        <input class="input" name="title" maxlength="60" placeholder="例如：求购 431 金融学综合 全套笔记（复旦）">
      </div>
      <div class="form-grid" style="gap:14px">
        <div class="field">
          <label class="label">资料分类</label>
          <select class="select" name="category">
            <option value="">不限分类</option>
            ${meta.categories.map((c) => `<option>${esc(c)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="label">院校</label>
          <select class="select" name="school">
            <option value="">不限院校</option>
            ${meta.schools.map((s) => `<option ${state.user && state.user.school === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field">
        <label class="label">预算（元）</label>
        <div class="price-input"><span class="prefix">¥</span><input class="input" name="budget" type="number" min="0" max="999" step="1" value="20"></div>
      </div>
      <div class="field">
        <label class="label">补充说明</label>
        <textarea class="textarea" name="description" maxlength="300" placeholder="说明你需要的版本、年份、是否要含答案等" style="min-height:90px"></textarea>
      </div>
      <div class="error-text hidden" data-error></div>
    </form>`,
    footer: `<button class="btn btn-ghost" data-cancel>取消</button>
             <button class="btn btn-primary" data-submit>发布求购</button>`
  });
  modal.el.querySelector('[data-cancel]').addEventListener('click', modal.close);
  attachSelectSearch(modal.el.querySelector('[data-want-form]').elements.school, { placeholder: '搜索院校，如「清华」「师范」' });
  modal.el.querySelector('[data-submit]').addEventListener('click', async () => {
    const form = modal.el.querySelector('[data-want-form]');
    const data = new FormData(form);
    const error = modal.el.querySelector('[data-error]');
    error.classList.add('hidden');
    try {
      const res = await api.post('/api/wants', {
        title: String(data.get('title')).trim(),
        category: data.get('category'),
        school: data.get('school'),
        budget: Number(data.get('budget')) || 0,
        description: String(data.get('description')).trim()
      });
      modal.close();
      toast(res.message);
      if (onDone) onDone();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    }
  });
}
