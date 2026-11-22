/**
 * 学涯集市 · 院校/学科/教师资源库 + AI 智能客服全流程测试
 *
 * 覆盖：全国高校数据导入、三个模块的模糊搜索、分页与耗时、
 *       AI 客服意图识别、兜底回复、输入校验、免登录可用、
 *       新院校认证兼容性。
 *
 * 运行：npm run test:catalog
 * 说明：测试启动独立的临时数据目录服务（默认端口 3398），不影响现有数据。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adminLogin } from './admin-login-helper.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.CATALOG_TEST_PORT || 3398);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xueya-catalog-'));

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
  const started = performance.now();
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data, elapsed: performance.now() - started };
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
  console.log(`\n学涯集市资源库与 AI 客服测试 · ${BASE}\n`);

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, PAYMENT_MODE: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (buf) => process.stderr.write(`[server] ${buf}`));

  try {
    await waitForServer(child);

    /* 1. 数据扩充 */
    const meta = await request('/api/meta');
    check('院校库已扩充到 400 所以上', (meta.data?.schools || []).length >= 400, String((meta.data?.schools || []).length));
    check('学科库已扩充到 90 个以上', (meta.data?.subjects || []).length >= 90, String((meta.data?.subjects || []).length));
    check('院校列表包含新增高校（深圳大学）', (meta.data?.schools || []).includes('深圳大学'));
    check('院校列表包含 985 高校（清华大学）', (meta.data?.schools || []).includes('清华大学'));

    const overview = await request('/api/catalog/overview');
    check('资源库概览接口可用', overview.status === 200 && overview.data?.schools >= 400);
    check('概览返回院校/学科/教师统计', overview.data?.subjects >= 90 && overview.data?.teachers >= 400, JSON.stringify(overview.data && { s: overview.data.schools, su: overview.data.subjects, t: overview.data.teachers }));
    check('概览返回覆盖省份数', overview.data?.provinces >= 30, String(overview.data?.provinces));

    /* 2. 院校搜索 */
    const schoolSearch = await request('/api/catalog/search?type=school&q=' + encodeURIComponent('清华'));
    check('院校关键词搜索命中', schoolSearch.status === 200 && schoolSearch.data.total >= 1);
    check('院校搜索结果名称正确', schoolSearch.data?.items?.[0]?.name === '清华大学', JSON.stringify(schoolSearch.data?.items?.[0]));
    check('院校搜索返回省份与层次', Boolean(schoolSearch.data?.items?.[0]?.province) && Boolean(schoolSearch.data?.items?.[0]?.level));
    check('院校搜索耗时低于 1 秒', schoolSearch.data?.tookMs < 1000 && schoolSearch.elapsed < 1000, `${schoolSearch.data?.tookMs}ms / ${Math.round(schoolSearch.elapsed)}ms`);

    const schoolFuzzy = await request('/api/catalog/search?type=school&q=' + encodeURIComponent('师范'));
    check('院校模糊搜索返回多条结果', schoolFuzzy.data?.total >= 20, String(schoolFuzzy.data?.total));
    check('模糊搜索命中名称包含关键词', schoolFuzzy.data?.items?.some((item) => item.name.includes('师范')));

    const schoolMulti = await request('/api/catalog/search?type=school&q=' + encodeURIComponent('北京 大学'));
    check('多关键词组合搜索生效', schoolMulti.data?.total >= 1 && schoolMulti.data.items.every((item) => `${item.name}${item.province}${item.city}${item.level}`.includes('北京')), String(schoolMulti.data?.total));

    const schoolAll = await request('/api/catalog/search?type=school&limit=30');
    check('空关键词返回首屏院校', schoolAll.data?.items?.length === 30 && schoolAll.data.total >= 400, JSON.stringify({ len: schoolAll.data?.items?.length, total: schoolAll.data?.total }));
    const collator = new Intl.Collator('zh-Hans-CN', { collation: 'pinyin', numeric: true, sensitivity: 'base' });
    check('院校结果按名称首字母升序', (schoolAll.data?.items || []).every((item, i, arr) => i === 0 || collator.compare(arr[i - 1].name, item.name) <= 0));
    check('院校名单完整覆盖教育部官方名单', schoolAll.data?.total === 3196, String(schoolAll.data?.total));

    const majorSearch = await request('/api/catalog/search?type=major&q=' + encodeURIComponent('计算机'));
    check('专业库搜索命中计算机科学与技术', (majorSearch.data?.items || []).some((item) => item.name === '计算机科学与技术'));
    check('专业结果包含专业代码与门类 / 专业类', (majorSearch.data?.items || []).every((item) => item.code && item.category && item.className));
    const majorAll = await request('/api/catalog/search?type=major&limit=5');
    check('专业目录完整覆盖教育部本科专业目录', majorAll.data?.total === 883, String(majorAll.data?.total));

    const schoolPaged = await request('/api/catalog/search?type=school&limit=10&page=2');
    check('院校搜索支持分页', schoolPaged.data?.page === 2 && schoolPaged.data.items.length === 10 && schoolPaged.data.pages >= 40);

    /* 3. 学科搜索 */
    const subjectSearch = await request('/api/catalog/search?type=subject&q=' + encodeURIComponent('计算机'));
    const cs = (subjectSearch.data?.items || []).find((item) => item.name === '计算机科学与技术');
    check('学科搜索命中计算机科学与技术', Boolean(cs), JSON.stringify(subjectSearch.data?.items?.slice(0, 3)));
    check('学科结果包含门类与教师数量', Boolean(cs?.category) && cs?.teacherCount >= 1, JSON.stringify(cs));
    check('学科搜索耗时低于 1 秒', subjectSearch.data?.tookMs < 1000 && subjectSearch.elapsed < 1000, `${subjectSearch.data?.tookMs}ms`);

    const subjectCategory = await request('/api/catalog/search?type=subject&q=' + encodeURIComponent('医学'));
    check('学科支持按门类模糊匹配', subjectCategory.data?.total >= 8, String(subjectCategory.data?.total));

    /* 4. 教师搜索 */
    const teacherSubject = await request('/api/catalog/search?type=teacher&q=' + encodeURIComponent('数学'));
    check('教师按学科搜索', teacherSubject.data?.total >= 8 && teacherSubject.data.items.every((t) => `${t.name}${t.school}${t.subject}${t.title}`.includes('数学')), String(teacherSubject.data?.total));

    const teacherSchool = await request('/api/catalog/search?type=teacher&q=' + encodeURIComponent('浙江大学'));
    check('教师按院校搜索', teacherSchool.data?.total >= 5 && teacherSchool.data.items.every((t) => t.school === '浙江大学'), String(teacherSchool.data?.total));

    const teacherTitle = await request('/api/catalog/search?type=teacher&q=' + encodeURIComponent('教授'));
    check('教师按职称搜索', teacherTitle.data?.total >= 50, String(teacherTitle.data?.total));

    const teacherNamed = await request('/api/catalog/search?type=teacher&q=' + encodeURIComponent('陈立群'));
    check('教师按姓名精确搜索', teacherNamed.data?.items?.[0]?.name === '陈立群', JSON.stringify(teacherNamed.data?.items?.[0]));
    check('教师搜索耗时低于 1 秒', teacherNamed.data?.tookMs < 1000 && teacherNamed.elapsed < 1000, `${teacherNamed.data?.tookMs}ms`);

    check('非法搜索类型返回 400', (await request('/api/catalog/search?type=bad&q=x')).status === 400);
    const limitClamp = await request('/api/catalog/search?type=school&limit=999');
    check('limit 上限被钳制为 50', limitClamp.data?.limit === 50 && limitClamp.data.items.length <= 50, String(limitClamp.data?.limit));

    /* 5. AI 客服 */
    const info = await request('/api/support/ai');
    check('AI 客服信息接口免登录可用', info.status === 200 && info.data?.service?.available === true);
    check('AI 客服标注 7×24 小时', info.data?.service?.hours === '7×24 小时');
    check('AI 客服返回热门问题', (info.data?.hotQuestions || []).length >= 5);

    const verifyAnswer = await request('/api/support/ai', { method: 'POST', body: { message: '怎么完成实名认证？' } });
    check('AI 识别认证意图', verifyAnswer.data?.intent === 'verify', JSON.stringify(verifyAnswer.data));
    check('AI 认证回复包含操作路径', verifyAnswer.data?.reply?.includes('实名') && verifyAnswer.data?.reply?.includes('学号'));
    check('AI 回复附带追问建议', (verifyAnswer.data?.suggestions || []).length >= 2);
    check('AI 客服响应低于 1 秒', verifyAnswer.elapsed < 1000, `${Math.round(verifyAnswer.elapsed)}ms`);

    const payAnswer = await request('/api/support/ai', { method: 'POST', body: { message: '支持微信和支付宝付款吗？' } });
    check('AI 识别支付意图', payAnswer.data?.intent === 'payment');
    check('AI 支付回复说明三种渠道', ['微信', '支付宝', '银行卡'].every((k) => payAnswer.data.reply.includes(k)));
    check('AI 支付回复说明不提供充值提现', payAnswer.data.reply.includes('不提供充值'));

    const bargainAnswer = await request('/api/support/ai', { method: 'POST', body: { message: '砍价怎么让好友助力？' } });
    check('AI 识别砍价意图', bargainAnswer.data?.intent === 'bargain');

    const catalogAnswer = await request('/api/support/ai', { method: 'POST', body: { message: '院校和老师资源库怎么搜索？' } });
    check('AI 识别资源库意图', catalogAnswer.data?.intent === 'catalog', JSON.stringify(catalogAnswer.data && { intent: catalogAnswer.data.intent }));

    const greetingAnswer = await request('/api/support/ai', { method: 'POST', body: { message: '你好' } });
    check('AI 识别问候语', greetingAnswer.data?.intent === 'greeting');

    const fallbackAnswer = await request('/api/support/ai', { method: 'POST', body: { message: '帮我推荐一份量子纠缠实验的复习计划' } });
    check('AI 未命中时兜底回复', fallbackAnswer.data?.intent === 'fallback');
    check('AI 兜底建议提交工单', fallbackAnswer.data?.reply?.includes('提交反馈') || fallbackAnswer.data?.reply?.includes('工单'));

    check('AI 空消息返回 400', (await request('/api/support/ai', { method: 'POST', body: { message: '' } })).status === 400);
    check('AI 超长消息返回 400', (await request('/api/support/ai', { method: 'POST', body: { message: '问'.repeat(501) } })).status === 400);

    /* 6. 新院校认证兼容 */
    const adminAuth = await adminLogin(BASE);
    check('管理员专属入口密码+MFA 登录', adminAuth.ok === true && Boolean(adminAuth.token), JSON.stringify(adminAuth.data || {}));
    const admin = adminAuth;
    const tag = String(Date.now()).slice(-8);
    const reg = await request('/api/auth/register', {
      method: 'POST',
      body: {
        username: `catalog${tag}`,
        email: `catalog${tag}@xueya.test`,
        password: 'Catalog123456',
        nickname: '资源库测试',
        school: '深圳大学'
      }
    });
    check('可使用新增院校注册', [200, 201].includes(reg.status) && Boolean(reg.data?.token), JSON.stringify(reg.data));
    const newUser = { token: reg.data?.token, id: reg.data?.user?.id };
    const submitVerify = await request('/api/verify/submit', {
      method: 'POST', token: newUser.token,
      body: { realName: '资源库测试', school: '深圳大学', studentNo: `2024${tag}` }
    });
    check('新增院校可用于实名认证', submitVerify.status === 200, JSON.stringify(submitVerify.data));
    const approve = await request(`/api/admin/verifications/${newUser.id}/review`, {
      method: 'POST', token: admin.token, body: { action: 'approve' }
    });
    check('新增院校认证审核通过', approve.status === 200, JSON.stringify(approve.data));

    const verifyStatus = await request('/api/verify/status', { token: newUser.token });
    check('认证状态回显新院校', verifyStatus.data?.user?.verified === true && verifyStatus.data?.user?.school === '深圳大学', JSON.stringify(verifyStatus.data?.user));
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
