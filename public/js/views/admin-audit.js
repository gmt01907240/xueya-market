import { api } from '../api.js';
import { esc, dateAgo } from '../util.js';
import { icon, toast, openModal, confirmDialog, emptyState } from '../components.js';

const LEVEL_META = {
  block: { text: '直接拦截', cls: 'red' },
  review: { text: '人工复核', cls: 'gold' },
  watch: { text: '关注项', cls: 'gray' }
};

const VERDICT_META = {
  pass: { text: '通过', cls: 'green' },
  review: { text: '疑似违规', cls: 'gold' },
  block: { text: '已拦截', cls: 'red' },
  error: { text: '检测异常', cls: 'gray' }
};

const LOG_STATUS_TEXT = {
  auto_pass: '自动放行',
  pending_review: '待人工复核',
  blocked: '自动拦截',
  error_review: '异常转复核',
  manual_approved: '人工通过',
  manual_rejected: '人工驳回'
};

function levelBadge(level) {
  const meta = LEVEL_META[level] || LEVEL_META.review;
  return `<span class="badge ${meta.cls}">${meta.text}</span>`;
}

function verdictBadge(verdict) {
  const meta = VERDICT_META[verdict] || { text: verdict, cls: 'gray' };
  return `<span class="badge ${meta.cls}">${meta.text}</span>`;
}

export async function auditContent(ctx) {
  const section = ctx.query.section === 'logs' ? 'logs' : 'rules';
  const verdict = ['pass', 'review', 'block', 'error'].includes(ctx.query.verdict) ? ctx.query.verdict : '';
  const page = Math.max(1, Number(ctx.query.page) || 1);
  let overview;
  try {
    overview = await api.get('/api/admin/audit/overview');
  } catch (err) {
    return emptyState({ iconName: 'alertCircle', title: '内容审核数据加载失败', text: err.message });
  }
  const stats = overview.stats;
  let body;
  if (section === 'rules') {
    const data = await api.get('/api/admin/audit/rules');
    body = rulesTable(data.items);
  } else {
    const data = await api.get(`/api/admin/audit/logs?verdict=${encodeURIComponent(verdict)}&page=${page}`);
    body = logsTable(data, verdict);
  }

  const settings = stats.settings;
  return `<div class="admin-head">
      <div><h1>内容审核</h1><p>提交即检测 · 自动拦截违法内容 · 疑似风险转人工复核</p></div>
      <div class="row" style="gap:8px">
        <button class="btn btn-ghost" type="button" data-audit-test>${icon('search')} 规则测试</button>
        <button class="btn btn-ghost" type="button" data-audit-reload>${icon('refresh')} 刷新缓存</button>
        <button class="btn btn-soft" type="button" data-audit-settings>${icon('settings')} 阈值设置</button>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi"><span>今日检测</span><b>${stats.today.total}<small> 次</small></b><small>通过 ${stats.today.pass} · 疑似 ${stats.today.review} · 拦截 ${stats.today.blocked}</small></div>
      <div class="kpi"><span>累计自动拦截</span><b>${stats.totalBlocked}<small> 次</small></b><small>违法违规内容未进入审核队列</small></div>
      <div class="kpi"><span>待人工复核</span><b>${stats.pendingReviewMaterials}<small> 份</small></b><small>机审疑似或检测异常的资料</small></div>
      <div class="kpi"><span>平均检测耗时</span><b>${stats.today.avgDurationMs}<small> ms</small></b><small>同步检测，不阻塞提交</small></div>
    </div>

    <div class="panel admin-section" style="margin-top:18px">
      <div class="row-between wrap">
        <div class="row wrap" style="gap:8px">
          <span class="badge ${settings.enabled ? 'green' : 'gray'}">${settings.enabled ? '自动审核已启用' : '自动审核已暂停'}</span>
          <span class="small muted">复核阈值 ${settings.reviewThreshold} 分 · 拦截阈值 ${settings.blockThreshold} 分 · 单次扫描 ${settings.maxScanChars} 字符 · 规则 ${stats.activeRules}/${stats.totalRules} 条启用</span>
        </div>
        <span class="small muted">规则版本 v${stats.engineVersion}${stats.lastError ? ' · 最近异常：' + esc(stats.lastError) : ''}</span>
      </div>
    </div>

    <div class="admin-filter" style="margin-top:18px">
      <a class="chip ${section === 'rules' ? 'active' : ''}" href="#/admin?tab=audit&section=rules">规则库 · ${stats.totalRules}</a>
      <a class="chip ${section === 'logs' ? 'active' : ''}" href="#/admin?tab=audit&section=logs">审核日志</a>
      ${section === 'rules' ? `<button class="btn btn-primary btn-sm" type="button" data-audit-create>${icon('plus')} 新增规则</button>` : ''}
    </div>
    ${body}`;
}

