import { api } from '../api.js';
import { state } from '../layout.js';
import { esc, money } from '../util.js';
import { icon, toast, emptyState, confirmDialog } from '../components.js';
import { attachSelectSearch } from '../list-search.js';

let optionsCache = null;

function shell(options, query) {
  const goals = options.goals || [];
  const selected = goals.some((g) => g.code === query.goal) ? query.goal : 'final';
  return `
    <div class="view-enter">
      <section class="panel panel-pad plan-hero">
        <span class="eyebrow"><span class="seal">${icon('sparkles')}</span> 智能学习规划 · 可解释推荐</span>
        <h1 style="margin:10px 0 8px;font-size:30px">把「该学什么」变成一份可执行的清单</h1>
        <p class="muted" style="max-width:720px;margin:0">结合你的院校、学科、已购与收藏，按目标场景对在架资料做多因子排序，给出逐日安排与推荐理由。不采集资料内容，不上传个人文件。</p>
        <div class="plan-hero-tags">
          <span class="tag">目标场景匹配</span>
          <span class="tag">同校优先</span>
          <span class="tag">分类覆盖检测</span>
          <span class="tag">保存与打卡</span>
        </div>
      </section>

      <div id="planSaved" class="stack" style="gap:18px;margin-bottom:18px"></div>

      <div class="split-2 plan-layout">
        <form class="panel panel-pad" id="planForm">
          <div class="row-between" style="margin-bottom:12px">
            <h3 style="font-size:18px;margin:0">生成我的学习计划</h3>
            <span class="badge gray">${options.engine === 'rule-based-v1' ? '本地规则引擎' : '智能引擎'}</span>
          </div>
          <div class="field">
            <label>学习目标</label>
            <div class="filter-chips" data-goals>
              ${goals.map((g) => `<button type="button" class="chip ${g.code === selected ? 'active' : ''}" data-goal="${esc(g.code)}" title="${esc(g.desc)}">${esc(g.name)}</button>`).join('')}
            </div>
          </div>
          <div class="field">
            <label for="planSubject">学科方向</label>
            <select class="input" id="planSubject" name="subject">
              <option value="">全部学科（由我的购买记录推断）</option>
              ${(options.subjects || []).map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
            </select>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="field">
              <label for="planDays">规划天数</label>
              <input class="input" id="planDays" name="days" type="number" min="3" max="30" value="7">
            </div>
            <div class="field">
              <label>每日时长</label>
              <div class="filter-chips" data-minutes>
                ${[30, 60, 90, 120].map((m) => `<button type="button" class="chip ${m === 60 ? 'active' : ''}" data-minute="${m}">${m} 分钟</button>`).join('')}
              </div>
            </div>
          </div>
          <button class="btn btn-primary btn-block" type="submit" style="margin-top:4px">${icon('sparkles')} 生成学习计划</button>
          <p class="small muted" style="margin:10px 0 0">${state.user ? `已识别院校：${esc(state.user.school || '未填写')}，将优先匹配同校资料。登录后可保存计划并每日打卡。` : '未登录也可生成；登录后可结合已购与收藏自动匹配，并保存计划打卡。'}</p>
        </form>

        <aside class="panel panel-pad plan-guide">
          <h3 style="font-size:16px;margin:0 0 10px">规划是怎么算出来的</h3>
          <ol class="plan-steps">
            <li><b>目标拆解</b><span>把期末、考研、竞赛等目标映射到资料分类。</span></li>
            <li><b>多因子排序</b><span>学科匹配、同校、评分、下载量、价格与购买状态加权。</span></li>
            <li><b>覆盖检查</b><span>检查目标所需分类是否齐全，缺口直接给出补充建议。</span></li>
            <li><b>逐日安排</b><span>按天数与每日时长生成主任务和间隔复习。</span></li>
            <li><b>保存打卡</b><span>保存后逐项勾选完成，进度自动统计。</span></li>
          </ol>
          <div class="plan-guide-note">${icon('shield')} 推荐结果可解释、可复现，不依赖外部大模型，也不会上传你的文件。</div>
        </aside>
      </div>

      <div id="planResult" class="stack" style="gap:18px;margin-top:18px"></div>
    </div>`;
}

