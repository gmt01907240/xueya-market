'use strict';

/**
 * 轻量级运行指标（单进程内存计数）
 *
 * 供 /api/metrics 与外部探针读取：请求量、状态码分布、内存占用与数据库体积。
 * 不采集任何用户身份信息；多实例部署时应由外部监控聚合。
 */

const fs = require('node:fs');
const { DB_FILE } = require('./paths');

const startedAt = Date.now();
const counters = {
  total: 0,
  byStatus: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }
};

function recordRequest(statusCode) {
  counters.total += 1;
  const bucket = `${Math.floor(Number(statusCode) / 100)}xx`;
  if (counters.byStatus[bucket] !== undefined) counters.byStatus[bucket] += 1;
}

function snapshot() {
  const mem = process.memoryUsage();
  let dbSize = 0;
  try {
    dbSize = fs.statSync(DB_FILE).size;
  } catch {
    dbSize = 0;
  }
  return {
    service: 'xueya-market',
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: new Date(startedAt).toISOString(),
    requests: {
      total: counters.total,
      byStatus: { ...counters.byStatus },
      serverErrors: counters.byStatus['5xx']
    },
    memory: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
    database: { sizeBytes: dbSize }
  };
}

module.exports = { recordRequest, snapshot };
