#!/usr/bin/env node
/**
 * SQLite 热备份
 *
 * 使用 VACUUM INTO 生成一致性快照，可在服务运行中执行，不阻塞读写。
 * 同时备份 Token 签名密钥 secret.key，并保留最近 N 份快照。
 *
 * 用法：
 *   npm run backup
 *   DATA_DIR=/path/to/data BACKUP_DIR=/path/to/backups BACKUP_KEEP=14 node scripts/backup.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'xueya.db');
const BACKUP_DIR = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(DATA_DIR, 'backups');
const KEEP = Number(process.env.BACKUP_KEEP) > 0 ? Number(process.env.BACKUP_KEEP) : 14;

if (!fs.existsSync(DB_FILE)) {
  console.error(`数据库不存在：${DB_FILE}`);
  process.exit(1);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });

const pad = (n) => String(n).padStart(2, '0');
const d = new Date();
const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const base = `xueya-${stamp}`;
const target = path.join(BACKUP_DIR, `${base}.db`);

const db = new DatabaseSync(DB_FILE);
try {
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const secret = path.join(DATA_DIR, 'secret.key');
if (fs.existsSync(secret)) {
  fs.copyFileSync(secret, path.join(BACKUP_DIR, `${base}.secret.key`));
}

const snapshots = fs.readdirSync(BACKUP_DIR)
  .filter((name) => /^xueya-\d{8}-\d{6}\.db$/.test(name))
  .sort();
while (snapshots.length > KEEP) {
  const old = snapshots.shift();
  const stampOf = old.replace(/\.db$/, '');
  for (const suffix of ['.db', '.secret.key']) {
    const file = path.join(BACKUP_DIR, `${stampOf}${suffix}`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

const size = fs.statSync(target).size;
console.log(`备份完成：${target}（${(size / 1024).toFixed(1)} KB），保留最近 ${KEEP} 份`);
console.log('提示：上传文件目录 data/uploads 请通过对象存储或卷快照单独备份。');
