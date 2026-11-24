'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./paths');

const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

function loadSecret() {
  if (!fs.existsSync(SECRET_FILE)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, crypto.randomBytes(48).toString('hex'), 'utf8');
  }
  return fs.readFileSync(SECRET_FILE, 'utf8').trim();
}

const SECRET = loadSecret();
const TOKEN_TTL = 24 * 3600 * 1000;

function hashPassword(password, salt) {
  const realSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), realSalt, 64).toString('hex');
  return { hash, salt: realSalt };
}

function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signToken(userIdOrPayload, ttl = TOKEN_TTL) {
  const base = userIdOrPayload && typeof userIdOrPayload === 'object'
    ? { ...userIdOrPayload }
    : { uid: userIdOrPayload };
  const payload = b64url(JSON.stringify({ ...base, exp: Date.now() + ttl }));
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!data || !data.uid || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, TOKEN_TTL };
