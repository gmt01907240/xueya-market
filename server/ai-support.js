'use strict';

const { sendJson, fail } = require('./http');
const runtime = require('./runtime-config');
const { now } = require('./db');

const HOT_QUESTIONS = [
  '如何完成实名认证？',
  '支持哪些支付方式？',
  '购买后怎么下载资料？',
  '怎么申请退款？',
  '上传资料需要什么条件？',
  '院校 / 学科 / 教师怎么搜索？'
];

const INTENTS = [
  {
    id: 'verify',
    name: '实名与高校认证',
    keywords: [['认证', 3], ['实名', 3], ['学号', 2], ['学生证', 2], ['身份', 1], ['审核', 1]],
    answer:
      '完成认证：登录后进入「个人中心 → 实名与高校认证」，选择所在院校并填写真实姓名、学号（6—20 位字母或数字），提交后由管理员审核。\n审核通过前不能购买、上传或发布求购；认证通过后院校信息会锁定，如需变更请提交客服工单。',
    suggestions: ['认证需要多久？', '认证后能做什么？', '院校填错了怎么办？']
  },
  {
    id: 'payment',
    name: '购买与支付方式',
    keywords: [['支付', 3], ['付款', 3], ['微信', 2], ['支付宝', 2], ['银行卡', 2], ['下单', 2], ['购买', 1], ['充值', 2], ['提现', 2]],
    answer:
      '平台所有交易都在站内完成：在资料详情页点击购买后，会弹出统一支付窗口，可选择微信支付、支付宝或银行卡。\n平台不提供充值、提现与余额支付；付款成功后订单立即完成并开放完整文件下载。支付回调会做验签、金额校验与幂等落账，若支付状态未更新，可在「我的订单」刷新或提交工单。',
    suggestions: ['支持哪些支付方式？', '支付成功但订单未更新怎么办？', '可以退款吗？']
  },
  {
    id: 'download',
    name: '下载与文件交付',
    keywords: [['下载', 3], ['文件', 2], ['打不开', 2], ['交付', 2], ['订单', 1], ['预览', 1]],
    answer:
      '购买成功后可在「个人中心 → 我的订单」或资料详情页重复下载完整文件。\n未购买时只能查看试读片段，试读区已禁用复制、右键与下载。若下载失败，请确认登录状态与网络，再提交工单并附上资料名称与浏览器信息。',
    suggestions: ['购买后怎么下载资料？', '预览可以复制吗？', '下载失败怎么办？']
  },
  {
    id: 'refund',
    name: '退款与售后',
    keywords: [['退款', 3], ['售后', 2], ['投诉', 2], ['退钱', 3], ['不符', 2], ['维权', 2]],
    answer:
      '在「个人中心 → 我的订单」找到对应订单提交退款申请，管理员会在 48 小时内核实处理；交易投诉可同时在客服中心提交工单。\n已下载或已确认交付的订单需说明具体理由，平台会根据资料描述一致性与版权情况判定。',
    suggestions: ['怎么申请退款？', '投诉多久处理？', '资料与描述不符怎么办？']
  },
  {
    id: 'upload',
    name: '上传与内容审核',
    keywords: [['上传', 3], ['发布', 2], ['审核', 2], ['通过', 1], ['下架', 2], ['违规', 2]],
    answer:
      '上传资料需要先完成实名与高校认证。进入「上传资料」，填写标题、院校、学科、授课老师、课程与价格，系统会自动生成试读片段并执行内容自动审核。\n命中直接拦截规则的内容不会入库；疑似内容会转人工复核。审核通过后自动上架，可在「卖家中心」查看状态。',
    suggestions: ['上传资料需要什么条件？', '审核多久能通过？', '资料被拒绝怎么办？']
  },
  {
    id: 'pricing',
    name: '定价与价格标准',
    keywords: [['定价', 3], ['价格', 2], ['推荐价', 3], ['多少钱', 2], ['标准库', 2]],
    answer:
      '平台价格标准库按「院校 + 学科 + 资料类型」维护参考价，上传时自动给出推荐价与可调区间，你可以一键采用或手动调整。\n匹配优先级为：精确组合 → 院校 + 类型 → 学科 + 类型 → 全平台类型参考价。',
    suggestions: ['推荐价怎么算？', '可以自己改价格吗？', '平台服务费是多少？']
  },
  {
    id: 'bargain',
    name: '好友砍价',
    keywords: [['砍价', 4], ['助力', 3], ['底价', 3], ['专享价', 2]],
    answer:
      '在资料详情页点击「发起砍价」即可生成专属砍价单，分享给好友后每位好友可助力一次。\n发起时会把价格与规则写入快照，之后修改活动不会影响已创建的砍价单；砍到底价后可按专享价直接购买，进度可在「我的砍价」查看。',
    suggestions: ['砍价怎么分享给好友？', '好友可以砍几次？', '砍到底价怎么购买？']
  },
  {
    id: 'catalog',
    name: '院校 / 学科 / 教师资源库',
    keywords: [['院校', 2], ['学校', 2], ['学科', 2], ['专业', 2], ['教师', 2], ['老师', 2], ['搜索', 1], ['资源库', 3], ['高校', 2]],
    answer:
      '顶部导航已新增「资源库」，院校、学科、教师三个模块各自支持全局搜索：输入关键词即可实时返回模糊匹配结果，并可直接跳转到资料市场查看对应资料。\n首页与资料市场的搜索仍按资料标题、课程、学科和老师匹配。',
    suggestions: ['院校库覆盖哪些学校？', '怎么按老师找资料？', '搜索没有结果怎么办？']
  },
  {
    id: 'ticket',
    name: '人工客服与工单',
    keywords: [['人工', 3], ['客服', 2], ['工单', 3], ['反馈', 2], ['联系', 1], ['电话', 2], ['热线', 3], ['时间', 1]],
    answer:
      '你可以随时询问 AI 智能客服（7×24 小时在线）。需要人工处理时，在「客服中心 → 提交反馈」选择问题类型并描述情况，系统会生成工单并支持状态追踪。\n人工客服暂未设置固定服务时间，处理进展会通过站内消息与工单状态同步。',
    suggestions: ['怎么提交工单？', '工单在哪里查看？', '人工客服什么时候回复？']
  },
  {
    id: 'copyright',
    name: '版权保护与举报',
    keywords: [['版权', 3], ['盗版', 3], ['侵权', 3], ['举报', 2], ['抄袭', 2]],
    answer:
      '如发现资料侵犯版权或与描述不符，可在资料详情页点击「举报」并选择原因；平台会在 48 小时内核实，违规资料将下架并冻结相关收益。\n也可以在客服中心提交「交易投诉」工单补充证据。',
    suggestions: ['怎么举报资料？', '举报后多久处理？', '盗版资料会被下架吗？']
  },
  {
    id: 'account',
    name: '账号与登录',
    keywords: [['密码', 3], ['登录', 2], ['账号', 2], ['注册', 2], ['邮箱', 1], ['忘记', 2]],
    answer:
      '登录支持「邮箱或用户名 + 密码」；登录后可在「个人中心」修改昵称、简介与密码。\n如果忘记密码，建议提交人工客服工单协助处理。为保障账号安全，请不要向他人透露密码或登录凭证。',
    suggestions: ['怎么注册账号？', '忘记密码怎么办？', '怎么修改昵称？']
  },
  {
    id: 'greeting',
    name: '问候',
    keywords: [['你好', 3], ['您好', 3], ['在吗', 3], ['嗨', 2], ['hello', 3], ['hi', 2]],
    answer:
      '你好，我是学涯集市 AI 智能客服，7×24 小时在线。\n你可以问我认证、购买支付、下载、退款、上传审核、定价、砍价、院校库搜索等问题。',
    suggestions: HOT_QUESTIONS.slice(0, 3)
  },
  {
    id: 'thanks',
    name: '感谢',
    keywords: [['谢谢', 3], ['感谢', 3], ['辛苦了', 2], ['好的', 1]],
    answer: '不客气～如果还有认证、交易或资料方面的问题，随时继续问我。',
    suggestions: ['如何完成实名认证？', '支持哪些支付方式？', '购买后怎么下载资料？']
  }
];

