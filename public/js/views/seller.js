import { api } from '../api.js';
import { esc, money, moneyPlain, dateAgo, statusMeta, catIndex, CAT_GLYPHS } from '../util.js';
import { icon, emptyState, loadingBlock, statusBadge } from '../components.js';

export async function renderSeller(root, ctx) {
  root.innerHTML = `<div class="loading-wrap">${loadingBlock('正在加载卖家数据…')}</div>`;
  let overview;
  let materials;
  let sales;
  let chats = { items: [] };
  let settlement = { stats: {}, items: [], cycle: 'T+1' };
  try {
    [overview, materials, sales, chats, settlement] = await Promise.all([
      api.get('/api/seller/overview'),
      api.get('/api/materials/mine'),
      api.get('/api/orders/sales'),
      api.get('/api/threads?perspective=sell'),
      api.get('/api/seller/settlements')
    ]);
  } catch (err) {
    root.innerHTML = emptyState({ iconName: 'alertCircle', title: '加载失败', text: err.message });
    return;
  }
  const settleStats = settlement.stats || {};
  const settleMeta = {
    pending: { text: '待结算', cls: 'gold' },
    settled: { text: '已结算', cls: 'green' },
    cancelled: { text: '已取消', cls: 'gray' }
  };
  const s = overview.stats;
  const maxRevenue = Math.max(...overview.series.map((d) => d.revenue), 1);
  const buyerChats = chats.items;
  const chatUnread = buyerChats.reduce((sum, t) => sum + (t.unread || 0), 0);

  root.innerHTML = `<div class="view-enter">
    <div class="page-hero">
      <div class="row-between wrap">
        <div>
          <h1>卖家中心</h1>
          <p>管理你的资料、查看成交与收益，收益按 T+1 自动结算</p>
        </div>
        <a class="btn btn-primary" href="#/upload">${icon('upload')} 上传新资料</a>
      </div>
    </div>

    <div class="stat-grid" style="margin-top:22px">
      <div class="panel stat-card">
        <div class="label">${icon('wallet')} 累计收益</div>
        <div class="value">¥${moneyPlain(s.revenue)}</div>
        <div class="delta">已扣除 10% 平台服务费</div>
      </div>
      <div class="panel stat-card">
        <div class="label">${icon('bag')} 成交份数</div>
        <div class="value">${s.sold}<small>份</small></div>
        <div class="delta">成交总额 ¥${moneyPlain(s.gross)}</div>
      </div>
      <div class="panel stat-card">
        <div class="label">${icon('download')} 资料下载</div>
        <div class="value">${s.downloads}<small>次</small></div>
        <div class="delta">${s.materials} 份资料 · ${s.pending} 份待审核</div>
      </div>
      <div class="panel stat-card">
        <div class="label">${icon('clock')} 退款处理中</div>
        <div class="value">${s.refunding}<small>笔</small></div>
        <div class="delta ${s.refunding ? 'down' : ''}">${s.refunding ? '请留意平台通知' : '暂无待处理退款'}</div>
      </div>
    </div>

    <div class="split-2" style="margin-top:18px">
      <div class="panel chart-card">
        <div class="row-between" style="margin-bottom:6px">
          <h3 style="font-size:17px">近 7 天收益</h3>
          <span class="small muted">每日结余（元）</span>
        </div>
        <div class="chart">
          ${overview.series.map((d) => {
            const h = Math.max(3, Math.round((d.revenue / maxRevenue) * 100));
            return `<div class="col">
              <div class="bar ${d.revenue ? '' : 'zero'}" style="height:${h}%" data-tip="¥${(d.revenue / 100).toFixed(2)} · ${d.count} 单"></div>
              <span class="day">${d.date}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="wallet-box">
        <div class="label">账户收益（元）</div>
        <div class="amount">¥${moneyPlain(s.balance)}</div>
        <p class="small muted" style="margin:0 0 10px">成交收益按 T+1 自动结算，无充值与提现环节</p>
        <a class="btn" href="#/me?tab=wallet">${icon('clock')} 查看收益明细</a>
      </div>
    </div>

    <div class="panel panel-pad" style="margin-top:18px">
      <div class="row-between wrap" style="margin-bottom:12px">
        <div>
          <h3 style="font-size:17px;margin:0">收益结算</h3>
          <p class="small muted" style="margin:4px 0 0">成交收益扣除 10% 平台服务费后，按 ${esc(settlement.cycle || 'T+1')} 自动结算至收款账户，无需充值与提现。</p>
        </div>
        <span class="badge green">自动结算</span>
      </div>
      <div class="stat-grid" style="margin-bottom:14px">
        <div class="panel stat-card">
          <div class="label">待结算收益</div>
          <div class="value">¥${moneyPlain(settleStats.pending || 0)}</div>
          <div class="delta">${settleStats.pendingCount || 0} 笔订单等待结算</div>
        </div>
        <div class="panel stat-card">
          <div class="label">已结算收益</div>
          <div class="value">¥${moneyPlain(settleStats.settled || 0)}</div>
          <div class="delta">按 T+1 自动划付</div>
        </div>
        <div class="panel stat-card">
          <div class="label">平台服务费</div>
          <div class="value">¥${moneyPlain(settleStats.commission || 0)}</div>
          <div class="delta">成交额 ¥${moneyPlain(settleStats.gross || 0)}</div>
        </div>
      </div>
      ${settlement.items.length ? `<div class="table-wrap"><table class="mini-table">
        <thead><tr><th>资料</th><th>买家</th><th>订单金额</th><th>服务费</th><th>结算金额</th><th>状态</th><th>时间</th></tr></thead>
        <tbody>${settlement.items.slice(0, 10).map((r) => {
          const meta = settleMeta[r.status] || { text: r.statusText, cls: 'gray' };
          return `<tr>
            <td><a href="#/material/${r.material ? r.material.id : ''}"><b style="font-family:var(--serif);font-size:13px">${esc(r.material ? r.material.title : '订单 #' + r.orderId)}</b></a></td>
            <td>${esc(r.buyer ? r.buyer.nickname : '—')}</td>
            <td class="num">${money(r.orderAmount)}</td>
            <td class="num">${money(r.commission)}</td>
            <td class="num">${money(r.net)}</td>
            <td><span class="badge ${meta.cls}">${meta.text}</span>${r.status === 'pending' ? `<br><span class="small muted">预计 ${esc((r.settleDue || '').slice(5, 16))}</span>` : ''}</td>
            <td class="small muted">${dateAgo(r.createdAt)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : `<p class="muted small" style="padding:6px 0">暂无结算记录。资料成交后会自动生成结算账单。</p>`}
    </div>

    <div class="split-2" style="margin-top:18px">
      <div class="panel panel-pad">
        <div class="row-between" style="margin-bottom:10px">
          <h3 style="font-size:17px">最近成交</h3>
          <span class="small muted">最近 50 笔</span>
        </div>
        ${sales.items.length ? `<div class="table-wrap"><table class="mini-table">
          <thead><tr><th>资料</th><th>买家</th><th>金额</th><th>时间</th><th>状态</th></tr></thead>
          <tbody>
            ${sales.items.slice(0, 8).map((o) => {
              const meta = statusMeta(o.status);
              return `<tr>
                <td><a href="#/material/${o.material.id}"><b style="font-family:var(--serif);font-size:13px">${esc(o.material.title)}</b></a></td>
                <td>${esc(o.buyer.nickname)}</td>
                <td class="num">${money(o.amount)}</td>
                <td class="small muted">${dateAgo(o.createdAt)}</td>
                <td><span class="badge ${meta.cls}">${meta.text}</span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>` : emptyState({ iconName: 'bag', title: '还没有成交', text: '完善资料介绍并分享到班级群，会更快迎来第一单' })}
      </div>
      <div class="panel panel-pad">
        <h3 style="font-size:17px;margin-bottom:12px">收益排行</h3>
        ${overview.top.length ? overview.top.map((m, i) => `<div class="list-row" style="padding:11px 0">
          <span class="badge ${i === 0 ? 'gold' : 'gray'}">${i + 1}</span>
          <div class="list-main">
            <b>${esc(m.title)}</b>
            <span>${m.sold || 0} 份成交 · 收益 ¥${moneyPlain(m.revenue)}</span>
          </div>
        </div>`).join('') : '<p class="muted small" style="padding:16px 0">暂无收益数据</p>'}
      </div>
    </div>

    <div class="panel panel-pad" style="margin-top:18px">
      <div class="row-between" style="margin-bottom:10px">
        <h3 style="font-size:17px">买家咨询 ${chatUnread ? `<span class="badge accent">${chatUnread} 条未读</span>` : ''}</h3>
        <a class="link small" href="#/messages?perspective=sell">前往消息中心 ${icon('chevronRight')}</a>
      </div>
      ${buyerChats.length ? buyerChats.slice(0, 4).map((t) => `<div class="list-row" style="padding:12px 0;cursor:pointer" data-thread-open="${t.id}">
          <span class="ticket-icon small">${icon('message')}</span>
          <div class="list-main">
            <b>${esc(t.other.nickname)} ${t.unread ? '<span class="unread-dot"></span>' : ''}</b>
            <span>${esc(t.context.title)} · ${esc(t.sceneText)} · ${dateAgo(t.lastMessageAt)}</span>
            ${t.lastMessage ? `<span class="ticket-snippet">${t.lastMessage.mine ? '我：' : ''}${esc(t.lastMessage.content)}</span>` : ''}
          </div>
          ${t.unread ? `<span class="badge accent">${t.unread}</span>` : `<span class="badge gray">已读</span>`}
        </div>`).join('') : `<p class="muted small" style="padding:10px 0">暂无买家咨询。买家在资料详情页点击「联系卖家」后，会话会显示在这里。</p>`}
    </div>

    <div class="panel panel-pad" style="margin-top:18px">
      <div class="row-between" style="margin-bottom:10px">
        <h3 style="font-size:17px">我的资料</h3>
        <a class="link small" href="#/me?tab=materials">管理全部 ${materials.items.length} 份</a>
      </div>
      ${materials.items.length ? materials.items.slice(0, 5).map((m) => {
        const idx = catIndex(m.category);
        return `<div class="list-row">
          <div class="thumb cover-${idx}">${CAT_GLYPHS[idx]}</div>
          <div class="list-main">
            <b><a href="#/material/${m.id}">${esc(m.title)}</a></b>
            <span>${money(m.price)} · ${m.downloads} 次下载 · ${dateAgo(m.createdAt)}</span>
            ${m.status === 'rejected' && m.rejectReason ? `<span class="error-text" style="display:block">驳回原因：${esc(m.rejectReason)}</span>` : ''}
            ${m.priceSource === 'admin' ? `<span class="price-note">${icon('scale')} 平台已校准价格${m.priceNote ? `：${esc(m.priceNote)}` : ''}</span>` : ''}
          </div>
          <span class="badge ${statusMeta(m.status).cls}">${statusMeta(m.status).text}</span>
        </div>`;
      }).join('') : `<div class="upload-cta">
        <h4>还没有上传资料</h4>
        <p>第一份资料通过审核后，这里会显示销量与收益</p>
        <a class="btn btn-primary btn-sm" href="#/upload">上传资料</a>
      </div>`}
    </div>
  </div>`;

  root.querySelectorAll('[data-thread-open]').forEach((el) => {
    el.addEventListener('click', () => {
      window.location.hash = `#/messages?perspective=sell&thread=${el.dataset.threadOpen}`;
    });
  });
}
