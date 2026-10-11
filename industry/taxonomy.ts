// A股财经 V1 分类、标签、机构主体和身份保护。网址 key 上线后保持稳定。
export const CATEGORIES = [
  { key: "market", label: "市场", section: "市场动态", guide: "指数、板块、成交额、资金流、涨跌停及市场交易表现；产品价格变化归行业，宏观数据归宏观" },
  { key: "company", label: "公司", section: "公司动态", guide: "公司经营、业绩预告/快报/财报、订单合同与产品商业化；IPO、融资、并购、控制权、回购增减持归资本" },
  { key: "industry", label: "行业", section: "产业趋势", guide: "产业供需、产能、产品价格与产业链变化，包括半导体、AI算力、机器人等产业化事实；板块股价变化归市场" },
  { key: "policy", label: "政策", section: "政策与监管", guide: "正式政策发布、监管决定、交易所规则及产业政策；宏观数据发布归宏观，政策影响分析按研究对象分类" },
  { key: "capital", label: "资本", section: "资本运作", guide: "IPO、再融资、定增、可转债、并购重组、资产注入、控制权、股权变化、回购及增减持，不因主体是公司而归公司" },
  { key: "macro", label: "宏观", section: "宏观经济", guide: "宏观数据、经济变化、利率汇率及海外宏观向中国市场的传导；正式政策决定归政策" },
] as const;

// 类型以核心事件为准；纯观点按研究对象归入上述六个类别。
export const ITEM_TYPES = ["market_move", "company_event", "industry_event", "policy_event", "capital_event", "macro_event", "opinion_analysis"] as const;

/** 第一个标签为分类标签；公司动态不意味着正式公告，机构观点不意味着个人评论。 */
export const CATEGORY_TAGS = [
  "市场异动", "公司动态", "公司公告", "业绩", "产业趋势", "政策监管", "资本运作", "宏观数据", "机构观点", "其他",
] as const;

export const TOPIC_TAGS = [
  "半导体", "AI算力", "机器人", "创新药", "新能源", "汽车", "消费", "房地产", "金融", "军工", "有色", "化工", "能源", "光伏", "储能", "港股",
  "IPO", "并购重组", "增持回购", "业绩增长", "业绩下滑", "订单合同", "涨价", "降价",
  "光通信", "液冷", "半导体设备", "半导体材料", "先进封装", "机器人执行器", "机器人传感器", "创新药临床", "创新药审批", "创新药授权",
] as const;

export const ENTITY_TAGS = ["中国证监会", "上交所", "深交所", "北交所", "中国人民银行", "国家统计局", "港交所"] as const;

export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  "市场动态": "市场异动", "板块异动": "市场异动",
  "经营动态": "公司动态", "公司经营": "公司动态", "上市公司公告": "公司公告",
  "财报": "业绩", "业绩预告": "业绩", "业绩快报": "业绩",
  "行业动态": "产业趋势", "行业趋势": "产业趋势", "产业链趋势": "产业趋势",
  "政策": "政策监管", "监管": "政策监管", "政策/监管": "政策监管", "政策与监管": "政策监管",
  "融资": "资本运作", "收购": "资本运作", "重组": "资本运作", "资本动作": "资本运作",
  "宏观经济": "宏观数据", "经济数据": "宏观数据", "机构研究": "机构观点",
  "人工智能算力": "AI算力", "首次公开发行": "IPO", "ipo": "IPO",
  "并购": "并购重组", "增持": "增持回购", "回购": "增持回购",
  "业绩下降": "业绩下滑", "订单": "订单合同", "重大合同": "订单合同",
  "价格上涨": "涨价", "价格下跌": "降价",
  "光模块": "光通信", "光互连": "光通信", "服务器液冷": "液冷", "数据中心液冷": "液冷",
  "半导体制造设备": "半导体设备", "芯片制造设备": "半导体设备", "芯片制造材料": "半导体材料", "晶圆材料": "半导体材料",
  "芯片先进封装": "先进封装", "半导体先进封装": "先进封装",
  "机器人关节执行器": "机器人执行器", "机器人关节模组": "机器人执行器",
  "机器人力矩传感器": "机器人传感器", "机器人触觉传感器": "机器人传感器",
  "创新药临床试验": "创新药临床", "新药临床研究": "创新药临床",
  "创新药获批": "创新药审批", "新药上市审批": "创新药审批",
  "创新药许可交易": "创新药授权", "创新药对外授权": "创新药授权",
  "中国证券监督管理委员会": "中国证监会", "上海证券交易所": "上交所", "深圳证券交易所": "深交所", "北京证券交易所": "北交所",
  "中国央行": "中国人民银行", "香港交易所": "港交所",
};

export const CATEGORY_BY_ITEM_TYPE: Readonly<Record<string, string>> = {
  market_move: "市场异动", company_event: "公司动态", industry_event: "产业趋势",
  policy_event: "政策监管", capital_event: "资本运作", macro_event: "宏观数据", opinion_analysis: "其他",
};

/** V1 仅维护七个机构；未知上市公司保留在标题、摘要与 fact.subject，不冒充机构主体。 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[] }> = {
  csrc: { name: "中国证监会", displayTag: "中国证监会", aliases: ["中国证券监督管理委员会", "中国证监会", "CSRC"] },
  sse: { name: "上交所", displayTag: "上交所", aliases: ["上海证券交易所", "上交所", "Shanghai Stock Exchange"] },
  szse: { name: "深交所", displayTag: "深交所", aliases: ["深圳证券交易所", "深交所", "Shenzhen Stock Exchange"] },
  bse: { name: "北交所", displayTag: "北交所", aliases: ["北京证券交易所", "北交所", "Beijing Stock Exchange"] },
  pboc: { name: "中国人民银行", displayTag: "中国人民银行", aliases: ["中国人民银行", "中国央行", "People's Bank of China", "PBOC"] },
  nbs: { name: "国家统计局", displayTag: "国家统计局", aliases: ["国家统计局", "中国国家统计局", "National Bureau of Statistics of China"] },
  hkex: { name: "港交所", displayTag: "港交所", aliases: ["香港交易所", "香港交易及结算所有限公司", "港交所", "HKEX"] },
};

/** 不使用裸证监会/央行/SSE/NBS等歧义词，避免把外国机构或技术缩写错归中国机构。 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "csrc", name: "中国证监会", patterns: [/中国证券监督管理委员会|中国证监会|\bCSRC\b/i] },
  { id: "sse", name: "上交所", patterns: [/上海证券交易所|上交所|Shanghai Stock Exchange/i] },
  { id: "szse", name: "深交所", patterns: [/深圳证券交易所|深交所|Shenzhen Stock Exchange/i] },
  { id: "bse", name: "北交所", patterns: [/北京证券交易所|北交所|Beijing Stock Exchange/i] },
  { id: "pboc", name: "中国人民银行", patterns: [/中国人民银行|中国央行|People['’]s Bank of China|\bPBOC\b/i] },
  { id: "nbs", name: "国家统计局", patterns: [
    /(?:中国|中华人民共和国)国家统计局|\bNational Bureau of Statistics of China\b/i,
    // 简称仅从句首/标点或其后的据/根据归因开始，不截取地域修饰词内的子串；空格本身不是机构边界。
    /(?:^|[\p{P}\r\n])\s*(?:据\s*|根据\s*)?国家统计局/u,
  ] },
  { id: "hkex", name: "港交所", patterns: [/香港交易所|香港交易及结算所有限公司|港交所|\bHKEX\b/i] },
];

// 现有媒体域名不等于机构身份；待信源所有权核实后再添加映射。
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [];
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [];
