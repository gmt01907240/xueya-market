import { esc, money, catIndex, CAT_GLYPHS, fileExt, initials, statusMeta, dateAgo } from './util.js';

const ICONS = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  message: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  chevronRight: '<polyline points="9 18 15 12 9 6"/>',
  chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  arrowLeft: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  alertCircle: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  school: '<path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/><line x1="9" y1="11" x2="15" y2="11"/>',
  tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  creditCard: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
  chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  trending: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  bookOpen: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  bag: '<path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  gift: '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
  award: '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/>',
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
  headphones: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
  bot: '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8.01" y2="16"/><line x1="16" y1="16" x2="16.01" y2="16"/>',
  sparkles: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/><path d="M5 15l.6 1.6L7 17l-1.4.4L5 19l-.6-1.6L3 17l1.4-.4z"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="12" y2="16"/>',
  shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  scale: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="M6 7l-3 6a3 3 0 0 0 6 0z"/><path d="M18 7l-3 6a3 3 0 0 0 6 0z"/><path d="M8 21h8"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  badgeCheck: '<path d="M12 2l2.4 2.4 3.4-.6.6 3.4L21 9.6 19.4 13 21 16.4l-2.6 2.2-.6 3.4-3.4-.6L12 24l-2.4-2.6-3.4.6-.6-3.4L3 16.4 4.6 13 3 9.6l2.6-2.2.6-3.4 3.4.6z"/><polyline points="8.5 13.5 11 16 15.5 10.5"/>',
  arrowUpRight: '<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>'
};

