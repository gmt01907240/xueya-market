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
  const row = get('SELECT * FROM idempotency_keys WHERE scope = ? AND key = ?', scope, key);
  if (!row) return null;
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
  run(
    `INSERT INTO idempotency_keys (scope, key, request_hash, status_code, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, key) DO NOTHING`,
    scope, key, hashRequest(ctx.body), statusCode, JSON.stringify(data === undefined ? null : data), now()
  );
  return true;
}

module.exports = { replay, remember, requestKey, hashRequest };
