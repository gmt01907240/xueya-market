'use strict';

const { fail } = require('./http');

function isVerified(user) {
  return !!user && (user.role === 'admin' || user.verify_status === 'verified');
}

function requireVerified(ctx, action = '进行交易') {
  if (isVerified(ctx.user)) return true;
  fail(ctx.res, 403, `请先完成实名认证与高校认证后再${action}`);
  return false;
}

module.exports = { isVerified, requireVerified };