export function icon(name, cls = '') {
  const body = ICONS[name] || ICONS.file;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function avatar(name, size = '') {
  return `<span class="avatar ${size}">${esc(initials(name))}</span>`;
}

export function stars(value = 0, cls = '') {
  const rating = Number(value) || 0;
  let html = `<span class="stars ${cls}">`;
  for (let i = 1; i <= 5; i++) {
    html += `<svg viewBox="0 0 24 24" fill="${i <= Math.round(rating) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5">${ICONS.star}</svg>`;
  }
  return html + '</span>';
}

const TOAST_LIMIT = 3;

export function toast(message, type = 'success') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  // 限制同屏提示数量，避免连续操作时堆叠遮挡页面内容
  while (root.children.length >= TOAST_LIMIT) root.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === 'error' ? 'alertCircle' : 'checkCircle')}<span>${esc(message)}</span>`;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

const modalInstances = new Set();

/** 路由切换时统一关闭所有弹窗，避免弹窗跨页残留与 body 滚动锁死 */
export function closeAllModals() {
  for (const instance of [...modalInstances]) {
    try { instance.close(); } catch { /* 单个弹窗关闭失败不影响其他 */ }
  }
  modalInstances.clear();
  const root = document.getElementById('modal-root');
  if (root) root.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
  document.body.style.overflow = '';
}

export function openModal({ title, subtitle = '', body = '', footer = '', wide = false, onClose } = {}) {
  const root = document.getElementById('modal-root');
  const previousFocus = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title || '对话框')}">
      <div class="modal-head">
        <div>
          <h3>${esc(title || '')}</h3>
          ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
        </div>
        <button class="modal-close" type="button" aria-label="关闭">${icon('x')}</button>
      </div>
      <div class="modal-body">${typeof body === 'string' ? body : ''}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  if (typeof body !== 'string') wrap.querySelector('.modal-body').appendChild(body);
  root.appendChild(wrap);
  document.body.style.overflow = 'hidden';

  let closed = false;
  let instance = null;
  const close = () => {
    if (closed) return;
    closed = true;
    if (instance) modalInstances.delete(instance);
    wrap.remove();
    const modalRoot = document.getElementById('modal-root');
    const empty = !modalRoot || !modalRoot.querySelector('.modal-backdrop');
    if (empty) {
      document.body.style.overflow = '';
      // 关闭最后一个弹窗后，把焦点还给打开它的元素
      if (previousFocus && typeof previousFocus.focus === 'function' && document.contains(previousFocus)) {
        previousFocus.focus();
      }
    }
    if (onClose) onClose();
  };
  wrap.querySelector('.modal-close').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    // 焦点陷阱：Tab 在弹窗内循环，避免焦点跑到背景页面
    const focusables = [...wrap.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === wrap)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  setTimeout(() => {
    const focusable = wrap.querySelector('input, textarea, select, button:not(.modal-close)');
    if (focusable) focusable.focus();
  }, 60);
  instance = { close, el: wrap.querySelector('.modal'), bodyEl: wrap.querySelector('.modal-body') };
  modalInstances.add(instance);
  return instance;
}

export function confirmDialog({ title = '请确认', text = '', confirmText = '确认', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const modal = openModal({
      title,
      body: `<p class="confirm-text">${esc(text)}</p>`,
      footer: `<button class="btn btn-ghost" data-act="cancel">${esc(cancelText)}</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(confirmText)}</button>`,
      onClose: () => { if (!settled) resolve(false); }
    });
    modal.el.querySelector('[data-act="cancel"]').addEventListener('click', () => { settled = true; modal.close(); resolve(false); });
    modal.el.querySelector('[data-act="ok"]').addEventListener('click', () => { settled = true; modal.close(); resolve(true); });
    modal.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') modal.el.querySelector('[data-act="ok"]').click(); });
  });
}

export function promptDialog({ title = '请输入', label = '', placeholder = '', value = '', multiline = false, confirmText = '提交', required = true } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const field = multiline
      ? `<textarea class="textarea" data-input placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input class="input" data-input value="${esc(value)}" placeholder="${esc(placeholder)}">`;
    const modal = openModal({
      title,
      body: `<div class="field">${label ? `<label class="label">${esc(label)}</label>` : ''}${field}<div class="error-text hidden" data-error></div></div>`,
      footer: `<button class="btn btn-ghost" data-act="cancel">取消</button>
               <button class="btn btn-primary" data-act="ok">${esc(confirmText)}</button>`,
      onClose: () => { if (!settled) resolve(null); }
    });
    const input = modal.el.querySelector('[data-input]');
    const error = modal.el.querySelector('[data-error]');
    const submit = () => {
      const text = input.value.trim();
      if (required && !text) {
        error.textContent = '请填写内容后再提交';
        error.classList.remove('hidden');
        return;
      }
      settled = true;
      modal.close();
      resolve(text);
    };
    modal.el.querySelector('[data-act="ok"]').addEventListener('click', submit);
    modal.el.querySelector('[data-act="cancel"]').addEventListener('click', () => { settled = true; modal.close(); resolve(null); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) submit(); });
  });
}

export function materialCard(m) {
  const idx = catIndex(m.category);
  const glyph = CAT_GLYPHS[idx] || '书';
  const rating = m.rating ? Number(m.rating).toFixed(1) : '暂无';
  return `<a class="mcard" href="#/material/${m.id}" title="${esc(m.title)}">
    <div class="mcover cover-${idx}">
      <span class="glyph">${glyph}</span>
      <div class="mcover-top">
        <span class="mcover-cat">${esc(m.category)}</span>
        <span class="mcover-type">${esc(fileExt(m.fileName))}</span>
      </div>
      <div class="mcover-bottom">
        <span class="mcover-price ${m.price === 0 ? 'free' : ''}">${money(m.price)}</span>
        <span class="mcover-stamp">${esc(m.school || '通用资料')}</span>
      </div>
    </div>
    <div class="mbody">
      <h3 class="mtitle">${esc(m.title)}</h3>
      <div class="mmeta">
        <span>${icon('download')} ${m.downloads}</span>
        <span class="sep"></span>
        <span>${icon('star')} ${rating}</span>
        <span class="sep"></span>
        <span>${esc(m.course || m.category)}</span>
      </div>
      <div class="mfoot">
        <div class="seller-mini">${avatar(m.seller && m.seller.nickname, 'sm')}<span>${esc(m.seller ? m.seller.nickname : '匿名同学')}</span></div>
        <span class="rating">${icon('star')} ${rating}</span>
      </div>
    </div>
  </a>`;
}

export function statusBadge(status) {
  const meta = statusMeta(status);
  return `<span class="badge ${meta.cls}">${meta.text}</span>`;
}

export function emptyState({ iconName = 'bookOpen', title = '这里还空着', text = '', action = '' } = {}) {
  return `<div class="empty">
    <div class="empty-icon">${icon(iconName)}</div>
    <h4>${esc(title)}</h4>
    ${text ? `<p>${esc(text)}</p>` : ''}
    ${action}
  </div>`;
}

export function loadingBlock(text = '正在加载…') {
  return `<div class="empty"><div class="empty-icon">${icon('refresh')}</div><h4>${esc(text)}</h4></div>`;
}

export function skeletonGrid(count = 6, cols = 3) {
  let html = `<div class="material-grid ${cols === 4 ? 'cols-4' : ''}">`;
  for (let i = 0; i < count; i++) {
    html += `<div class="sk-card"><div class="sk-cover skeleton"></div>
      <div class="sk-line skeleton"></div><div class="sk-line short skeleton"></div><div class="sk-line skeleton"></div></div>`;
  }
  return html + '</div>';
}

export function pager(page, pages) {
  if (pages <= 1) return '';
  const items = [];
  const push = (p) => items.push(`<button data-page="${p}" class="${p === page ? 'active' : ''}">${p}</button>`);
  const ellipsis = '<span class="gap">…</span>';
  if (pages <= 7) {
    for (let i = 1; i <= pages; i++) push(i);
  } else {
    push(1);
    if (page > 3) items.push(ellipsis);
    for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) push(i);
    if (page < pages - 2) items.push(ellipsis);
    push(pages);
  }
  return `<div class="pager">
    <button data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="上一页">${icon('chevronLeft')}</button>
    ${items.join('')}
    <button data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="下一页">${icon('chevronRight')}</button>
  </div>`;
}

export function sectionHead({ kicker = '', title = '', desc = '', linkHref = '', linkText = '' } = {}) {
  return `<div class="section-head">
    <div>
      ${kicker ? `<div class="section-kicker">${esc(kicker)}</div>` : ''}
      <h2>${esc(title)}</h2>
      ${desc ? `<p>${esc(desc)}</p>` : ''}
    </div>
    ${linkHref ? `<a class="section-link" href="${linkHref}">${esc(linkText)} ${icon('arrowRight')}</a>` : ''}
  </div>`;
}

export function tag(text, cls = 'tag') {
  return `<span class="${cls}">${esc(text)}</span>`;
}

export { dateAgo };
