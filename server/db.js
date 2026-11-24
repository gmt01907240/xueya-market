'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { DB_FILE, UPLOAD_DIR } = require('./paths');
const { hashPassword, verifyPassword } = require('./auth');
const adminSecurity = require('./admin-security');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
// 并发写入时等待锁而不是立即失败，避免高频接口出现 SQLITE_BUSY
db.exec('PRAGMA busy_timeout = 5000;');

// 空闲时定期截断 WAL，防止长期运行后 WAL 文件持续增长
setInterval(() => {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* 写入繁忙时跳过 */ }
}, 30 * 60 * 1000).unref();

const statements = new Map();
function prepare(sql) {
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    // 防止动态 SQL 过多导致缓存无限增长；达到阈值后整体重建
    if (statements.size >= 500) statements.clear();
    statements.set(sql, stmt);
  }
  return stmt;
}

function all(sql, ...params) {
  return prepare(sql).all(...params);
}
function get(sql, ...params) {
  return prepare(sql).get(...params);
}
function run(sql, ...params) {
  return prepare(sql).run(...params);
}
let txDepth = 0;
function tx(fn) {
  // 嵌套调用复用外层事务，避免 BEGIN 嵌套报错导致账本与业务写入不一致
  if (txDepth > 0) {
    txDepth += 1;
    try {
      return fn();
    } finally {
      txDepth -= 1;
    }
  }
  db.exec('BEGIN');
  txDepth = 1;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth = 0;
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}
function stamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function daysAgo(days, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, (days * 17) % 60, (days * 31) % 60, 0);
  return stamp(d);
}
const now = () => stamp(new Date());

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  nickname TEXT NOT NULL,
  school TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  balance_cents INTEGER NOT NULL DEFAULT 0,
  real_name TEXT NOT NULL DEFAULT '',
  student_no TEXT NOT NULL DEFAULT '',
  verify_status TEXT NOT NULL DEFAULT 'none',
  verify_note TEXT NOT NULL DEFAULT '',
  verified_at TEXT,
  phone TEXT NOT NULL DEFAULT '',
  last_login_at TEXT,
  last_login_ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_password_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_pwd_history ON admin_password_history(admin_id, id);