function savedListHtml(data) {
  const items = data.items || [];
  if (!items.length) return '';
  return `
    <div class="panel panel-pad">
      <div class="row-between" style="margin-bottom:12px">
        <h3 style="font-size:17px;margin:0">我的学习计划</h3>
        <span class="small muted">已保存 ${items.length} / ${data.limit || 20} 份</span>
      </div>
      <div class="plan-saved-list">
        ${items.map((p) => `<div class="plan-saved-item">
          <div class="plan-saved-main">
            <b>${esc(p.goalName)} · ${esc(p.subject || '全学科')}</b>
            <div class="small muted">${p.days} 天 · 每天 ${p.dailyMinutes} 分钟 · 资料覆盖 ${p.coverage}% · 保存于 ${esc(String(p.createdAt).slice(0, 10))}</div>
            <div class="plan-bar"><i style="width:${Math.max(2, p.progress.percent)}%"></i></div>
          </div>
          <div class="row" style="gap:6px">
            <span class="small muted nowrap">${p.progress.done}/${p.progress.total}</span>
            <a class="btn btn-soft btn-sm" href="#/plan?id=${p.id}">继续</a>
            <button class="btn btn-quiet btn-sm" type="button" data-del-plan="${p.id}">删除</button>
          </div>
        </div>`).join('')}
      </div>
    </div>`;
}

function bindSaved(host) {
  host.querySelectorAll('[data-del-plan]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmDialog({ title: '删除学习计划', text: '删除后打卡记录会一并清除，且无法恢复。', confirmText: '删除', danger: true })) return;
    btn.disabled = true;
    try {
      await api.del(`/api/plan/${btn.dataset.delPlan}`);
      const card = btn.closest('.plan-saved-item');
      if (card) card.remove();
      toast('已删除学习计划');
    } catch (err) {
      btn.disabled = false;
      toast(err.message, 'error');
    }
  }));
}

function taskHtml(day, item, index, planId, checks) {
  const key = `${day.day}-${index}`;
  const checked = checks ? checks.has(key) : false;
  return `<div class="plan-task${checked ? ' done' : ''}">
    ${planId ? `<label class="plan-check"><input type="checkbox" data-task="${key}" ${checked ? 'checked' : ''} aria-label="标记完成"><span></span></label>` : ''}
    <div class="plan-task-body">
      <a href="#/material/${item.materialId}"><b>${esc(item.title)}</b></a>
      <span class="tag">${esc(item.category)}</span>
      <p>${esc(item.action)}</p>
      <span class="small muted">${item.minutes} 分钟 · ${esc(item.reason)}</span>
    </div>
  </div>`;
}

