import { api } from '../api.js';
import { esc } from '../util.js';
import { icon, materialCard, skeletonGrid, emptyState, pager } from '../components.js';
import { loadMeta, state } from '../layout.js';
import { attachSelectSearch } from '../list-search.js';

const SORTS = [
  ['hot', '综合热度'],
  ['new', '最新上架'],
  ['rating', '评分优先'],
  ['price_asc', '价格从低到高'],
  ['price_desc', '价格从高到低']
];

export async function renderMarket(root, ctx) {
  const query = ctx.query;
  const page = Math.max(1, Number(query.page) || 1);
  const user = state.user;
  const verified = !!(user && user.verified);
  const zone = query.zone === 'all' ? 'all' : 'auto';
  const effectiveSchool = query.school || (zone === 'auto' && verified ? user.school : '');
  root.innerHTML = `<div class="loading-wrap">${skeletonGrid(6)}</div>`;

  let meta;
  let data;
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: '9' });
    ['q', 'category', 'subject', 'teacher', 'price', 'sort'].forEach((key) => {
      if (query[key]) params.set(key, query[key]);
    });
    if (effectiveSchool) params.set('school', effectiveSchool);
    [meta, data] = await Promise.all([loadMeta(), api.get(`/api/materials?${params}`)]);
  } catch (err) {
    root.innerHTML = emptyState({ iconName: 'alertCircle', title: '资料加载失败', text: err.message });
    return;
  }

  const activeCat = query.category || '';
  const activeSubject = query.subject || '';
  const activeTeacher = query.teacher || '';
  const priceOptions = [['', '全部价格'], ['free', '0 元体验（免支付）'], ['low', '15 元以内'], ['mid', '15—30 元'], ['high', '30 元以上']];
  const subjectOptions = (data.subjectFacets && data.subjectFacets.length ? data.subjectFacets.map((s) => s.subject) : meta.subjects);
  const teacherOptions = (data.teacherFacets || []).map((t) => t.teacher);
  const inSchoolZone = verified && !query.school && zone === 'auto';

  root.innerHTML = `<div class="view-enter">
    <div class="page-hero">
      <h1>${query.q ? `“${esc(query.q)}” 的搜索结果` : '资料市场'}</h1>
      <p>${query.q ? `在全部资料中查找与 ${esc(query.q)} 相关的内容` : '按院校、学科、老师三维筛选，找到最适合你的那一份'}</p>
    </div>

    ${verified ? `<div class="zone-bar">
      <div class="zone-info">
        <span class="badge green">${icon('badgeCheck')} 已认证 · ${esc(user.school)}</span>
        <span class="small muted">认证后默认展示本校专区资料，可手动切换查看其他高校</span>
      </div>
      <div class="zone-actions">
        <a class="chip ${inSchoolZone ? 'active' : ''}" href="${buildHash({ ...query, school: '', zone: 'auto', page: 1 })}">本校专区</a>
        <a class="chip ${zone === 'all' ? 'active' : ''}" href="${buildHash({ ...query, school: '', zone: 'all', page: 1 })}">全部院校</a>
      </div>
    </div>` : ''}

    <div class="market-toolbar">
      <form class="market-search" data-search>
        <div class="search-box">
          ${icon('search')}
          <input type="search" name="q" value="${esc(query.q || '')}" placeholder="搜索资料标题、课程、学科、老师…" aria-label="搜索资料">
        </div>
        <button class="btn btn-primary" type="submit">搜索</button>
      </form>
      <div class="filter-row">
        <div class="filter-chips">
          <a class="chip ${activeCat ? '' : 'active'}" href="${buildHash({ ...query, category: '', page: 1 })}">全部</a>
          ${meta.categories.map((c) => `<a class="chip ${activeCat === c ? 'active' : ''}" href="${buildHash({ ...query, category: activeCat === c ? '' : c, page: 1 })}">${esc(c)}</a>`).join('')}
          <a class="chip ${query.price === 'free' ? 'active' : ''}" href="${buildHash({ ...query, price: query.price === 'free' ? '' : 'free', page: 1 })}">0 元体验</a>
        </div>
      </div>
      <div class="filter-grid">
        <label class="filter-cell">
          <span class="filter-label">院校</span>
          <select class="select" data-filter="school" aria-label="院校筛选">
            <option value="">全部院校</option>
            ${meta.schools.map((s) => `<option value="${esc(s)}" ${effEquiv(effectiveSchool, s) ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </label>
        <label class="filter-cell">
          <span class="filter-label">学科</span>
          <select class="select" data-filter="subject" aria-label="学科筛选">
            <option value="">全部学科</option>
            ${subjectOptions.map((s) => `<option value="${esc(s)}" ${activeSubject === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </label>
        <label class="filter-cell">
          <span class="filter-label">授课老师</span>
          <select class="select" data-filter="teacher" aria-label="老师筛选">
            <option value="">全部老师</option>
            ${teacherOptions.map((t) => `<option value="${esc(t)}" ${activeTeacher === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
          </select>
        </label>
        <label class="filter-cell">
          <span class="filter-label">价格</span>
          <select class="select" data-filter="price" aria-label="价格筛选">
            ${priceOptions.map(([v, text]) => `<option value="${v}" ${(query.price || '') === v ? 'selected' : ''}>${text}</option>`).join('')}
          </select>
        </label>
        <label class="filter-cell">
          <span class="filter-label">排序</span>
          <select class="select" data-filter="sort" aria-label="排序方式">
            ${SORTS.map(([v, text]) => `<option value="${v}" ${(query.sort || 'hot') === v ? 'selected' : ''}>${text}</option>`).join('')}
          </select>
        </label>
        <div class="filter-actions">
          ${Object.keys(query).some((k) => ['q', 'category', 'school', 'subject', 'teacher', 'price'].includes(k) && query[k]) || query.zone === 'all'
            ? `<a class="btn btn-quiet btn-sm" href="${buildHash({ zone: verified ? 'auto' : '', page: 1 })}">清除筛选 ${icon('x')}</a>` : ''}
        </div>
      </div>
    </div>

    <div class="result-line">
      <span>共找到 <b>${data.total}</b> 份资料
        ${inSchoolZone ? ` · <b>${esc(user.school)}</b> 本校专区` : effectiveSchool ? ` · ${esc(effectiveSchool)}` : ''}
        ${activeSubject ? ` · 学科：${esc(activeSubject)}` : ''}
        ${activeTeacher ? ` · 老师：${esc(activeTeacher)}` : ''}
        ${query.q ? ` · 关键词“${esc(query.q)}”` : ''}
      </span>
      <span class="small">第 ${data.page} / ${data.pages} 页</span>
    </div>
    ${data.items.length ? `<div class="material-grid">${data.items.map(materialCard).join('')}</div>${pager(data.page, data.pages)}` :
      emptyState({ iconName: 'search', title: '没有找到匹配的资料', text: '换个关键词，或调整院校 / 学科 / 老师筛选', action: '<a class="btn btn-primary" href="#/wants">去求购广场</a>' })}
  </div>`;

  root.querySelector('[data-search]').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = new FormData(e.target).get('q').trim();
    window.location.hash = buildHash({ ...query, q: value, page: 1 });
  });

  const filterLabels = { school: '院校', subject: '学科', teacher: '老师' };
  root.querySelectorAll('[data-filter]').forEach((select) => {
    const label = filterLabels[select.dataset.filter];
    if (label) attachSelectSearch(select, { placeholder: `搜索${label}，支持模糊匹配` });
    select.addEventListener('change', () => {
      const key = select.dataset.filter;
      const next = { ...query, [key]: select.value, page: 1 };
      if (key === 'school') {
        next.zone = select.value ? '' : (verified ? 'all' : '');
      }
      window.location.hash = buildHash(next);
    });
  });

  root.querySelectorAll('.pager [data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      window.location.hash = buildHash({ ...query, page: btn.dataset.page });
    });
  });
}

function effEquiv(effectiveSchool, school) {
  return effectiveSchool === school;
}

function buildHash(query) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '' && key !== 'page') params.set(key, value);
    if (key === 'page' && Number(value) > 1) params.set('page', value);
  });
  const str = params.toString();
  return `#/market${str ? `?${str}` : ''}`;
}
