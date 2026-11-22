import { api } from '../api.js';
import { esc } from '../util.js';
import { icon, emptyState } from '../components.js';

const TABS = [
  ['school', '院校库', 'school', '按院校名称、标识码、省份、层次搜索'],
  ['major', '专业库', 'book', '按专业名称、专业代码、门类搜索'],
  ['subject', '学科库', 'bookOpen', '按一级学科与门类搜索'],
  ['teacher', '教师库', 'users', '按教师姓名、院校、学科、职称搜索']
];

const TYPE_TEXT = { school: '院校', major: '专业', subject: '学科', teacher: '教师' };
const UNIT = { school: '所院校', major: '个专业', subject: '个学科', teacher: '位教师' };

const PLACEHOLDER = {
  school: '搜索院校名称、标识码、省份，如「清华」「4111010003」',
  major: '搜索专业名称、专业代码、门类，如「计算机」「080901」',
  subject: '搜索学科或门类，如「计算机」「医学」',
  teacher: '搜索教师姓名、院校、学科，如「浙江大学」「教授」'
};

const HOT = {
  school: ['清华大学', '北京大学', '师范', '医科大学', '深圳大学', '理工'],
  major: ['计算机科学与技术', '软件工程', '临床医学', '金融学', '法学', '人工智能'],
  subject: ['计算机科学与技术', '数学', '临床医学', '金融学', '法学', '软件工程'],
  teacher: ['陈立群', '王海涛', '浙江大学', '计算机科学与技术', '教授', '数学']
};

const searchState = {
  school: { q: '', items: [], total: 0, tookMs: 0, loaded: false },
  major: { q: '', items: [], total: 0, tookMs: 0, loaded: false },
  subject: { q: '', items: [], total: 0, tookMs: 0, loaded: false },
  teacher: { q: '', items: [], total: 0, tookMs: 0, loaded: false }
};

const controllers = {};
let activeRoot = null;
let activeTab = 'school';

export async function renderCatalog(root, ctx) {
  activeRoot = root;
  const initial = TABS.some((t) => t[0] === ctx.query.tab) ? ctx.query.tab : 'school';
  activeTab = initial;
  root.innerHTML = `<div class="loading-wrap">${emptyState({
    iconName: 'school', title: '正在加载资源库', text: '院校、专业、学科与教师数据加载中…'
  })}</div>`;

  let overview;
  try {
    overview = await api.get('/api/catalog/overview');
  } catch (err) {
    root.innerHTML = emptyState({
      iconName: 'alertCircle', title: '资源库加载失败', text: err.message,
      action: '<button class="btn btn-primary" type="button" data-action="reload">重新加载</button>'
    });
    return;
  }

  root.innerHTML = `<div class="view-enter">
    <div class="page-hero catalog-hero">
      <div class="row-between wrap">
        <div>
          <div class="section-kicker">ACADEMIC RESOURCE LIBRARY</div>
          <h1>院校 · 专业 · 学科 · 教师资源库</h1>
          <p>完整收录教育部《全国高等学校名单（2026）》与《普通高等学校本科专业目录（2026年）》。四个模块各自支持关键词模糊搜索，结果实时返回，可直接跳转资料市场查看对应资料。</p>
        </div>
        <span class="badge green">${icon('sparkles')} 官方数据 · 实时搜索</span>
      </div>
      <div class="catalog-stats">
        <div class="catalog-stat"><b>${overview.schools}</b><span>收录院校</span></div>
        <div class="catalog-stat"><b>${overview.majors}</b><span>本科专业</span></div>
        <div class="catalog-stat"><b>${overview.subjects}</b><span>学科方向</span></div>
        <div class="catalog-stat"><b>${overview.teachers}</b><span>教师资源</span></div>
        <div class="catalog-stat"><b>${overview.provinces}</b><span>覆盖省份</span></div>
      </div>
    </div>

    <div class="catalog-tabs" role="tablist">
      ${TABS.map(([key, text, ic]) => `<button class="catalog-tab ${key === initial ? 'active' : ''}" type="button" role="tab" data-catalog-tab="${key}" aria-selected="${key === initial}">
        ${icon(ic)}<span>${esc(text)}</span>
      </button>`).join('')}
    </div>

    <div data-catalog-panel></div>
  </div>`;

  root.querySelectorAll('[data-catalog-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.catalogTab === activeTab) return;
      activeTab = btn.dataset.catalogTab;
      history.replaceState(null, '', `#/catalog?tab=${activeTab}`);
      root.querySelectorAll('[data-catalog-tab]').forEach((el) => {
        const on = el.dataset.catalogTab === activeTab;
        el.classList.toggle('active', on);
        el.setAttribute('aria-selected', String(on));
      });
      paint(activeTab);
    });
  });

  paint(initial);
}