function resultHtml(data, opts = {}) {
  const summary = data.summary || {};
  if (!data.recommendations || !data.recommendations.length) {
    return `<div class="panel panel-pad">${emptyState({
      iconName: 'sparkles',
      title: '暂时没有匹配资料',
      text: (data.tips && data.tips[0]) || '换一个学科或目标再试试',
      action: '<a class="btn btn-primary" href="#/market">去资料市场看看</a>'
    })}</div>`;
  }
  const coverage = summary.coverage || 0;
  const checks = opts.checks ? new Set(opts.checks) : null;
  const progress = opts.progress;
  return `
    <div class="panel panel-pad plan-summary">
      <div class="row-between wrap" style="gap:12px">
        <div>
          <span class="badge green">${esc(data.goal.name)}</span>
          <h3 style="margin:8px 0 4px;font-size:20px">${esc(data.subject || '全学科')} · ${data.days} 天 · 每天 ${data.dailyMinutes} 分钟</h3>
          <p class="small muted" style="margin:0">候选 ${summary.candidateCount || 0} 份，精选 ${summary.matchedCount || 0} 份资料组合${opts.savedAt ? ` · 保存于 ${esc(String(opts.savedAt).slice(0, 10))}` : ''}</p>
        </div>
        <div class="plan-coverage"><b>${coverage}%</b><span>资料覆盖</span></div>
      </div>
      <div class="plan-bar"><i style="width:${Math.max(2, coverage)}%"></i></div>
      ${summary.strengths && summary.strengths.length ? `<div class="plan-gaps"><b>已具备</b>${summary.strengths.map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>` : ''}
      ${summary.gaps && summary.gaps.length ? `<div class="plan-gaps"><b>待补齐</b>${summary.gaps.map((s) => `<span class="tag warn">${esc(s)}</span>`).join('')}</div>` : ''}
      ${progress ? `<div class="plan-progress">
        <div class="row-between"><b>执行进度</b><span class="small muted" data-plan-progress-text>${progress.done}/${progress.total} 已完成</span></div>
        <div class="plan-bar"><i data-plan-progress-bar style="width:${Math.max(2, progress.percent)}%"></i></div>
      </div>` : ''}
      ${!opts.planId && state.user ? `<div class="row" style="margin-top:12px"><button class="btn btn-soft" type="button" data-save-plan>${icon('heart')} 保存计划并打卡</button><span class="small muted">保存后可逐项勾选完成，进度自动统计</span></div>` : ''}
    </div>

    <div class="split-2">
      <div class="panel panel-pad">
        <div class="row-between" style="margin-bottom:10px"><h3 style="font-size:17px;margin:0">逐日安排</h3><span class="small muted">可点击资料查看详情</span></div>
        <div class="plan-days">
          ${(data.plan || []).map((day) => `
            <div class="plan-day">
              <div class="plan-day-badge"><b>D${day.day}</b><span>${esc(day.date)}</span></div>
              <div class="plan-day-body">
                ${day.items.map((item, index) => taskHtml(day, item, index, opts.planId, checks)).join('')}
              </div>
            </div>`).join('')}
        </div>
      </div>

      <div class="panel panel-pad">
        <div class="row-between" style="margin-bottom:10px"><h3 style="font-size:17px;margin:0">推荐资料</h3><span class="small muted">按匹配分排序</span></div>
        <div class="plan-recs">
          ${data.recommendations.map((m) => `<a class="plan-rec" href="#/material/${m.id}">
            <div class="row-between" style="gap:8px">
              <b>${esc(m.title)}</b>
              <span class="plan-price">${money(m.price)}</span>
            </div>
            <div class="small muted" style="margin-top:4px">${esc(m.category)} · ${esc(m.subject || '通用')}${m.school ? ' · ' + esc(m.school) : ''}</div>
            <div class="plan-reasons">${m.reasons.map((r) => `<span class="tag">${esc(r)}</span>`).join('')}${m.purchased ? '<span class="tag">已购买</span>' : ''}</div>
          </a>`).join('')}
        </div>
      </div>
    </div>

    <div class="panel panel-pad">
      <h3 style="font-size:16px;margin:0 0 8px">执行建议</h3>
      <ul class="plan-tips">${(data.tips || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    </div>`;
}

function bindCheckins(host, planId) {
  const paint = (progress) => {
    const bar = host.querySelector('[data-plan-progress-bar]');
    if (bar) bar.style.width = `${Math.max(2, progress.percent)}%`;
    const text = host.querySelector('[data-plan-progress-text]');
    if (text) text.textContent = `${progress.done}/${progress.total} 已完成`;
    host.querySelectorAll('.plan-task').forEach((task) => {
      const cb = task.querySelector('[data-task]');
      if (cb) task.classList.toggle('done', cb.checked);
    });
  };
  host.querySelectorAll('[data-task]').forEach((cb) => cb.addEventListener('change', async () => {
    cb.disabled = true;
    try {
      const res = await api.post(`/api/plan/${planId}/check`, { taskKey: cb.dataset.task, done: cb.checked });
      paint(res.progress);
    } catch (err) {
      cb.checked = !cb.checked;
      toast(err.message, 'error');
    } finally {
      cb.disabled = false;
    }
  }));
}

function bindSave(root, host, payload) {
  const btn = host.querySelector('[data-save-plan]');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = '正在保存…';
    try {
      const saved = await api.post('/api/plan/save', payload);
      toast('计划已保存，可每日打卡');
      window.location.hash = `#/plan?id=${saved.id}`;
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = original;
      toast(err.message, 'error');
    }
  });
}

