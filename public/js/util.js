export const CATEGORIES = ['考研资料', '期末真题', '课堂笔记', '课件讲义', '电子教材', '竞赛考证', '论文范文', '语言学习'];
export const CAT_GLYPHS = ['研', '题', '记', '课', '书', '赛', '论', '语'];

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function money(cents) {
  const value = Number(cents) || 0;
  if (value === 0) return '免费';
  const yuan = value / 100;
  return Number.isInteger(yuan) ? `¥${yuan}` : `¥${yuan.toFixed(2).replace(/0$/, '')}`;
}

export function moneyPlain(cents) {
  const value = (Number(cents) || 0) / 100;
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
}

export function dateAgo(input) {
  if (!input) return '';
  const ts = new Date(String(input).replace(' ', 'T')).getTime();
  if (Number.isNaN(ts)) return String(input);
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 3600 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return String(input).slice(0, 10);
}

export function dateShort(input) {
  if (!input) return '';
  return String(input).slice(5, 16);
}

export function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fileExt(name) {
  const parts = String(name || '').split('.');
  return parts.length > 1 ? parts.pop().toUpperCase() : 'FILE';
}

export function catIndex(category) {
  const idx = CATEGORIES.indexOf(category);
  return idx >= 0 ? idx : 0;
}

export function initials(name) {
  const value = String(name || '同学').trim();
  return value.slice(0, 1);
}

export function debounce(fn, wait = 320) {
  let timer;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

export function plural(n, unit) {
  return `${n}${unit}`;
}

export function parseHash() {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query = {};
  new URLSearchParams(queryPart || '').forEach((value, key) => { query[key] = value; });
  return { path: '/' + segments.join('/'), segments, query };
}

export function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

export function statusMeta(status) {
  const map = {
    pending: { text: '待审核', cls: 'gold' },
    approved: { text: '已上架', cls: 'green' },
    rejected: { text: '未通过', cls: 'red' },
    offline: { text: '已下架', cls: 'gray' },
    completed: { text: '已完成', cls: 'green' },
    pending_payment: { text: '待支付', cls: 'gold' },
    cancelled: { text: '已取消', cls: 'gray' },
    refund_requested: { text: '退款中', cls: 'gold' },
    refunded: { text: '已退款', cls: 'gray' },
    open: { text: '求购中', cls: 'green' },
    closed: { text: '已关闭', cls: 'gray' }
  };
  return map[status] || { text: status, cls: 'gray' };
}

export function verifyMeta(status) {
  const map = {
    verified: { text: '已认证', cls: 'green' },
    pending: { text: '审核中', cls: 'gold' },
    rejected: { text: '未通过', cls: 'red' },
    none: { text: '未认证', cls: 'gray' }
  };
  return map[status] || map.none;
}

export const TICKET_TYPE_TEXT = {
  bug: 'Bug 报错',
  suggestion: '功能建议',
  complaint: '交易投诉',
  consult: '售前咨询',
  other: '其他'
};

export function ticketStatusMeta(status) {
  const map = {
    open: { text: '待处理', cls: 'gold' },
    processing: { text: '处理中', cls: 'accent' },
    resolved: { text: '已解决', cls: 'green' },
    closed: { text: '已关闭', cls: 'gray' }
  };
  return map[status] || map.open;
}

export function maskName(name) {
  const value = String(name || '');
  if (value.length <= 1) return value;
  return value.slice(0, 1) + '*'.repeat(Math.max(1, value.length - 1));
}

export function maskNo(no) {
  const value = String(no || '');
  if (value.length <= 4) return value;
  return value.slice(0, 3) + '****' + value.slice(-2);
}
