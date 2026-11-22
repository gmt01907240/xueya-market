'use strict';

const contentAudit = require('./content-audit');
const { sendJson, fail } = require('./http');

function overview(ctx) {
  sendJson(ctx.res, 200, {
    stats: contentAudit.stats(),
    categories: contentAudit.AUDIT_CATEGORIES,
    levels: contentAudit.AUDIT_LEVELS
  });
}

function rules(ctx) {
  sendJson(ctx.res, 200, {
    items: contentAudit.listRules(),
    categories: contentAudit.AUDIT_CATEGORIES,
    levels: contentAudit.AUDIT_LEVELS
  });
}

function createRule(ctx) {
  const result = contentAudit.createRule(ctx.body);
  if (result.error) return fail(ctx.res, 400, result.error);
  sendJson(ctx.res, 201, { id: result.id, message: '审核规则已新增并即时生效' });
}

function updateRule(ctx) {
  const result = contentAudit.updateRule(ctx.params.id, ctx.body);
  if (result.error) return fail(ctx.res, result.error === '规则不存在' ? 404 : 400, result.error);
  sendJson(ctx.res, 200, { message: '规则已更新并即时生效' });
}

function deleteRule(ctx) {
  const result = contentAudit.deleteRule(ctx.params.id);
  if (result.error) return fail(ctx.res, 404, result.error);
  sendJson(ctx.res, 200, { message: '规则已删除' });
}

function testRule(ctx) {
  const text = String(ctx.body.text || '').trim();
  if (!text) return fail(ctx.res, 400, '请填写待检测文本');
  if (text.length > 20000) return fail(ctx.res, 400, '测试文本不能超过 20000 字');
  const result = contentAudit.testText(text);
  sendJson(ctx.res, 200, {
    result: {
      verdict: result.verdict,
      score: result.score,
      hits: result.hits,
      categories: result.categories || [],
      durationMs: result.durationMs
    }
  });
}

function reload(ctx) {
  const version = contentAudit.invalidate();
  sendJson(ctx.res, 200, { message: `规则缓存已刷新（版本 ${version}）`, version });
}

function logs(ctx) {
  sendJson(ctx.res, 200, contentAudit.listLogs(ctx.query));
}

function settings(ctx) {
  sendJson(ctx.res, 200, { settings: contentAudit.loadSettings() });
}

function updateSettings(ctx) {
  const result = contentAudit.updateSettings(ctx.body);
  if (result.error) return fail(ctx.res, 400, result.error);
  sendJson(ctx.res, 200, { message: '审核阈值已更新并即时生效', settings: result.settings });
}

module.exports = {
  overview, rules, createRule, updateRule, deleteRule, testRule, reload,
  logs, settings, updateSettings
};