function rulesTable(items) {
  if (!items.length) {
    return emptyState({ iconName: 'shield', title: '还没有审核规则', text: '新增规则后立即生效' });
  }
  const byCategory = {};
  for (const rule of items) {
    (byCategory[rule.category] = byCategory[rule.category] || []).push(rule);
  }
  return Object.entries(byCategory).map(([category, rules]) => `<div class="panel admin-section" style="margin-top:14px">
      <h3>${esc(category)} <span class="small muted">· ${rules.length} 条</span></h3>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>规则</th><th>等级</th><th>权重</th><th>匹配</th><th>命中</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${rules.map((r) => `<tr>
          <td class="cell-title"><b class="mono small">${esc(r.code)}</b><span title="${esc(r.pattern)}">${esc(r.pattern.length > 48 ? r.pattern.slice(0, 48) + '…' : r.pattern)}</span>
            ${r.tip ? `<span class="small muted">${esc(r.tip)}</span>` : ''}${r.valid ? '' : ' <span class="badge red">正则异常</span>'}</td>
          <td>${levelBadge(r.level)}</td>
          <td class="num">${r.weight}</td>
          <td><span class="tag">${r.matchType === 'regex' ? '正则' : '关键词'}</span>${r.source === 'builtin' ? ' <span class="small muted">内置</span>' : ''}</td>
          <td class="num">${r.hitCount}</td>
          <td><span class="badge ${r.active ? 'green' : 'gray'}">${r.active ? '启用' : '停用'}</span></td>
          <td><div class="actions">
            <button class="btn btn-ghost btn-xs" data-audit-edit="${r.id}">编辑</button>
            <button class="btn ${r.active ? 'btn-ghost' : 'btn-soft'} btn-xs" data-audit-toggle="${r.id}" data-active="${r.active ? '1' : '0'}">${r.active ? '停用' : '启用'}</button>
            <button class="btn btn-danger btn-xs" data-audit-delete="${r.id}" data-code="${esc(r.code)}">删除</button>
          </div></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`).join('');
}

function logsTable(data, verdict) {
  const chips = [['', '全部'], ['pass', '通过'], ['review', '疑似'], ['block', '拦截'], ['error', '异常']];
  const link = (nextVerdict, nextPage) => {
    const q = new URLSearchParams({ tab: 'audit', section: 'logs' });
    if (nextVerdict) q.set('verdict', nextVerdict);
    if (nextPage && nextPage > 1) q.set('page', String(nextPage));
    return `#/admin?${q.toString()}`;
  };
  return `<div class="panel admin-section" style="margin-top:14px">
    <div class="admin-filter">
      ${chips.map(([key, text]) => `<a class="chip ${verdict === key ? 'active' : ''}" href="${link(key)}">${text}${data.counts[key] !== undefined ? ` · ${data.counts[key]}` : ''}</a>`).join('')}
    </div>
    ${data.items.length ? `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>时间</th><th>资料 / 提交人</th><th>检测结果</th><th>分数</th><th>触发规则</th><th>处理状态</th><th>耗时</th></tr></thead>
      <tbody>${data.items.map((log) => `<tr>
        <td class="small muted">${dateAgo(log.createdAt)}<br><span class="mono small">#${log.id}</span></td>
        <td class="cell-title">${log.targetId ? `<b><a href="#/material/${log.targetId}">${esc(log.materialTitle || '资料 #' + log.targetId)}</a></b>` : '<b>未入库（提交被拦截）</b>'}
          <span>${esc(log.user)} · ${log.action === 'update' ? '修改资料' : '提交资料'}</span></td>
        <td>${verdictBadge(log.verdict)}${log.excerpt ? `<br><span class="small muted" title="${esc(log.excerpt)}">${esc(log.excerpt.slice(0, 26))}…</span>` : ''}</td>
        <td class="num">${log.score}</td>
        <td class="small">${log.hits.length ? log.hits.map((h) => `<span class="tag" title="${esc(h.tip)}">${esc(h.category)}</span>`).join(' ') : '<span class="muted">—</span>'}</td>
        <td><span class="badge ${log.status === 'blocked' ? 'red' : log.status === 'manual_approved' || log.status === 'auto_pass' ? 'green' : 'gold'}">${LOG_STATUS_TEXT[log.status] || log.status}</span>${log.note ? `<br><span class="small muted">${esc(log.note)}</span>` : ''}</td>
        <td class="small muted">${log.durationMs} ms</td>
      </tr>`).join('')}</tbody>
    </table></div>` : emptyState({ iconName: 'clipboard', title: '暂无审核日志', text: '资料提交或修改后会在这里留下完整记录' })}
    ${data.pages > 1 ? `<div class="row" style="justify-content:center;gap:10px;margin-top:14px">
      ${data.page > 1 ? `<a class="btn btn-ghost btn-sm" href="${link(verdict, data.page - 1)}">上一页</a>` : ''}
      <span class="small muted">第 ${data.page} / ${data.pages} 页</span>
      ${data.page < data.pages ? `<a class="btn btn-ghost btn-sm" href="${link(verdict, data.page + 1)}">下一页</a>` : ''}
    </div>` : ''}
  </div>`;
}

