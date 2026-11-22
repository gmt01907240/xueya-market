'use strict';

const AUDIT_CATEGORIES = ['涉政', '涉恐', '涉黄', '涉赌', '涉毒', '暴力诈骗', '违禁物品', '侵权盗版'];

const AUDIT_LEVELS = [
  { key: 'block', text: '直接拦截' },
  { key: 'review', text: '人工复核' },
  { key: 'watch', text: '关注项' }
];

const DEFAULT_SETTINGS = {
  enabled: 1,
  reviewThreshold: 30,
  blockThreshold: 80,
  maxScanChars: 200000
};

const DEFAULT_RULES = [
  /* ---- 涉政 ---- */
  {
    code: 'POL_BLOCK_001', category: '涉政', level: 'block', weight: 100, matchType: 'regex',
    pattern: '(推翻|颠覆)(国家)?(政权|政府)|分裂国家|煽动分裂',
    tip: '涉及煽动颠覆国家政权或分裂国家'
  },
  {
    code: 'POL_BLOCK_002', category: '涉政', level: 'block', weight: 100, matchType: 'regex',
    pattern: '煽动颠覆|暴力革命|推翻(共产党|中共)',
    tip: '涉及煽动颠覆、暴力革命等危害国家安全内容'
  },
  {
    code: 'POL_BLOCK_003', category: '涉政', level: 'block', weight: 100, matchType: 'keyword',
    pattern: '台独|藏独|疆独|港独|法轮功|全能神',
    tip: '涉及分裂势力或非法组织'
  },
  {
    code: 'POL_REVIEW_001', category: '涉政', level: 'review', weight: 25, matchType: 'keyword',
    pattern: '政治庇护|反华势力|敏感政治|抗议游行',
    tip: '涉及敏感政治话题，需人工判断语境'
  },
  {
    code: 'POL_REVIEW_002', category: '涉政', level: 'review', weight: 25, matchType: 'regex',
    pattern: '(领导人|国家主席|总书记).{0,8}(丑化|侮辱|攻击|抹黑)',
    tip: '涉及对领导人的攻击性表述'
  },

  /* ---- 涉恐 ---- */
  {
    code: 'TER_BLOCK_001', category: '涉恐', level: 'block', weight: 100, matchType: 'keyword',
    pattern: '恐怖袭击|恐怖组织|极端组织|圣战|基地组织|ISIS',
    tip: '涉及恐怖组织或恐怖主义宣传'
  },
  {
    code: 'TER_BLOCK_002', category: '涉恐', level: 'block', weight: 100, matchType: 'regex',
    pattern: '(制作|自制|组装).{0,6}(炸弹|爆炸物|炸药|爆炸装置)|炸弹制作|制爆教程',
    tip: '涉及爆炸物制作方法或教程'
  },
  {
    code: 'TER_BLOCK_003', category: '涉恐', level: 'block', weight: 100, matchType: 'regex',
    pattern: '(圣战|恐怖).{0,8}(招募|训练|袭击)|恐怖袭击教程',
    tip: '涉及恐怖活动招募或训练'
  },

  /* ---- 涉黄 ---- */
  {
    code: 'POR_REVIEW_001', category: '涉黄', level: 'review', weight: 20, matchType: 'keyword',
    pattern: '色情|淫秽|裸聊|招嫖|卖淫|嫖娼',
    tip: '涉及色情或性交易相关表述'
  },
  {
    code: 'POR_REVIEW_002', category: '涉黄', level: 'review', weight: 20, matchType: 'keyword',
    pattern: '成人视频|黄片|福利视频|约炮|一夜情',
    tip: '涉及低俗色情内容'
  },
  {
    code: 'POR_BLOCK_001', category: '涉黄', level: 'block', weight: 100, matchType: 'regex',
    pattern: '(提供|出售|购买|上门).{0,8}(色情|淫秽|性服务|特殊服务)',
    tip: '涉及色情内容的交易或服务'
  },
  {
    code: 'POR_BLOCK_002', category: '涉黄', level: 'block', weight: 100, matchType: 'regex',
    pattern: '(未成年|学生妹).{0,8}(色情|性行为|裸照)',
    tip: '涉及未成年人色情内容'
  },

  /* ---- 涉赌 ---- */
  {
    code: 'GAM_REVIEW_001', category: '涉赌', level: 'review', weight: 20, matchType: 'keyword',
    pattern: '赌博|博彩|赌球|百家乐|六合彩|时时彩|网络赌场',
    tip: '涉及赌博或博彩相关表述'
  },
  {
    code: 'GAM_BLOCK_001', category: '涉赌', level: 'block', weight: 100, matchType: 'regex',
    pattern: '(开户|充值|下注|投注|注册).{0,10}(赌博|博彩|彩票平台|娱乐城)',
    tip: '涉及引导参与网络赌博'
  },
  {
    code: 'GAM_BLOCK_002', category: '涉赌', level: 'block', weight: 100, matchType: 'keyword',
    pattern: '赌博网站|博彩平台|拉人下注|代理返佣',
    tip: '涉及赌博平台推广或代理拉人'
  },

  /* ---- 涉毒 ---- */
  {
    code: 'DRU_REVIEW_001', category: '涉毒', level: 'review', weight: 25, matchType: 'keyword',
    pattern: '毒品|冰毒|海洛因|大麻|摇头丸|K粉|可卡因',
    tip: '涉及毒品相关表述，需人工判断语境'
  },
  {
    code: 'DRU_BLOCK_001', category: '涉毒', level: 'block', weight: 100, matchType: 'regex',
    pattern: '(出售|购买|代购|制作|提炼|贩卖).{0,8}(毒品|冰毒|海洛因|大麻|摇头丸)',
    tip: '涉及毒品的制作、贩卖或购买'
  },
  {
    code: 'DRU_BLOCK_002', category: '涉毒', level: 'block', weight: 100, matchType: 'keyword',
    pattern: '制毒|贩毒|吸毒工具|溜冰壶',
    tip: '涉及制毒、贩毒或吸毒工具'
  },

  /* ---- 暴力诈骗 ---- */
  {
    code: 'VIO_BLOCK_001', category: '暴力诈骗', level: 'block', weight: 100, matchType: 'regex',
    pattern: '(兼职|日结|刷单).{0,10}(返利|佣金|垫付)|刷单返利',
    tip: '涉及刷单返利类诈骗'
  },
  {
    code: 'VIO_BLOCK_002', category: '暴力诈骗', level: 'block', weight: 100, matchType: 'keyword',
    pattern: '杀猪盘|冒充公检法|冒充客服|洗钱|跑分|出租银行卡|出售银行卡',
    tip: '涉及电信诈骗或洗钱黑产'
  },
  {
    code: 'VIO_REVIEW_001', category: '暴力诈骗', level: 'review', weight: 20, matchType: 'keyword',
    pattern: '诈骗|骗局|网络兼职|高薪兼职',
    tip: '涉及诈骗相关表述，需人工核实'
  },
  {
    code: 'VIO_REVIEW_002', category: '暴力诈骗', level: 'review', weight: 20, matchType: 'keyword',
    pattern: '砍人|杀人|血腥|虐杀|暴力袭击',
    tip: '涉及暴力或血腥内容'
  },
  {
    code: 'VIO_BLOCK_003', category: '暴力诈骗', level: 'block', weight: 100, matchType: 'regex',
    pattern: '(教程|方法|步骤).{0,6}(杀人|伤人|投毒|绑架)',
    tip: '涉及暴力犯罪方法或教程'
  },
  {
    code: 'VIO_REVIEW_003', category: '暴力诈骗', level: 'review', weight: 30, matchType: 'keyword',
    pattern: '自杀|自残',
    tip: '涉及自伤自残内容，需人工关怀与研判'
  },
  {
    code: 'VIO_BLOCK_004', category: '暴力诈骗', level: 'block', weight: 100, matchType: 'keyword',
    pattern: '相约自杀|自杀教程',
    tip: '涉及诱导或教唆自伤自杀'
  },

  /* ---- 违禁物品 ---- */
  {
    code: 'BAN_REVIEW_001', category: '违禁物品', level: 'review', weight: 20, matchType: 'keyword',
    pattern: '管制刀具|仿真枪|窃听器|定位器|迷药|催情药',
    tip: '涉及违禁或管制物品'
  },
  {
    code: 'BAN_BLOCK_001', category: '违禁物品', level: 'block', weight: 100, matchType: 'regex',
    pattern: '(出售|购买|代购).{0,8}(枪支|弹药|管制刀具|迷药|窃听器)',
    tip: '涉及违禁物品的买卖'
  },

  /* ---- 侵权盗版 ---- */
  {
    code: 'IP_REVIEW_001', category: '侵权盗版', level: 'review', weight: 15, matchType: 'keyword',
    pattern: '盗版|破解版|翻录|盗录|枪版',
    tip: '涉及盗版或未经授权转载'
  },
  {
    code: 'IP_REVIEW_002', category: '侵权盗版', level: 'review', weight: 15, matchType: 'regex',
    pattern: '(出售|代购|分享).{0,8}(盗版|破解版|翻录)',
    tip: '涉及盗版资源的传播或交易'
  },

  /* ---- 学术黑产（平台治理） ---- */
  {
    code: 'ACA_REVIEW_001', category: '侵权盗版', level: 'review', weight: 20, matchType: 'regex',
    pattern: '(代考|代写|包过).{0,8}(论文|作业|考试|课程)',
    tip: '涉及代考代写等学术不端服务'
  },
  {
    code: 'ACA_WATCH_001', category: '侵权盗版', level: 'watch', weight: 10, matchType: 'keyword',
    pattern: '内部试题|泄题|原题泄露',
    tip: '涉及试题泄露风险，建议人工关注'
  }
];

module.exports = { AUDIT_CATEGORIES, AUDIT_LEVELS, DEFAULT_SETTINGS, DEFAULT_RULES };
