import { api, downloadFile } from '../api.js';
import { esc, money, moneyPlain, dateAgo, catIndex, CAT_GLYPHS, statusMeta, fileSize, verifyMeta, maskName, maskNo } from '../util.js';
import { icon, avatar, toast, openModal, confirmDialog, emptyState, materialCard, loadingBlock, statusBadge } from '../components.js';
import { state, refreshUser, loadMeta, requireLogin } from '../layout.js';
import { openChatComposer } from './messages.js';
import { attachSelectSearch } from '../list-search.js';

const TABS = [
  ['orders', '我的订单', 'bag'],
  ['verify', '实名认证', 'shieldCheck'],
  ['favorites', '我的收藏', 'heart'],
  ['materials', '我的资料', 'upload'],
  ['wallet', '账单与收益', 'creditCard'],
  ['settings', '账户设置', 'settings']
];

export async function renderMe(root, ctx) {
  const tab = TABS.some((t) => t[0] === ctx.query.tab) ? ctx.query.tab : 'orders';
  root.innerHTML = `<div class="loading-wrap">${loadingBlock('正在加载个人中心…')}</div>`;
  let orders;
  let favorites;
  let materials;
  let payments;
  let settlement = { stats: {}, items: [] };
  let me;
  try {
    [orders, favorites, materials, payments, settlement, me] = await Promise.all([
      api.get('/api/orders/mine'),
      api.get('/api/materials/favorites'),
      api.get('/api/materials/mine'),
      api.get('/api/payments/mine'),
      api.get('/api/seller/settlements'),
      api.get('/api/auth/me')
    ]);
  } catch (err) {
    root.innerHTML = emptyState({ iconName: 'alertCircle', title: '加载失败', text: err.message });
    return;
  }
  if (me?.user) Object.assign(state.user, me.user);
  const user = state.user;
  const balance = user.balance || 0;

  root.innerHTML = `<div class="view-enter">
    <div class="panel profile-head">
      ${avatar(user.nickname, 'xl')}
      <div class="info">
        <h2>${esc(user.nickname)} ${user.role === 'admin' ? '<span class="badge gold">管理员</span>' : ''} ${(() => { const vm = verifyMeta(user.verifyStatus); return `<span class="badge ${vm.cls}">${vm.text}</span>`; })()}</h2>
        <p>${esc(user.school || '未填写院校')} · 加入于 ${String(user.createdAt).slice(0, 10)}</p>
        ${user.bio ? `<p style="margin-top:6px">${esc(user.bio)}</p>` : ''}
      </div>
      <div class="profile-stats">
        <div><b>¥${moneyPlain(balance)}</b><span>账户收益</span></div>
        <div><b>${orders.items.length}</b><span>购买记录</span></div>
        <div><b>${materials.items.length}</b><span>上传资料</span></div>
        <div><b>${favorites.items.length}</b><span>收藏</span></div>
      </div>
    </div>

    <div class="tabs">
      ${TABS.map(([key, text, iconName]) => `<a class="tab ${tab === key ? 'active' : ''}" href="#/me?tab=${key}">${esc(text)}
        ${key === 'orders' ? `<span class="count">${orders.items.length}</span>` : ''}
        ${key === 'favorites' ? `<span class="count">${favorites.items.length}</span>` : ''}
        ${key === 'materials' ? `<span class="count">${materials.items.length}</span>` : ''}
      </a>`).join('')}
    </div>

    <div data-tab-content>
      ${tab === 'orders' ? ordersTab(orders) : ''}
      ${tab === 'verify' ? verifyTab(user) : ''}
      ${tab === 'favorites' ? favoritesTab(favorites) : ''}
      ${tab === 'materials' ? materialsTab(materials) : ''}
      ${tab === 'wallet' ? walletTab(balance, payments, settlement) : ''}
      ${tab === 'settings' ? settingsTab(user) : ''}
    </div>
  </div>`;

  bindOrders(root);
  bindVerify(root, ctx);
  bindMaterials(root, ctx);
  bindSettings(root);
}