export function bindAudit(root, ctx, rerender) {
  let metaCache = null;
  const ensureMeta = async () => {
    if (!metaCache) metaCache = await api.get('/api/admin/audit/rules');
    return metaCache;
  };

  root.querySelector('[data-audit-create]')?.addEventListener('click', async () => {
    try {
      const meta = await ensureMeta();
      openRuleModal(null, meta, rerender);
    } catch (err) { toast(err.message, 'error'); }
  });

  root.querySelectorAll('[data-audit-edit]').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      const meta = await ensureMeta();
      const rule = meta.items.find((r) => String(r.id) === btn.dataset.auditEdit);
      if (!rule) return toast('规则不存在，请刷新后重试', 'error');
      openRuleModal(rule, meta, rerender);
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelectorAll('[data-audit-toggle]').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      const active = btn.dataset.active === '1';
      const res = await api.patch(`/api/admin/audit/rules/${btn.dataset.auditToggle}`, { active: !active });
      toast(res.message);
      rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelectorAll('[data-audit-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '删除这条审核规则？',
      text: `规则 ${btn.dataset.code} 删除后将立即停止生效。若是内置规则，建议优先「停用」而不是删除。`,
      confirmText: '删除规则', danger: true
    });
    if (!ok) return;
    try {
      const res = await api.del(`/api/admin/audit/rules/${btn.dataset.auditDelete}`);
      toast(res.message);
      rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelector('[data-audit-test]')?.addEventListener('click', () => openTestModal());
  root.querySelector('[data-audit-settings]')?.addEventListener('click', async () => {
    try {
      const data = await api.get('/api/admin/audit/settings');
      openSettingsModal(data.settings, rerender);
    } catch (err) { toast(err.message, 'error'); }
  });
  root.querySelector('[data-audit-reload]')?.addEventListener('click', async () => {
    try {
      const res = await api.post('/api/admin/audit/rules/reload');
      toast(res.message);
      rerender();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function openRuleModal(existing, meta, onDone) {
  const categoryOptions = meta.categories.map((c) => `<option value="${esc(c)}" ${existing && existing.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const levelOptions = meta.levels.map((l) => `<option value="${esc(l.key)}" ${existing && existing.level === l.key ? 'selected' : ''}>${esc(l.text)}</option>`).join('');
  const modal = openModal({
    title: existing ? '编辑审核规则' : '新增审核规则',
    subtitle: '保存后即时生效，无需重启服务',
    wide: true,
    body: `<div class="stack" style="gap:14px">
      <div class="form-grid-2">
        <div class="field"><label class="label">规则编号</label><input class="input" data-code maxlength="40" value="${existing ? esc(existing.code) : ''}" placeholder="例如 CUSTOM_001"></div>
        <div class="field"><label class="label">违规分类</label><select class="select" data-category>${categoryOptions}</select></div>
      </div>
      <div class="form-grid-2">
        <div class="field"><label class="label">规则等级</label><select class="select" data-level>${levelOptions}</select></div>
        <div class="field"><label class="label">权重（1—100）</label><input class="input" data-weight type="number" min="1" max="100" value="${existing ? existing.weight : 20}"></div>
      </div>
      <div class="field"><label class="label">匹配方式</label>
        <select class="select" data-match>
          <option value="keyword" ${!existing || existing.matchType === 'keyword' ? 'selected' : ''}>关键词（自动忽略空格、标点与零宽字符）</option>
          <option value="regex" ${existing && existing.matchType === 'regex' ? 'selected' : ''}>正则表达式（组合语义与行为模式）</option>
        </select>
      </div>
      <div class="field"><label class="label">匹配表达式</label>
        <textarea class="textarea mono" data-pattern maxlength="500" style="min-height:96px" placeholder="关键词用 | 分隔，例如：代写|代考|包过">${existing ? esc(existing.pattern) : ''}</textarea>
      </div>
      <div class="field"><label class="label">规则说明</label><input class="input" data-tip maxlength="120" value="${existing ? esc(existing.tip || '') : ''}" placeholder="命中的内容会展示给管理员，便于快速复核"></div>
      <label class="check-row"><input type="checkbox" data-active ${!existing || existing.active ? 'checked' : ''}> 启用该规则</label>
      <div class="error-text hidden" data-error></div>
    </div>`,
    footer: `<button class="btn btn-ghost" data-cancel>取消</button>
             <button class="btn btn-primary" data-submit>${existing ? '保存修改' : '新增并生效'}</button>`
  });
  modal.el.querySelector('[data-cancel]').addEventListener('click', modal.close);
  modal.el.querySelector('[data-submit]').addEventListener('click', async () => {
    const val = (sel) => modal.el.querySelector(sel).value;
    const payload = {
      code: val('[data-code]').trim(),
      category: val('[data-category]'),
      level: val('[data-level]'),
      weight: Number(val('[data-weight]')),
      matchType: val('[data-match]'),
      pattern: val('[data-pattern]').trim(),
      tip: val('[data-tip]').trim(),
      active: modal.el.querySelector('[data-active]').checked
    };
    const error = modal.el.querySelector('[data-error]');
    try {
      if (existing) await api.patch(`/api/admin/audit/rules/${existing.id}`, payload);
      else await api.post('/api/admin/audit/rules', payload);
      modal.close();
      toast(existing ? '规则已更新并即时生效' : '规则已新增并即时生效');
      if (onDone) onDone();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    }
  });
}

function openSettingsModal(settings, onDone) {
  const modal = openModal({
    title: '审核阈值设置',
    subtitle: '分级阈值用于平衡拦截准确率与正常内容发布',
    body: `<div class="stack" style="gap:14px">
      <label class="check-row"><input type="checkbox" data-enabled ${settings.enabled ? 'checked' : ''}> 启用内容自动审核</label>
      <div class="form-grid-2">
        <div class="field"><label class="label">人工复核阈值（1—100）</label><input class="input" data-review type="number" min="1" max="100" value="${settings.reviewThreshold}"><div class="hint">累计权重达到该分数即进入人工复核</div></div>
        <div class="field"><label class="label">自动拦截阈值（1—100）</label><input class="input" data-block type="number" min="1" max="100" value="${settings.blockThreshold}"><div class="hint">命中直接拦截规则，或分数达到该值即拒绝提交</div></div>
      </div>
      <div class="field"><label class="label">单次扫描字符数</label><input class="input" data-max type="number" min="1000" max="1000000" step="1000" value="${settings.maxScanChars}"><div class="hint">超长文件仅扫描前 N 个字符，保证毫秒级响应</div></div>
      <div class="error-text hidden" data-error></div>
    </div>`,
    footer: `<button class="btn btn-ghost" data-cancel>取消</button>
             <button class="btn btn-primary" data-submit>保存设置</button>`
  });
  modal.el.querySelector('[data-cancel]').addEventListener('click', modal.close);
  modal.el.querySelector('[data-submit]').addEventListener('click', async () => {
    const payload = {
      enabled: modal.el.querySelector('[data-enabled]').checked,
      reviewThreshold: Number(modal.el.querySelector('[data-review]').value),
      blockThreshold: Number(modal.el.querySelector('[data-block]').value),
      maxScanChars: Number(modal.el.querySelector('[data-max]').value)
    };
    const error = modal.el.querySelector('[data-error]');
    try {
      const res = await api.patch('/api/admin/audit/settings', payload);
      modal.close();
      toast(res.message);
      if (onDone) onDone();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    }
  });
}

function openTestModal() {
  const modal = openModal({
    title: '规则测试',
    subtitle: '输入一段文本，查看当前规则库的检测结果（不会写入日志）',
    wide: true,
    body: `<div class="stack" style="gap:14px">
      <div class="field"><label class="label">待检测文本</label>
        <textarea class="textarea" data-text maxlength="20000" style="min-height:140px" placeholder="粘贴资料标题、介绍或正文片段"></textarea>
      </div>
      <div class="row"><button class="btn btn-primary btn-sm" data-run>${icon('search')} 开始检测</button><span class="small muted" data-cost></span></div>
      <div data-result></div>
    </div>`,
    footer: `<button class="btn btn-ghost" data-close>关闭</button>`
  });
  modal.el.querySelector('[data-close]').addEventListener('click', modal.close);
  modal.el.querySelector('[data-run]').addEventListener('click', async () => {
    const text = modal.el.querySelector('[data-text]').value.trim();
    const result = modal.el.querySelector('[data-result]');
    const cost = modal.el.querySelector('[data-cost]');
    if (!text) return toast('请先输入待检测文本', 'error');
    result.innerHTML = '<span class="small muted">检测中…</span>';
    try {
      const res = await api.post('/api/admin/audit/rules/test', { text });
      const r = res.result;
      cost.textContent = `耗时 ${r.durationMs} ms`;
      result.innerHTML = `<div class="stack" style="gap:8px">
        <div class="row" style="gap:8px">${verdictBadge(r.verdict)}<b>${r.score} 分</b><span class="small muted">${r.categories.length ? esc(r.categories.join('、')) : '未命中分类'}</span></div>
        ${r.hits.length ? r.hits.map((h) => `<div class="guarantee">${icon('alertCircle')} <b>${esc(h.code)}</b> · ${esc(h.category)} · ${esc(h.tip || '')}<br><span class="small muted">${esc(h.excerpt || '')}</span></div>`).join('') : '<p class="small muted" style="margin:0">未命中任何规则，内容可正常提交。</p>'}
      </div>`;
    } catch (err) {
      result.innerHTML = `<div class="error-text">${esc(err.message)}</div>`;
    }
  });
}
