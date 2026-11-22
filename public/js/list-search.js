/**
 * 列表搜索增强：在院校 / 学科等下拉列表顶部插入搜索框，输入即过滤。
 *
 * 用法：
 *   import { attachSelectSearch } from '../list-search.js';
 *   attachSelectSearch(selectEl, { placeholder: '搜索院校，如「清华」「师范」' });
 *
 * 特性：
 * - 实时筛选，无需点击触发；支持空格分隔的多关键词（全部命中才显示）
 * - 大小写不敏感；保留下拉首项（如「全部院校」）始终可见
 * - 回车可直接选中第一个匹配项并触发 change，兼容原有筛选逻辑
 */

const attached = new WeakMap();

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

export function attachSelectSearch(select, options = {}) {
  if (!select || select.dataset.listSearch === '1') return null;
  select.dataset.listSearch = '1';

  const keep = typeof options.keep === 'function' ? options.keep : (option) => option.value === '';
  const allOptions = Array.from(select.options);
  const total = allOptions.filter((option) => !keep(option)).length;
  const wrap = document.createElement('div');
  wrap.className = 'list-search';

  const input = document.createElement('input');
  input.className = 'input list-search-input';
  input.type = 'search';
  input.autocomplete = 'off';
  input.placeholder = options.placeholder || '搜索名称，支持模糊匹配';
  input.setAttribute('aria-label', input.placeholder);

  const hint = document.createElement('div');
  hint.className = 'list-search-hint';
  hint.textContent = `共 ${total} 项`;

  wrap.append(input, hint);
  select.parentNode.insertBefore(wrap, select);

  const items = allOptions.map((option) => ({
    option,
    text: normalize(option.textContent),
    value: option.value,
    keep: keep(option)
  }));

  const apply = () => {
    const words = normalize(input.value).split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const item of items) {
      if (item.keep) continue; // 首项「全部 / 请选择」始终保留
      const hit = words.every((w) => item.text.includes(w));
      // 已选中的项保持可用，避免筛选后表单出现「选中项被禁用」的校验异常
      const locked = item.option.selected;
      item.option.hidden = !hit && !locked;
      item.option.disabled = !hit && !locked;
      if (hit) shown += 1;
    }
    hint.textContent = words.length ? `匹配 ${shown} / ${total} 项` : `共 ${total} 项`;
    hint.classList.toggle('is-empty', words.length > 0 && shown === 0);
  };

  input.addEventListener('input', apply);
  input.addEventListener('search', apply);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = items.find((item) => !item.keep && !item.option.hidden);
    if (!first) return;
    select.value = first.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

  const api = {
    reset() {
      input.value = '';
      apply();
    },
    focus() {
      input.focus();
    }
  };
  attached.set(select, api);
  return api;
}
