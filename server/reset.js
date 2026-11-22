'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DB_FILE, UPLOAD_DIR, DATA_DIR } = require('./paths');

for (const suffix of ['', '-wal', '-shm']) {
  const file = DB_FILE + suffix;
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
if (fs.existsSync(UPLOAD_DIR)) {
  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    fs.unlinkSync(path.join(UPLOAD_DIR, name));
  }
}
const secret = path.join(DATA_DIR, 'secret.key');
if (fs.existsSync(secret)) fs.unlinkSync(secret);

console.log('已清空数据库与上传文件，重新启动服务将自动初始化演示数据。');