function ordersTab(orders) {
  if (!orders.items.length) {
    return `<div class="panel panel-pad">${emptyState({ iconName: 'bag', title: '还没有购买记录', text: '去资料市场挑一份适合自己的资料吧', action: '<a class="btn btn-primary" href="#/market">去逛资料市场</a>' })}</div>`;
  }
  return `<div class="panel panel-pad">
    ${orders.items.map((o) => {
      const idx = catIndex(o.material.category);
      const meta = statusMeta(o.status);
      return `<div class="list-row">
        <div class="thumb cover-${idx}">${CAT_GLYPHS[idx]}</div>
        <div class="list-main">
          <b><a href="#/material/${o.material.id}">${esc(o.material.title)}</a></b>
          <span>${esc(o.material.category)} · 卖家 ${esc(o.seller.nickname)} · ${dateAgo(o.createdAt)} · 支付 ${money(o.amount)}</span>
        </div>
        <div class="order-status"><span class="badge ${meta.cls}">${meta.text}</span></div>
        <div class="list-actions">
          ${o.status === 'pending_payment' ? `<a class="btn btn-soft btn-sm" href="#/material/${o.material.id}">${icon('creditCard')} 继续支付</a>` : ''}
          ${o.status === 'completed' || o.status === 'refund_requested' ? `<button class="btn btn-soft btn-sm" data-download="${o.material.id}">${icon('download')} 下载</button>` : ''}
          ${o.canReview ? `<button class="btn btn-ghost btn-sm" data-review="${o.material.id}" data-title="${esc(o.material.title)}">${icon('star')} 评价</button>` : ''}
          ${o.reviewed ? '<span class="badge gray">已评价</span>' : ''}
          ${o.status === 'completed' ? `<button class="btn btn-quiet btn-sm" data-refund="${o.id}">申请退款</button>` : ''}
          ${o.status === 'refunded' ? '<span class="badge gray">已退款</span>' : ''}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function verifyTab(user) {
  if (user.role === 'admin') {
    return `<div class="panel panel-pad verify-panel">
      <div class="verify-status-head">
        <span class="verify-status-icon green">${icon('shieldCheck')}</span>
        <div><h3>平台管理员</h3><p class="muted small">管理员账号默认具备全部权限，无需进行学生认证。</p></div>
      </div>
    </div>`;
  }
  const meta = verifyMeta(user.verifyStatus);
  if (user.verifyStatus === 'verified') {
    return `<div class="split-2">
      <div class="panel panel-pad verify-panel">
        <div class="verify-status-head">
          <span class="verify-status-icon green">${icon('badgeCheck')}</span>
          <div>
            <h3>已完成实名与高校认证 <span class="badge green">${meta.text}</span></h3>
            <p class="muted small">你已具备资料买卖权限，资料专区默认切换为本校专区。</p>
          </div>
        </div>
        <div class="verify-facts">
          <div><span>真实姓名</span><b>${esc(maskName(user.realName))}</b></div>
          <div><span>认证高校</span><b>${esc(user.school || '—')}</b></div>
          <div><span>学号</span><b>${esc(maskNo(user.studentNo))}</b></div>
          <div><span>认证时间</span><b>${user.verifiedAt ? String(user.verifiedAt).slice(0, 10) : '—'}</b></div>
        </div>
        <div class="row" style="gap:10px;margin-top:18px">
          <a class="btn btn-primary" href="#/market?zone=auto">${icon('school')} 进入本校专区</a>
          <a class="btn btn-ghost" href="#/market?zone=all">浏览全部院校</a>
        </div>
      </div>
      <div class="panel panel-pad">
        <h4 style="font-size:16px;margin-bottom:10px">认证权益</h4>
        <div class="stack" style="gap:10px">
          <div class="guarantee">${icon('checkCircle')} 可购买、下载平台全部资料</div>
          <div class="guarantee">${icon('checkCircle')} 可上传资料并获取 90% 成交收益</div>
          <div class="guarantee">${icon('checkCircle')} 默认展示本校专区，可手动切换其他高校</div>
          <div class="guarantee">${icon('checkCircle')} 可购买、下载资料并与卖家在线沟通</div>
        </div>
        <p class="small muted" style="margin-top:14px">认证高校已锁定。如需变更院校，请通过 <a class="link" href="#/support?tab=new">客服工单</a> 提交申请。</p>
      </div>
    </div>`;
  }

  if (user.verifyStatus === 'pending') {
    return `<div class="panel panel-pad verify-panel">
      <div class="verify-status-head">
        <span class="verify-status-icon gold">${icon('clock')}</span>
        <div>
          <h3>认证申请审核中 <span class="badge gold">${meta.text}</span></h3>
          <p class="muted small">管理员通常会在 1 个工作日内完成审核，请耐心等待。</p>
        </div>
      </div>
      <div class="verify-facts">
        <div><span>真实姓名</span><b>${esc(user.realName || '—')}</b></div>
        <div><span>申请高校</span><b>${esc(user.school || '—')}</b></div>
        <div><span>学号</span><b>${esc(user.studentNo || '—')}</b></div>
        <div><span>当前状态</span><b>待管理员审核</b></div>
      </div>
      <p class="small muted" style="margin-top:16px">审核通过后，系统会自动为你开放买卖权限，并把资料专区切换到本校。</p>
    </div>`;
  }

  const rejected = user.verifyStatus === 'rejected';
  return `<div class="split-2">
    <form class="panel panel-pad" data-verify-form>
      <div class="verify-status-head">
        <span class="verify-status-icon ${rejected ? 'red' : 'gray'}">${icon('shieldCheck')}</span>
        <div>
          <h3>实名认证与高校认证</h3>
          <p class="muted small">认证通过后才能购买、下载与出售资料；未认证仅可浏览公开内容。</p>
        </div>
      </div>
      ${rejected ? `<div class="alert red" style="margin:14px 0">${icon('alertCircle')} 上次认证未通过：${esc(user.verifyNote || '信息不完整')}，请修改后重新提交。</div>` : ''}
      <div class="stack" style="gap:14px;margin-top:16px">
        <div class="field">
          <label class="label">真实姓名<span class="req">*</span></label>
          <input class="input" name="realName" maxlength="20" value="${esc(user.realName || '')}" placeholder="请输入与学籍一致的姓名">
        </div>
        <div class="field">
          <label class="label">所在高校<span class="req">*</span></label>
          <select class="select" name="school">
            <option value="">请选择高校</option>
            ${((state.meta && state.meta.schools) || []).map((s) => `<option ${user.school === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="label">学号<span class="req">*</span></label>
          <input class="input" name="studentNo" maxlength="20" value="${esc(user.studentNo || '')}" placeholder="6—20 位字母或数字">
          <div class="hint">学号仅用于身份核验，不会公开展示</div>
        </div>
        <div class="field">
          <label class="label">认证须知</label>
          <div class="stack" style="gap:8px">
            <div class="guarantee">${icon('checkCircle')} 认证通过后默认进入本校资料专区</div>
            <div class="guarantee">${icon('checkCircle')} 认证用户可手动切换查看其他高校专区</div>
            <div class="guarantee">${icon('alertCircle')} 请确保信息真实，虚假信息将被封禁账号</div>
          </div>
        </div>
        <div class="row" style="justify-content:flex-end">
          <button class="btn btn-primary" type="submit">${icon('send')} 提交认证申请</button>
        </div>
      </div>
    </form>
    <div class="stack" style="gap:16px">
      <div class="panel panel-pad">
        <h4 style="font-size:16px;margin-bottom:12px">认证流程</h4>
        <div class="steps">
          <div class="step"><b>1</b><div><strong>选择高校并填写学号</strong><span>需与本人学籍信息保持一致</span></div></div>
          <div class="step"><b>2</b><div><strong>管理员人工审核</strong><span>通常在 1 个工作日内完成</span></div></div>
          <div class="step"><b>3</b><div><strong>解锁买卖权限</strong><span>认证后默认进入本校专区</span></div></div>
        </div>
      </div>
      <div class="panel panel-pad">
        <h4 style="font-size:16px;margin-bottom:10px">未认证可以做什么？</h4>
        <div class="stack" style="gap:8px">
          <div class="guarantee">${icon('eye')} 可以浏览资料市场与试读片段</div>
          <div class="guarantee">${icon('heart')} 可以收藏资料、查看卖家主页</div>
          <div class="guarantee">${icon('headphones')} 可以提交客服工单与咨询卖家</div>
          <div class="guarantee">${icon('lock')} 不能购买、下载或上传资料</div>
        </div>
      </div>
    </div>
  </div>`;
}

function bindVerify(root, ctx) {
  const form = root.querySelector('[data-verify-form]');
  if (!form) return;
  attachSelectSearch(form.elements.school, { placeholder: '搜索院校，如「清华」「师范」' });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const submit = form.querySelector('button[type="submit"]');
    submit.setAttribute('aria-busy', 'true');
    try {
      const res = await api.post('/api/verify/submit', {
        realName: String(data.get('realName')).trim(),
        school: data.get('school'),
        studentNo: String(data.get('studentNo')).trim()
      });
      state.user = res.user;
      toast(res.message);
      await refreshUser();
      await renderMe(root, ctx);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      submit.removeAttribute('aria-busy');
    }
  });
}

function favoritesTab(favorites) {
  if (!favorites.items.length) {
    return `<div class="panel panel-pad">${emptyState({ iconName: 'heart', title: '收藏夹还是空的', text: '看到喜欢的资料，点一下收藏方便下次找到', action: '<a class="btn btn-primary" href="#/market">发现好资料</a>' })}</div>`;
  }
  return `<div class="material-grid">${favorites.items.map(materialCard).join('')}</div>`;
}

function materialsTab(materials) {
  if (!materials.items.length) {
    return `<div class="panel panel-pad">${emptyState({ iconName: 'upload', title: '你还没有上传资料', text: '把课堂整理分享出来，既是帮助同学，也能获得收益', action: '<a class="btn btn-primary" href="#/upload">上传第一份资料</a>' })}</div>`;
  }
  return `<div class="panel panel-pad">
    <div class="row-between wrap" style="margin-bottom:8px">
      <span class="small muted">共 ${materials.counts.all} 份 · 已上架 ${materials.counts.approved} · 待审核 ${materials.counts.pending} · 未通过 ${materials.counts.rejected}</span>
      <a class="btn btn-primary btn-sm" href="#/upload">${icon('plus')} 上传新资料</a>
    </div>
    ${materials.items.map((m) => {
      const idx = catIndex(m.category);
      const meta = statusMeta(m.status);
      return `<div class="list-row">
        <div class="thumb cover-${idx}">${CAT_GLYPHS[idx]}</div>
        <div class="list-main">
          <b><a href="#/material/${m.id}">${esc(m.title)}</a></b>
          <span>${esc(m.category)} · ${money(m.price)} · ${m.downloads} 次下载 · ${dateAgo(m.createdAt)} 上传</span>
          ${m.status === 'rejected' && m.rejectReason ? `<span class="error-text" style="display:block;margin-top:4px">驳回原因：${esc(m.rejectReason)}</span>` : ''}
          ${m.status === 'pending' ? '<span class="small muted" style="display:block;margin-top:4px">审核中，通过后将自动上架</span>' : ''}
          ${m.priceSource === 'admin' ? `<span class="price-note" style="display:block;margin-top:4px">${icon('scale')} 平台已校准价格${m.priceNote ? `：${esc(m.priceNote)}` : ''}</span>` : ''}
        </div>
        <div class="order-status"><span class="badge ${meta.cls}">${meta.text}</span></div>
        <div class="list-actions">
          <a class="btn btn-ghost btn-sm" href="#/material/${m.id}">${icon('eye')} 查看</a>
          <button class="btn btn-quiet btn-sm" data-delete-material="${m.id}">下架/删除</button>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function paymentMeta(status) {
  const map = {
    pending: { text: '待支付', cls: 'gold' },
    paid: { text: '已支付', cls: 'green' },
    failed: { text: '支付失败', cls: 'red' },
    closed: { text: '已关闭', cls: 'gray' },
    refunded: { text: '已退款', cls: 'gray' }
  };
  return map[status] || { text: status, cls: 'gray' };
}

function walletTab(balance, payments, settlement = { stats: {}, items: [] }) {
  const records = (payments && payments.items) || [];
  const settleRecords = settlement.items || [];
  const settleStats = settlement.stats || {};
  return `<div class="stack" style="gap:18px">
    <div class="split-2">
      <div class="wallet-box">
        <div class="label">账户收益（元）</div>
        <div class="amount">¥${moneyPlain(balance)}</div>
        <p class="small muted" style="margin:0">卖家成交收益按 T+1 自动结算至收款账户，无需充值与提现。</p>
      </div>
      <div class="panel panel-pad">
        <h4 style="font-size:16px;margin-bottom:10px">交易说明</h4>
        <div class="stack" style="gap:9px">
          <div class="guarantee">${icon('shield')} 所有购买直接通过微信、支付宝或银行卡完成支付</div>
          <div class="guarantee">${icon('trending')} 卖家成交后获得 90% 收益，平台收取 10% 服务费</div>
          <div class="guarantee">${icon('refresh')} 退款审核通过后按原支付渠道退回，无需站内余额</div>
        </div>
      </div>
    </div>
    <div class="panel panel-pad">
      <div class="row-between wrap" style="margin-bottom:8px">
        <h4 style="font-size:16px">收益结算</h4>
        <span class="small muted">按 T+1 自动结算 · 扣除 10% 服务费</span>
      </div>
      <div class="split-2" style="margin-bottom:10px">
        <div class="wallet-box" style="padding:16px 18px">
          <div class="label">待结算收益（元）</div>
          <div class="amount" style="font-size:26px">¥${moneyPlain(settleStats.pending || 0)}</div>
        </div>
        <div class="wallet-box" style="padding:16px 18px">
          <div class="label">已结算收益（元）</div>
          <div class="amount" style="font-size:26px">¥${moneyPlain(settleStats.settled || 0)}</div>
        </div>
      </div>
      ${settleRecords.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>资料</th><th>订单金额</th><th>服务费</th><th>结算金额</th><th>状态</th><th>时间</th></tr></thead>
        <tbody>${settleRecords.slice(0, 8).map((r) => {
          const meta = { pending: ['待结算', 'gold'], settled: ['已结算', 'green'], cancelled: ['已取消', 'gray'] }[r.status] || [r.statusText, 'gray'];
          return `<tr>
            <td>${esc(r.material ? r.material.title : '订单 #' + r.orderId)}</td>
            <td class="num">¥${moneyPlain(r.orderAmount)}</td>
            <td class="num">¥${moneyPlain(r.commission)}</td>
            <td class="num">¥${moneyPlain(r.net)}</td>
            <td><span class="badge ${meta[1]}">${meta[0]}</span></td>
            <td class="small muted">${dateAgo(r.createdAt)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : `<p class="muted small" style="padding:12px 0">暂无结算记录，资料成交后会自动生成。</p>`}
    </div>
    <div class="panel panel-pad">
      <div class="row-between wrap" style="margin-bottom:8px">
        <h4 style="font-size:16px">支付记录</h4>
        <span class="small muted">最近 ${records.length} 笔 · 微信 / 支付宝 / 银行卡</span>
      </div>
      ${records.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>支付单号</th><th>方式</th><th>用途</th><th>金额</th><th>状态</th><th>发起时间</th></tr></thead>
        <tbody>${records.map((p) => {
          const meta = paymentMeta(p.status);
          return `<tr>
            <td class="mono small">${esc(p.paymentNo)}</td>
            <td>${esc(p.channelName)}</td>
            <td>购买资料</td>
            <td class="num">¥${moneyPlain(p.amount)}</td>
            <td><span class="badge ${meta.cls}">${meta.text}</span></td>
            <td class="small muted">${dateAgo(p.createdAt)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : `<p class="muted small" style="padding:20px 0">还没有支付记录</p>`}
    </div>
  </div>`;
}

function settingsTab(user) {
  return `<div class="split-2">
    <form class="panel panel-pad" data-profile-form>
      <h4 style="font-size:17px;margin-bottom:16px">个人资料</h4>
      <div class="stack" style="gap:14px">
        <div class="field"><label class="label">昵称</label><input class="input" name="nickname" value="${esc(user.nickname)}" maxlength="20"></div>
        <div class="field"><label class="label">院校</label><input class="input" name="school" value="${esc(user.school || '')}" maxlength="30" placeholder="例如：浙江大学" ${user.verifyStatus === 'verified' ? 'disabled' : ''}>
          <div class="hint">${user.verifyStatus === 'verified' ? '认证院校已锁定，如需变更请提交客服工单' : '完成实名与高校认证后，院校将自动锁定'}</div>
        </div>
        <div class="field"><label class="label">个人简介</label><textarea class="textarea" name="bio" maxlength="200" style="min-height:90px" placeholder="介绍一下你的专业、年级或擅长的方向">${esc(user.bio || '')}</textarea></div>
        <div class="row" style="justify-content:flex-end"><button class="btn btn-primary" type="submit">保存资料</button></div>
      </div>
    </form>
    <form class="panel panel-pad" data-password-form>
      <h4 style="font-size:17px;margin-bottom:16px">修改密码</h4>
      <div class="stack" style="gap:14px">
        <div class="field"><label class="label">原密码</label><input class="input" name="oldPassword" type="password" autocomplete="current-password"></div>
        <div class="field"><label class="label">新密码</label><input class="input" name="newPassword" type="password" autocomplete="new-password" placeholder="8—72 位，需包含字母和数字"></div>
        <div class="row" style="justify-content:flex-end"><button class="btn btn-ghost" type="submit">更新密码</button></div>
      </div>
    </form>
  </div>`;
}

function bindOrders(root) {
  root.querySelectorAll('[data-download]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.setAttribute('aria-busy', 'true');
      try {
        await downloadFile(btn.dataset.download);
        toast('下载已开始');
      } catch (err) { toast(err.message, 'error'); }
      finally { btn.removeAttribute('aria-busy'); }
    });
  });

  root.querySelectorAll('[data-refund]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: '申请退款', text: '平台将在 1—3 个工作日内核实处理。若资料已下载，请说明退款原因。', confirmText: '提交申请', danger: true });
      if (!ok) return;
      try {
        const res = await api.post(`/api/orders/${btn.dataset.refund}/refund`);
        toast(res.message);
        window.location.reload();
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  root.querySelectorAll('[data-review]').forEach((btn) => {
    btn.addEventListener('click', () => openReviewModal(Number(btn.dataset.review), btn.dataset.title));
  });
}

function openReviewModal(materialId, title) {
  const modal = openModal({
    title: '评价资料',
    subtitle: title,
    body: `<div class="field" style="margin-bottom:14px">
        <label class="label">评分</label>
        <div class="star-input" data-review-stars>
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" class="on">${icon('star')}</button>`).join('')}
        </div>
      </div>
      <div class="field"><label class="label">评价内容</label>
        <textarea class="textarea" data-review-content maxlength="300" placeholder="资料质量、排版、对你的帮助…（选填）"></textarea>
      </div>`,
    footer: `<button class="btn btn-ghost" data-cancel>取消</button>
             <button class="btn btn-primary" data-submit>发布评价</button>`
  });
  let rating = 5;
  const starBox = modal.el.querySelector('[data-review-stars]');
  starBox.querySelectorAll('[data-star]').forEach((b) => b.addEventListener('click', () => {
    rating = Number(b.dataset.star);
    starBox.querySelectorAll('[data-star]').forEach((x) => x.classList.toggle('on', Number(x.dataset.star) <= rating));
  }));
  modal.el.querySelector('[data-cancel]').addEventListener('click', modal.close);
  modal.el.querySelector('[data-submit]').addEventListener('click', async () => {
    try {
      await api.post(`/api/materials/${materialId}/reviews`, {
        rating, content: modal.el.querySelector('[data-review-content]').value.trim()
      });
      modal.close();
      toast('评价已发布，感谢你的反馈');
      window.location.reload();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function bindMaterials(root, ctx) {
  root.querySelectorAll('[data-delete-material]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: '下架这份资料？', text: '若资料已有成交记录，将改为下架处理并保留下载记录；否则会被彻底删除。', confirmText: '确认下架', danger: true });
      if (!ok) return;
      try {
        const res = await api.del(`/api/materials/${btn.dataset.deleteMaterial}`);
        toast(res.message);
        await renderMe(root, ctx);
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

function bindSettings(root) {
  const profileForm = root.querySelector('[data-profile-form]');
  profileForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(profileForm);
    try {
      const res = await api.patch('/api/auth/me', {
        nickname: data.get('nickname'),
        school: state.user.verifyStatus === 'verified' ? state.user.school : data.get('school'),
        bio: data.get('bio')
      });
      state.user = res.user;
      toast('个人资料已更新');
      await refreshUser();
      window.location.reload();
    } catch (err) { toast(err.message, 'error'); }
  });

  const passwordForm = root.querySelector('[data-password-form]');
  passwordForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(passwordForm);
    try {
      const res = await api.post('/api/auth/password', {
        oldPassword: data.get('oldPassword'), newPassword: data.get('newPassword')
      });
      toast(res.message);
      passwordForm.reset();
    } catch (err) { toast(err.message, 'error'); }
  });
}

export async function renderSellerPublic(root, ctx) {
  const id = Number(ctx.params.id);
  root.innerHTML = `<div class="loading-wrap">${loadingBlock('正在打开卖家主页…')}</div>`;
  let data;
  try {
    data = await api.get(`/api/sellers/${id}`);
  } catch (err) {
    root.innerHTML = emptyState({ iconName: 'alertCircle', title: '用户不存在', text: err.message, action: '<a class="btn btn-primary" href="#/market">返回市场</a>' });
    return;
  }
  const s = data.seller;
  root.innerHTML = `<div class="view-enter">
    <div class="breadcrumb"><a href="#/">首页</a>${icon('chevronRight')}<a href="#/market">资料市场</a>${icon('chevronRight')}<span>${esc(s.nickname)}</span></div>
    <div class="panel profile-head">
      ${avatar(s.nickname, 'xl')}
      <div class="info">
        <h2>${esc(s.nickname)}</h2>
        <p>${esc(s.school || '未填写院校')} · 加入于 ${String(s.createdAt).slice(0, 10)}</p>
        ${s.bio ? `<p style="margin-top:6px">${esc(s.bio)}</p>` : ''}
      </div>
      <div class="profile-stats">
        <div><b>${data.stats.count}</b><span>在架资料</span></div>
        <div><b>${data.stats.downloads}</b><span>累计下载</span></div>
        <div><b>${Number(data.stats.rating).toFixed(1)}</b><span>平均评分</span></div>
      </div>
      <button class="btn btn-primary" type="button" data-contact-seller>${icon('message')} 联系卖家</button>
    </div>
    <section class="section">
      <div class="section-head"><div><div class="section-kicker">SELLER'S NOTES</div><h2>TA 的资料</h2></div></div>
      ${data.materials.length ? `<div class="material-grid">${data.materials.map(materialCard).join('')}</div>` : emptyState({ iconName: 'book', title: '暂时没有上架资料', text: '看看其他同学的资料吧' })}
    </section>
  </div>`;
  root.querySelector('[data-contact-seller]').addEventListener('click', () => {
    if (!requireLogin()) return;
    if (state.user && state.user.id === s.id) return toast('这是你自己的主页', 'error');
    openChatComposer({ toUserId: s.id, toName: s.nickname, scene: 'free' });
  });
}
