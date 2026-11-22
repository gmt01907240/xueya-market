import { api } from '../api.js';
import { esc } from '../util.js';
import { icon, toast, emptyState } from '../components.js';

function detailText(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return '';
  }
}

function levelBadge(level) {
  if (level === 'critical') return '<span class="badge red">高危</span>';
  if (level === 'info') return '<span class="badge">提示</span>';
  return '<span class="badge gold">告警</span>';
}

export async function securityContent() {
  const [overview, alerts, events, audit] = await Promise.all([
    api.get('/api/admin/security/overview'),
    api.get('/api/admin/security/alerts?pageSize=10'),
    api.get('/api/admin/security/events?pageSize=15'),
    api.get('/api/admin/security/audit?pageSize=15')
  ]);
  const counts = overview.counts || {};
  const statusBadge = overview.mfaEnabled
    ? '<span class="badge green">动态令牌已绑定</span>'
    : '<span class="badge red">动态令牌未绑定</span>';

  return `<div class="admin-head">
      <div><h1>安全中心</h1><p>管理员登录防护、异常告警与操作审计</p></div>
      <span class="badge green">${icon('shield')} 管理员视角</span>
    </div>

    <div class="panel admin-section">
      <div class="row-between" style="margin-bottom:12px">
        <h3 style="margin:0">账号安全状态</h3>
        ${statusBadge}
      </div>
      <div class="quick-list">
        <div class="quick-item"><div style="min-width:0"><b>${esc(overview.admin?.username || '')}</b><span>${esc(overview.admin?.email || '')}</span></div><span class="spacer"></span><span class="small muted">最近登录：${esc(overview.admin?.lastLoginAt || '暂无')} · ${esc(overview.admin?.lastLoginIp || '-')}</span></div>
        <div class="quick-item"><div><b>密码有效期</b><span>上次修改：${esc(overview.passwordChangedAt || '未记录')}</span></div><span class="spacer"></span><span class="badge ${overview.passwordExpired ? 'red' : overview.passwordExpiresInDays <= 14 ? 'gold' : 'green'}">${overview.passwordExpired ? '已过期' : `剩余 ${overview.passwordExpiresInDays} 天`}</span></div>
      </div>
    </div>

    <div class="kpi-grid" style="margin-top:18px">
      <div class="kpi"><span>未处理告警</span><b>${counts.openAlerts || 0}<small> 条</small></b><small>累计 ${counts.alerts || 0} 条</small></div>
      <div class="kpi"><span>今日安全事件</span><b>${counts.eventsToday || 0}<small> 条</small></b><small>累计 ${counts.events || 0} 条</small></div>
      <div class="kpi"><span>今日后台操作</span><b>${counts.auditToday || 0}<small> 次</small></b><small>累计 ${counts.audit || 0} 次</small></div>
    </div>

    <div class="panel admin-section" style="margin-top:18px">
      <h3>异常登录告警</h3>
      ${alerts.items.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>时间</th><th>级别</th><th>类型</th><th>说明</th><th>IP</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          ${alerts.items.map((item) => `<tr>
            <td>${esc(item.created_at)}</td>
            <td>${levelBadge(item.level)}</td>
            <td>${esc(item.type)}</td>
            <td class="small">${esc(item.message)}</td>
            <td class="small">${esc(item.ip || '-')}</td>
            <td>${item.acknowledged ? '<span class="badge">已确认</span>' : '<span class="badge red">待处理</span>'}</td>
            <td>${item.acknowledged ? '' : `<button class="btn btn-ghost btn-sm" data-alert-ack="${item.id}">确认</button>`}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : emptyState({ iconName: 'shield', title: '暂无告警', text: '未发现异常登录行为' })}
    </div>

    <div class="panel admin-section" style="margin-top:18px">
      <h3>安全事件</h3>
      ${events.items.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>时间</th><th>事件</th><th>IP</th><th>设备</th><th>详情</th></tr></thead>
        <tbody>
          ${events.items.map((item) => `<tr>
            <td>${esc(item.created_at)}</td>
            <td><b>${esc(item.type)}</b></td>
            <td class="small">${esc(item.ip || '-')}</td>
            <td class="small" title="${esc(item.ua || '')}">${esc((item.ua || '-').slice(0, 42))}</td>
            <td class="small">${esc(detailText(item.detail))}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : emptyState({ iconName: 'shield', title: '暂无安全事件', text: '管理员登录与安全操作会记录在此' })}
    </div>

    <div class="panel admin-section" style="margin-top:18px">
      <h3>管理员操作审计</h3>
      ${audit.items.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>时间</th><th>管理员</th><th>方法</th><th>路径</th><th>状态</th><th>IP</th><th>耗时</th></tr></thead>
        <tbody>
          ${audit.items.map((item) => `<tr>
            <td>${esc(item.created_at)}</td>
            <td>${esc(item.admin_name || '-')}</td>
            <td><code>${esc(item.method)}</code></td>
            <td class="small">${esc(item.path)}</td>
            <td>${item.status < 400 ? `<span class="badge green">${item.status}</span>` : `<span class="badge red">${item.status}</span>`}</td>
            <td class="small">${esc(item.ip || '-')}</td>
            <td class="small">${item.duration_ms} ms</td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : emptyState({ iconName: 'clipboard', title: '暂无审计日志', text: '管理员后台操作会全量记录' })}
    </div>`;
}

export function bindSecurity(root, ctx, rerender) {
  root.querySelectorAll('[data-alert-ack]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await api.post(`/api/admin/security/alerts/${btn.dataset.alertAck}/ack`);
        toast(res.message);
        rerender();
      } catch (err) {
        btn.disabled = false;
        toast(err.message, 'error');
      }
    });
  });
}
