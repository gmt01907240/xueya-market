/**
 * 学涯集市 · 砍价全流程测试
 *
 * 覆盖：活动管理（创建/校验/上下架/删除约束）、发起砍价、随机助力与底价边界、
 *       助力幂等、单用户次数上限、最大助力人数、过期结算、并发助力一致性、
 *       价格防篡改快照、砍价成功购买与支付、权限隔离。
 *
 * 运行：npm run test:bargain
 * 说明：测试会启动一个使用临时数据目录的独立服务（默认端口 3397），不会污染现有数据。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { adminLogin } from './admin-login-helper.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.BARGAIN_TEST_PORT || 3397);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-bargain-'));

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

function pickMaterial(materials, keyword) {
  const found = materials.find((m) => m.title.includes(keyword));
  if (!found) throw new Error(`未找到资料：${keyword}`);
  return found;
}

async function main() {
  console.log(`\n学涯集市砍价全流程测试 · ${BASE}\n`);

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, PAYMENT_MODE: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (buf) => process.stderr.write(`[server] ${buf}`));

  try {
    await waitForServer(child);

    const adminAuth = await adminLogin(BASE);
    check('管理员专属入口密码+MFA 登录', adminAuth.ok === true && Boolean(adminAuth.token), JSON.stringify(adminAuth.data || {}));
    const admin = adminAuth;
    const buyer = await login('student@xueya.cn', 'Student123456');
    const he = await login('heyue@xueya.cn', 'Student123456');
    const guo = await login('guojing@xueya.cn', 'Student123456');
    const wang = await login('wangyi@xueya.cn', 'Student123456');
    const liu = await login('liuxin@xueya.cn', 'Student123456');
    const lin = await login('seller@xueya.cn', 'Seller123456');

    /* 1. 管理后台与活动列表 */
    const denied = await request('/api/admin/bargains', { token: buyer.token });
    check('普通用户不可访问砍价管理', denied.status === 403, String(denied.status));

    const adminList = await request('/api/admin/bargains', { token: admin.token });
    check('管理后台砍价活动列表', adminList.status === 200 && (adminList.data?.items || []).length >= 3, `${adminList.status}`);
    check('活动列表带运营统计', !!adminList.data?.counts && adminList.data.counts.active >= 3, JSON.stringify(adminList.data?.counts));
    check('活动列表返回可选资料', (adminList.data?.materials || []).length > 0);

    const materialRows = adminList.data.materials;
    const myOrders = await request('/api/orders/mine', { token: buyer.token });
    const [heOrders, guoOrders, wangOrders] = await Promise.all([
      request('/api/orders/mine', { token: he.token }),
      request('/api/orders/mine', { token: guo.token }),
      request('/api/orders/mine', { token: wang.token })
    ]);
    const boughtOf = (res) => new Set((res.data?.items || []).map((o) => o.material.id));
    const usedMaterialIds = new Set((adminList.data.items || []).filter((a) => a.status === 'active').map((a) => a.materialId));
    function claimMaterial(initiator, bought) {
      const found = materialRows.find((m) => (
        !usedMaterialIds.has(m.id) && !bought.has(m.id) &&
        m.sellerNickname !== initiator.user.nickname && m.price >= 900
      ));
      if (!found) throw new Error('可测试资料不足');
      usedMaterialIds.add(found.id);
      return found;
    }
    const matA = claimMaterial(buyer, boughtOf(myOrders));
    const matB = claimMaterial(he, boughtOf(heOrders));
    const matC = claimMaterial(guo, boughtOf(guoOrders));
    const matD = claimMaterial(wang, boughtOf(wangOrders));
    const matE = materialRows.find((m) => !usedMaterialIds.has(m.id) && m.price >= 900);
    if (!matE) throw new Error('缺少用于删除测试的资料');
    usedMaterialIds.add(matE.id);
    const matFree = pickMaterial(materialRows, '线性代数期末冲刺讲义');

    /* 2. 活动规则校验 */
    const badFloor = await request('/api/admin/bargains', {
      method: 'POST', token: admin.token,
      body: { materialId: matA.id, startPrice: 5, floorPrice: 5, durationHours: 24, maxCutsPerUser: 1, maxHelpers: 3 }
    });
    check('底价必须低于初始价', badFloor.status === 400, `${badFloor.status} ${JSON.stringify(badFloor.data)}`);

    const badCuts = await request('/api/admin/bargains', {
      method: 'POST', token: admin.token,
      body: { materialId: matA.id, startPrice: 9.9, floorPrice: 5, durationHours: 24, maxCutsPerUser: 0, maxHelpers: 3 }
    });
    check('单用户次数上限校验', badCuts.status === 400, String(badCuts.status));

    const badHours = await request('/api/admin/bargains', {
      method: 'POST', token: admin.token,
      body: { materialId: matA.id, startPrice: 9.9, floorPrice: 5, durationHours: 9999, maxCutsPerUser: 1, maxHelpers: 3 }
    });
    check('有效期范围校验', badHours.status === 400, String(badHours.status));

    const freeMaterial = await request('/api/admin/bargains', {
      method: 'POST', token: admin.token,
      body: { materialId: matFree.id, startPrice: 5, floorPrice: 1, durationHours: 24, maxCutsPerUser: 1, maxHelpers: 3 }
    });
    check('免费资料不可创建砍价', freeMaterial.status === 400, String(freeMaterial.status));

    /* 3. 创建活动 A：2 人上限、每人 2 次 */
    const actA = await request('/api/admin/bargains', {
      method: 'POST', token: admin.token,
      body: { materialId: matA.id, startPrice: matA.price / 100, floorPrice: 5, durationHours: 24, maxCutsPerUser: 2, maxHelpers: 2 }
    });
    check('创建砍价活动', actA.status === 201 && actA.data?.item?.active === true, JSON.stringify(actA.data));
    const activityA = actA.data.item;

    const duplicateActivity = await request('/api/admin/bargains', {
      method: 'POST', token: admin.token,
      body: { materialId: matA.id, startPrice: matA.price / 100, floorPrice: 5, durationHours: 24, maxCutsPerUser: 1, maxHelpers: 3 }
    });
    check('同一资料仅允许一个进行中活动', duplicateActivity.status === 409, String(duplicateActivity.status));

    const materialEntry = await request(`/api/bargains/material/${matA.id}`, { token: buyer.token });
    check('资料页读取砍价活动', materialEntry.status === 200 && materialEntry.data?.activity?.id === activityA.id, JSON.stringify(materialEntry.data?.activity));
    check('未发起时 myOrder 为空', materialEntry.data?.myOrder === null, JSON.stringify(materialEntry.data?.myOrder));

    /* 4. 上下架 */
    const offline = await request(`/api/admin/bargains/${activityA.id}`, {
      method: 'PATCH', token: admin.token, body: { status: 'offline' }
    });
    check('下架砍价活动', offline.status === 200 && offline.data?.item?.active === false, JSON.stringify(offline.data));
    const afterOffline = await request(`/api/bargains/material/${matA.id}`, { token: buyer.token });
    check('下架后资料页无进行中活动', afterOffline.data?.activity === null);
    const createWhileOffline = await request('/api/bargains', { method: 'POST', token: buyer.token, body: { materialId: matA.id } });
    check('下架活动不可发起砍价', createWhileOffline.status === 404, String(createWhileOffline.status));
    const reOnline = await request(`/api/admin/bargains/${activityA.id}`, {
      method: 'PATCH', token: admin.token, body: { status: 'active' }
    });
    check('重新上架砍价活动', reOnline.status === 200 && reOnline.data?.item?.active === true);

    /* 5. 发起砍价（含价格字段篡改） */
    const created = await request('/api/bargains', {
      method: 'POST', token: buyer.token,
      body: { materialId: matA.id, startPrice: 0.01, currentPrice: 0.01, floorPrice: 0.01 }
    });
    check('发起砍价', created.status === 201 && created.data?.order?.status === 'active', JSON.stringify(created.data));
    const orderA = created.data.order;
    check('价格取服务端活动快照，忽略前端传价', orderA.startPrice === activityA.startPrice && orderA.floorPrice === activityA.floorPrice, JSON.stringify({ start: orderA.startPrice, floor: orderA.floorPrice }));
    check('初始进度为 0、助力人数为 0', orderA.progress === 0 && orderA.helperCount === 0);

    const dupCreate = await request('/api/bargains', { method: 'POST', token: buyer.token, body: { materialId: matA.id } });
    check('重复发起返回同一砍价单', dupCreate.status === 200 && dupCreate.data?.existed === true && dupCreate.data.orderId === orderA.id, JSON.stringify(dupCreate.data));

    const selfAssist = await request(`/api/bargains/${orderA.id}/assist`, { method: 'POST', token: buyer.token, body: { requestId: 'self-1' } });
    check('发起人不能给自己助力', selfAssist.status === 400, String(selfAssist.status));

    const anonDetail = await request(`/api/bargains/${orderA.id}`);
    check('分享链接匿名可查看详情', anonDetail.status === 200 && anonDetail.data?.order?.id === orderA.id);
    check('匿名用户不可助力', anonDetail.data.order.canAssist === false && /登录/.test(anonDetail.data.order.assistHint));
    const anonAssist = await request(`/api/bargains/${orderA.id}/assist`, { method: 'POST', body: { requestId: 'anon' } });
    check('未登录助力被拒绝', anonAssist.status === 401, String(anonAssist.status));

    const heView = await request(`/api/bargains/${orderA.id}`, { token: he.token });
    check('好友可助力', heView.data?.order?.canAssist === true && heView.data.order.myCutCount === 0);

    /* 6. 随机助力与幂等 */
    const assist1 = await request(`/api/bargains/${orderA.id}/assist`, {
      method: 'POST', token: he.token, body: { requestId: 'he-r1', cutCents: 99999999, price: 0.01 }
    });
    check('助力成功并随机砍价', assist1.status === 200 && assist1.data?.cut > 0 && assist1.data?.duplicated === false, JSON.stringify(assist1.data));
    const afterAssist1 = assist1.data.order;
    check('助力金额不超过剩余差价', afterAssist1.currentPrice === orderA.startPrice - assist1.data.cut && afterAssist1.currentPrice > afterAssist1.floorPrice, JSON.stringify({ current: afterAssist1.currentPrice, cut: assist1.data.cut }));
    check('进度与助力列表实时同步', afterAssist1.progress > 0 && afterAssist1.helperCount === 1 && afterAssist1.helpers.length === 1 && afterAssist1.helpers[0].helperId === he.user.id);

    const replay1 = await request(`/api/bargains/${orderA.id}/assist`, {
      method: 'POST', token: he.token, body: { requestId: 'he-r1', cutCents: 99999999 }
    });
    check('重复助力幂等返回', replay1.status === 200 && replay1.data?.duplicated === true, JSON.stringify(replay1.data));
    check('幂等请求不重复砍价', replay1.data.order.currentPrice === afterAssist1.currentPrice && replay1.data.order.myCutCount === 1, JSON.stringify(replay1.data.order.currentPrice));

    const assist2 = await request(`/api/bargains/${orderA.id}/assist`, { method: 'POST', token: he.token, body: { requestId: 'he-r2' } });
    check('同一好友可助力多次（受上限约束）', assist2.status === 200 && assist2.data.order.myCutCount === 2, JSON.stringify(assist2.data.order.myCutCount));

    const assist3 = await request(`/api/bargains/${orderA.id}/assist`, { method: 'POST', token: he.token, body: { requestId: 'he-r3' } });
    check('单个用户助力次数用完被拦截', assist3.status === 429, `${assist3.status} ${JSON.stringify(assist3.data)}`);

    const guoAssist = await request(`/api/bargains/${orderA.id}/assist`, { method: 'POST', token: guo.token, body: { requestId: 'guo-r1' } });
    check('人数达上限的最后一击直接砍到底价', guoAssist.status === 200 && guoAssist.data.completed === true, JSON.stringify(guoAssist.data));
    check('成交价等于底价且进度 100%', guoAssist.data.order.currentPrice === guoAssist.data.order.floorPrice && guoAssist.data.order.progress === 100 && guoAssist.data.order.status === 'success', JSON.stringify(guoAssist.data.order));

    const wangAssist = await request(`/api/bargains/${orderA.id}/assist`, { method: 'POST', token: wang.token, body: { requestId: 'wang-r1' } });
    check('已砍到底价后不可继续助力', wangAssist.status === 400, String(wangAssist.status));

    const detailA = await request(`/api/bargains/${orderA.id}`, { token: buyer.token });
    check('助力人数不超过活动上限', detailA.data.order.helperCount === 2 && detailA.data.order.helperCount <= detailA.data.order.maxHelpers);
    check('已助力用户列表完整', detailA.data.order.helpers.length === 3 && detailA.data.order.helpers.some((h) => h.helperId === guo.user.id));

    /* 7. 砍价成功后购买 */
    const purchaseEarly = await request(`/api/bargains/${orderA.id}/purchase`, { method: 'POST', token: buyer.token, body: { channel: 'wechat' } });
    check('成功后可创建专享价支付单', purchaseEarly.status === 201 && purchaseEarly.data?.amount === detailA.data.order.floorPrice, JSON.stringify(purchaseEarly.data));
    check('支付单待支付且金额来自服务端', purchaseEarly.data?.payment?.status === 'pending' && purchaseEarly.data?.payment?.amount === detailA.data.order.floorPrice, JSON.stringify(purchaseEarly.data?.payment));
    const payId = purchaseEarly.data.payment.id;
    const paid = await request(`/api/payments/${payId}/simulate`, { method: 'POST', token: buyer.token, body: { result: 'success' } });
    check('砍价专享价支付成功', paid.status === 200 && paid.data?.payment?.status === 'paid', JSON.stringify(paid.data));

    const afterPaid = await request(`/api/bargains/${orderA.id}`, { token: buyer.token });
    check('支付后砍价单标记已购买', afterPaid.data.order.purchased === true && afterPaid.data.order.purchaseOrderStatus === 'completed', JSON.stringify({ purchased: afterPaid.data.order.purchased, status: afterPaid.data.order.purchaseOrderStatus }));

    const repeatPurchase = await request(`/api/bargains/${orderA.id}/purchase`, { method: 'POST', token: buyer.token, body: { channel: 'wechat' } });
    check('已购买不可重复下单', repeatPurchase.status === 409, String(repeatPurchase.status));

    const otherPurchase = await request(`/api/bargains/${orderA.id}/purchase`, { method: 'POST', token: he.token, body: { channel: 'wechat' } });
    check('非发起人不可按砍价价购买', otherPurchase.status === 403, String(otherPurchase.status));

    /* 8. 快照防篡改：活动改价不影响已创建砍价单 */
    const updatedRules = await request(`/api/admin/bargains/${activityA.id}`, {
      method: 'PATCH', token: admin.token, body: { floorPrice: 6, startPrice: matA.price / 100 }
    });
    check('管理后台可调整活动规则', updatedRules.status === 200 && updatedRules.data.item.floorPrice === 600, JSON.stringify(updatedRules.data.item?.floorPrice));
    const snapshotDetail = await request(`/api/bargains/${orderA.id}`, { token: buyer.token });
    check('已创建砍价单保留原规则快照', snapshotDetail.data.order.floorPrice === activityA.floorPrice, JSON.stringify({ floor: snapshotDetail.data.order.floorPrice }));

    /* 9. 过期结算 */
    const actD = await request('/api/admin/bargains', {
      method: 'POST', token: admin.token,
      body: { materialId: matD.id, startPrice: matD.price / 100, floorPrice: 6, durationHours: 1, maxCutsPerUser: 1, maxHelpers: 3 }
    });
    const orderD = await request('/api/bargains', { method: 'POST', token: wang.token, body: { materialId: matD.id } });
    check('创建用于过期测试的砍价单', actD.status === 201 && orderD.status === 201, `${actD.status}/${orderD.status}`);

    const purchaseBeforeSuccess = await request(`/api/bargains/${orderD.data.orderId}/purchase`, { method: 'POST', token: wang.token, body: { channel: 'wechat' } });
    check('未砍到底价不可购买', purchaseBeforeSuccess.status === 400, `${purchaseBeforeSuccess.status} ${JSON.stringify(purchaseBeforeSuccess.data)}`);

    const sqlite = new DatabaseSync(path.join(DATA_DIR, 'xueya.db'));
    sqlite.exec('PRAGMA busy_timeout = 3000;');
    sqlite.prepare("UPDATE bargain_orders SET expires_at = '2000-01-01 00:00:00' WHERE id = ?").run(orderD.data.orderId);
    sqlite.close();

    const expiredDetail = await request(`/api/bargains/${orderD.data.orderId}`, { token: wang.token });
    check('过期砍价单状态实时结算', expiredDetail.data?.order?.status === 'expired' && expiredDetail.data.order.expired === true, JSON.stringify(expiredDetail.data?.order?.status));
    const expiredAssist = await request(`/api/bargains/${orderD.data.orderId}/assist`, { method: 'POST', token: he.token, body: { requestId: 'expired-1' } });
    check('过期后不可助力', expiredAssist.status === 400, String(expiredAssist.status));
    const expiredPurchase = await request(`/api/bargains/${orderD.data.orderId}/purchase`, { method: 'POST', token: wang.token, body: { channel: 'wechat' } });
    check('过期后不可购买', expiredPurchase.status === 400, String(expiredPurchase.status));

    const reCreate = await request('/api/bargains', { method: 'POST', token: wang.token, body: { materialId: matD.id } });
    check('过期后可基于同一活动重新发起', reCreate.status === 201 && reCreate.data.orderId !== orderD.data.orderId, JSON.stringify({ status: reCreate.status }));

    /* 10. 并发助力一致性 */
    const actB = await request('/api/admin/bargains', {
      method: 'POST', token: admin.token,
      body: { materialId: matB.id, startPrice: matB.price / 100, floorPrice: 5, durationHours: 24, maxCutsPerUser: 1, maxHelpers: 5 }
    });
    const orderB = await request('/api/bargains', { method: 'POST', token: he.token, body: { materialId: matB.id } });
    check('创建并发测试砍价单', actB.status === 201 && orderB.status === 201);

    const concurrent = await Promise.all([buyer, guo, wang, liu].map((u, i) => request(`/api/bargains/${orderB.data.orderId}/assist`, {
      method: 'POST', token: u.token, body: { requestId: `concurrent-${i}` }
    })));
    check('并发助力全部成功', concurrent.every((r) => r.status === 200), JSON.stringify(concurrent.map((r) => r.status)));
    const afterConcurrent = await request(`/api/bargains/${orderB.data.orderId}`, { token: he.token });
    check('并发后助力人数与记录一致', afterConcurrent.data.order.helperCount === 4 && afterConcurrent.data.order.totalCuts === 4, JSON.stringify({ helpers: afterConcurrent.data.order.helperCount, cuts: afterConcurrent.data.order.totalCuts }));
    check('并发后价格未击穿底价', afterConcurrent.data.order.currentPrice >= afterConcurrent.data.order.floorPrice, JSON.stringify({ current: afterConcurrent.data.order.currentPrice, floor: afterConcurrent.data.order.floorPrice }));

    const finalAssist = await request(`/api/bargains/${orderB.data.orderId}/assist`, { method: 'POST', token: lin.token, body: { requestId: 'final-1' } });
    check('第 5 位好友助力完成砍价', finalAssist.status === 200 && finalAssist.data.completed === true && finalAssist.data.order.currentPrice === finalAssist.data.order.floorPrice, JSON.stringify(finalAssist.data.order?.currentPrice));

    const actC = await request('/api/admin/bargains', {
      method: 'POST', token: admin.token,
      body: { materialId: matC.id, startPrice: matC.price / 100, floorPrice: 4, durationHours: 24, maxCutsPerUser: 2, maxHelpers: 5 }
    });
    const orderC = await request('/api/bargains', { method: 'POST', token: guo.token, body: { materialId: matC.id } });
    const sameKey = await Promise.all(Array.from({ length: 3 }, () => request(`/api/bargains/${orderC.data.orderId}/assist`, {
      method: 'POST', token: he.token, body: { requestId: 'same-key-1' }
    })));
    const sameKeyDetail = await request(`/api/bargains/${orderC.data.orderId}`, { token: he.token });
    check('并发重复助力仅生效一次', sameKeyDetail.data.order.myCutCount === 1 && sameKeyDetail.data.order.totalCuts === 1, JSON.stringify({ cuts: sameKeyDetail.data.order.totalCuts }));
    check('重复请求均返回成功（幂等）', sameKey.every((r) => r.status === 200), JSON.stringify(sameKey.map((r) => r.status)));

    /* 11. 删除约束与我的砍价 */
    const deleteWithOrders = await request(`/api/admin/bargains/${actC.data.item.id}`, { method: 'DELETE', token: admin.token });
    check('已产生砍价单的活动不可删除', deleteWithOrders.status === 409, String(deleteWithOrders.status));

    const actE = await request('/api/admin/bargains', {
      method: 'POST', token: admin.token,
      body: { materialId: matE.id, startPrice: matE.price / 100, floorPrice: 5, durationHours: 24, maxCutsPerUser: 1, maxHelpers: 3 }
    });
    const deleteEmpty = await request(`/api/admin/bargains/${actE.data.item.id}`, { method: 'DELETE', token: admin.token });
    check('无砍价单的活动可删除', deleteEmpty.status === 200, `${deleteEmpty.status} ${JSON.stringify(deleteEmpty.data)}`);

    const mine = await request('/api/bargains/mine', { token: buyer.token });
    const mineItems = mine.data?.items || [];
    check('我的砍价列表', mine.status === 200 && mineItems.some((o) => o.id === orderA.id), String(mineItems.length));
    check('我的砍价状态分类统计', mine.data?.counts?.success >= 1, JSON.stringify(mine.data?.counts));

    const mineHe = await request('/api/bargains/mine', { token: he.token });
    check('他人发起单出现在其本人列表', (mineHe.data?.items || []).some((o) => o.id === orderB.data.orderId));
    const mineOther = await request('/api/bargains/mine', { token: liu.token });
    check('砍价列表按用户隔离', !(mineOther.data?.items || []).some((o) => o.id === orderA.id), String((mineOther.data?.items || []).length));

    /* 12. 活动上下架不影响已创建砍价单 */
    const offlineA = await request(`/api/admin/bargains/${activityA.id}`, { method: 'PATCH', token: admin.token, body: { status: 'offline' } });
    const orderStillThere = await request(`/api/bargains/${orderA.id}`);
    check('活动下架后已创建砍价单仍可访问', offlineA.status === 200 && orderStillThere.status === 200 && orderStillThere.data.order.id === orderA.id);
  } finally {
    child.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
