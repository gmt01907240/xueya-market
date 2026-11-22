'use strict';

const settlements = require('./settlements');
const { sendJson } = require('./http');

function seller(ctx) {
  sendJson(ctx.res, 200, settlements.sellerList(ctx.user.id));
}

function admin(ctx) {
  const status = String(ctx.query.status || '');
  sendJson(ctx.res, 200, settlements.adminList(status));
}

module.exports = { seller, admin };
