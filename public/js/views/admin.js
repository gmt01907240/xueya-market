import { api } from '../api.js';
import { esc, money, moneyPlain, dateAgo, statusMeta, catIndex, CAT_GLYPHS, verifyMeta, ticketStatusMeta, TICKET_TYPE_TEXT } from '../util.js';
import { icon, toast, openModal, confirmDialog, promptDialog, emptyState, loadingBlock, statusBadge, avatar } from '../components.js';
import { state } from '../layout.js';
import { openTicketModal } from './support.js';
import { auditContent, bindAudit } from './admin-audit.js';
import { securityContent, bindSecurity } from './admin-security.js';
import { attachSelectSearch } from '../list-search.js';

const TABS = [
  ['overview', '数据概览', 'chart'],
  ['materials', '资料审核', 'clipboard'],
  ['audit', '内容审核', 'shield'],
  ['verifications', '认证审核', 'badgeCheck'],
  ['tickets', '客服工单', 'headphones'],
  ['pricing', '价格标准库', 'scale'],
  ['bargains', '砍价活动', 'gift'],
  ['users', '用户管理', 'users'],
  ['reports', '举报处理', 'flag'],
  ['finance', '退款处理', 'creditCard'],
  ['payments', '支付对账', 'receipt'],
  ['announcements', '公告管理', 'book'],
  ['security', '安全中心', 'shield']
];

export async function renderAdmin(root, ctx) {
  const tab = TABS.some((t) => t[0] === ctx.query.tab) ? ctx.query.tab : 'overview';
  root.innerHTML = `<div class="loading-wrap">${loadingBlock('正在加载管理后台…')}</div>`;
  let overview;
  try {
    overview = await api.get('/api/admin/overview');
  } catch (err) {
    root.innerHTML = emptyState({ iconName: 'alertCircle', title: '无权限访问', text: err.message, action: '<a class="btn btn-primary" href="#/">返回首页</a>' });
    return;
  }
  const stats = overview.stats;

  let content = '';
  try {
    if (tab === 'overview') content = overviewContent(overview);
    else if (tab === 'materials') content = await materialsContent(ctx);
    else if (tab === 'audit') content = await auditContent(ctx);
    else if (tab === 'verifications') content = await verificationsContent(ctx);
    else if (tab === 'tickets') content = await ticketsContent(ctx);
    else if (tab === 'pricing') content = await pricingContent();
    else if (tab === 'bargains') content = await bargainsContent();
    else if (tab === 'users') content = await usersContent(ctx);
    else if (tab === 'reports') content = await reportsContent();
    else if (tab === 'finance') content = await financeContent();
    else if (tab === 'payments') content = await paymentsContent(ctx);
    else if (tab === 'announcements') content = await announcementsContent();
    else if (tab === 'security') content = await securityContent(ctx);
  } catch (err) {
    content = emptyState({ iconName: 'alertCircle', title: '数据加载失败', text: err.message });
  }

  root.innerHTML = `<div class="view-enter admin-shell">
    <aside class="panel admin-side">
      <div class="admin-title"><b>平台管理</b><span>学涯集市 · 运营控制台</span></div>
      <nav class="admin-nav">
        ${TABS.map(([key, text, iconName]) => {
          const badge = key === 'materials' ? stats.pendingMaterials
            : key === 'audit' ? (stats.pendingAuditReviews || 0)
            : key === 'verifications' ? stats.pendingVerifications
            : key === 'tickets' ? stats.openTickets
            : key === 'reports' ? stats.pendingReports
            : key === 'finance' ? stats.pendingRefunds : 0;
          return `<a href="#/admin?tab=${key}" class="${tab === key ? 'active' : ''}">${icon(iconName)} ${text}${badge ? `<span class="pill">${badge}</span>` : ''}</a>`;
        }).join('')}
      </nav>
    </aside>
    <div class="admin-content">${content}</div>
  </div>`;

  bindAdmin(root, ctx, tab);
}