function paint(tab) {
  const root = activeRoot;
  if (!root) return;
  const panel = root.querySelector('[data-catalog-panel]');
  if (!panel) return;
  const meta = TABS.find((t) => t[0] === tab);
  const state = searchState[tab];

  panel.innerHTML = `<div class="panel panel-pad catalog-panel">
    <form class="catalog-search" data-catalog-form>
      <div class="search-box">
        ${icon('search')}
        <input type="search" name="q" value="${esc(state.q)}" placeholder="${esc(PLACEHOLDER[tab])}" aria-label="搜索${meta[1]}">
      </div>
      <button class="btn btn-primary" type="submit">搜索</button>
    </form>
    <div class="catalog-hot">
      <span class="small muted">热门搜索</span>
      ${HOT[tab].map((word) => `<button class="chip ghost" type="button" data-hot="${esc(word)}">${esc(word)}</button>`).join('')}
    </div>
    <div class="catalog-meta" data-catalog-meta></div>
    <div data-catalog-results>${loadingRow()}</div>
  </div>`;

  const form = panel.querySelector('[data-catalog-form]');
  const input = form.querySelector('input[name="q"]');
  let timer = null;

  const trigger = (q) => {
    state.q = q;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => runSearch(tab), 180);
  };

  input.addEventListener('input', () => trigger(input.value.trim()));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (timer) clearTimeout(timer);
    state.q = input.value.trim();
    runSearch(tab);
  });
  panel.querySelectorAll('[data-hot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.hot;
      trigger(btn.dataset.hot);
    });
  });

  if (state.loaded) {
    renderResults(tab, panel, state.q);
  } else {
    runSearch(tab);
  }
}

function loadingRow() {
  return `<div class="catalog-loading">${icon('search')}<span>正在搜索…</span></div>`;
}

function runSearch(tab) {
  const root = activeRoot;
  if (!root || tab !== activeTab) return;
  const panel = root.querySelector('[data-catalog-panel]');
  if (!panel) return;
  const state = searchState[tab];
  const results = panel.querySelector('[data-catalog-results]');
  const meta = panel.querySelector('[data-catalog-meta]');
  const startedAt = performance.now();

  if (controllers[tab]) controllers[tab].abort();
  controllers[tab] = new AbortController();
  const signal = controllers[tab].signal;
  const q = state.q;

  if (results) results.innerHTML = loadingRow();
  if (meta) meta.innerHTML = '<span class="small muted">检索中…</span>';

  const params = new URLSearchParams({ type: tab, q, limit: '30' });
  api.get(`/api/catalog/search?${params}`, { signal })
    .then((data) => {
      if (tab !== activeTab) return;
      state.items = data.items;
      state.total = data.total;
      state.tookMs = data.tookMs;
      state.loaded = true;
      state.roundtrip = Math.round(performance.now() - startedAt);
      renderResults(tab, panel, q);
    })
    .catch((err) => {
      if (err.name === 'AbortError' || signal.aborted) return;
      if (results) {
        results.innerHTML = emptyState({
          iconName: 'alertCircle', title: '搜索失败', text: err.message || '请稍后重试'
        });
      }
      if (meta) meta.innerHTML = '<span class="small muted">搜索请求失败</span>';
    });
}

