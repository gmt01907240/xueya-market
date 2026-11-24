'use strict';

/**
 * 接口幂等助手
 *
 * 客户端可通过 `Idempotency-Key` 请求头（或 body.idempotencyKey）声明幂等键。
 * 同一 scope + key 的重复请求直接复用首次响应，避免网络重试造成重复下单、
 * 重复退款或重复确认到账。未提供幂等键时保持原有行为。
 */

const crypto = require('node:crypto');
const { get, run, now } = require('./db');

const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 128;
// 幂等记录保留 24 小时：超期后同一键允许复用，避免长期占用存储
const TTL_MS = 24 * 60 * 60 * 1000;

function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function expired(createdAt) {
  const time = new Date(String(createdAt || '').replace(' ', 'T')).getTime();
  return !time || Date.now() - time > TTL_MS;
}

/** 低概率清理过期幂等键，避免每次请求都扫表 */
function prune() {
  if (Math.random() > 0.02) return;
  run('DELETE FROM idempotency_keys WHERE created_at < ?', stamp(new Date(Date.now() - TTL_MS)));
}

function requestKey(ctx, scope) {
  const header = ctx.req && ctx.req.headers ? ctx.req.headers['idempotency-key'] : '';
  const bodyKey = ctx.body && typeof ctx.body === 'object' ? ctx.body.idempotencyKey : '';
  const raw = String(header || bodyKey || '').trim();
  if (!raw) return '';
  if (raw.length < MIN_KEY_LENGTH || raw.length > MAX_KEY_LENGTH) return '';
  return `${scope}:${raw}`;
}

function hashRequest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value === undefined ? null : value)).digest('hex');
}

function replay(ctx, scope) {
  const key = requestKey(ctx, scope);
  if (!key) return null;
  prune();
  const row = get('SELECT * FROM idempotency_keys WHERE scope = ? AND key = ?', scope, key);
  if (!row) return null;
  if (expired(row.created_at)) {
    run('DELETE FROM idempotency_keys WHERE scope = ? AND key = ?', scope, key);
    return null;
  }
  // 同一幂等键只允许对应同一份请求体，避免换个参数复用旧响应
  if (row.request_hash && row.request_hash !== hashRequest(ctx.body)) return { conflict: true };
  let data = null;
  try {
    data = JSON.parse(row.response_json || 'null');
  } catch {
    data = null;
  }
  return { statusCode: row.status_code || 200, data, replayed: true };
}

function remember(ctx, scope, statusCode, data) {
  const key = requestKey(ctx, scope);
  if (!key) return false;
  prune();
  run(
    `INSERT INTO idempotency_keys (scope, key, request_hash, status_code, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, key) DO NOTHING`,
    scope, key, hashRequest(ctx.body), statusCode, JSON.stringify(data === undefined ? null : data), now()
  );
  return true;
}

module.exports = { replay, remember, requestKey, hashRequest };
