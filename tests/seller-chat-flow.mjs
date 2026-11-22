/**
 * 学涯集市 · 统一卖家沟通全流程测试
 *
 * 覆盖：历史卖家咨询工单迁移、统一会话列表、场景分类、快捷回复、
 *       消息收发、已读未读同步、历史记录顺序、旧入口兼容、权限隔离。
 *
 * 运行：npm run test:chat
 * 说明：测试会启动一个使用临时数据目录的独立服务（默认端口 3398），不会污染现有数据。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.CHAT_TEST_PORT || 3398);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-chat-'));

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function request(url, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data };
}

async function login(account, password) {
  const res = await request('/api/auth/login', { method: 'POST', body: { account, password } });
  if (res.status !== 200 || !res.data?.token) throw new Error(`登录失败：${account}`);
  return res.data;
}

async function waitForServer(child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务启动失败，退出码 ${child.exitCode}`);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务启动超时');
}

async function main() {
  console.log(`\n学涯集市统一卖家沟通测试 · ${BASE}\n`);

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, PAYMENT_MODE: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (buf) => process.stderr.write(`[server] ${buf}`));

  try {
    await waitForServer(child);

    const seller = await login('seller@xueya.cn', 'Seller123456');
    const buyer = await login('student@xueya.cn', 'Student123456');
    const other = await login('heyue@xueya.cn', 'Student123456');

    /* 1. 场景与快捷回复元数据 */
    const meta = await request('/api/threads/meta', { token: buyer.token });
    const scenes = meta.data?.scenes || [];
    check('咨询场景元数据 /api/threads/meta', meta.status === 200 && scenes.length === 5, String(scenes.length));
    check('保留资料咨询与自由沟通场景', ['consult', 'price', 'delivery', 'after_sale', 'free'].every((k) => scenes.some((s) => s.key === k)));
    check('快捷回复按场景下发', (meta.data?.quickReplies?.consult || []).length >= 3, JSON.stringify(meta.data?.quickReplies?.consult));

    /* 2. 历史卖家咨询已迁移到统一会话 */
    const buyerList = await request('/api/threads', { token: buyer.token });
    const items = buyerList.data?.items || [];
    check('统一会话列表 /api/threads', buyerList.status === 200 && items.length >= 2, String(items.length));
    const migrated = items.find((t) => t.perspective === 'buy' && t.material && /数学一/.test(t.material.title));
    check('历史卖家咨询合并进资料会话', !!migrated, JSON.stringify(items.map((t) => t.context.title)));
    check('会话带场景分类', migrated?.scene === 'consult' && !!migrated?.sceneText, JSON.stringify({ scene: migrated?.scene, text: migrated?.sceneText }));

    const history = await request(`/api/threads/${migrated.id}`, { token: buyer.token });
    const messages = history.data?.messages || [];
    check('历史消息无丢失（私信 + 工单）', messages.some((m) => /这份数学一真题是最新版/.test(m.content)) && messages.some((m) => /2024 年真题的完整解析/.test(m.content)));
    check('历史消息按时间顺序返回', messages.every((m, i) => i === 0 || m.createdAt >= messages[i - 1].createdAt));
    check('会话详情返回快捷回复', (history.data?.quickReplies || []).length >= 3);

    /* 3. 卖家侧未读与读状态同步 */
    const sellerUnread = await request('/api/threads/unread', { token: seller.token });
    check('卖家未读汇总 /api/threads/unread', sellerUnread.status === 200 && sellerUnread.data.asSeller > 0, JSON.stringify(sellerUnread.data));

    const sellerList = await request('/api/threads?perspective=sell', { token: seller.token });
    check('卖家侧仅返回卖家身份会话', (sellerList.data?.items || []).length > 0 && (sellerList.data?.items || []).every((t) => t.perspective === 'sell' || t.perspective === 'peer'), String((sellerList.data?.items || []).length));

    const sellerDetail = await request(`/api/threads/${migrated.id}`, { token: seller.token });
    check('卖家可读取统一会话', sellerDetail.status === 200 && sellerDetail.data?.thread?.id === migrated.id);
    const sellerUnreadAfter = await request('/api/threads/unread', { token: seller.token });
    check('打开会话后卖家未读清零', sellerUnreadAfter.data.asSeller === 0, JSON.stringify(sellerUnreadAfter.data));

    /* 4. 场景切换 */
    const changed = await request(`/api/threads/${migrated.id}`, { method: 'PATCH', token: seller.token, body: { scene: 'price' } });
    check('切换咨询场景', changed.status === 200 && changed.data.sceneText === '价格与优惠', JSON.stringify(changed.data));
    const badScene = await request(`/api/threads/${migrated.id}`, { method: 'PATCH', token: seller.token, body: { scene: 'nope' } });
    check('非法场景被拒绝', badScene.status === 400, String(badScene.status));

    /* 5. 消息收发与未读联动 */
    const sent = await request(`/api/threads/${migrated.id}/messages`, { method: 'POST', token: seller.token, body: { content: '含 2024 年完整解析，共 96 页，下单后可直接下载。' } });
    check('卖家发送消息', sent.status === 201 && sent.data?.message?.mine === true);
    const buyerUnread = await request('/api/threads/unread', { token: buyer.token });
    check('买家未读同步增加', buyerUnread.data.total >= 1, JSON.stringify(buyerUnread.data));
    const buyerDetail = await request(`/api/threads/${migrated.id}`, { token: buyer.token });
    check('买家收到卖家消息', (buyerDetail.data?.messages || []).some((m) => /共 96 页/.test(m.content)));
    const buyerUnreadAfter = await request('/api/threads', { token: buyer.token });
    const readThread = (buyerUnreadAfter.data?.items || []).find((t) => t.id === migrated.id);
    check('买家阅读后该会话未读清零', readThread && readThread.unread === 0, JSON.stringify(readThread?.unread));

    /* 6. 商品详情页统一入口：同一卖家复用同一会话 */
    const opened = await request('/api/threads', {
      method: 'POST', token: buyer.token,
      body: { toUserId: seller.user.id, materialId: migrated.material.id, content: '从商品详情页发起咨询：支持打印吗？', scene: 'consult' }
    });
    check('商品详情入口创建/复用会话', opened.status === 201 && opened.data.threadId === migrated.id, JSON.stringify(opened.data));
    const afterOpen = await request(`/api/threads/${migrated.id}`, { token: seller.token });
    check('统一会话无重复、消息已入库', (afterOpen.data?.messages || []).some((m) => /支持打印吗/.test(m.content)));

    /* 7. 旧版「卖家客服」入口兼容，不产生第二套消息 */
    const legacy = await request('/api/tickets', {
      method: 'POST', token: buyer.token,
      body: { kind: 'seller', materialId: migrated.material.id, content: '旧入口咨询：是否可以开发票？' }
    });
    check('旧卖家客服入口返回统一会话', legacy.status === 201 && legacy.data?.threadId === migrated.id, JSON.stringify(legacy.data));
    const legacyTicketList = await request('/api/tickets?scope=staff', { token: seller.token });
    check('卖家工单入口不再返回卖家咨询', (legacyTicketList.data?.items || []).every((t) => t.kind !== 'seller'), JSON.stringify((legacyTicketList.data?.items || []).map((t) => t.kind)));
    const merged = await request(`/api/threads/${migrated.id}`, { token: buyer.token });
    check('旧入口消息同步到统一会话', (merged.data?.messages || []).some((m) => /是否可以开发票/.test(m.content)));

    /* 8. 官方客服工单仍独立可用 */
    const official = await request('/api/tickets', {
      method: 'POST', token: buyer.token,
      body: { kind: 'official', type: 'bug', content: '统一沟通改动后的官方工单回归测试。' }
    });
    check('官方客服工单仍可提交', official.status === 201 && official.data?.ticket?.kind === 'official');
    const officialList = await request('/api/tickets?scope=mine', { token: buyer.token });
    check('我的工单仅包含官方工单', (officialList.data?.items || []).length > 0 && (officialList.data?.items || []).every((t) => t.kind === 'official'));

    /* 9. 权限隔离 */
    const denied = await request(`/api/threads/${migrated.id}`, { token: other.token });
    check('非会话成员无法查看', denied.status === 403, String(denied.status));
    const deniedSend = await request(`/api/threads/${migrated.id}/messages`, { method: 'POST', token: other.token, body: { content: 'hi' } });
    check('非会话成员无法发送', deniedSend.status === 403, String(deniedSend.status));

    /* 10. 自由对话模式 */
    const free = await request('/api/threads', {
      method: 'POST', token: buyer.token,
      body: { toUserId: seller.user.id, content: '自由沟通：最近还有新的复习资料吗？', scene: 'free' }
    });
    check('自由对话模式可用', free.status === 201 && free.data?.scene === 'free');
    const freeList = await request('/api/threads', { token: buyer.token });
    const sameThreadCount = (freeList.data?.items || []).filter((t) => t.other.id === seller.user.id).length;
    check('同一卖家只保留一个会话窗口', sameThreadCount === 1, String(sameThreadCount));
  } finally {
    child.kill();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n测试执行失败：${err.message}\n`);
  process.exitCode = 1;
});
