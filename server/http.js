'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { PUBLIC_DIR } = require('./paths');

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt']);

function acceptsGzip(req) {
  return /\bgzip\b/i.test((req && req.headers['accept-encoding']) || '');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function sendJson(res, status, payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  const useGzip = raw.length > 1024 && acceptsGzip(res.req);
  const body = useGzip ? zlib.gzipSync(raw) : raw;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length
  };
  if (useGzip) {
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  res.writeHead(status, headers);
  res.end(body);
}

function fail(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求内容过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      req.rawBody = raw;
      if (!raw) return resolve({});
      const type = String(req.headers['content-type'] || '').toLowerCase();
      // 支付渠道回调既有 JSON（微信 APIv3）也有表单（支付宝、银联），统一保留原始报文
      if (type.includes('application/x-www-form-urlencoded')) {
        const params = {};
        for (const [key, value] of new URLSearchParams(raw).entries()) params[key] = value;
        return resolve(params);
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('请求格式错误'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function parseQuery(url) {
  const query = {};
  for (const [key, value] of url.searchParams.entries()) {
    query[key] = value;
  }
  return query;
}

/* 静态资源压缩缓存：key 为文件路径，命中时直接复用 gzip 结果，避免每次请求重复压缩 */
const STATIC_CACHE_MAX_BYTES = 512 * 1024;
const staticCache = new Map();

function etagOf(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

function isNotModified(req, etag) {
  const header = req.headers['if-none-match'];
  if (!header) return false;
  return header.split(',').some((item) => item.trim() === etag);
}

function sendGzip(res, headers, body) {
  res.writeHead(200, {
    ...headers,
    'Content-Encoding': 'gzip',
    Vary: 'Accept-Encoding',
    'Content-Length': body.length
  });
  res.end(body);
}

function sendFile(req, res, filePath, stat) {
  const ext = path.extname(filePath).toLowerCase();
  const etag = etagOf(stat);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag
  };

  if (isNotModified(req, etag)) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }

  const gzipWanted = stat.size > 1024 && COMPRESSIBLE.has(ext) && acceptsGzip(req);
  if (!gzipWanted) {
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    return fs.createReadStream(filePath).pipe(res);
  }

  const cached = staticCache.get(filePath);
  if (cached && cached.etag === etag) return sendGzip(res, headers, cached.body);

  fs.readFile(filePath, (err, buf) => {
    if (err) return fail(res, 500, '资源读取失败');
    zlib.gzip(buf, (zerr, body) => {
      if (zerr) return fail(res, 500, '资源压缩失败');
      if (buf.length <= STATIC_CACHE_MAX_BYTES) {
        if (staticCache.size > 200) staticCache.clear();
        staticCache.set(filePath, { etag, body });
      }
      sendGzip(res, headers, body);
    });
  });
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return fail(res, 400, '请求地址无效');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, rel);
  const normalized = path.normalize(filePath);
  const rootIndex = path.join(PUBLIC_DIR, 'index.html');
  if (!normalized.startsWith(PUBLIC_DIR + path.sep) && normalized !== rootIndex) {
    return fail(res, 403, '禁止访问');
  }
  fs.stat(normalized, (err, stat) => {
    if (!err && stat.isFile()) return sendFile(req, res, normalized, stat);
    // 前端为 hash 路由，未知路径回落到首页
    if (!path.extname(rel)) {
      fs.stat(rootIndex, (e, indexStat) => {
        if (e || !indexStat.isFile()) return fail(res, 404, '页面不存在');
        sendFile(req, res, rootIndex, indexStat);
      });
      return;
    }
    fail(res, 404, '资源不存在');
  });
}

module.exports = { sendJson, fail, readBody, parseQuery, serveStatic };