function bind(root, options) {
  const form = root.querySelector('#planForm');
  if (!form) return;
  attachSelectSearch(form.elements.subject, { placeholder: '搜索学科，支持模糊匹配' });
  let goal = form.querySelector('[data-goal].active')?.dataset.goal || 'final';
  let minutes = Number(form.querySelector('[data-minute].active')?.dataset.minute || 60);

  form.querySelectorAll('[data-goal]').forEach((btn) => btn.addEventListener('click', () => {
    goal = btn.dataset.goal;
    form.querySelectorAll('[data-goal]').forEach((b) => b.classList.toggle('active', b === btn));
  }));
  form.querySelectorAll('[data-minute]').forEach((btn) => btn.addEventListener('click', () => {
    minutes = Number(btn.dataset.minute);
    form.querySelectorAll('[data-minute]').forEach((b) => b.classList.toggle('active', b === btn));
  }));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = root.querySelector('#planResult');
    const submit = form.querySelector('button[type="submit"]');
    const payload = {
      goal,
      subject: form.querySelector('#planSubject').value,
      days: Number(form.querySelector('#planDays').value),
      dailyMinutes: minutes
    };
    submit.disabled = true;
    const original = submit.innerHTML;
    submit.innerHTML = '正在生成…';
    result.innerHTML = `<div class="panel panel-pad"><p class="muted">正在根据你的目标与资料库生成计划…</p></div>`;
    try {
      const data = await api.post('/api/plan/generate', payload);
      result.innerHTML = resultHtml(data);
      bindSave(root, result, payload);
      result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      result.innerHTML = '';
      toast(err.message, 'error');
    } finally {
      submit.disabled = false;
      submit.innerHTML = original;
    }
  });
}

async function paintSaved(root) {
  const host = root.querySelector('#planSaved');
  if (!host || !state.user) return;
  try {
    const data = await api.get('/api/plan/mine');
    host.innerHTML = savedListHtml(data);
    bindSaved(host);
  } catch {
    host.innerHTML = '';
  }
}

export async function renderPlan(root, { query = {} } = {}) {
  root.innerHTML = '<div class="loading-wrap"><div class="panel panel-pad"><p class="muted">正在加载规划选项…</p></div></div>';
  let options;
  try {
    options = optionsCache || await api.get('/api/plan/options');
    optionsCache = options;
  } catch (err) {
    root.innerHTML = emptyState({ iconName: 'alertCircle', title: '加载失败', text: err.message });
    return;
  }
  root.innerHTML = shell(options, query);
  bind(root, options);
  paintSaved(root);

  const planId = Number(query.id);
  if (!query.id) return;
  const result = root.querySelector('#planResult');
  if (!state.user) {
    result.innerHTML = `<div class="panel panel-pad"><p class="muted">登录后可查看保存的学习计划与打卡进度。</p></div>`;
    return;
  }
  result.innerHTML = `<div class="panel panel-pad"><p class="muted">正在加载学习计划…</p></div>`;
  try {
    const detail = await api.get(`/api/plan/${planId}`);
    result.innerHTML = resultHtml(detail.plan, {
      planId: detail.id,
      checks: detail.checks,
      progress: detail.progress,
      savedAt: detail.savedAt
    });
    bindCheckins(result, detail.id);
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    result.innerHTML = `<div class="panel panel-pad"><p class="muted">${esc(err.message)}</p></div>`;
  }
}