CREATE TABLE IF NOT EXISTS admin_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  ua TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  ip_prefix TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE(admin_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS admin_security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  type TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sec_events ON admin_security_events(admin_id, id);
CREATE TABLE IF NOT EXISTS admin_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'warning',
  message TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_alerts_state ON admin_alerts(acknowledged, id);
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  admin_name TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON admin_audit_logs(admin_id, id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at);
CREATE TABLE IF NOT EXISTS sms_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_phone ON sms_codes(phone, purpose, created_at);
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  school TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  teacher TEXT NOT NULL DEFAULT '',
  course TEXT NOT NULL DEFAULT '',
  preview_text TEXT NOT NULL DEFAULT '',
  preview_ratio INTEGER NOT NULL DEFAULT 15,
  price_source TEXT NOT NULL DEFAULT 'seller',
  price_note TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  file_name TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL DEFAULT '',
  file_size INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT NOT NULL DEFAULT '',
  audit_verdict TEXT NOT NULL DEFAULT '',
  audit_score INTEGER NOT NULL DEFAULT 0,
  audit_hits TEXT NOT NULL DEFAULT '',
  audit_status TEXT NOT NULL DEFAULT '',
  audit_at TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0,
  rating_avg REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (seller_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL,
  buyer_id INTEGER NOT NULL,
  seller_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  commission_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL,
  FOREIGN KEY (material_id) REFERENCES materials(id)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL,
  order_id INTEGER UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, material_id)
);
CREATE TABLE IF NOT EXISTS wants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  school TEXT NOT NULL DEFAULT '',
  budget_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a INTEGER NOT NULL,
  user_b INTEGER NOT NULL,
  material_id INTEGER,
  want_id INTEGER,
  scene TEXT NOT NULL DEFAULT '',
  last_message_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_migrations (
  source TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source, source_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL,
  reporter_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT '公告',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS price_standards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school TEXT NOT NULL DEFAULT '*',
  subject TEXT NOT NULL DEFAULT '*',
  category TEXT NOT NULL,
  base_price_cents INTEGER NOT NULL,
  min_price_cents INTEGER NOT NULL,
  max_price_cents INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'official',
  ticket_type TEXT NOT NULL DEFAULT 'other',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  material_id INTEGER,
  target_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  user_unread INTEGER NOT NULL DEFAULT 0,
  staff_unread INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'review',
  weight INTEGER NOT NULL DEFAULT 10,
  match_type TEXT NOT NULL DEFAULT 'keyword',
  pattern TEXT NOT NULL,
  tip TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'builtin',
  active INTEGER NOT NULL DEFAULT 1,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL DEFAULT 'material',
  target_id INTEGER,
  user_id INTEGER,
  action TEXT NOT NULL DEFAULT 'submit',
  verdict TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  hits TEXT NOT NULL DEFAULT '[]',
  digest TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'auto_pass',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_no TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  order_id INTEGER,
  purpose TEXT NOT NULL DEFAULT 'order',
  channel TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  channel_trade_no TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT,
  paid_at TEXT,
  failure_code TEXT NOT NULL DEFAULT '',
  failure_message TEXT NOT NULL DEFAULT '',
  last_notify_nonce TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE,
  seller_id INTEGER NOT NULL,
  buyer_id INTEGER NOT NULL,
  order_amount_cents INTEGER NOT NULL,
  commission_cents INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  settle_due TEXT NOT NULL,
  settled_at TEXT,
  cancelled_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_channel ON payments(channel, status);
CREATE INDEX IF NOT EXISTS idx_materials_status ON materials(status);
CREATE INDEX IF NOT EXISTS idx_materials_seller ON materials(seller_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_material_buyer ON orders(material_id, buyer_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_material ON reviews(material_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_settlements_seller ON settlements(seller_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements(status, settle_due);
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  owner_type TEXT NOT NULL DEFAULT 'platform',
  owner_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_no TEXT NOT NULL UNIQUE,
  biz_type TEXT NOT NULL,
  biz_id TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (txn_id) REFERENCES ledger_transactions(id),
  FOREIGN KEY (account_id) REFERENCES ledger_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_txn ON ledger_entries(txn_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account_id, id);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL DEFAULT '',
  status_code INTEGER NOT NULL DEFAULT 0,
  response_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE TABLE IF NOT EXISTS recon_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL DEFAULT 'all',
  bill_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  channel_count INTEGER NOT NULL DEFAULT 0,
  channel_amount INTEGER NOT NULL DEFAULT 0,
  platform_count INTEGER NOT NULL DEFAULT 0,
  platform_amount INTEGER NOT NULL DEFAULT 0,
  diff_count INTEGER NOT NULL DEFAULT 0,
  diff_amount INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recon_batches_date ON recon_batches(bill_date, channel);
CREATE TABLE IF NOT EXISTS recon_diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  diff_type TEXT NOT NULL,
  payment_no TEXT NOT NULL DEFAULT '',
  channel_trade_no TEXT NOT NULL DEFAULT '',
  platform_amount INTEGER NOT NULL DEFAULT 0,
  channel_amount INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES recon_batches(id)
);
CREATE INDEX IF NOT EXISTS idx_recon_diffs_batch ON recon_diffs(batch_id, id);
CREATE TABLE IF NOT EXISTS channel_bill_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  bill_date TEXT NOT NULL,
  payment_no TEXT NOT NULL DEFAULT '',
  channel_trade_no TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'SUCCESS',
  fee_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES recon_batches(id)
);
CREATE INDEX IF NOT EXISTS idx_channel_bill_items_batch ON channel_bill_items(batch_id);
CREATE TABLE IF NOT EXISTS study_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  goal TEXT NOT NULL,
  goal_name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  school TEXT NOT NULL DEFAULT '',
  days INTEGER NOT NULL,
  daily_minutes INTEGER NOT NULL,
  coverage INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_study_plans_user ON study_plans(user_id, created_at);
CREATE TABLE IF NOT EXISTS study_plan_checks (
  plan_id INTEGER NOT NULL,
  task_key TEXT NOT NULL,
  done_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, task_key),
  FOREIGN KEY (plan_id) REFERENCES study_plans(id)
);
CREATE TABLE IF NOT EXISTS invite_usage (
  code TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_standards_key ON price_standards(school, subject, category);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_target ON tickets(target_user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_replies ON ticket_replies(ticket_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_verdict ON audit_logs(verdict, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_rules_active ON audit_rules(active, category);
CREATE TABLE IF NOT EXISTS bargain_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL,
  start_price_cents INTEGER NOT NULL,
  floor_price_cents INTEGER NOT NULL,
  duration_hours INTEGER NOT NULL DEFAULT 48,
  max_cuts_per_user INTEGER NOT NULL DEFAULT 1,
  max_helpers INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'active',
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (material_id) REFERENCES materials(id)
);
CREATE TABLE IF NOT EXISTS bargain_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  start_price_cents INTEGER NOT NULL,
  current_price_cents INTEGER NOT NULL,
  floor_price_cents INTEGER NOT NULL,
  max_cuts_per_user INTEGER NOT NULL,
  max_helpers INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT NOT NULL,
  order_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (activity_id) REFERENCES bargain_activities(id),
  FOREIGN KEY (material_id) REFERENCES materials(id)
);
CREATE TABLE IF NOT EXISTS bargain_assists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  helper_id INTEGER NOT NULL,
  cut_cents INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES bargain_orders(id),
  FOREIGN KEY (helper_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bargain_assists_idem ON bargain_assists(order_id, helper_id, request_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bargain_assists_seq ON bargain_assists(order_id, helper_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bargain_orders_active ON bargain_orders(activity_id, user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_bargain_orders_user ON bargain_orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bargain_orders_status ON bargain_orders(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_bargain_activities_material ON bargain_activities(material_id, status);
CREATE TABLE IF NOT EXISTS bargain_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  supervisor TEXT NOT NULL DEFAULT '',
  province TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  degree_level TEXT NOT NULL DEFAULT '',
  school_type TEXT NOT NULL DEFAULT '',
  ownership TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS majors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category_code TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  class_code TEXT NOT NULL DEFAULT '',
  class_name TEXT NOT NULL DEFAULT '',
  degree_note TEXT NOT NULL DEFAULT '',
  is_special INTEGER NOT NULL DEFAULT 0,
  is_controlled INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_majors_name ON majors(name);
CREATE INDEX IF NOT EXISTS idx_majors_category ON majors(category_code, class_code);
CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  school TEXT NOT NULL,
  subject TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(name, school, subject)
);
CREATE INDEX IF NOT EXISTS idx_schools_province ON schools(province);
CREATE INDEX IF NOT EXISTS idx_schools_name ON schools(name);
CREATE INDEX IF NOT EXISTS idx_subjects_category ON subjects(category);
CREATE INDEX IF NOT EXISTS idx_teachers_school ON teachers(school);
CREATE INDEX IF NOT EXISTS idx_teachers_subject ON teachers(subject);
CREATE INDEX IF NOT EXISTS idx_teachers_name ON teachers(name);
/* 业务热点查询索引：列表筛选、订单归属、会话消息与未读统计 */
CREATE INDEX IF NOT EXISTS idx_materials_status ON materials(status, created_at);
CREATE INDEX IF NOT EXISTS idx_materials_seller ON materials(seller_id);
CREATE INDEX IF NOT EXISTS idx_materials_school ON materials(school);
CREATE INDEX IF NOT EXISTS idx_materials_subject ON materials(subject);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_material ON orders(material_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(thread_id, read_at);
CREATE INDEX IF NOT EXISTS idx_threads_a ON threads(user_a, last_message_at);
CREATE INDEX IF NOT EXISTS idx_threads_b ON threads(user_b, last_message_at);
CREATE INDEX IF NOT EXISTS idx_wants_status ON wants(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ticket_replies_ticket ON ticket_replies(ticket_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_price_standards_scope ON price_standards(school, subject, category);
CREATE INDEX IF NOT EXISTS idx_favorites_material ON favorites(material_id);
CREATE INDEX IF NOT EXISTS idx_reviews_material ON reviews(material_id);
`;

const {
  SUBJECTS: SUBJECT_PROFILES,
  TEACHERS: TEACHER_PROFILES,
  SUBJECT_NAMES: SUBJECTS
} = require('./catalog-data');
const { sortNames } = require('./name-sort');

// 教育部官方名单与专业目录（由 build_catalog.py 依据官方 xls / pdf 解析生成）
const DATA_DIR = path.join(__dirname, 'data');
const SCHOOL_PROFILES = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'schools-official.json'), 'utf8'));
const MAJOR_PROFILES = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'majors-official.json'), 'utf8'));
const CATALOG_MANIFEST = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog-manifest.json'), 'utf8'));

const MAJOR_SOURCE = '教育部《普通高等学校本科专业目录（2026年）》';
const SCHOOLS = sortNames(SCHOOL_PROFILES.map((s) => s.name));
const MAJORS = sortNames(MAJOR_PROFILES.map((m) => m.name));
const CATEGORIES = ['考研资料', '期末真题', '课堂笔记', '课件讲义', '电子教材', '竞赛考证', '论文范文', '语言学习'];
const COURSE_META = {
  高等数学: ['数学', '陈立群'],
  线性代数: ['数学', '陈立群'],
  概率论: ['数学', '周慧敏'],
  数学建模: ['数学', '刘振华'],
  数据结构: ['计算机科学与技术', '王海涛'],
  C语言: ['计算机科学与技术', '王海涛'],
  计算机网络: ['计算机科学与技术', '李国强'],
  算法竞赛: ['计算机科学与技术', '张一鸣'],
  Java: ['计算机科学与技术', '李国强'],
  宏观经济学: ['经济学', '沈清源'],
  微观经济学: ['经济学', '沈清源'],
  财务管理: ['管理学', '赵敏'],
  毕业论文: ['管理学', '孙博'],
  大学物理: ['物理学', '吴天成'],
  数字电路: ['电子信息工程', '郑宇'],
  自动控制原理: ['自动化', '胡远'],
  雅思: ['外国语言文学', 'Emily Chen'],
  考研英语: ['外国语言文学', '许静'],
  普通心理学: ['心理学', '林安'],
  近现代史: ['历史学', '马文'],
  有机化学: ['化学', '何晶'],
  社会学: ['社会学', '梁思']
};

function seedUser(username, email, password, nickname, school, bio, role, balanceCents, createdDays) {
  const { hash, salt } = hashPassword(password);
  const info = run(
    `INSERT INTO users (username, email, password_hash, salt, nickname, school, bio, role, status, balance_cents, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    username, email, hash, salt, nickname, school, bio, role, balanceCents, daysAgo(createdDays)
  );
  return Number(info.lastInsertRowid);
}

// 演示模式下的体验账号：个人用户角色，与普通用户共享同一登录流程与买卖权限
const EXPERIENCE_DEMO = {
  username: 'judge',
  email: 'judge@xueya.cn',
  password: 'Judge123456',
  nickname: '体验账号',
  school: '学涯集市',
  bio: '演示体验账号，可浏览、购买、下载与上传资料，完整使用买家与卖家功能。'
};

function ensureExperienceUser() {
  const exists = get('SELECT id FROM users WHERE email = ?', EXPERIENCE_DEMO.email);
  if (exists) {
    run(
      `UPDATE users SET nickname = ?, bio = ?, role = 'user' WHERE id = ?`,
      EXPERIENCE_DEMO.nickname, EXPERIENCE_DEMO.bio, exists.id
    );
    return exists.id;
  }
  const id = seedUser(EXPERIENCE_DEMO.username, EXPERIENCE_DEMO.email, EXPERIENCE_DEMO.password, EXPERIENCE_DEMO.nickname, EXPERIENCE_DEMO.school, EXPERIENCE_DEMO.bio, 'user', 0, 0);
  run(
    `UPDATE users SET real_name = ?, student_no = ?, verify_status = 'verified', verify_note = '', verified_at = ? WHERE id = ?`,
    EXPERIENCE_DEMO.nickname, 'DEMO0001', now(), id
  );
  return id;
}

const PREVIEW_TEMPLATES = {
  考研资料: [
    '考试大纲与命题趋势：近五年真题的题型分布、分值结构与难度变化，帮助你判断复习重心。',
    '核心考点精讲：按章节拆解高频考点，标注「必背」「理解」「了解」三个掌握层级。',
    '真题分类精练：按题型重排历年真题，每题附考点定位、完整解题步骤与易错提醒。',
    '冲刺提分策略：汇总常见失分原因，给出可执行的周计划与考前复盘清单。'
  ],
  期末真题: [
    '考试范围与题型说明：对照教学大纲梳理本次期末的章节权重与常见题型。',
    '真题分类汇编：按知识点重排近年期末试题，保留原题分值并补充评分点。',
    '标准答案与步骤：主观题给出完整推导，客观题标注陷阱选项与判断依据。',
    '考前速通清单：用一页纸串起必考公式、定理与典型例题的解题模板。'
  ],
  课堂笔记: [
    '课程框架：按教材章节整理知识地图，标出老师课上反复强调的重点。',
    '课堂补充：保留老师口述的案例、扩展阅读与考试提示，便于还原课堂语境。',
    '概念对照：核心术语附中英文对照与一句话解释，方便简答与论述题作答。',
    '复习自测：每章末尾设置自测问题，帮助检查理解程度而不是死记硬背。'
  ],
  课件讲义: [
    '章节结构：与授课进度一致地整理课件要点，补充板书中的推导与例题。',
    '重点标注：对考试涉及的定义、定理和模型进行高亮，并说明适用条件。',
    '例题拆解：选取典型例题展示解题路径，标注每一步的依据与易错点。',
    '课后练习：附配套练习与参考答案，方便在复习时进行针对性训练。'
  ],
  电子教材: [
    '内容概览：说明教材版本、章节范围与适用课程，便于判断是否符合你的教学安排。',
    '知识点索引：按章节列出核心概念与公式，方便快速检索与对照教材。',
    '习题与解答：精选课后习题并给出完整解答，重点题附另一种思路。',
    '使用建议：说明如何配合课堂进度使用，以及打印、批注的排版建议。'
  ],
  竞赛考证: [
    '赛制与考纲：梳理竞赛/证书的题型、评分方式与近年命题趋势。',
    '知识模块：按专题拆解必备知识点，标注基础、进阶与冲刺三个层次。',
    '真题精讲：逐题分析解题思路、复杂度与边界情况，附参考代码或答题框架。',
    '备赛计划：给出可执行的训练节奏与模拟安排，帮助稳定发挥。'
  ],
  论文范文: [
    '选题与结构：展示研究问题如何收敛，以及摘要、引言、文献综述的写作结构。',
    '论证与数据：说明研究方法、数据来源与分析过程，附图表呈现建议。',
    '常见问题：整理导师常问的问题与修改方向，帮助提前规避结构性缺陷。',
    '写作清单：提供提交前的格式、引用与查重自检清单。'
  ],
  语言学习: [
    '题型与评分：说明考试各部分的题型、时间分配与评分标准。',
    '高频素材：按话题整理常用表达、同义替换与连接词，附使用场景说明。',
    '示范答案：提供完整示范并标注可替换的句型，避免模板痕迹过重。',
    '练习建议：给出每日训练量与复盘方法，帮助把输入转化为输出。'
  ]
};

function courseMeta(course) {
  return COURSE_META[course] || ['其他', '待补充'];
}

function buildPreview(m, subject, teacher) {
  const outline = PREVIEW_TEMPLATES[m.category] || PREVIEW_TEMPLATES['课堂笔记'];
  return [
    `《${m.title}》`,
    `${m.school || '通用'} ｜ 学科：${subject} ｜ 授课老师：${teacher} ｜ 类型：${m.category}`,
    '',
    m.desc.split('\n')[0],
    '',
    '目录与内容节选',
    ...outline.map((line, i) => `${i + 1}. ${line}`),
    '',
    `本资料按课程章节整理，含例题、答案与复习提示。购买后可查看完整内容与全部附件。`,
    '—— 以上为试读节选（约前 15%），完整内容需购买后查看 ——'
  ].join('\n');
}

function seedMaterial(sellerId, m, idx) {
  const fileName = `${m.title}.${m.ext || 'pdf'}`;
  const safe = fileName.replace(/[\\/:*?"<>|]/g, '_');
  const stored = `seed-${idx}-${safe}`;
  const filePath = path.join(UPLOAD_DIR, stored);
  const body = [
    '学涯集市 · 演示资料文件',
    '=============================',
    '',
    `资料名称：${m.title}`,
    `所属院校：${m.school}`,
    `相关课程：${m.course}`,
    `资料分类：${m.category}`,
    '',
    '说明：这是平台内置的演示文件，用于验证购买、下载与版权保护流程。',
    '正式使用时，卖家上传的原始文件会存放在服务端，购买后凭订单下载。',
    '',
    `生成时间：${new Date().toLocaleString('zh-CN')}`
  ].join('\n');
  fs.writeFileSync(filePath, body, 'utf8');
  const size = Buffer.byteLength(body);
  const createdAt = daysAgo(m.days || 3, 9 + (idx % 8));
  const [defaultSubject, defaultTeacher] = courseMeta(m.course);
  const subject = m.subject || defaultSubject;
  const teacher = m.teacher || defaultTeacher;
  const preview = buildPreview(m, subject, teacher);
  const info = run(
    `INSERT INTO materials (seller_id, title, description, category, school, subject, teacher, course, preview_text, preview_ratio, price_source, price_note, price_cents, file_name, file_path, file_size, tags, status, reject_reason, views, downloads, rating_avg, rating_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 15, 'seller', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    sellerId, m.title, m.desc, m.category, m.school, subject, teacher, m.course, preview, Math.round(m.price * 100),
    fileName, stored, size, (m.tags || []).join(','), m.status || 'approved', m.reason || '',
    m.views || 0, m.downloads || 0, createdAt, createdAt
  );
  return Number(info.lastInsertRowid);
}

function seed() {
  const userIds = {};
  userIds.admin = seedUser('admin', 'admin@xueya.cn', adminSecurity.ADMIN_PASSWORD, '平台管理员', '学涯集市', '负责资料审核、用户治理与平台运营。', 'admin', 0, 120);
  userIds.lin = seedUser('linzhiyao', 'seller@xueya.cn', 'Seller123456', '林知遥', '浙江大学', '计算机科学与技术 2022 级，考研数学 142 分，整理控。', 'user', 186050, 96);
  userIds.chen = seedUser('chenyan', 'student@xueya.cn', 'Student123456', '陈砚', '武汉大学', '新闻传播学 2023 级，正在准备雅思与考研。', 'user', 0, 80);
  userIds.su = seedUser('suwan', 'suwan@xueya.cn', 'Seller123456', '苏晚', '复旦大学', '金融学 2021 级，喜欢把课堂内容整理成可复习的知识卡片。', 'user', 86400, 88);
  userIds.zhou = seedUser('zhouyu', 'zhouyu@xueya.cn', 'Seller123456', '周屿', '上海交通大学', '电子信息工程 2022 级，实验报告和电路题整理爱好者。', 'user', 43200, 70);
  userIds.xu = seedUser('xuyiming', 'xuyiming@xueya.cn', 'Seller123456', '许一鸣', '清华大学', '自动化系，保研党，擅长把课件压缩成考点。', 'user', 121400, 76);
  userIds.he = seedUser('heyue', 'heyue@xueya.cn', 'Student123456', '何悦', '南京大学', '化学专业，期末周靠整理笔记续命。', 'user', 0, 52);
  userIds.guo = seedUser('guojing', 'guojing@xueya.cn', 'Student123456', '郭静', '四川大学', '汉语言文学，正在准备教师资格证。', 'user', 0, 44);
  userIds.wang = seedUser('wangyi', 'wangyi@xueya.cn', 'Student123456', '王奕', '华中科技大学', '软件工程，秋招准备中。', 'user', 0, 33);
  userIds.liu = seedUser('liuxin', 'liuxin@xueya.cn', 'Student123456', '刘欣', '中山大学', '社会学专业，爱做访谈与田野笔记。', 'user', 0, 21);

  // 实名与高校认证（除刘欣待审核外，其余演示账号均已认证）
  const VERIFY_INFO = {
    admin: ['平台运营部', '0000000000'],
    lin: ['林知遥', '2022031101'],
    chen: ['陈砚', '2023041208'],
    su: ['苏晚', '2021010833'],
    zhou: ['周屿', '2022060547'],
    xu: ['许一鸣', '2020010219'],
    he: ['何悦', '2023090712'],
    guo: ['郭静', '2022100345'],
    wang: ['王奕', '2022071126'],
    liu: ['刘欣', '2023050604']
  };
  for (const [key, uid] of Object.entries(userIds)) {
    const [realName, studentNo] = VERIFY_INFO[key];
    const status = key === 'liu' ? 'pending' : 'verified';
    run(
      `UPDATE users SET real_name = ?, student_no = ?, verify_status = ?, verify_note = ?, verified_at = ? WHERE id = ?`,
      realName, studentNo, status, '', status === 'verified' ? daysAgo(60, 10) : null, uid
    );
  }

  // 管理员安全初始化：强密码、改密时间、密码历史；MFA secret 仅在显式配置时注入，否则首次登录绑定
  const adminRow = get('SELECT password_hash, salt FROM users WHERE id = ?', userIds.admin);
  const mfaSecret = String(process.env.ADMIN_MFA_SECRET || '').trim();
  run(
    `UPDATE users SET admin_password_changed_at = ?, admin_mfa_secret = ?, admin_mfa_enabled_at = ?, token_version = 0
     WHERE id = ?`,
    now(), mfaSecret, mfaSecret ? now() : null, userIds.admin
  );
  if (adminRow) {
    run(
      'INSERT INTO admin_password_history (admin_id, password_hash, salt, created_at) VALUES (?, ?, ?, ?)',
      userIds.admin, adminRow.password_hash, adminRow.salt, now()
    );
  }

  const M = [
    { seller: 'lin', title: '2024 考研数学一 真题全解（2010-2024）', category: '考研资料', school: '浙江大学', course: '高等数学', price: 29.9, tags: ['考研数学', '真题', '逐题解析'], views: 4320, downloads: 1286, days: 26,
      desc: '覆盖 2010—2024 年考研数学一全部真题，按高数、线代、概率三大板块重新编排。每题附「考点定位 + 解题路径 + 易错提醒」，大题给出完整步骤而不是跳步答案。\n适合 2025/2026 考研、希望系统刷真题的同学，也可以作为期末复习的高阶练习。\n附赠一份 12 页的公式速查表，打印后可直接夹在错题本里。' },
    { seller: 'lin', title: '数据结构期末复习提纲（含近五年真题答案）', category: '期末真题', school: '浙江大学', course: '数据结构', price: 19.9, tags: ['数据结构', '期末', '408'], views: 3110, downloads: 842, days: 24,
      desc: '面向期末与 408 双场景整理：线性表、树、图、查找、排序五大模块的知识树 + 复杂度对照表。\n收录本校近五年期末真题，并标注每题的得分点与常见扣分原因，最后两页是「一晚速通」清单。\n代码部分统一使用 C 语言伪代码，和大多数教材保持一致。' },
    { seller: 'su', title: '宏观经济学课堂笔记（曼昆版 · 全学期）', category: '课堂笔记', school: '复旦大学', course: '宏观经济学', price: 15.9, tags: ['曼昆', '宏观', '课堂笔记'], views: 2260, downloads: 517, days: 21,
      desc: '按曼昆《宏观经济学》章节顺序整理，包含课堂补充案例、老师强调的模型推导和考试重点标记。\n每个模型都配了一张手绘风格的逻辑图，适合考前快速回忆 IS-LM、AD-AS 等框架。\n笔记为个人理解版本，建议搭配教材使用。' },
    { seller: 'zhou', title: '大学物理实验报告模板 + 数据处理脚本', category: '课件讲义', school: '上海交通大学', course: '大学物理', price: 9.9, tags: ['大物实验', '报告模板', '数据处理'], views: 1980, downloads: 693, days: 19,
      desc: '包含 8 个常见大物实验的报告模板：示波器、杨氏模量、霍尔效应、分光计等。\n附 Python 数据处理脚本，可一键完成最小二乘拟合与误差分析，并自动生成图表。\n模板只提供结构与表达参考，请务必填写自己的实验数据。' },
    { seller: 'xu', title: '自动控制原理 课件合集（胡寿松版）', category: '课件讲义', school: '清华大学', course: '自动控制原理', price: 12.9, tags: ['自控', '课件', '胡寿松'], views: 2640, downloads: 731, days: 18,
      desc: '整理自课程讲义与课堂板书，覆盖系统建模、时域分析、根轨迹、频域分析与校正装置。\n每章末尾附「考点清单」和两道典型例题，根轨迹部分补充了手绘规则速记。\n课件为 PDF 版本，适合打印或平板批注。' },
    { seller: 'chen', title: '雅思口语 Part 2 高频题库与示范（2024 版）', category: '语言学习', school: '武汉大学', course: '雅思', price: 24.9, tags: ['雅思', '口语', 'Part2'], views: 1850, downloads: 402, days: 16,
      desc: '按人物、地点、物品、事件四大类整理 60 个高频话题，每题给出 2 分钟回答框架与关键词提示。\n附 12 篇完整示范答案，标注可替换的表达和连接词，避免背模板痕迹过重。\n适合目标 6.5—7.5 分的同学做考前冲刺。' },
    { seller: 'lin', title: '线性代数期末冲刺讲义（免费）', category: '期末真题', school: '南京大学', course: '线性代数', price: 0, tags: ['线代', '免费', '期末'], views: 5240, downloads: 2380, days: 15,
      desc: '把线代期末拆成 6 个必考题型：行列式计算、矩阵方程、向量组相关性、特征值、二次型、线性方程组解的结构。\n每个题型给出 3 道例题与 1 道自测题，答案在文末。\n免费分享，欢迎在评价区补充你的解法。' },
    { seller: 'wang', title: '计算机网络 408 笔记（思维导图版）', category: '考研资料', school: '华中科技大学', course: '计算机网络', price: 39.9, tags: ['408', '计算机网络', '思维导图'], views: 3020, downloads: 588, days: 14,
      desc: '以谢希仁教材为基础，结合 408 真题整理的层次化笔记，每一章配一张可打印的思维导图。\n重点标注了 TCP 拥塞控制、IP 分片、路由协议等高频考点的出题方式。\n附 2019—2024 年 408 网络部分真题分类索引。' },
    { seller: 'he', title: '概率论与数理统计 习题详解', category: '课堂笔记', school: '中山大学', course: '概率论', price: 14.9, tags: ['概率论', '习题', '期末'], views: 1420, downloads: 366, days: 13,
      desc: '覆盖随机事件、随机变量、数字特征、大数定律、参数估计与假设检验。\n每道题先给思路再给过程，重点题附另一种解法和直观解释，帮助理解而不是死记。\n适合期末复习和考研基础阶段。' },
    { seller: 'guo', title: '大学生数学建模竞赛 优秀论文合集', category: '竞赛考证', school: '四川大学', course: '数学建模', price: 34.9, tags: ['数学建模', '国赛', '论文'], views: 1760, downloads: 298, days: 12,
      desc: '精选近三年国赛与美赛优秀论文 10 篇，保留完整摘要、模型假设、求解过程与灵敏度分析。\n每篇附编辑点评，拆解「好论文」的写作结构、图表表达和结果讨论方式。\n适合第一次参赛、需要套路的队伍快速建立框架。' },
    { seller: 'su', title: '毕业论文开题报告范文（经管类）', category: '论文范文', school: '复旦大学', course: '毕业论文', price: 9.9, tags: ['开题报告', '经管', '范文'], views: 1620, downloads: 521, days: 11,
      desc: '提供 3 份经管类开题报告完整范文，覆盖研究背景、文献综述、研究问题、方法与进度安排。\n附导师常见提问清单与修改建议，帮你提前规避「题目太大」「方法不落地」等问题。\n范文仅作结构与表达参考，请独立完成自己的研究设计。' },
    { seller: 'lin', title: 'C 语言程序设计 上机真题 50 例', category: '期末真题', school: '浙江大学', course: 'C语言', price: 16.9, tags: ['C语言', '上机', '真题'], views: 2040, downloads: 634, days: 10,
      desc: '收录 50 道上机真题，涵盖数组、指针、结构体、文件操作与递归。\n每题提供可编译代码、边界测试用例和常见错误提示，适合考前在机房限时练习。\n按难度分为基础、进阶、挑战三档，可自行安排刷题节奏。' },
    { seller: 'xu', title: '普通心理学 期末重点整理（北大版）', category: '课堂笔记', school: '北京大学', course: '普通心理学', price: 11.9, tags: ['心理学', '期末', '重点'], views: 1280, downloads: 287, days: 9,
      desc: '按教材章节梳理感觉、知觉、记忆、思维、情绪、人格等核心概念，附中英文术语对照。\n整理了 18 位经典心理学家的核心观点与实验，方便应对简答题与论述题。\n最后附三套模拟卷及参考答案。' },
    { seller: 'chen', title: '中国近现代史纲要 考点速记', category: '期末真题', school: '武汉大学', course: '近现代史', price: 6.9, tags: ['史纲', '考点', '速记'], views: 2100, downloads: 706, days: 8,
      desc: '把史纲教材压缩成 24 页时间轴 + 考点卡片，重大事件按「背景—过程—意义」三段式整理。\n附选择题高频陷阱清单和材料题答题模板，适合考前三天突击。\n所有内容基于公开教材整理，不含本校内部试题。' },
    { seller: 'he', title: '有机化学 反应机理图解笔记', category: '课堂笔记', school: '南京大学', course: '有机化学', price: 18.9, tags: ['有机化学', '反应机理', '图解'], views: 1540, downloads: 342, days: 7,
      desc: '用箭头推动的方式手绘 40 个核心反应机理，包括亲核取代、消除、加成、芳香亲电取代等。\n每个机理标注电子转移方向、中间体稳定性和常见副反应，帮助建立统一的判断框架。\n适合期末复习与考研有机化学基础阶段。' },
    { seller: 'zhou', title: '微观经济学 英文教材习题答案（Varian）', category: '电子教材', school: '上海交通大学', course: '微观经济学', price: 22.9, tags: ['微观经济学', 'Varian', '英文'], views: 1120, downloads: 214, days: 6,
      desc: '对应 Varian《Intermediate Microeconomics》各章习题，提供英文解答与中文要点提示。\n重点章节补充了效用最大化、斯卢茨基方程、一般均衡的推导过程。\n适合双语授课班级和准备出国的同学。' },
    { seller: 'xu', title: '蓝桥杯 算法竞赛真题与题解（C++/Java）', category: '竞赛考证', school: '清华大学', course: '算法竞赛', price: 26.9, tags: ['蓝桥杯', '算法', 'C++'], views: 2380, downloads: 476, days: 5,
      desc: '覆盖近五届蓝桥杯省赛与国赛真题，按暴力、搜索、动态规划、图论、数论分类讲解。\n每道题给出 C++ 与 Java 两份参考代码，并分析时间复杂度和易错边界。\n附一份 30 天备赛计划表。' },
    { seller: 'guo', title: '考研英语 作文模板（大小作文全题型）', category: '考研资料', school: '四川大学', course: '考研英语', price: 19.9, tags: ['考研英语', '作文', '模板'], views: 2890, downloads: 812, days: 4,
      desc: '大作文按图画、图表、现象三类给出可拼接的段落框架，小作文覆盖书信、通知、备忘录。\n提供 20 组高分替换表达和 5 篇完整范文，强调「模板骨架 + 自己的句子」。\n适合冲刺阶段快速稳定作文分数。' },
    { seller: 'wang', title: 'Java 后端开发 面试八股整理', category: '竞赛考证', school: '华中科技大学', course: 'Java', price: 28.9, tags: ['Java', '面试', '八股'], views: 3260, downloads: 592, days: 3,
      desc: '按 JVM、集合、并发、MySQL、Redis、Spring、消息队列七大主题整理高频面试题。\n每题给出「一句话答案 + 展开要点 + 追问方向」，便于模拟面试时自测。\n附一条从基础到进阶的复习路线，适合秋招前两个月使用。' },
    { seller: 'su', title: '高等数学 上下册 习题全解（免费）', category: '电子教材', school: '北京大学', course: '高等数学', price: 0, tags: ['高数', '免费', '习题'], views: 6120, downloads: 3120, days: 2,
      desc: '同济版高数上下册课后习题全解，步骤完整，重点题附思路说明。\n按章节编号整理，方便对照教材使用。\n免费分享，欢迎纠错。' },
    { seller: 'liu', title: '社会学概论 课堂录音转写笔记', category: '课堂笔记', school: '中山大学', course: '社会学', price: 13.9, tags: ['社会学', '课堂笔记', '转写'], views: 860, downloads: 148, days: 1,
      desc: '将一学期课堂录音转写并人工校对，保留老师补充的田野案例和书单。\n按专题整理：社会结构、社会化、组织、分层、家庭与城市化。\n适合补课和期末复习，也适合对社会学感兴趣的同学泛读。' },
    { seller: 'zhou', title: '数字电路 期末复习卷（三套含答案）', category: '期末真题', school: '上海交通大学', course: '数字电路', price: 9.9, tags: ['数电', '期末', '模拟卷'], views: 940, downloads: 201, days: 1,
      desc: '三套按本校期末题型编写的模拟卷，覆盖逻辑代数、组合逻辑、时序逻辑、触发器与计数器。\n每题附详细答案与评分点，最后附一张常见错误清单。\n建议限时 120 分钟完成。' },
    { seller: 'su', title: '财务管理 公式手册与计算题精讲', category: '期末真题', school: '复旦大学', course: '财务管理', price: 17.9, tags: ['财务管理', '公式', '计算题'], views: 0, downloads: 0, days: 0, status: 'pending',
      desc: '整理时间价值、风险收益、资本成本、投资决策、营运资金管理等章节的核心公式。\n每个公式配一道典型计算题和易错提示，适合期末与 CPA 基础阶段。\n资料为个人整理，正在等待平台审核。' },
    { seller: 'wang', title: '数据结构 实验代码合集（C++ 实现）', category: '课件讲义', school: '华中科技大学', course: '数据结构', price: 21.9, tags: ['数据结构', 'C++', '实验'], views: 0, downloads: 0, days: 0, status: 'pending',
      desc: '包含链表、栈、队列、二叉树、图、排序、查找的完整 C++ 实现与测试用例。\n代码带详细注释，可直接用于课程实验和课程设计。\n正在等待平台审核。' },
    { seller: 'chen', title: '雅思听力 同义替换词表（盗版整理）', category: '语言学习', school: '武汉大学', course: '雅思', price: 4.9, tags: ['雅思', '听力', '词表'], views: 0, downloads: 0, days: 1, status: 'rejected', reason: '疑似未经授权转载第三方付费资料，请提供版权说明后重新提交。',
      desc: '整理雅思听力高频同义替换词，按场景分类。' }
  ];

  const materialIds = M.map((m, idx) => {
    const sellerId = userIds[m.seller];
    return seedMaterial(sellerId, m, idx);
  });

  // ---- 订单与评价 ----
  const reviewerPool = [userIds.chen, userIds.he, userIds.guo, userIds.wang, userIds.liu, userIds.zhou, userIds.xu];
  const reviewTexts = [
    '整理得很清楚，公式和考点都标出来了，考前一周看这个效率很高。',
    '内容比描述还全，下载后直接在平板上做批注，省了不少时间。',
    '重点抓得准，就是有几页排版稍微挤了一点，整体很值。',
    '学长/学姐很用心，问的问题也回复得很快，推荐。',
    '适合基础一般的人过一遍框架，深入的部分还是要回到教材。',
    '真题分类做得很好，刷完一遍明显有感觉了。',
    '免费资料能做到这个质量真的很良心，已收藏。',
    '和课程贴合度高，老师课上强调的点基本都覆盖到了。',
    '排版舒服，打印出来效果也不错。',
    '价格合理，希望后面能持续更新。',
    '内容有点偏基础，冲刺阶段可能还需要补充难题。',
    '下载很顺畅，客服处理速度也快。'
  ];
  let randSeed = 20261120;
  const rnd = () => {
    randSeed = (randSeed * 1103515245 + 12345) % 2147483648;
    return randSeed / 2147483648;
  };
  const nowMs = Date.now();
  let reviewIdx = 0;
  const materialRows = all('SELECT id, seller_id, price_cents, status FROM materials ORDER BY id');
  for (const row of materialRows) {
    if (row.status !== 'approved') continue;
    const reviewerCount = 2 + Math.floor(rnd() * 4);
    const used = new Set();
    for (let i = 0; i < reviewerCount; i++) {
      let buyer = reviewerPool[Math.floor(rnd() * reviewerPool.length)];
      if (buyer === row.seller_id || used.has(buyer)) {
        buyer = reviewerPool.find((u) => u !== row.seller_id && !used.has(u));
      }
      if (!buyer) continue;
      used.add(buyer);
      const daysBack = 1 + Math.floor(rnd() * 12);
      const createdAt = daysAgo(daysBack, 11 + (i % 6));
      const orderInfo = run(
        `INSERT INTO orders (material_id, buyer_id, seller_id, amount_cents, commission_cents, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'completed', ?)`,
        row.id, buyer, row.seller_id, row.price_cents, Math.round(row.price_cents * 0.1), createdAt
      );
      const orderId = Number(orderInfo.lastInsertRowid);
      const rating = rnd() > 0.22 ? 5 : (rnd() > 0.35 ? 4 : 3);
      run(
        `INSERT INTO reviews (material_id, order_id, user_id, rating, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        row.id, orderId, buyer, rating, reviewTexts[reviewIdx++ % reviewTexts.length], createdAt
      );
    }
  }
  // 额外订单，用于销售看板与趋势图
  for (let i = 0; i < 46; i++) {
    const row = materialRows[Math.floor(rnd() * materialRows.length)];
    if (row.status !== 'approved') continue;
    const buyer = reviewerPool[Math.floor(rnd() * reviewerPool.length)];
    if (buyer === row.seller_id) continue;
    run(
      `INSERT INTO orders (material_id, buyer_id, seller_id, amount_cents, commission_cents, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'completed', ?)`,
      row.id, buyer, row.seller_id, row.price_cents, Math.round(row.price_cents * 0.1), daysAgo(Math.floor(rnd() * 20), 9 + (i % 10))
    );
  }
  // 一个申请退款中的订单
  const refundRow = materialRows[3];
  run(
    `INSERT INTO orders (material_id, buyer_id, seller_id, amount_cents, commission_cents, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'refund_requested', ?)`,
    refundRow.id, userIds.guo, refundRow.seller_id, refundRow.price_cents, Math.round(refundRow.price_cents * 0.1), daysAgo(1, 16)
  );

  // 更新资料评分、销量
  for (const row of materialRows) {
    const agg = get('SELECT COUNT(*) AS c, AVG(rating) AS avg FROM reviews WHERE material_id = ?', row.id);
    const sold = get(`SELECT COUNT(*) AS c FROM orders WHERE material_id = ? AND status IN ('completed','refund_requested')`, row.id);
    run(
      'UPDATE materials SET rating_avg = ?, rating_count = ?, downloads = MAX(downloads, ?) WHERE id = ?',
      agg.c ? Math.round(agg.avg * 10) / 10 : 0, agg.c, sold.c, row.id
    );
  }

  // ---- 收藏 ----
  const favTargets = [materialIds[0], materialIds[7], materialIds[18], materialIds[6]];
  favTargets.forEach((mid, i) => {
    run('INSERT OR IGNORE INTO favorites (user_id, material_id, created_at) VALUES (?, ?, ?)', userIds.chen, mid, daysAgo(i + 1));
  });
  run('INSERT OR IGNORE INTO favorites (user_id, material_id, created_at) VALUES (?, ?, ?)', userIds.he, materialIds[13], daysAgo(2));

  // ---- 求购 ----
  run(
    `INSERT INTO wants (user_id, title, description, category, school, budget_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    userIds.chen, '求购 431 金融学综合 全套笔记（复旦）', '希望有完整的公司理财 + 金融学笔记，最好带真题和框架图，预算可小刀。', '考研资料', '复旦大学', 8000, daysAgo(2)
  );
  run(
    `INSERT INTO wants (user_id, title, description, category, school, budget_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    userIds.liu, '求购 中山大学 社会学概论 期末重点', '期末临近，想收一份老师划重点的版本，有往年题更好。', '期末真题', '中山大学', 3000, daysAgo(1)
  );
  run(
    `INSERT INTO wants (user_id, title, description, category, school, budget_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    userIds.guo, '求购 雅思 7 分备考资料包', '听说读写都要，最好包含口语题库和写作批改范例。', '语言学习', '', 5000, daysAgo(4)
  );

  // ---- 私信 ----
  const t1 = Number(run(
    `INSERT INTO threads (user_a, user_b, material_id, want_id, last_message_at, created_at) VALUES (?, ?, ?, NULL, ?, ?)`,
    userIds.chen, userIds.lin, materialIds[0], daysAgo(0, 11), daysAgo(0, 10)
  ).lastInsertRowid);
  run(`INSERT INTO messages (thread_id, sender_id, content, read_at, created_at) VALUES (?, ?, ?, ?, ?)`, t1, userIds.chen, '同学你好，这份数学一真题是最新版的吗？包含 2024 的解析吗？', null, daysAgo(0, 10));
  run(`INSERT INTO messages (thread_id, sender_id, content, read_at, created_at) VALUES (?, ?, ?, ?, ?)`, t1, userIds.lin, '是的，2024 的题和解析都在里面，排版是按题型重编的。', null, daysAgo(0, 10));
  run(`INSERT INTO messages (thread_id, sender_id, content, read_at, created_at) VALUES (?, ?, ?, ?, ?)`, t1, userIds.chen, '好的，那我直接下单，下载后有问题再找你。', null, daysAgo(0, 11));

  const t2 = Number(run(
    `INSERT INTO threads (user_a, user_b, material_id, want_id, last_message_at, created_at) VALUES (?, ?, NULL, ?, ?, ?)`,
    userIds.guo, userIds.chen, 1, daysAgo(1, 15), daysAgo(1, 14)
  ).lastInsertRowid);
  run(`INSERT INTO messages (thread_id, sender_id, content, read_at, created_at) VALUES (?, ?, ?, ?, ?)`, t2, userIds.guo, '你好，看到你在收雅思资料，我这边有口语题库，需要吗？', null, daysAgo(1, 14));
  run(`INSERT INTO messages (thread_id, sender_id, content, read_at, created_at) VALUES (?, ?, ?, ?, ?)`, t2, userIds.chen, '需要的，方便说一下版本和价格吗？', null, daysAgo(1, 15));

  // ---- 举报 / 提现 / 公告 ----
  run(
    `INSERT INTO reports (material_id, reporter_id, reason, detail, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
    materialIds[24], userIds.wang, '疑似侵权', '该资料与某付费课程讲义高度相似，建议核实版权。', daysAgo(1, 9)
  );
  run(
    `INSERT INTO reports (material_id, reporter_id, reason, detail, status, created_at) VALUES (?, ?, ?, ?, 'resolved', ?)`,
    materialIds[15], userIds.liu, '描述不符', '下载后发现只有前两章内容。', daysAgo(9, 13)
  );

  run(
    `INSERT INTO announcements (title, content, tag, active, created_at) VALUES (?, ?, ?, 1, ?)`,
    '期末季资料专区上线', '期末真题、课堂笔记、复习提纲集中推荐，上传并审核通过后可获得首页曝光位。请确保资料为本人整理，不侵犯他人版权。', '活动', daysAgo(1, 9)
  );
  run(
    `INSERT INTO announcements (title, content, tag, active, created_at) VALUES (?, ?, ?, 1, ?)`,
    '平台服务费调整说明', '自本月起，平台按成交金额收取 10% 服务费，卖家实际获得 90%。收益将于成交次日（T+1）自动结算至收款账户。', '规则', daysAgo(6, 10)
  );
  run(
    `INSERT INTO announcements (title, content, tag, active, created_at) VALUES (?, ?, ?, 1, ?)`,
    '版权保护与举报通道', '如发现资料侵犯你的权益，可在资料详情页点击「举报」，平台将在 48 小时内核实处理，违规资料将下架并冻结相关收益。', '安全', daysAgo(11, 14)
  );

  // ---- 官方价格标准库（按院校 + 学科 + 类型，基于公开教学资料与同类成交价测算） ----
  const combos = all(
    `SELECT school, subject, category, AVG(price_cents) AS avg_price, COUNT(*) AS c
     FROM materials WHERE status = 'approved' AND school != '' AND subject != ''
     GROUP BY school, subject, category`
  );
  const ts = daysAgo(30, 10);
  for (const combo of combos) {
    const base = Math.min(49900, Math.max(500, Math.round(combo.avg_price / 100) * 100));
    run(
      `INSERT INTO price_standards (school, subject, category, base_price_cents, min_price_cents, max_price_cents, note, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      combo.school, combo.subject, combo.category, base,
      Math.max(0, Math.round(base * 0.7)), Math.round(base * 1.6),
      '参考院校公开课程资料定价与同类成交价测算', ts, ts
    );
  }
  const catCombos = all(
    `SELECT category, AVG(price_cents) AS avg_price FROM materials WHERE status = 'approved' GROUP BY category`
  );
  for (const combo of catCombos) {
    if (combo.avg_price <= 0) continue;
    const base = Math.max(500, Math.round(combo.avg_price / 100) * 100);
    run(
      `INSERT INTO price_standards (school, subject, category, base_price_cents, min_price_cents, max_price_cents, note, active, created_at, updated_at)
       VALUES ('*', '*', ?, ?, ?, ?, ?, 1, ?, ?)`,
      combo.category, base, Math.max(0, Math.round(base * 0.6)), Math.round(base * 1.8),
      '全平台通用参考价，用于未收录院校/学科的兜底定价', ts, ts
    );
  }

  // ---- 砍价活动（演示数据） ----
  const future = (hours) => stamp(new Date(Date.now() + hours * 3600 * 1000));
  const bargainSeed = [
    { idx: 0, start: 2990, floor: 990, hours: 48, cuts: 2, helpers: 8 },
    { idx: 1, start: 1990, floor: 690, hours: 24, cuts: 1, helpers: 5 },
    { idx: 17, start: 1990, floor: 1190, hours: 72, cuts: 3, helpers: 10 }
  ];
  const bargainActivityIds = [];
  for (const item of bargainSeed) {
    const material = get('SELECT * FROM materials WHERE id = ?', materialIds[item.idx]);
    if (!material || material.price_cents <= item.floor) continue;
    const info = run(
      `INSERT INTO bargain_activities (material_id, start_price_cents, floor_price_cents, duration_hours,
         max_cuts_per_user, max_helpers, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      material.id, item.start, item.floor, item.hours, item.cuts, item.helpers,
      userIds.admin, daysAgo(1, 10), daysAgo(1, 10)
    );
    bargainActivityIds.push(Number(info.lastInsertRowid));
  }
  // 演示：陈砚发起的一个进行中的砍价单，已有两位好友助力
  if (bargainActivityIds[0] && materialIds[0]) {
    const info = run(
      `INSERT INTO bargain_orders (activity_id, material_id, user_id, start_price_cents, current_price_cents,
         floor_price_cents, max_cuts_per_user, max_helpers, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 2990, 1990, 990, 2, 8, 'active', ?, ?, ?)`,
      bargainActivityIds[0], materialIds[0], userIds.chen, future(30), daysAgo(0, 9), daysAgo(0, 9)
    );
    const orderId = Number(info.lastInsertRowid);
    run(
      `INSERT INTO bargain_assists (order_id, helper_id, cut_cents, seq, request_id, created_at)
       VALUES (?, ?, 600, 1, 'seed-he-1', ?)`, orderId, userIds.he, daysAgo(0, 10)
    );
    run(
      `INSERT INTO bargain_assists (order_id, helper_id, cut_cents, seq, request_id, created_at)
       VALUES (?, ?, 400, 1, 'seed-guo-1', ?)`, orderId, userIds.guo, daysAgo(0, 11)
    );
  }

  // ---- 客服工单 ----
  const tk1 = Number(run(
    `INSERT INTO tickets (user_id, kind, ticket_type, title, content, material_id, target_user_id, status, priority,
       user_unread, staff_unread, created_at, updated_at)
     VALUES (?, 'official', 'bug', '手机端资料预览显示不全', ?, NULL, NULL, 'processing', 'normal', 0, 0, ?, ?)`,
    userIds.chen, '在手机上打开资料详情页时，预览区域右侧会被截断，横屏后仍然存在。使用的是 iPhone 14 和最新版 Safari，希望尽快修复。',
    daysAgo(2, 14), daysAgo(2, 15)
  ).lastInsertRowid);
  run(
    `INSERT INTO ticket_replies (ticket_id, author_id, role, content, created_at) VALUES (?, ?, 'admin', ?, ?)`,
    tk1, userIds.admin, '已收到反馈，我们复现后发现是预览容器的最小宽度设置问题，正在修复并会在本周版本更新中上线，感谢你的反馈。', daysAgo(2, 15)
  );

  const tk2 = Number(run(
    `INSERT INTO tickets (user_id, kind, ticket_type, title, content, material_id, target_user_id, status, priority,
       user_unread, staff_unread, created_at, updated_at)
     VALUES (?, 'official', 'suggestion', '希望资料市场支持按授课老师筛选', ?, NULL, NULL, 'resolved', 'normal', 1, 0, ?, ?)`,
    userIds.he, '不同老师讲课重点差别很大，如果能按老师筛选会更容易找到对口的笔记。另外希望能显示学科维度。',
    daysAgo(5, 10), daysAgo(4, 9)
  ).lastInsertRowid);
  run(
    `INSERT INTO ticket_replies (ticket_id, author_id, role, content, created_at) VALUES (?, ?, 'admin', ?, ?)`,
    tk2, userIds.admin, '你的建议已采纳。资料市场现已支持「院校 / 学科 / 老师」三级筛选，认证用户还可以默认进入本校专区。感谢你的建议！', daysAgo(4, 9)
  );

  const tk3 = Number(run(
    `INSERT INTO tickets (user_id, kind, ticket_type, title, content, material_id, target_user_id, status, priority,
       user_unread, staff_unread, created_at, updated_at)
     VALUES (?, 'seller', 'consult', '咨询：这份数学真题包含 2024 年解析吗？', ?, ?, ?, 'open', 'normal', 0, 1, ?, ?)`,
    userIds.chen, '同学你好，请问这份资料是否包含 2024 年真题的完整解析？大概多少页？谢谢！',
    materialIds[0], userIds.lin, daysAgo(0, 9), daysAgo(0, 9)
  ).lastInsertRowid);
  void tk3;

  // 让示例数据中的浏览量更自然
  for (const row of materialRows) {
    if (row.status !== 'approved') continue;
    const base = get('SELECT downloads FROM materials WHERE id = ?', row.id).downloads;
    run('UPDATE materials SET views = MAX(views, ?) WHERE id = ?', base * (2 + Math.floor(rnd() * 4)), row.id);
  }
}

function ensureColumn(table, column, ddl) {
  const cols = all(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/**
 * 将历史「卖家客服」工单迁移为统一会话消息，保证历史记录与未读状态不丢失。
 * 使用 chat_migrations 记录来源，重复启动不会重复写入。
 */
function migrateSellerChat() {
  const tickets = all(
    `SELECT * FROM tickets WHERE kind = 'seller' AND target_user_id IS NOT NULL ORDER BY id ASC`
  );
  for (const t of tickets) {
    if (get('SELECT 1 AS ok FROM chat_migrations WHERE source = ? AND source_id = ?', 'ticket', t.id)) continue;

    let thread = get(
      `SELECT * FROM threads WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)
       ORDER BY (material_id = ?) DESC, last_message_at DESC LIMIT 1`,
      t.user_id, t.target_user_id, t.target_user_id, t.user_id, t.material_id
    );
    let threadId;
    if (thread) {
      threadId = thread.id;
    } else {
      const info = run(
        `INSERT INTO threads (user_a, user_b, material_id, want_id, scene, last_message_at, created_at)
         VALUES (?, ?, ?, NULL, 'consult', ?, ?)`,
        t.user_id, t.target_user_id, t.material_id, t.updated_at, t.created_at
      );
      threadId = Number(info.lastInsertRowid);
    }

    const rows = [{ sender_id: t.user_id, content: t.content, created_at: t.created_at }];
    for (const r of all('SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY id ASC', t.id)) {
      rows.push({ sender_id: r.author_id, content: r.content, created_at: r.created_at });
    }
    for (const m of rows) {
      run(
        'INSERT INTO messages (thread_id, sender_id, content, read_at, created_at) VALUES (?, ?, ?, ?, ?)',
        threadId, m.sender_id, m.content, m.created_at, m.created_at
      );
    }
    if (t.user_unread > 0) {
      run(
        `UPDATE messages SET read_at = NULL WHERE id = (
           SELECT id FROM messages WHERE thread_id = ? AND sender_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
         )`, threadId, t.target_user_id
      );
    }
    if (t.staff_unread > 0) {
      run(
        `UPDATE messages SET read_at = NULL WHERE id = (
           SELECT id FROM messages WHERE thread_id = ? AND sender_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
         )`, threadId, t.user_id
      );
    }
    run(
      `UPDATE threads SET material_id = COALESCE(material_id, ?),
         scene = CASE WHEN scene = '' THEN 'consult' ELSE scene END,
         last_message_at = CASE WHEN last_message_at < ? THEN ? ELSE last_message_at END
       WHERE id = ?`,
      t.material_id, t.updated_at, t.updated_at, threadId
    );
    run(
      'INSERT OR IGNORE INTO chat_migrations (source, source_id, thread_id, created_at) VALUES (?, ?, ?, ?)',
      'ticket', t.id, threadId, now()
    );
  }
}

function ensureBargainSeed() {
  // 仅首次升级时补充演示活动，管理员清空后重启不会再次写入
  if (get("SELECT value FROM bargain_settings WHERE key = 'seeded'")) return;
  if (get('SELECT COUNT(*) AS c FROM bargain_activities').c === 0) {
    const admin = get("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
    const materials = admin ? all(
      `SELECT id, price_cents FROM materials
       WHERE status = 'approved' AND price_cents >= 1000 ORDER BY id LIMIT 3`
    ) : [];
    const ts = now();
    materials.forEach((m, index) => {
      const floor = Math.max(100, Math.round((m.price_cents * (index === 0 ? 0.35 : 0.5)) / 100) * 100);
      if (m.price_cents <= floor) return;
      run(
        `INSERT INTO bargain_activities (material_id, start_price_cents, floor_price_cents, duration_hours,
           max_cuts_per_user, max_helpers, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        m.id, m.price_cents, floor, index === 0 ? 48 : 24,
        index === 0 ? 2 : 1, index === 0 ? 8 : 5, admin.id, ts, ts
      );
    });
  }
  run("INSERT OR REPLACE INTO bargain_settings (key, value, updated_at) VALUES ('seeded', '1', ?)", now());
}

function ensureCatalog(seedDemo) {
  // 以教育部官方名单 / 专业目录为准做全量同步：清理非官方历史条目，补齐与校准官方字段
  tx(() => {
    const ts = now();

    const officialSchools = new Set(SCHOOL_PROFILES.map((s) => s.name));
    for (const row of all('SELECT id, name FROM schools')) {
      if (!officialSchools.has(row.name)) run('DELETE FROM schools WHERE id = ?', row.id);
    }
    const schoolStmt = db.prepare(
      `INSERT INTO schools (name, code, supervisor, province, city, degree_level, school_type, ownership, note, level, tags, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         code = excluded.code,
         supervisor = excluded.supervisor,
         province = excluded.province,
         city = excluded.city,
         degree_level = excluded.degree_level,
         school_type = excluded.school_type,
         ownership = excluded.ownership,
         note = excluded.note,
         level = excluded.level,
         tags = excluded.tags,
         source = excluded.source`
    );
    for (const s of SCHOOL_PROFILES) {
      schoolStmt.run(
        s.name, s.code, s.supervisor, s.province, s.city, s.degreeLevel,
        s.schoolType, s.ownership, s.note, s.level, s.tags, s.source, ts
      );
    }

    const officialMajors = new Set(MAJOR_PROFILES.map((m) => m.code));
    for (const row of all('SELECT id, code FROM majors')) {
      if (!officialMajors.has(row.code)) run('DELETE FROM majors WHERE id = ?', row.id);
    }
    const majorStmt = db.prepare(
      `INSERT INTO majors (code, name, category_code, category, class_code, class_name, degree_note, is_special, is_controlled, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         name = excluded.name,
         category_code = excluded.category_code,
         category = excluded.category,
         class_code = excluded.class_code,
         class_name = excluded.class_name,
         degree_note = excluded.degree_note,
         is_special = excluded.is_special,
         is_controlled = excluded.is_controlled,
         source = excluded.source`
    );
    for (const m of MAJOR_PROFILES) {
      majorStmt.run(
        m.code, m.name, m.categoryCode, m.category, m.classCode, m.className,
        m.degreeNote, m.isSpecial ? 1 : 0, m.isControlled ? 1 : 0, MAJOR_SOURCE, ts
      );
    }

    for (const s of SUBJECT_PROFILES) {
      run('INSERT OR IGNORE INTO subjects (name, category, created_at) VALUES (?, ?, ?)', s.name, s.category, ts);
    }
    // 教师名单为开发演示用的虚构姓名，生产环境不写入；真实教师由运营导入或随资料录入
    if (seedDemo) {
      for (const t of TEACHER_PROFILES) {
        run(
          'INSERT OR IGNORE INTO teachers (name, school, subject, title, created_at) VALUES (?, ?, ?, ?, ?)',
          t.name, t.school, t.subject, t.title, ts
        );
      }
    }
  });
}

function ensureAdminSecuritySeed() {
  const admin = get("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  if (!admin) return;
  const stillWeak = verifyPassword('Admin123456', admin.salt, admin.password_hash);
  if (stillWeak || !admin.admin_password_changed_at) {
    const { hash, salt } = hashPassword(adminSecurity.ADMIN_PASSWORD);
    run(
      'UPDATE users SET password_hash = ?, salt = ?, admin_password_changed_at = ?, token_version = token_version + 1 WHERE id = ?',
      hash, salt, now(), admin.id
    );
    run(
      'INSERT INTO admin_password_history (admin_id, password_hash, salt, created_at) VALUES (?, ?, ?, ?)',
      admin.id, hash, salt, now()
    );
    console.log(JSON.stringify({ level: 'warn', event: 'admin_password_hardened', adminId: admin.id }));
  }
  const mfaSecret = String(process.env.ADMIN_MFA_SECRET || '').trim();
  if (!admin.admin_mfa_secret && mfaSecret) {
    run('UPDATE users SET admin_mfa_secret = ?, admin_mfa_enabled_at = ? WHERE id = ?', mfaSecret, now(), admin.id);
  }
  const history = get('SELECT COUNT(*) AS c FROM admin_password_history WHERE admin_id = ?', admin.id);
  if (!history || !history.c) {
    const current = get('SELECT password_hash, salt FROM users WHERE id = ?', admin.id);
    if (current) {
      run(
        'INSERT INTO admin_password_history (admin_id, password_hash, salt, created_at) VALUES (?, ?, ?, ?)',
        admin.id, current.password_hash, current.salt, now()
      );
    }
  }
}

function init() {
  db.exec(SCHEMA);
  // 兼容旧库：幂等补充新增字段
  ensureColumn('users', 'real_name', "real_name TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'student_no', "student_no TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'verify_status', "verify_status TEXT NOT NULL DEFAULT 'none'");
  ensureColumn('users', 'verify_note', "verify_note TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'verified_at', 'verified_at TEXT');
  ensureColumn('users', 'phone', "phone TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'last_login_at', 'last_login_at TEXT');
  ensureColumn('users', 'last_login_ip', "last_login_ip TEXT NOT NULL DEFAULT ''");
  // 管理员认证加固字段
  ensureColumn('users', 'admin_mfa_secret', "admin_mfa_secret TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'admin_mfa_enabled_at', 'admin_mfa_enabled_at TEXT');
  ensureColumn('users', 'admin_mfa_last_step', 'admin_mfa_last_step INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'admin_password_changed_at', 'admin_password_changed_at TEXT');
  ensureColumn('users', 'admin_fail_count', 'admin_fail_count INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'admin_mfa_fail_count', 'admin_mfa_fail_count INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'admin_lock_until', 'admin_lock_until INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'admin_lock_ip', "admin_lock_ip TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'token_version', 'token_version INTEGER NOT NULL DEFAULT 0');
  try {
    run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone <> ''`);
  } catch { /* 旧库存在重复手机号时不阻断启动，由接口层兜底拦截 */ }
  // 同一院校下学号唯一（仅约束审核中与已认证状态；历史数据重复时跳过，由接口层兜底拦截）
  try {
    run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_school_student ON users(school, student_no)
         WHERE student_no <> '' AND verify_status IN ('pending','verified')`);
  } catch { /* 旧库存在重复学号时不阻断启动 */ }
  ensureColumn('materials', 'subject', "subject TEXT NOT NULL DEFAULT ''");
  ensureColumn('materials', 'teacher', "teacher TEXT NOT NULL DEFAULT ''");
  ensureColumn('materials', 'preview_text', "preview_text TEXT NOT NULL DEFAULT ''");
  ensureColumn('materials', 'preview_ratio', 'preview_ratio INTEGER NOT NULL DEFAULT 15');
  ensureColumn('materials', 'content_chars', 'content_chars INTEGER NOT NULL DEFAULT 0');
  ensureColumn('materials', 'price_source', "price_source TEXT NOT NULL DEFAULT 'seller'");
  ensureColumn('materials', 'price_note', "price_note TEXT NOT NULL DEFAULT ''");
  ensureColumn('materials', 'audit_verdict', "audit_verdict TEXT NOT NULL DEFAULT ''");
  ensureColumn('materials', 'audit_score', 'audit_score INTEGER NOT NULL DEFAULT 0');
  ensureColumn('materials', 'audit_hits', "audit_hits TEXT NOT NULL DEFAULT ''");
  ensureColumn('materials', 'audit_status', "audit_status TEXT NOT NULL DEFAULT ''");
  // 退款申请计数：被驳回后可再次申请，但总次数受限，避免反复触发人工审核
  ensureColumn('orders', 'refund_attempts', 'refund_attempts INTEGER NOT NULL DEFAULT 0');
  ensureColumn('materials', 'audit_at', 'audit_at TEXT');
  ensureColumn('orders', 'payment_channel', "payment_channel TEXT NOT NULL DEFAULT ''");
  ensureColumn('orders', 'bargain_id', 'bargain_id INTEGER');
  ensureColumn('payments', 'channel_order_id', "channel_order_id TEXT NOT NULL DEFAULT ''");
  ensureColumn('payments', 'channel_payload', "channel_payload TEXT NOT NULL DEFAULT ''");
  ensureColumn('threads', 'scene', "scene TEXT NOT NULL DEFAULT ''");
  ensureColumn('settlements', 'payout_txn_no', "payout_txn_no TEXT NOT NULL DEFAULT ''");
  ensureColumn('settlements', 'reversed_at', 'reversed_at TEXT');
  // 院校库对齐教育部官方名单：补充官方标识码、办学层次、办学类型等字段
  ensureColumn('schools', 'code', "code TEXT NOT NULL DEFAULT ''");
  ensureColumn('schools', 'supervisor', "supervisor TEXT NOT NULL DEFAULT ''");
  ensureColumn('schools', 'degree_level', "degree_level TEXT NOT NULL DEFAULT ''");
  ensureColumn('schools', 'school_type', "school_type TEXT NOT NULL DEFAULT ''");
  ensureColumn('schools', 'ownership', "ownership TEXT NOT NULL DEFAULT ''");
  ensureColumn('schools', 'note', "note TEXT NOT NULL DEFAULT ''");
  ensureColumn('schools', 'source', "source TEXT NOT NULL DEFAULT ''");
  try {
    run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_schools_code ON schools(code) WHERE code <> ''`);
  } catch { /* 旧库存在重复官方编码时不阻断启动，由同步逻辑覆盖 */ }
  run('CREATE INDEX IF NOT EXISTS idx_schools_type ON schools(school_type)');
  // 列表主查询与分面统计的常用前缀，减少全表扫描
  run('CREATE INDEX IF NOT EXISTS idx_materials_status_sort ON materials(status, downloads DESC)');
  run('CREATE INDEX IF NOT EXISTS idx_materials_status_category ON materials(status, category)');
  run('CREATE INDEX IF NOT EXISTS idx_materials_status_school ON materials(status, school)');
  run('CREATE INDEX IF NOT EXISTS idx_materials_status_subject ON materials(status, subject)');
  run('CREATE INDEX IF NOT EXISTS idx_orders_material_buyer ON orders(material_id, buyer_id, status)');
  // 审计日志保留期：启动时清理超期记录，避免长期累积操作详情
  const auditKeepDays = Math.max(7, Number(process.env.AUDIT_LOG_KEEP_DAYS) || 180);
  const auditCutoff = stamp(new Date(Date.now() - auditKeepDays * 24 * 3600 * 1000));
  run('DELETE FROM admin_audit_logs WHERE created_at < ?', auditCutoff);
  run('DELETE FROM audit_logs WHERE created_at < ?', auditCutoff);
  // 角色统一收敛为两类：个人用户（user）与管理员（admin）
  run("UPDATE users SET role = 'user' WHERE role NOT IN ('user', 'admin')");
  run("UPDATE ticket_replies SET role = 'user' WHERE role NOT IN ('user', 'admin')");
  const row = get('SELECT COUNT(*) AS c FROM users');
  const seedDemo = process.env.SEED_DEMO === 'true'
    ? true
    : process.env.SEED_DEMO === 'false'
      ? false
      : process.env.NODE_ENV !== 'production';
  if ((!row || row.c === 0) && seedDemo) {
    tx(() => seed());
  }
  if (seedDemo) ensureExperienceUser();
  ensureAdminSecuritySeed();
  migrateSellerChat();
  ensureBargainSeed();
  ensureCatalog(seedDemo);
}

module.exports = {
  db, all, get, run, tx, init, now,
  SCHOOLS, MAJORS, CATALOG_MANIFEST, CATEGORIES, SUBJECTS, COURSE_META, buildPreview
};
