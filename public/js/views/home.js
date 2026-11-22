import { api } from '../api.js';
import { esc, money, catIndex, CAT_GLYPHS, dateAgo, moneyPlain } from '../util.js';
import { icon, materialCard, sectionHead, skeletonGrid, avatar, stars, openModal, emptyState } from '../components.js';
import { loadMeta, state } from '../layout.js';

const CAT_ICONS = ['award', 'clipboard', 'bookOpen', 'layers', 'book', 'award', 'file', 'message'];

export async function renderHome(root) {
  root.innerHTML = `<div class="loading-wrap">${skeletonGrid(3)}</div>`;
  let meta;
  let top;
  let latest;
  let wants;
  try {
    [meta, top, latest, wants] = await Promise.all([
      loadMeta(),
      api.get('/api/materials?sort=rating&pageSize=3'),
      api.get('/api/materials?sort=new&pageSize=3'),
      api.get('/api/wants')
    ]);
  } catch (err) {
    root.innerHTML = emptyState({ iconName: 'alertCircle', title: '加载失败', text: err.message, action: '<button class="btn btn-primary" type="button" data-action="reload">重新加载</button>' });
    return;
  }

  const stats = meta.stats || {};
  const catCount = {};
  (meta.categoryStats || []).forEach((c) => { catCount[c.category] = c.count; });
  const announcement = (meta.announcements || [])[0];

  root.innerHTML = `
    <div class="view-enter">
      <section class="hero">
        <div class="hero-grid">
          <div class="hero-copy">
            <span class="eyebrow"><span class="seal">${icon('check')}</span> 校内资料 · 人工审核 · 安心交易</span>
            <h1>让每一份笔记，<br>找到<em>需要它的人</em>。</h1>
            <p class="hero-lead">从期末真题到考研笔记，从课堂整理到竞赛题解。学涯集市把同校同专业的优质资料聚在一起，用审核与托管，让分享和购买都更放心。</p>
            <form class="hero-search" data-search>
              ${icon('search')}
              <input type="search" name="q" placeholder="试试搜「数据结构」「考研数学」…" aria-label="搜索资料">
              <button class="btn btn-primary" type="submit">搜索资料</button>
            </form>
            <div class="hot-searches">
              <span>热门搜索</span>
              ${['考研数学', '期末真题', '雅思口语', '408', '数学建模'].map((t) => `<button type="button" data-hot="${esc(t)}">${esc(t)}</button>`).join('')}
            </div>
            <div class="hero-stats">
              <div class="hero-stat"><b>${stats.materials || 0}</b><span>在架资料</span></div>
              <div class="hero-stat"><b>${Math.round((stats.downloads || 0) / 1000)}k+</b><span>累计下载</span></div>
              <div class="hero-stat"><b>${stats.schools || 0}</b><span>覆盖高校</span></div>
              <div class="hero-stat"><b>${stats.users || 0}</b><span>注册同学</span></div>
            </div>
          </div>
          <div class="hero-visual" aria-hidden="true">
            <div class="paper p1">
              <div class="paper-top"><span class="paper-kicker">FINAL REVIEW</span><span class="badge gray">笔记</span></div>
              <h4>宏观经济学<br>课堂笔记</h4>
              <p>曼昆 · 全学期整理</p>
              <div class="paper-lines"><i></i><i></i><i></i><i></i></div>
              <div class="paper-foot"><span class="paper-price">¥15.9</span>${stars(5)}</div>
            </div>
            <div class="paper p2">
              <div class="paper-top"><span class="paper-kicker">POSTGRAD EXAM</span><span class="badge gray">真题</span></div>
              <h4>考研数学一<br>真题全解</h4>
              <p>2010—2024 · 逐题解析</p>
              <div class="paper-lines"><i></i><i></i><i></i><i></i></div>
              <div class="paper-foot"><span class="paper-price">¥29.9</span>${stars(5)}</div>
            </div>
            <div class="paper p3">
              <div class="paper-stamp">平台<br>审核<br>通过</div>
              <div class="paper-top"><span class="paper-kicker">VERIFIED NOTE</span></div>
              <h4>数据结构<br>期末复习提纲</h4>
              <p>知识树 + 近五年真题，考前一周高效复习。</p>
              <div class="paper-lines"><i></i><i></i><i></i><i></i></div>
              <div class="paper-foot"><span class="paper-price">¥19.9</span><span class="badge green">${icon('download')} 842</span></div>
            </div>
            <div class="hero-note">
              <span class="icon">${icon('shield')}</span>
              <span><b>每一份资料都经过审核</b><span>版权投诉 48 小时内响应</span></span>
            </div>
          </div>
        </div>
      </section>

      ${announcement ? `
      <button class="notice-bar" type="button" data-notice="${announcement.id}">
        <span class="notice-tag">${esc(announcement.tag)}</span>
        <span class="notice-text">${esc(announcement.title)} — ${esc(announcement.content.slice(0, 46))}${announcement.content.length > 46 ? '…' : ''}</span>
        <span class="notice-more">查看 ${icon('arrowRight')}</span>
      </button>` : ''}

      <section class="section">
        <div class="panel plan-cta">
          <div class="plan-cta-copy">
            <span class="eyebrow"><span class="seal">${icon('sparkles')}</span> AI STUDY PLANNER</span>
            <h2>不知道先学什么？让规划帮你排好</h2>
            <p>选一个目标，系统会结合你的院校、学科、已购与收藏，从在架资料中挑出最合适的组合，生成逐日任务和覆盖缺口。每条推荐都给出理由，不做黑盒。</p>
            <div class="filter-chips">
              <a class="chip" href="#/plan?goal=final">期末冲刺</a>
              <a class="chip" href="#/plan?goal=postgrad">考研备考</a>
              <a class="chip" href="#/plan?goal=contest">竞赛考证</a>
              <a class="chip" href="#/plan?goal=paper">论文写作</a>
            </div>
            <a class="btn btn-primary" href="#/plan">生成我的学习计划 ${icon('arrowRight')}</a>
          </div>
          <div class="plan-cta-side">
            <div class="plan-cta-stat"><b>5</b><span>目标场景</span></div>
            <div class="plan-cta-stat"><b>4</b><span>排序因子组</span></div>
            <div class="plan-cta-stat"><b>30</b><span>天最长周期</span></div>
            <div class="plan-cta-preview">
              <span class="tag">D1 · 建立框架</span>
              <span class="tag">D2 · 真题训练</span>
              <span class="tag">D3 · 错题复盘</span>
            </div>
          </div>
        </div>
      </section>

      <section class="section">
        ${sectionHead({ kicker: 'BROWSE BY SUBJECT', title: '按分类找资料', desc: '从备考到日常，覆盖大学学习的主要场景' })}
        <div class="cat-grid">
          ${meta.categories.map((name, i) => {
            const count = catCount[name] || 0;
            const tints = ['#e3efe8', '#fbe9dc', '#f7eed7', '#e6edf1', '#efe8ef', '#e3f0ef', '#f4ecdf', '#eef0dd'];
            const tones = ['#1a5f4c', '#a94f22', '#8a6417', '#355f76', '#6a4a72', '#1f6663', '#7b5c33', '#5c6426'];
            return `<a class="cat-card" href="#/market?category=${encodeURIComponent(name)}" style="--tint:${tints[i]};--tone:${tones[i]}">
              <span class="cat-icon">${icon(CAT_ICONS[i])}</span>
              <span class="arrow">${icon('arrowUpRight')}</span>
              <span class="cat-name">${esc(name)}</span>
              <span class="cat-meta">${count ? `${count} 份在架资料` : '等待第一份资料'}</span>
            </a>`;
          }).join('')}
        </div>
      </section>

      <section class="section">
        ${sectionHead({ kicker: 'EDITOR’S PICKS', title: '本周精选', desc: '评分与下载量双高的口碑资料', linkHref: '#/market?sort=rating', linkText: '查看全部' })}
        <div class="material-grid">${top.items.map(materialCard).join('')}</div>
      </section>

      <section class="section">
        <div class="assurance">
          ${[
            ['shield', '人工审核', '资料上架前逐份检查，拒绝侵权与低质内容'],
            ['lock', '购买后下载', '资料不公开传播，仅购买者可获取原文件'],
            ['creditCard', '资金托管', '下单后款项由平台托管，交易完成再结算'],
            ['flag', '版权保障', '发现侵权可一键举报，48 小时内核实处理']
          ].map(([ic, title, text]) => `<div class="assurance-item">
            <span class="a-icon">${icon(ic)}</span>
            <div><b>${title}</b><p>${text}</p></div>
          </div>`).join('')}
        </div>
      </section>

      <section class="section">
        ${sectionHead({ kicker: 'WANTED', title: '求购广场', desc: '没有找到想要的资料？发一条求购，让同学来帮你', linkHref: '#/wants', linkText: '去求购广场' })}
        <div class="want-list">
          ${(wants.items || []).slice(0, 3).map((w) => `<a class="panel want-card" href="#/wants">
            <div class="want-budget"><b>¥${moneyPlain(w.budget)}</b><span>预算</span></div>
            <div class="want-body">
              <h4>${esc(w.title)}</h4>
              <p>${esc(w.description || '暂无补充说明')}</p>
              <div class="want-meta">
                <span>${icon('school')} ${esc(w.school || '不限院校')}</span>
                <span>${icon('clock')} ${dateAgo(w.createdAt)}</span>
                <span>${esc(w.user.nickname)}</span>
              </div>
            </div>
          </a>`).join('') || emptyState({ iconName: 'message', title: '暂时没有求购', text: '成为第一个发布求购的人' })}
        </div>
      </section>

      <section class="section">
        <div class="split-2">
          <div>
            ${sectionHead({ kicker: 'FRESH UPLOADS', title: '最新上架', desc: '刚刚通过审核的新资料', linkHref: '#/market?sort=new', linkText: '更多新资料' })}
            <div class="material-grid" style="grid-template-columns:repeat(2,1fr)">${latest.items.slice(0, 4).map(materialCard).join('')}</div>
          </div>
          <div class="stack" style="gap:18px">
            <div class="panel side-panel">
              <h4>热门院校</h4>
              <div class="filter-chips">
                ${(meta.schoolStats || []).map((s) => `<a class="chip" href="#/market?school=${encodeURIComponent(s.school)}">${esc(s.school)} <span class="muted">${s.count}</span></a>`).join('')}
              </div>
            </div>
            <div class="seller-cta">
              <div class="seller-cta-copy">
                <span class="badge gold">卖家招募</span>
                <h3>把你的整理，变成收入</h3>
                <p>上传资料通过审核即可上架，成交后获得 90% 收益，平台提供审核、托管与版权保护。</p>
              </div>
              <a class="btn btn-accent" href="#/upload">${icon('upload')} 立即上传</a>
            </div>
          </div>
        </div>
      </section>
    </div>`;

  root.querySelector('[data-search]').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = new FormData(e.target).get('q').trim();
    window.location.hash = value ? `#/market?q=${encodeURIComponent(value)}` : '#/market';
  });
  root.querySelectorAll('[data-hot]').forEach((btn) => {
    btn.addEventListener('click', () => { window.location.hash = `#/market?q=${encodeURIComponent(btn.dataset.hot)}`; });
  });
  root.querySelector('[data-notice]')?.addEventListener('click', () => {
    const notice = (meta.announcements || []).find((a) => String(a.id) === root.querySelector('[data-notice]').dataset.notice);
    if (!notice) return;
    openModal({
      title: notice.title,
      subtitle: `${notice.tag} · ${notice.created_at.slice(0, 10)}`,
      body: `<p class="prose">${esc(notice.content)}</p>`
    });
  });
}