function renderResults(tab, panel, q) {
  const state = searchState[tab];
  const results = panel.querySelector('[data-catalog-results]');
  const meta = panel.querySelector('[data-catalog-meta]');
  if (!results) return;

  if (meta) {
    const roundtrip = state.roundtrip || 0;
    if (q) {
      meta.innerHTML = `<span>关键词“<b>${esc(q)}</b>”找到 <b>${state.total}</b> ${UNIT[tab]}</span>
        <span class="badge ${state.tookMs < 1000 ? 'green' : 'red'}">${icon('clock')} 响应 ${state.tookMs} ms · 往返 ${roundtrip} ms</span>`;
    } else {
      meta.innerHTML = `<span>共收录 <b>${state.total}</b> ${UNIT[tab]} · 显示前 ${state.items.length} 条</span>
        <span class="badge ${state.tookMs < 1000 ? 'green' : 'red'}">${icon('clock')} 响应 ${state.tookMs} ms</span>`;
    }
  }

  if (!state.items.length) {
    results.innerHTML = emptyState({
      iconName: 'search',
      title: `没有找到匹配的${TYPE_TEXT[tab]}`,
      text: '换个关键词试试，支持名称简称、官方编码、省份与门类模糊匹配'
    });
    return;
  }

  results.innerHTML = `<div class="catalog-grid">${state.items.map((item) => card(tab, item)).join('')}</div>`;
}

function levelClass(level = '') {
  if (level.includes('985')) return 'badge gold';
  if (level.includes('211') || level.includes('双一流')) return 'badge green';
  return 'badge gray';
}

function card(tab, item) {
  if (tab === 'school') {
    const meta = [item.degreeLevel, item.schoolType, item.ownership].filter(Boolean).join(' · ');
    return `<a class="catalog-item" href="#/market?school=${encodeURIComponent(item.name)}">
      <span class="catalog-icon">${icon('school')}</span>
      <div class="catalog-main">
        <div class="catalog-title"><b>${esc(item.name)}</b><span class="${levelClass(item.level)}">${esc(item.level)}</span></div>
        <p class="catalog-desc">${esc(item.province)}${item.city ? ` · ${esc(item.city)}` : ''}${meta ? ` · ${esc(meta)}` : ''}</p>
        <p class="catalog-desc small">官方标识码 ${esc(item.code || '—')}${item.supervisor ? ` · 主管部门 ${esc(item.supervisor)}` : ''}</p>
        <div class="catalog-foot">
          <span>${item.materialCount ? `${item.materialCount} 份在架资料` : '暂无在架资料'}</span>
          <span class="link">查看资料 ${icon('chevronRight')}</span>
        </div>
      </div>
    </a>`;
  }
  if (tab === 'major') {
    const flags = [item.isSpecial ? '特设' : '', item.isControlled ? '国家控制布点' : ''].filter(Boolean).join(' · ');
    return `<div class="catalog-item">
      <span class="catalog-icon">${icon('book')}</span>
      <div class="catalog-main">
        <div class="catalog-title"><b>${esc(item.name)}</b><span class="badge gray">${esc(item.code)}</span></div>
        <p class="catalog-desc">${esc(item.category)}门类 · ${esc(item.className)}${flags ? ` · ${esc(flags)}` : ''}</p>
        <div class="catalog-foot">
          <span>${item.degreeNote ? esc(item.degreeNote) : `专业类代码 ${esc(item.classCode)}`}</span>
          <a class="link" href="#/market?subject=${encodeURIComponent(item.name)}">查看资料 ${icon('chevronRight')}</a>
        </div>
      </div>
    </div>`;
  }
  if (tab === 'subject') {
    return `<a class="catalog-item" href="#/market?subject=${encodeURIComponent(item.name)}">
      <span class="catalog-icon">${icon('bookOpen')}</span>
      <div class="catalog-main">
        <div class="catalog-title"><b>${esc(item.name)}</b><span class="badge gray">${esc(item.category)}</span></div>
        <p class="catalog-desc">${item.teacherCount} 位教师 · ${item.materialCount} 份在架资料</p>
        <div class="catalog-foot">
          <span>${item.category}门类</span>
          <span class="link">查看资料 ${icon('chevronRight')}</span>
        </div>
      </div>
    </a>`;
  }
  return `<a class="catalog-item" href="#/market?teacher=${encodeURIComponent(item.name)}&school=${encodeURIComponent(item.school)}">
    <span class="catalog-icon">${icon('user')}</span>
    <div class="catalog-main">
      <div class="catalog-title"><b>${esc(item.name)}</b><span class="badge gray">${esc(item.title)}</span></div>
      <p class="catalog-desc">${esc(item.school)} · ${esc(item.subject)}</p>
      <div class="catalog-foot">
        <span>${item.materialCount ? `${item.materialCount} 份在架资料` : '暂无在架资料'}</span>
        <span class="link">查看资料 ${icon('chevronRight')}</span>
      </div>
    </div>
  </a>`;
}