function overviewContent(overview) {
  const s = overview.stats;
  const maxGmv = Math.max(...overview.series.map((d) => d.gmv), 1);
  return `<div class="admin-head">
      <div><h1>数据概览</h1><p>平台交易、内容与治理的关键指标</p></div>
      <span class="badge green">${icon('shield')} 管理员视角</span>
    </div>
    <div class="kpi-grid">
      <div class="kpi"><span>注册用户</span><b>${s.users}<small> 人</small></b><small>其中 ${s.sellers} 人上传过资料</small></div>
      <div class="kpi"><span>在架资料</span><b>${s.materials}<small> 份</small></b><small>${s.pendingMaterials} 份待审核</small></div>
      <div class="kpi"><span>累计成交额</span><b>¥${moneyPlain(s.gmv)}</b><small>${s.orders} 笔有效订单</small></div>
      <div class="kpi"><span>平台服务费</span><b>¥${moneyPlain(s.revenue)}</b><small>按成交额 10% 计提</small></div>
    </div>

    <div class="panel admin-section" style="margin-top:18px">
      <div class="row-between" style="margin-bottom:6px">
        <h3 style="margin:0">近 7 天成交额</h3><span class="small muted">单位：元</span>
      </div>
      <div class="chart">
        ${overview.series.map((d) => {
          const h = Math.max(3, Math.round((d.gmv / maxGmv) * 100));
          return `<div class="col"><div class="bar ${d.gmv ? '' : 'zero'}" style="height:${h}%" data-tip="¥${(d.gmv / 100).toFixed(2)} · ${d.count} 单"></div><span class="day">${d.date}</span></div>`;
        }).join('')}
      </div>
    </div>

    <div class="admin-grid" style="margin-top:18px">
      <div class="panel admin-section">
        <h3>最近上架申请</h3>
        <div class="quick-list">
          ${overview.recent.materials.map((m) => {
            const meta = statusMeta(m.status);
            return `<div class="quick-item">
              ${avatar(m.nickname, 'sm')}
              <div style="min-width:0"><b>${esc(m.title)}</b><span>${esc(m.nickname)} · ${dateAgo(m.created_at)}</span></div>
              <span class="spacer"></span>
              <span class="badge ${meta.cls}">${meta.text}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="panel admin-section">
        <h3>待办事项</h3>
        <div class="quick-list">
          <a class="quick-item" href="#/admin?tab=materials"><span class="badge gold">${s.pendingMaterials}</span><div><b>待审核资料</b><span>通过后即可在市场展示</span></div><span class="spacer"></span>${icon('chevronRight')}</a>
          <a class="quick-item" href="#/admin?tab=verifications"><span class="badge accent">${s.pendingVerifications}</span><div><b>待审核认证</b><span>核验学号与实名信息后开放交易</span></div><span class="spacer"></span>${icon('chevronRight')}</a>
          <a class="quick-item" href="#/admin?tab=tickets"><span class="badge gold">${s.openTickets}</span><div><b>待处理工单</b><span>官方客服工单与历史卖家咨询归档</span></div><span class="spacer"></span>${icon('chevronRight')}</a>
          <a class="quick-item" href="#/admin?tab=reports"><span class="badge red">${s.pendingReports}</span><div><b>待处理举报</b><span>需在 48 小时内响应</span></div><span class="spacer"></span>${icon('chevronRight')}</a>
          <a class="quick-item" href="#/admin?tab=finance"><span class="badge accent">${s.pendingRefunds}</span><div><b>退款申请</b><span>核实资料与描述是否一致</span></div><span class="spacer"></span>${icon('chevronRight')}</a>
        </div>
      </div>
    </div>

    <div class="panel admin-section" style="margin-top:18px">
      <h3>成交排行</h3>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>资料</th><th>分类</th><th>成交份数</th><th>成交额</th></tr></thead>
        <tbody>${overview.topMaterials.map((m) => `<tr>
          <td class="cell-title"><b>${esc(m.title)}</b></td>
          <td><span class="tag">${esc(m.category)}</span></td>
          <td>${m.sold}</td>
          <td class="num">¥${moneyPlain(m.gmv)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

async function materialsContent(ctx) {
  const status = ctx.query.status || 'pending';
  const data = await api.get(`/api/admin/materials?status=${encodeURIComponent(status === 'all' ? 'all' : status)}`);
  const chips = [['pending', '待审核'], ['approved', '已上架'], ['rejected', '已驳回'], ['offline', '已下架'], ['all', '全部']];
  return `<div class="admin-head">
      <div><h1>资料审核</h1><p>逐份检查内容与描述，保障平台资料质量；机审疑似内容已优先标记</p></div>
    </div>
    <div class="panel admin-section">
      <div class="admin-filter">
        ${chips.map(([key, text]) => `<a class="chip ${status === key ? 'active' : ''}" href="#/admin?tab=materials&status=${key}">${text}${key !== 'all' && data.counts[key] !== undefined ? ` · ${data.counts[key]}` : ''}</a>`).join('')}
        ${data.counts.autoReview ? `<span class="badge red">${icon('alertCircle')} ${data.counts.autoReview} 份机审疑似，建议优先复核</span>` : ''}
      </div>
      ${data.items.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>资料</th><th>卖家</th><th>价格</th><th>状态 / 机审</th><th>数据</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${data.items.map((m) => {
          const meta = statusMeta(m.status);
          return `<tr>
            <td class="cell-title"><b><a href="#/material/${m.id}">${esc(m.title)}</a></b><span>${esc(m.category)}${m.subject ? ` · ${esc(m.subject)}` : ''}${m.teacher ? ` · ${esc(m.teacher)}老师` : ''} · ${esc(m.fileName)} · ${dateAgo(m.createdAt)}${m.pendingReports ? ' · 有举报' : ''}</span></td>
            <td>${esc(m.seller.nickname)}<br><span class="small muted">${esc(m.seller.school || '')}</span></td>
            <td class="num">${money(m.price)}<br>
              <button class="btn btn-quiet btn-xs" data-price-adjust="${m.id}" data-price="${(m.price / 100).toFixed(1)}">校准</button>
              ${m.priceSource === 'admin' ? '<span class="price-note">已校准</span>' : ''}
            </td>
            <td><span class="badge ${meta.cls}">${meta.text}</span>${auditBadge(m.audit)}</td>
            <td class="small muted">${m.downloads} 下载</td>
            <td><div class="actions">
              ${m.status === 'pending' ? `<button class="btn btn-primary btn-xs" data-approve="${m.id}">通过</button><button class="btn btn-danger btn-xs" data-reject="${m.id}">驳回</button>` : ''}
              ${m.status === 'approved' ? `<button class="btn btn-danger btn-xs" data-offline="${m.id}">下架</button>` : ''}
              ${m.status === 'rejected' || m.status === 'offline' ? `<button class="btn btn-soft btn-xs" data-approve="${m.id}">重新上架</button>` : ''}
            </div></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : emptyState({ iconName: 'checkCircle', title: '没有需要处理的资料', text: '当前筛选条件下暂无内容' })}
    </div>`;
}

function auditBadge(audit) {
  if (!audit || !audit.verdict) return '';
  if (audit.verdict === 'review') {
    return `<br><span class="badge gold" title="${esc((audit.hits || []).map((h) => h.tip).join('；'))}">机审疑似 · ${audit.score} 分</span>`;
  }
  if (audit.verdict === 'error') return '<br><span class="badge gray">机审异常 · 转人工</span>';
  return '<br><span class="badge green">机审通过</span>';
}

async function usersContent(ctx) {
  const q = ctx.query.q || '';
  const data = await api.get(`/api/admin/users?q=${encodeURIComponent(q)}`);
  return `<div class="admin-head">
      <div><h1>用户管理</h1><p>查看用户活跃与交易情况，处理违规账号</p></div>
    </div>
    <div class="panel admin-section">
      <form class="market-search" data-user-search style="margin-bottom:14px">
        <div class="search-box">${icon('search')}<input type="search" name="q" value="${esc(q)}" placeholder="搜索昵称、邮箱或用户名"></div>
        <button class="btn btn-ghost" type="submit">搜索</button>
      </form>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>用户</th><th>院校</th><th>角色</th><th>资料/收益</th><th>账户收益</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${data.items.map((u) => `<tr>
          <td class="cell-title"><b>${esc(u.nickname)}</b><span>${esc(u.email)} · 注册于 ${String(u.createdAt).slice(0, 10)}</span></td>
          <td>${esc(u.school || '—')}</td>
          <td>${u.role === 'admin' ? '<span class="badge gold">管理员</span>' : '<span class="badge gray">普通用户</span>'}</td>
          <td class="small">${u.materialCount} 份 · ¥${moneyPlain(u.income)}</td>
          <td class="num">¥${moneyPlain(u.balance)}</td>
          <td>${u.status === 'banned' ? '<span class="badge red">已限制</span>' : '<span class="badge green">正常</span>'}</td>
          <td><div class="actions">
            ${u.role === 'admin' ? '' : `<button class="btn ${u.status === 'banned' ? 'btn-soft' : 'btn-danger'} btn-xs" data-user-status="${u.id}" data-next="${u.status === 'banned' ? 'active' : 'banned'}">${u.status === 'banned' ? '恢复账号' : '限制账号'}</button>`}
            <a class="btn btn-quiet btn-xs" href="#/u/${u.id}">主页</a>
          </div></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

async function reportsContent() {
  const data = await api.get('/api/admin/reports?status=pending');
  return `<div class="admin-head">
      <div><h1>举报处理</h1><p>核实侵权、描述不符等问题，维护平台秩序</p></div>
      <span class="badge gold">${data.pending} 条待处理</span>
    </div>
    <div class="panel admin-section">
      ${data.items.length ? data.items.map((r) => `<div class="report-card">
        <div class="rhead">
          <span class="badge red">${esc(r.reason)}</span>
          <a class="link small" href="#/material/${r.material.id}">${esc(r.material.title)}</a>
          <span class="spacer"></span>
          <span class="small muted">${dateAgo(r.createdAt)}</span>
        </div>
        <p>${esc(r.detail || '举报人未填写补充说明')}</p>
        <div class="rfoot">
          <span class="small muted">举报人：${esc(r.reporter)} · 卖家：${esc(r.seller)}</span>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-sm" data-report-dismiss="${r.id}">驳回举报</button>
          <button class="btn btn-danger btn-sm" data-report-takedown="${r.id}">核实并下架</button>
        </div>
      </div>`).join('') : emptyState({ iconName: 'flag', title: '没有待处理的举报', text: '平台秩序良好，继续保持' })}
    </div>`;
}

async function financeContent() {
  const refunds = await api.get('/api/admin/refunds');
  return `<div class="admin-head">
      <div><h1>退款处理</h1><p>处理买家退款诉求，通过后按原支付渠道退回</p></div>
    </div>
    <div class="panel admin-section">
      <h3>退款申请（${refunds.items.length}）</h3>
      ${refunds.items.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>资料</th><th>买家</th><th>卖家</th><th>金额</th><th>申请时间</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${refunds.items.map((o) => `<tr>
          <td class="cell-title"><b><a href="#/material/${o.material.id}">${esc(o.material.title)}</a></b></td>
          <td>${esc(o.buyer)}</td>
          <td>${esc(o.seller)}</td>
          <td class="num">${money(o.amount)}</td>
          <td class="small muted">${dateAgo(o.createdAt)}</td>
          <td><div class="actions">
            <button class="btn btn-primary btn-xs" data-refund-approve="${o.id}">同意退款</button>
            <button class="btn btn-ghost btn-xs" data-refund-reject="${o.id}">驳回</button>
          </div></td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted small" style="padding:14px 0">暂无退款申请</p>'}
    </div>`;
}

function payStatusMeta(status) {
  const map = {
    pending: { text: '待支付', cls: 'gold' },
    paid: { text: '已支付', cls: 'green' },
    failed: { text: '支付失败', cls: 'red' },
    closed: { text: '已关闭', cls: 'gray' },
    refunded: { text: '已退款', cls: 'gray' }
  };
  return map[status] || { text: status, cls: 'gray' };
}

async function paymentsContent(ctx) {
  const status = ctx.query.status || '';
  const channel = ctx.query.channel || '';
  const date = ctx.query.date || '';
  const [list, reco, settlement, ledgerData, batchesData] = await Promise.all([
    api.get(`/api/admin/payments?status=${encodeURIComponent(status)}&channel=${encodeURIComponent(channel)}&date=${encodeURIComponent(date)}`),
    api.get(`/api/admin/payments/reconcile?date=${encodeURIComponent(date)}`),
    api.get('/api/admin/settlements'),
    api.get('/api/admin/finance/ledger'),
    api.get('/api/admin/payments/batches?limit=5')
  ]);
  const trial = ledgerData.trial || { balanced: false, accounts: [], totalDebit: 0, totalCredit: 0 };
  const mismatches = ledgerData.mismatches || [];
  const batches = batchesData.items || [];
  const link = (patch) => {
    const q = new URLSearchParams({ tab: 'payments' });
    if (status) q.set('status', status);
    if (channel) q.set('channel', channel);
    if (date) q.set('date', date);
    Object.entries(patch).forEach(([k, v]) => { if (v) q.set(k, v); else q.delete(k); });
    return `#/admin?${q.toString()}`;
  };
  const statusChips = [['', '全部'], ['pending', '待支付'], ['paid', '已支付'], ['refunded', '已退款'], ['failed', '失败'], ['closed', '已关闭']];
  const channelChips = [['', '全部渠道'], ['wechat', '微信'], ['alipay', '支付宝'], ['bankcard', '银行卡']];
  const anomalies = (reco.anomalies.paidWithoutCompletedOrder || []).length
    + (reco.anomalies.completedOrderWithoutPayment || []).length;

  return `<div class="admin-head">
      <div><h1>支付对账</h1><p>按渠道核对支付流水，监控超时、失败与订单异常</p></div>
      <span class="badge ${list.mode === 'mock' ? 'gold' : 'green'}">${list.mode === 'mock' ? '演示模式' : '生产模式'}</span>
      <span class="badge ${list.readiness?.ready ? 'green' : 'red'}">${list.readiness?.ready ? '支付通道就绪' : '支付通道未就绪'}</span>
    </div>
    ${list.readiness?.blockers?.length ? `<div class="panel admin-section" style="margin-bottom:18px">
      ${list.readiness.blockers.map((b) => `<div class="guarantee">${icon('alertCircle')} ${esc(b.code)}：${esc(b.message)}</div>`).join('')}
    </div>` : ''}
    <div class="kpi-grid">
      <div class="kpi"><span>当日支付成功</span><b>${reco.totalPaidCount}<small> 笔</small></b><small>${esc(reco.date)}</small></div>
      <div class="kpi"><span>当日支付金额</span><b>¥${moneyPlain(reco.totalPaidAmount)}</b><small>按支付渠道汇总</small></div>
      <div class="kpi"><span>待支付</span><b>${list.totals.pending.count}<small> 笔</small></b><small>¥${moneyPlain(list.totals.pending.amount)} 待回收</small></div>
      <div class="kpi"><span>对账异常</span><b>${anomalies}<small> 项</small></b><small>订单与支付流水不匹配</small></div>
    </div>

    <div class="panel admin-section" style="margin-top:18px">
      <div class="row-between wrap" style="margin-bottom:8px">
        <div><h3 style="margin:0">资金账本 · 复式记账</h3><p class="small muted" style="margin:4px 0 0">每笔支付与退款生成借贷平衡凭证，用户余额以账本为核对基准</p></div>
        <span class="badge ${trial.balanced ? 'green' : 'red'}">${trial.balanced ? '借贷平衡' : '账本不平衡'}</span>
      </div>
      <div class="kpi-grid">
        <div class="kpi"><span>渠道待清算资金</span><b>¥${moneyPlain(ledgerData.cashBalance || 0)}</b><small>资产科目余额</small></div>
        <div class="kpi"><span>卖家应付款</span><b>¥${moneyPlain(ledgerData.sellerPayable || 0)}</b><small>负债科目余额</small></div>
        <div class="kpi"><span>平台服务费收入</span><b>¥${moneyPlain(ledgerData.commission || 0)}</b><small>累计确认收入</small></div>
        <div class="kpi"><span>余额差异</span><b>${mismatches.length}<small> 户</small></b><small>账本 vs 用户余额</small></div>
      </div>
      ${mismatches.length ? `<div class="stack" style="gap:8px;margin-top:12px">
        ${mismatches.slice(0, 5).map((m) => `<div class="guarantee">${icon('alertCircle')} 用户 #${m.userId} ${esc(m.nickname || '')} 余额 ¥${moneyPlain(m.balance)}，账本 ¥${moneyPlain(m.ledgerBalance)}，差异 ¥${moneyPlain(m.diff)}</div>`).join('')}
      </div>` : ''}
    </div>

    <div class="panel admin-section" style="margin-top:18px">
      <div class="row-between wrap" style="margin-bottom:8px">
        <div><h3 style="margin:0">对账批次</h3><p class="small muted" style="margin:4px 0 0">按自然日生成批次，差异明细持久化留痕</p></div>
        <span class="small muted">最近 ${batches.length} 个批次</span>
      </div>
      ${batches.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>批次</th><th>日期</th><th>平台金额</th><th>渠道金额</th><th>差异</th><th>状态</th></tr></thead>
        <tbody>${batches.map((b) => `<tr>
          <td class="cell-title"><b class="mono small">${esc(b.batchNo)}</b><span>${b.platformCount} 笔 / ${b.channelCount} 笔账单</span></td>
          <td>${esc(b.billDate)}</td>
          <td class="num">¥${moneyPlain(b.platformAmount)}</td>
          <td class="num">¥${moneyPlain(b.channelAmount)}</td>
          <td class="num">${b.diffCount} 项 / ¥${moneyPlain(b.diffAmount)}</td>
          <td><span class="badge ${b.status === 'balanced' ? 'green' : (b.status === 'diff' ? 'red' : 'gray')}">${esc(b.statusText)}</span></td>
        </tr>`).join('')}</tbody>
      </table></div>` : emptyState({ iconName: 'receipt', title: '暂无对账批次', text: '执行支付对账后会生成批次记录' })}
    </div>

    <div class="panel admin-section" style="margin-top:18px">
      <div class="row-between wrap" style="margin-bottom:8px">
        <h3 style="margin:0">渠道汇总 · ${esc(reco.date)}</h3>
        <form class="row" style="gap:8px" data-pay-date data-status="${esc(status)}" data-channel="${esc(channel)}">
          <input class="input" type="date" name="date" value="${esc(reco.date)}" style="width:170px">
          <button class="btn btn-soft btn-sm" type="submit">查询</button>
        </form>
      </div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>渠道</th><th>成功笔数</th><th>成功金额</th><th>待支付</th><th>失败/关闭</th><th>结算周期</th></tr></thead>
        <tbody>${reco.summary.map((row) => `<tr>
          <td class="cell-title"><b>${esc(row.name)}</b><span>${esc(row.channel)}</span></td>
          <td>${row.paidCount}</td>
          <td class="num">¥${moneyPlain(row.paidAmount)}</td>
          <td>${row.pendingCount}</td>
          <td>${row.failedCount}</td>
          <td class="small muted">${esc(row.settle)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>

    <div class="panel admin-section" style="margin-top:18px">
      <div class="admin-filter">
        ${statusChips.map(([key, text]) => `<a class="chip ${status === key ? 'active' : ''}" href="${link({ status: key })}">${text}</a>`).join('')}
      </div>
      <div class="admin-filter">
        ${channelChips.map(([key, text]) => `<a class="chip ${channel === key ? 'active' : ''}" href="${link({ channel: key })}">${text}</a>`).join('')}
      </div>
      ${list.items.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>支付单号</th><th>用户</th><th>渠道</th><th>用途</th><th>金额</th><th>状态</th><th>时间</th></tr></thead>
        <tbody>${list.items.map((p) => {
          const meta = payStatusMeta(p.status);
          return `<tr>
            <td class="cell-title"><b class="mono small">${esc(p.paymentNo)}</b><span>${p.orderId ? `订单 #${p.orderId}` : '—'}</span></td>
            <td>${esc(p.user.nickname)}<br><span class="small muted">${esc(p.user.email)}</span></td>
            <td>${esc(p.channelName)}</td>
            <td>购买资料</td>
            <td class="num">¥${moneyPlain(p.amount)}</td>
            <td><span class="badge ${meta.cls}">${meta.text}</span>
              ${p.failureMessage ? `<br><span class="small muted">${esc(p.failureMessage)}</span>` : ''}
              ${list.mode === 'live' && p.channel === 'bankcard' && p.status === 'pending' ? `<br><button class="btn btn-soft btn-sm" type="button" data-pay-confirm="${p.id}" style="margin-top:6px">确认到账</button>` : ''}</td>
            <td class="small muted">${dateAgo(p.createdAt)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : emptyState({ iconName: 'receipt', title: '暂无支付记录', text: '当前筛选条件下没有支付流水' })}
    </div>

    <div class="panel admin-section" style="margin-top:18px">
      <div class="row-between wrap" style="margin-bottom:8px">
        <div><h3 style="margin:0">收益结算</h3><p class="small muted" style="margin:4px 0 0">成交收益扣除 10% 服务费后按 ${esc(settlement.cycle)} 自动结算，退款订单自动取消结算</p></div>
        <span class="small muted">待结算 ${settlement.totals.pending.count} 笔 / ¥${moneyPlain(settlement.totals.pending.amount)} · 已结算 ¥${moneyPlain(settlement.totals.settled.amount)}</span>
      </div>
      ${settlement.items.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>资料 / 订单</th><th>卖家</th><th>买家</th><th>订单金额</th><th>服务费</th><th>结算金额</th><th>状态</th><th>时间</th></tr></thead>
        <tbody>${settlement.items.slice(0, 20).map((s) => {
          const meta = { pending: ['待结算', 'gold'], settled: ['已结算', 'green'], cancelled: ['已取消', 'gray'] }[s.status] || [s.statusText, 'gray'];
          return `<tr>
            <td class="cell-title"><b>${esc(s.material ? s.material.title : '—')}</b><span>订单 #${s.orderId}</span></td>
            <td>${esc(s.seller ? s.seller.nickname : '—')}</td>
            <td>${esc(s.buyer ? s.buyer.nickname : '—')}</td>
            <td class="num">¥${moneyPlain(s.orderAmount)}</td>
            <td class="num">¥${moneyPlain(s.commission)}</td>
            <td class="num">¥${moneyPlain(s.net)}</td>
            <td><span class="badge ${meta[1]}">${meta[0]}</span>${s.status === 'pending' ? `<br><span class="small muted">预计 ${esc((s.settleDue || '').slice(5, 16))}</span>` : ''}</td>
            <td class="small muted">${dateAgo(s.createdAt)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : emptyState({ iconName: 'wallet', title: '暂无结算记录', text: '资料成交后会自动生成卖家结算账单' })}
    </div>

    ${anomalies ? `<div class="panel admin-section" style="margin-top:18px">
      <h3>对账异常</h3>
      <div class="stack" style="gap:8px">
        ${(reco.anomalies.paidWithoutCompletedOrder || []).map((a) => `<div class="guarantee">${icon('alertCircle')} 支付单 ${esc(a.payment_no)} 已支付，但订单 #${a.order_id} 状态为 ${esc(a.order_status)}（¥${moneyPlain(a.amount_cents)}）</div>`).join('')}
        ${(reco.anomalies.completedOrderWithoutPayment || []).map((a) => `<div class="guarantee">${icon('alertCircle')} 订单 #${a.id} 已完成（${esc(a.payment_channel)}），但缺少已支付流水（¥${moneyPlain(a.amount_cents)}）</div>`).join('')}
      </div>
    </div>` : ''}`;
}

async function announcementsContent() {
  const data = await api.get('/api/admin/announcements');
  return `<div class="admin-head">
      <div><h1>公告管理</h1><p>发布活动、规则与安全提示，首条公告会展示在首页</p></div>
      <button class="btn btn-primary" type="button" data-ann-create>${icon('plus')} 发布公告</button>
    </div>
    <div class="panel admin-section">
      ${data.items.length ? data.items.map((a) => `<div class="report-card">
        <div class="rhead">
          <span class="badge ${a.active ? 'green' : 'gray'}">${esc(a.tag)}</span>
          <b style="font-family:var(--serif);font-size:15px">${esc(a.title)}</b>
          <span class="spacer"></span>
          <span class="small muted">${dateAgo(a.created_at)}</span>
        </div>
        <p>${esc(a.content)}</p>
        <div class="rfoot">
          <span class="small muted">${a.active ? '首页展示中' : '已隐藏'}</span>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-sm" data-ann-toggle="${a.id}" data-active="${a.active}">${a.active ? '隐藏' : '展示'}</button>
          <button class="btn btn-ghost btn-sm" data-ann-edit="${a.id}" data-title="${esc(a.title)}" data-content="${esc(a.content)}" data-tag="${esc(a.tag)}">编辑</button>
          <button class="btn btn-danger btn-sm" data-ann-delete="${a.id}">删除</button>
        </div>
      </div>`).join('') : emptyState({ iconName: 'book', title: '还没有公告', text: '发布第一条平台公告吧' })}
    </div>`;
}

async function verificationsContent(ctx) {
  const status = ['pending', 'verified', 'rejected', 'none'].includes(ctx.query.status) ? ctx.query.status : 'pending';
  const data = await api.get(`/api/admin/verifications?status=${status}`);
  const chips = [['pending', '待审核'], ['verified', '已通过'], ['rejected', '已驳回'], ['none', '未申请']];
  return `<div class="admin-head">
      <div><h1>认证审核</h1><p>核验学生提交的院校、学号与实名信息，通过后开放交易权限</p></div>
    </div>
    <div class="panel admin-section">
      <div class="admin-filter">
        ${chips.map(([key, text]) => `<a class="chip ${status === key ? 'active' : ''}" href="#/admin?tab=verifications&status=${key}">${text}${data.counts[key] !== undefined ? ` · ${data.counts[key]}` : ''}</a>`).join('')}
      </div>
      ${data.items.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>用户</th><th>院校</th><th>真实姓名</th><th>学号</th><th>状态</th><th>申请时间</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${data.items.map((u) => {
          const meta = verifyMeta(u.verifyStatus);
          return `<tr>
            <td class="cell-title"><b>${esc(u.nickname)}</b><span>${esc(u.email || u.username || '')}</span></td>
            <td>${esc(u.school || '未填写')}</td>
            <td>${u.realName ? esc(u.realName) : '<span class="muted">—</span>'}</td>
            <td>${u.studentNo ? esc(u.studentNo) : '<span class="muted">—</span>'}</td>
            <td><span class="badge ${meta.cls}">${meta.text}</span>${u.verifyNote ? `<br><span class="small muted">${esc(u.verifyNote)}</span>` : ''}</td>
            <td class="small muted">${dateAgo(u.createdAt)}</td>
            <td><div class="actions">
              ${u.verifyStatus === 'pending' ? `<button class="btn btn-primary btn-xs" data-verify-approve="${u.id}">通过</button>
              <button class="btn btn-danger btn-xs" data-verify-reject="${u.id}">驳回</button>` : `<span class="small muted">${u.verifiedAt ? `通过于 ${String(u.verifiedAt).slice(0, 10)}` : '—'}</span>`}
            </div></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : emptyState({ iconName: 'badgeCheck', title: '当前没有认证申请', text: '用户提交实名与高校认证后会出现在这里' })}
    </div>`;
}

async function ticketsContent(ctx) {
  const status = ['open', 'processing', 'resolved', 'closed'].includes(ctx.query.status) ? ctx.query.status : '';
  const data = await api.get(`/api/admin/tickets${status ? `?status=${status}` : ''}`);
  const chips = [['', '全部'], ['open', '待处理'], ['processing', '处理中'], ['resolved', '已解决'], ['closed', '已关闭']];
  return `<div class="admin-head">
      <div><h1>客服工单</h1><p>处理平台官方客服工单；历史卖家咨询已合并至统一会话，此处仅保留归档追溯</p></div>
    </div>
    <div class="panel admin-section">
      <div class="admin-filter">
        ${chips.map(([key, text]) => `<a class="chip ${status === key ? 'active' : ''}" href="#/admin?tab=tickets${key ? `&status=${key}` : ''}">${text}${key && data.counts[key] !== undefined ? ` · ${data.counts[key]}` : ''}</a>`).join('')}
      </div>
      ${data.items.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>工单</th><th>渠道 / 类型</th><th>发起人</th><th>关联对象</th><th>状态</th><th>更新</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${data.items.map((t) => {
          const meta = ticketStatusMeta(t.status);
          return `<tr>
            <td class="cell-title"><b>${esc(t.title)}</b><span>${t.replyCount} 条回复${t.unread ? ' · 有新回复' : ''}</span></td>
            <td><span class="tag">${t.kind === 'seller' ? '卖家咨询（归档）' : '官方客服'}</span><br><span class="small muted">${TICKET_TYPE_TEXT[t.type] || '其他'}</span></td>
            <td>${esc(t.user.nickname)}<br><span class="small muted">${esc(t.user.school || '')}</span></td>
            <td>${t.materialTitle ? `<a class="link small" href="#/material/${t.materialId}">${esc(t.materialTitle)}</a>` : t.targetName ? esc(t.targetName) : '<span class="muted">平台官方</span>'}</td>
            <td><span class="badge ${meta.cls}">${meta.text}</span></td>
            <td class="small muted">${dateAgo(t.updatedAt)}</td>
            <td><div class="actions"><button class="btn btn-soft btn-xs" data-ticket-open="${t.id}">查看处理</button></div></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : emptyState({ iconName: 'headphones', title: '暂无工单', text: '用户提交 bug 报错、功能建议或交易投诉后会显示在这里' })}
    </div>`;
}

async function pricingContent() {
  const data = await api.get('/api/admin/pricing');
  const schools = (state.meta && state.meta.schools) || [];
  const subjects = (state.meta && state.meta.subjects) || [];
  return `<div class="admin-head">
      <div><h1>价格标准库</h1><p>维护官方参考价，卖家上传资料时自动匹配推荐定价</p></div>
      <button class="btn btn-primary" type="button" data-price-create>${icon('plus')} 新增标准价</button>
    </div>
    <div class="panel admin-section">
      <p class="small muted" style="margin:0 0 12px">匹配优先级：院校 + 学科 + 类型 → 院校 + 类型 → 学科 + 类型 → 全平台类型参考价。院校或学科填「*」表示通用。</p>
      ${data.items.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>院校</th><th>学科</th><th>类型</th><th>标准价</th><th>可调区间</th><th>说明</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${data.items.map((s) => `<tr>
          <td class="cell-title"><b>${s.school === '*' ? '全平台' : esc(s.school)}</b></td>
          <td>${s.subject === '*' ? '<span class="muted">通用</span>' : esc(s.subject)}</td>
          <td><span class="tag">${esc(s.category)}</span></td>
          <td class="num">¥${moneyPlain(s.basePrice)}</td>
          <td class="small muted">¥${moneyPlain(s.minPrice)} — ¥${moneyPlain(s.maxPrice)}</td>
          <td class="small muted" style="max-width:200px">${esc(s.note || '')}</td>
          <td><span class="badge ${s.active ? 'green' : 'gray'}">${s.active ? '启用' : '停用'}</span></td>
          <td><div class="actions">
            <button class="btn btn-ghost btn-xs" data-price-edit="${s.id}"
              data-school="${esc(s.school)}" data-subject="${esc(s.subject)}" data-category="${esc(s.category)}"
              data-base="${s.basePrice}" data-min="${s.minPrice}" data-max="${s.maxPrice}"
              data-note="${esc(s.note || '')}" data-active="${s.active ? '1' : '0'}">编辑</button>
            <button class="btn btn-danger btn-xs" data-price-delete="${s.id}">删除</button>
          </div></td>
        </tr>`).join('')}</tbody>
      </table></div>` : emptyState({ iconName: 'scale', title: '还没有价格标准', text: '新增第一条标准价，卖家上传时即可获得参考定价' })}
    </div>
    <div class="panel admin-section" style="margin-top:18px">
      <h3>可选院校与学科</h3>
      <p class="small muted" style="margin:0">院校 ${schools.length} 所 · 学科 ${subjects.length} 个。资料类型沿用平台分类：${data.categories.map((c) => `<span class="tag">${esc(c)}</span>`).join(' ')}</p>
    </div>`;
}

let bargainMaterialCache = [];

async function bargainsContent() {
  const data = await api.get('/api/admin/bargains');
  bargainMaterialCache = data.materials || [];
  const c = data.counts || {};
  return `<div class="admin-head">
      <div><h1>砍价活动</h1><p>配置资料砍价规则，用户分享好友助力后随机降价，砍到底价即可按专享价购买</p></div>
      <button class="btn btn-primary" type="button" data-bargain-create>${icon('plus')} 新建砍价活动</button>
    </div>
    <div class="kpi-grid" style="margin-bottom:18px">
      <div class="kpi"><span>进行中活动</span><b>${c.active || 0}<small> 个</small></b><small>共 ${c.total || 0} 个活动</small></div>
      <div class="kpi"><span>砍价单</span><b>${c.orders || 0}<small> 单</small></b><small>${c.success || 0} 单已砍到底价</small></div>
      <div class="kpi"><span>参与助力</span><b>${c.participants || 0}<small> 人</small></b><small>按用户去重统计</small></div>
    </div>
    <div class="panel admin-section">
      <p class="small muted" style="margin:0 0 12px">规则说明：初始价与底价在用户发起砍价时快照到砍价单，后续修改活动不会影响已创建砍价单；最后一位助力好友会直接砍到底价。</p>
      ${data.items.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>资料</th><th>价格规则</th><th>活动规则</th><th>运营数据</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${data.items.map((a) => `<tr>
          <td class="cell-title"><b>${esc(a.material.title)}</b><span class="muted small">${esc(a.material.category)} · ${esc(a.material.school || '全平台')}</span></td>
          <td><b class="num">¥${moneyPlain(a.startPrice)}</b> <span class="muted small">→ 底价 ¥${moneyPlain(a.floorPrice)}</span></td>
          <td class="small muted">${a.durationHours} 小时 · 每人 ${a.maxCutsPerUser} 次 · ${a.maxHelpers} 人上限</td>
          <td class="small">
            <b>${a.stats.orders}</b> 单砍价 · <b>${a.stats.successOrders}</b> 单成功<br>
            <span class="muted">${a.stats.participants} 人参与 · ${a.stats.activeOrders} 单进行中</span>
          </td>
          <td><span class="badge ${a.active ? 'green' : 'gray'}">${esc(a.statusText)}</span></td>
          <td><div class="actions">
            <button class="btn btn-ghost btn-xs" data-bargain-edit="${a.id}"
              data-title="${esc(a.material.title)}"
              data-start="${(a.startPrice / 100).toFixed(2)}" data-floor="${(a.floorPrice / 100).toFixed(2)}"
              data-hours="${a.durationHours}" data-cuts="${a.maxCutsPerUser}" data-helpers="${a.maxHelpers}"
              data-status="${a.status}">编辑</button>
            <button class="btn btn-ghost btn-xs" data-bargain-toggle="${a.id}" data-next="${a.active ? 'offline' : 'active'}">${a.active ? '下架' : '上架'}</button>
            <button class="btn btn-danger btn-xs" data-bargain-delete="${a.id}">删除</button>
          </div></td>
        </tr>`).join('')}</tbody>
      </table></div>` : emptyState({
        iconName: 'gift', title: '还没有砍价活动',
        text: '在已上架资料中创建砍价活动，用户即可发起好友助力砍价'
      })}
    </div>`;
}

function bindAdmin(root, ctx, tab) {
  const rerender = () => renderAdmin(root, ctx);

  root.querySelector('[data-pay-date]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const q = new URLSearchParams({ tab: 'payments' });
    if (form.dataset.status) q.set('status', form.dataset.status);
    if (form.dataset.channel) q.set('channel', form.dataset.channel);
    const date = new FormData(form).get('date');
    if (date) q.set('date', date);
    window.location.hash = `#/admin?${q.toString()}`;
  });

  root.querySelectorAll('[data-pay-confirm]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!window.confirm('确认已收到该笔银行卡转账？确认后订单将完成并生成卖家结算。')) return;
    try {
      const res = await api.post(`/api/admin/payments/${btn.dataset.payConfirm}/confirm`);
      toast(res.message);
      rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelectorAll('[data-approve]').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      const res = await api.post(`/api/admin/materials/${btn.dataset.approve}/review`, { action: 'approve' });
      toast(res.message);
      rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelectorAll('[data-reject]').forEach((btn) => btn.addEventListener('click', async () => {
    const reason = await promptDialog({
      title: '驳回资料', label: '驳回原因（会展示给卖家）', placeholder: '例如：文件无法打开，或内容与描述不符',
      confirmText: '确认驳回', multiline: true
    });
    if (!reason) return;
    try {
      const res = await api.post(`/api/admin/materials/${btn.dataset.reject}/review`, { action: 'reject', reason });
      toast(res.message);
      rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelectorAll('[data-offline]').forEach((btn) => btn.addEventListener('click', async () => {
    const reason = await promptDialog({ title: '下架资料', label: '下架原因', placeholder: '说明下架原因，便于卖家了解', multiline: true, confirmText: '确认下架' });
    if (!reason) return;
    try {
      const res = await api.post(`/api/admin/materials/${btn.dataset.offline}/review`, { action: 'offline', reason });
      toast(res.message);
      rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelector('[data-user-search]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = new FormData(e.target).get('q');
    window.location.hash = `#/admin?tab=users${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  });

  root.querySelectorAll('[data-user-status]').forEach((btn) => btn.addEventListener('click', async () => {
    const banned = btn.dataset.next === 'banned';
    const ok = await confirmDialog({
      title: banned ? '限制该账号？' : '恢复该账号？',
      text: banned ? '限制后该用户将无法登录、购买或上传资料，已购买资料仍保留下载权利。' : '恢复后用户可以正常登录和使用平台功能。',
      confirmText: banned ? '确认限制' : '确认恢复', danger: banned
    });
    if (!ok) return;
    try {
      const res = await api.post(`/api/admin/users/${btn.dataset.userStatus}/status`, { status: btn.dataset.next });
      toast(res.message);
      rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelectorAll('[data-report-dismiss]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: '驳回这条举报？', text: '资料将保持正常展示，举报会被标记为已处理。', confirmText: '驳回举报' });
    if (!ok) return;
    try {
      const res = await api.post(`/api/admin/reports/${btn.dataset.reportDismiss}/resolve`, { action: 'dismiss' });
      toast(res.message); rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelectorAll('[data-report-takedown]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: '核实并下架资料？', text: '资料将立即从市场下架，历史订单与下载不受影响。请确认已核实举报内容。', confirmText: '确认下架', danger: true });
    if (!ok) return;
    try {
      const res = await api.post(`/api/admin/reports/${btn.dataset.reportTakedown}/resolve`, { action: 'takedown' });
      toast(res.message); rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelectorAll('[data-refund-approve]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: '同意退款？', text: '退款将按买家原支付渠道退回（T+1 到账），并从卖家收益中扣除对应金额。', confirmText: '同意退款' });
    if (!ok) return;
    try {
      const res = await api.post(`/api/admin/orders/${btn.dataset.refundApprove}/refund`, { action: 'approve' });
      toast(res.message); rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelectorAll('[data-refund-reject]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: '驳回退款申请？', text: '订单将恢复为已完成状态，买家继续拥有下载权限。', confirmText: '驳回申请', danger: true });
    if (!ok) return;
    try {
      const res = await api.post(`/api/admin/orders/${btn.dataset.refundReject}/refund`, { action: 'reject' });
      toast(res.message); rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelector('[data-ann-create]')?.addEventListener('click', () => openAnnouncementModal(null, rerender));
  root.querySelectorAll('[data-ann-edit]').forEach((btn) => btn.addEventListener('click', () => {
    openAnnouncementModal({
      id: btn.dataset.annEdit, title: btn.dataset.title, content: btn.dataset.content, tag: btn.dataset.tag
    }, rerender);
  }));
  root.querySelectorAll('[data-ann-toggle]').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      const active = btn.dataset.active === '1';
      const res = await api.patch(`/api/admin/announcements/${btn.dataset.annToggle}`, { active: !active });
      toast(res.message); rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));
  root.querySelectorAll('[data-ann-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: '删除这条公告？', text: '删除后无法恢复。', confirmText: '删除', danger: true });
    if (!ok) return;
    try {
      const res = await api.del(`/api/admin/announcements/${btn.dataset.annDelete}`);
      toast(res.message); rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelectorAll('[data-verify-approve]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '通过该认证申请？',
      text: '通过后用户将获得资料买卖权限，并默认进入其认证院校的资料专区。',
      confirmText: '确认通过'
    });
    if (!ok) return;
    try {
      const res = await api.post(`/api/admin/verifications/${btn.dataset.verifyApprove}/review`, { action: 'approve' });
      toast(res.message); rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelectorAll('[data-verify-reject]').forEach((btn) => btn.addEventListener('click', async () => {
    const note = await promptDialog({
      title: '驳回认证申请', label: '驳回原因（会展示给用户）',
      placeholder: '例如：学号与院校信息不匹配，请核对后重新提交', confirmText: '确认驳回', multiline: true
    });
    if (!note) return;
    try {
      const res = await api.post(`/api/admin/verifications/${btn.dataset.verifyReject}/review`, { action: 'reject', note });
      toast(res.message); rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelectorAll('[data-ticket-open]').forEach((btn) => btn.addEventListener('click', () => {
    openTicketModal(Number(btn.dataset.ticketOpen), rerender);
  }));

  root.querySelector('[data-price-create]')?.addEventListener('click', () => openPricingModal(null, rerender));
  root.querySelectorAll('[data-price-edit]').forEach((btn) => btn.addEventListener('click', () => {
    openPricingModal({
      id: btn.dataset.priceEdit,
      school: btn.dataset.school,
      subject: btn.dataset.subject,
      category: btn.dataset.category,
      basePrice: Number(btn.dataset.base),
      minPrice: Number(btn.dataset.min),
      maxPrice: Number(btn.dataset.max),
      note: btn.dataset.note,
      active: btn.dataset.active === '1'
    }, rerender);
  }));
  root.querySelectorAll('[data-price-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: '删除这条标准价？', text: '删除后匹配该院校/学科/类型的资料将回退到上一级参考价。', confirmText: '删除', danger: true });
    if (!ok) return;
    try {
      const res = await api.del(`/api/admin/pricing/${btn.dataset.priceDelete}`);
      toast(res.message); rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  root.querySelectorAll('[data-price-adjust]').forEach((btn) => btn.addEventListener('click', () => {
    openPriceAdjustModal(btn.dataset.priceAdjust, Number(btn.dataset.price), rerender);
  }));

  root.querySelector('[data-bargain-create]')?.addEventListener('click', () => openBargainModal(null, rerender));
  root.querySelectorAll('[data-bargain-edit]').forEach((btn) => btn.addEventListener('click', () => {
    openBargainModal({
      id: btn.dataset.bargainEdit,
      materialTitle: btn.dataset.title,
      startPrice: Number(btn.dataset.start),
      floorPrice: Number(btn.dataset.floor),
      durationHours: Number(btn.dataset.hours),
      maxCutsPerUser: Number(btn.dataset.cuts),
      maxHelpers: Number(btn.dataset.helpers),
      status: btn.dataset.status
    }, rerender);
  }));
  root.querySelectorAll('[data-bargain-toggle]').forEach((btn) => btn.addEventListener('click', async () => {
    const next = btn.dataset.next;
    const ok = await confirmDialog({
      title: next === 'offline' ? '下架该砍价活动？' : '重新上架该砍价活动？',
      text: next === 'offline'
        ? '下架后用户无法再发起新的砍价，已创建的砍价单仍可继续助力与购买。'
        : '上架后用户可以对该资料发起新的砍价。',
      confirmText: next === 'offline' ? '确认下架' : '确认上架',
      danger: next === 'offline'
    });
    if (!ok) return;
    try {
      const res = await api.patch(`/api/admin/bargains/${btn.dataset.bargainToggle}`, { status: next });
      toast(res.message);
      rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));
  root.querySelectorAll('[data-bargain-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '删除该砍价活动？',
      text: '仅未产生砍价单的活动可以删除，删除后不可恢复。',
      confirmText: '删除', danger: true
    });
    if (!ok) return;
    try {
      const res = await api.del(`/api/admin/bargains/${btn.dataset.bargainDelete}`);
      toast(res.message);
      rerender();
    } catch (err) { toast(err.message, 'error'); }
  }));

  if (tab === 'audit') bindAudit(root, ctx, rerender);
  if (tab === 'security') bindSecurity(root, ctx, rerender);
}

function openPricingModal(existing, onDone) {
  const schools = (state.meta && state.meta.schools) || [];
  const subjects = (state.meta && state.meta.subjects) || [];
  const categories = (state.meta && state.meta.categories) || [];
  const schoolOptions = ['*', ...schools].map((s) => `<option value="${esc(s)}" ${existing && existing.school === s ? 'selected' : ''}>${s === '*' ? '全平台通用' : esc(s)}</option>`).join('');
  const subjectOptions = ['*', ...subjects].map((s) => `<option value="${esc(s)}" ${existing && existing.subject === s ? 'selected' : ''}>${s === '*' ? '通用（不限学科）' : esc(s)}</option>`).join('');
  const categoryOptions = categories.map((c) => `<option value="${esc(c)}" ${existing && existing.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const yuan = (cents) => (cents === undefined || cents === null ? '' : (cents / 100).toFixed(2));
  const modal = openModal({
    title: existing ? '编辑标准价' : '新增标准价',
    subtitle: '标准价会作为卖家上传资料时的推荐定价依据',
    body: `<div class="stack" style="gap:14px">
      <div class="form-grid-2">
        <div class="field"><label class="label">院校</label><select class="select" data-school>${schoolOptions}</select></div>
        <div class="field"><label class="label">学科</label><select class="select" data-subject>${subjectOptions}</select></div>
      </div>
      <div class="field"><label class="label">资料类型</label><select class="select" data-category>${categoryOptions}</select></div>
      <div class="form-grid-2">
        <div class="field"><label class="label">标准价（元）</label><input class="input" data-base type="number" min="0.5" step="0.5" value="${existing ? yuan(existing.basePrice) : ''}"></div>
        <div class="field"><label class="label">说明</label><input class="input" data-note maxlength="100" value="${existing ? esc(existing.note || '') : ''}" placeholder="例如：依据院校公开课程资料"></div>
      </div>
      <div class="form-grid-2">
        <div class="field"><label class="label">最低可调价（元）</label><input class="input" data-min type="number" min="0" step="0.5" value="${existing ? yuan(existing.minPrice) : ''}" placeholder="留空自动按 70%"></div>
        <div class="field"><label class="label">最高可调价（元）</label><input class="input" data-max type="number" min="0" step="0.5" value="${existing ? yuan(existing.maxPrice) : ''}" placeholder="留空自动按 160%"></div>
      </div>
      <label class="check-row"><input type="checkbox" data-active ${!existing || existing.active ? 'checked' : ''}> 启用该标准价</label>
      <div class="error-text hidden" data-error></div>
    </div>`,
    footer: `<button class="btn btn-ghost" data-cancel>取消</button>
             <button class="btn btn-primary" data-submit>${existing ? '保存修改' : '新增标准价'}</button>`
  });
  modal.el.querySelector('[data-cancel]').addEventListener('click', modal.close);
  attachSelectSearch(modal.el.querySelector('[data-school]'), {
    placeholder: '搜索院校，支持模糊匹配',
    keep: (option) => option.value === '*'
  });
  attachSelectSearch(modal.el.querySelector('[data-subject]'), {
    placeholder: '搜索学科，支持模糊匹配',
    keep: (option) => option.value === '*'
  });
  modal.el.querySelector('[data-submit]').addEventListener('click', async () => {
    const val = (sel) => modal.el.querySelector(sel).value;
    const payload = {
      school: val('[data-school]'),
      subject: val('[data-subject]'),
      category: val('[data-category]'),
      basePrice: Number(val('[data-base]')),
      minPrice: val('[data-min]') === '' ? undefined : Number(val('[data-min]')),
      maxPrice: val('[data-max]') === '' ? undefined : Number(val('[data-max]')),
      note: val('[data-note]').trim(),
      active: modal.el.querySelector('[data-active]').checked
    };
    const error = modal.el.querySelector('[data-error]');
    try {
      if (existing) await api.patch(`/api/admin/pricing/${existing.id}`, payload);
      else await api.post('/api/admin/pricing', payload);
      modal.close();
      toast(existing ? '标准价已更新' : '标准价已新增');
      onDone && onDone();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    }
  });
}

function openBargainModal(existing, onDone) {
  const isEdit = !!existing;
  const first = bargainMaterialCache[0];
  const suggestStart = first ? (first.price / 100).toFixed(2) : '';
  const suggestFloor = first ? Math.max(1, Math.floor(first.price / 100 / 2)).toFixed(2) : '';
  const materialOptions = bargainMaterialCache.map((m) => `<option value="${m.id}" data-price="${m.price}">${esc(m.title)} · ¥${moneyPlain(m.price)}</option>`).join('');
  const modal = openModal({
    title: isEdit ? '编辑砍价活动' : '新建砍价活动',
    subtitle: '价格与规则会在用户发起砍价时快照保存，修改活动不影响已创建的砍价单',
    body: `<div class="stack" style="gap:14px">
      <div class="field">
        <label class="label">参与砍价的资料</label>
        ${isEdit ? `<div class="static-note">${esc(existing.materialTitle)}</div>`
          : `<select class="select" data-material>${materialOptions}</select>`}
      </div>
      <div class="form-grid-2">
        <div class="field"><label class="label">初始价（元）</label><input class="input" data-start type="number" min="1" step="0.1" value="${isEdit ? existing.startPrice.toFixed(2) : suggestStart}"></div>
        <div class="field"><label class="label">目标底价（元）</label><input class="input" data-floor type="number" min="1" step="0.1" value="${isEdit ? existing.floorPrice.toFixed(2) : suggestFloor}"></div>
      </div>
      <div class="form-grid-2">
        <div class="field"><label class="label">有效期（小时）</label><input class="input" data-hours type="number" min="1" max="720" step="1" value="${isEdit ? existing.durationHours : 48}"></div>
        <div class="field"><label class="label">最大助力人数</label><input class="input" data-helpers type="number" min="1" max="100" step="1" value="${isEdit ? existing.maxHelpers : 5}"></div>
      </div>
      <div class="form-grid-2">
        <div class="field"><label class="label">单个用户可砍次数</label><input class="input" data-cuts type="number" min="1" max="10" step="1" value="${isEdit ? existing.maxCutsPerUser : 1}"></div>
        <div class="field"><label class="label">活动状态</label><select class="select" data-status>
          <option value="active" ${!isEdit || existing.status === 'active' ? 'selected' : ''}>进行中</option>
          <option value="offline" ${isEdit && existing.status === 'offline' ? 'selected' : ''}>已下架</option>
        </select></div>
      </div>
      <p class="small muted" style="margin:0">提示：最后一位助力好友会直接砍到底价；目标底价不得低于 ¥1.00，且必须低于初始价。</p>
      <div class="error-text hidden" data-error></div>
    </div>`,
    footer: `<button class="btn btn-ghost" data-cancel>取消</button>
             <button class="btn btn-primary" data-submit>${isEdit ? '保存修改' : '创建活动'}</button>`
  });
  modal.el.querySelector('[data-cancel]').addEventListener('click', modal.close);

  const materialSelect = modal.el.querySelector('[data-material]');
  materialSelect?.addEventListener('change', () => {
    const opt = materialSelect.selectedOptions[0];
    const cents = Number(opt?.dataset.price || 0);
    if (!cents) return;
    modal.el.querySelector('[data-start]').value = (cents / 100).toFixed(2);
    modal.el.querySelector('[data-floor]').value = Math.max(1, Math.floor(cents / 100 / 2)).toFixed(2);
  });

  modal.el.querySelector('[data-submit]').addEventListener('click', async () => {
    const val = (sel) => modal.el.querySelector(sel).value;
    const payload = {
      startPrice: Number(val('[data-start]')),
      floorPrice: Number(val('[data-floor]')),
      durationHours: Number(val('[data-hours]')),
      maxCutsPerUser: Number(val('[data-cuts]')),
      maxHelpers: Number(val('[data-helpers]')),
      status: val('[data-status]')
    };
    if (!isEdit) payload.materialId = Number(val('[data-material]'));
    const error = modal.el.querySelector('[data-error]');
    try {
      if (isEdit) await api.patch(`/api/admin/bargains/${existing.id}`, payload);
      else await api.post('/api/admin/bargains', payload);
      modal.close();
      toast(isEdit ? '砍价活动已更新' : '砍价活动已创建');
      onDone && onDone();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    }
  });
}

function openPriceAdjustModal(id, currentYuan, onDone) {
  const modal = openModal({
    title: '校准资料价格',
    subtitle: '运营人工干预价格，卖家会收到调价说明',
    body: `<div class="stack" style="gap:14px">
      <div class="field"><label class="label">最新价格（元）</label>
        <div class="price-input"><span class="prefix">¥</span><input class="input" data-price type="number" min="0" max="999" step="0.1" value="${currentYuan}"></div>
      </div>
      <div class="field"><label class="label">调价说明（展示给卖家）</label>
        <textarea class="textarea" data-note maxlength="100" style="min-height:80px" placeholder="例如：该资料与官方标准价偏差较大，已按同类资料均值校准"></textarea>
      </div>
      <div class="error-text hidden" data-error></div>
    </div>`,
    footer: `<button class="btn btn-ghost" data-cancel>取消</button>
             <button class="btn btn-primary" data-submit>确认校准</button>`
  });
  modal.el.querySelector('[data-cancel]').addEventListener('click', modal.close);
  modal.el.querySelector('[data-submit]').addEventListener('click', async () => {
    const price = Number(modal.el.querySelector('[data-price]').value);
    const note = modal.el.querySelector('[data-note]').value.trim();
    const error = modal.el.querySelector('[data-error]');
    try {
      const res = await api.patch(`/api/admin/materials/${id}/price`, { price, note });
      modal.close();
      toast(res.message);
      onDone && onDone();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    }
  });
}

function openAnnouncementModal(existing, onDone) {
  const modal = openModal({
    title: existing ? '编辑公告' : '发布公告',
    subtitle: '发布后可在首页公告栏展示',
    body: `<div class="stack" style="gap:14px">
      <div class="field"><label class="label">标题</label><input class="input" data-title maxlength="60" value="${existing ? esc(existing.title) : ''}"></div>
      <div class="field"><label class="label">标签</label><input class="input" data-tag maxlength="10" value="${existing ? esc(existing.tag) : '公告'}" placeholder="例如：活动 / 规则 / 安全"></div>
      <div class="field"><label class="label">内容</label><textarea class="textarea" data-content maxlength="500" style="min-height:120px">${existing ? esc(existing.content) : ''}</textarea></div>
      <div class="error-text hidden" data-error></div>
    </div>`,
    footer: `<button class="btn btn-ghost" data-cancel>取消</button>
             <button class="btn btn-primary" data-submit>${existing ? '保存修改' : '发布公告'}</button>`
  });
  modal.el.querySelector('[data-cancel]').addEventListener('click', modal.close);
  modal.el.querySelector('[data-submit]').addEventListener('click', async () => {
    const payload = {
      title: modal.el.querySelector('[data-title]').value.trim(),
      tag: modal.el.querySelector('[data-tag]').value.trim() || '公告',
      content: modal.el.querySelector('[data-content]').value.trim()
    };
    const error = modal.el.querySelector('[data-error]');
    try {
      if (existing) {
        await api.patch(`/api/admin/announcements/${existing.id || ''}`, payload);
      } else {
        await api.post('/api/admin/announcements', payload);
      }
      modal.close();
      toast(existing ? '公告已更新' : '公告已发布');
      if (onDone) onDone();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    }
  });
}