const FALLBACK = {
  id: 'fallback',
  name: '未匹配到明确意图',
  answer:
    '这个问题我暂时没有找到准确答案。你可以换个说法，或从下面的常见问题中选择。\n如果仍无法解决，建议在「客服中心 → 提交反馈」提交工单，人工客服会按工单顺序处理（暂未设置固定服务时间）。',
  suggestions: HOT_QUESTIONS
};

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ');
}

function answer(message) {
  const text = normalize(message);
  let best = null;
  let bestScore = 0;
  for (const intent of INTENTS) {
    let score = 0;
    for (const [keyword, weight] of intent.keywords) {
      if (text.includes(keyword)) score += weight;
    }
    if (score > bestScore) {
      bestScore = score;
      best = intent;
    }
  }
  const matched = best && bestScore >= 2;
  const intent = matched ? best : FALLBACK;
  return {
    intent: intent.id,
    intentName: intent.name,
    confidence: matched ? Math.min(0.98, Math.round((0.52 + bestScore * 0.08) * 100) / 100) : 0.2,
    reply: intent.answer,
    suggestions: intent.suggestions.slice(0, 4)
  };
}

function chat(ctx) {
  if (!runtime.feature('aiSupport')) return fail(ctx.res, 403, 'AI 客服暂未开放，请提交工单');
  const started = process.hrtime.bigint();
  const message = String(ctx.body.message || '').trim();
  if (!message) return fail(ctx.res, 400, '请输入咨询内容');
  if (message.length > 500) return fail(ctx.res, 400, '单条咨询请控制在 500 字以内');
  const result = answer(message);
  const responseMs = Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100;
  sendJson(ctx.res, 200, {
    ...result,
    question: message,
    answeredAt: now(),
    service: { mode: 'ai', available: true, hours: '7×24 小时', responseMs }
  });
}

function info(ctx) {
  sendJson(ctx.res, 200, {
    service: { mode: 'ai', available: true, hours: '7×24 小时' },
    welcome: '你好，我是学涯集市 AI 智能客服，7×24 小时在线。认证、支付、下载、退款、上传、定价、砍价等问题都可以问我。',
    hotQuestions: HOT_QUESTIONS,
    intents: INTENTS.filter((item) => !['greeting', 'thanks'].includes(item.id)).map((item) => item.name)
  });
}

module.exports = { chat, info, answer, HOT_QUESTIONS };
