'use strict';

/**
 * 中英文名称统一排序：中文按拼音、英文按字母，数字按自然顺序。
 * 返回负数表示 a 排在 b 前面，可直接用于 Array.prototype.sort。
 */
const collator = new Intl.Collator('zh-Hans-CN', {
  collation: 'pinyin',
  numeric: true,
  sensitivity: 'base'
});

function compareNames(a, b) {
  return collator.compare(String(a || ''), String(b || ''));
}

function sortNames(list) {
  return list.slice().sort(compareNames);
}

module.exports = { compareNames, sortNames };
