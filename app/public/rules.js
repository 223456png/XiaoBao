/* ============================================================
 * 消保审查规则层 v2
 * 设计原则：
 *   1. 规则层只保留高置信度、零歧义的匹配，用于毫秒级兜底；
 *   2. 词库改为四元组：category / pattern / examples / semantic_hint；
 *   3. 数据引用、特别标识显著性改为「要素核查」，不依赖词表；
 *   4. 主要判断职责交给大模型（按维度判断模式逐项审查）。
 * ============================================================ */

/* ---------- 法规锚点（供规则层与大模型共用，禁止编造条款号） ---------- */
const LAWS = {
  xfz10: '《中华人民共和国消费者权益保护法》第十条（消费者享有自主选择商品或者服务的权利）',
  xfz20: '《中华人民共和国消费者权益保护法》第二十条（经营者向消费者提供有关商品或服务的质量、性能、用途、有效期限等信息，应当真实、全面，不得作虚假或者引人误解的宣传）',
  ggf9: '《中华人民共和国广告法》第九条第（三）项（广告不得使用“国家级”“最高级”“最佳”等用语）',
  ggf13: '《中华人民共和国广告法》第十三条（广告不得贬低其他生产经营者的商品或者服务）',
  xb21: '《银行保险机构消费者权益保护管理办法》（银保监会令2022年第9号）第二十一条（银行保险机构应当以足以引起消费者注意的文字、符号、字体、颜色等特别标识，对限制消费者权利和加重消费者义务的事项进行说明，并合理揭示产品风险）',
  xb23: '《银行保险机构消费者权益保护管理办法》（银保监会令2022年第9号）第二十三条（不得有下列行为：（一）虚假、欺诈、隐瞒或者引人误解的宣传；（二）引用不真实、不准确的数据和资料或者隐瞒限制条件等，对过往业绩或者产品收益进行夸大表述；（三）利用金融管理部门对金融产品或者服务的审核或者备案程序，误导消费者认为金融管理部门已提供保证；（四）载明保本、无风险或者保收益等，对非保本投资型金融产品的未来效果、收益作出保证性承诺；（五）使用“国家级”“最高级”“最佳”“唯一”等极限类用语；（六）含有或隐含与性别、种族、宗教信仰相关的歧视性用语；（七）其他违反金融消费者权益保护及金融营销宣传相关法律法规和监管规定的内容）',
  yf316: '《关于进一步规范金融营销宣传行为的通知》（银发〔2019〕316号）（金融营销宣传负面清单：不得损害金融消费者知情权，不得利用政府公信力，不得对业绩或产品收益夸大表述，不得以不当方式吸引消费者）',
  xb23_1: '《银行保险机构消费者权益保护管理办法》（银保监会令2022年第9号）第二十三条第（一）项（不得进行虚假、欺诈、隐瞒或者引人误解的宣传）',
  xb23_2: '《银行保险机构消费者权益保护管理办法》（银保监会令2022年第9号）第二十三条第（二）项（不得引用不真实、不准确的数据和资料或者隐瞒限制条件等，对过往业绩或者产品收益进行夸大表述）',
  xb23_3: '《银行保险机构消费者权益保护管理办法》（银保监会令2022年第9号）第二十三条第（三）项（不得利用金融管理部门对金融产品或者服务的审核或者备案程序，误导消费者认为金融管理部门已提供保证）',
  xb23_4: '《银行保险机构消费者权益保护管理办法》（银保监会令2022年第9号）第二十三条第（四）项（不得载明保本、无风险或者保收益等，对非保本投资型金融产品的未来效果、收益或者相关情况作出保证性承诺）',
  xb23_5: '《银行保险机构消费者权益保护管理办法》（银保监会令2022年第9号）第二十三条第（五）项（不得使用“国家级”“最高级”“最佳”“唯一”等极限类用语）',
  xb23_6: '《银行保险机构消费者权益保护管理办法》（银保监会令2022年第9号）第二十三条第（六）项（不得含有或者隐含与性别、种族、宗教信仰相关的歧视性用语）',
  lcs: '《理财公司理财产品销售管理暂行办法》（不得夸大过往业绩、不得使用未经核实的数据资料、不得宣传理财产品保本保收益）',
  gdk: '《个人贷款管理办法》（2024年修订）（贷款用途管理与支付管理要求，不得发放无指定用途的个人贷款）',
  bxpl: '《人身保险产品信息披露管理办法》（分红、万能等演示利益必须明示非保证，不得将演示利益表述为确定收益）',
  pbc3: '《中国人民银行公告〔2021〕第3号》（贷款产品应以明显方式展示年化利率）'
};

/* ---------- 八个审查维度：判断模式（不是词表） ---------- */
const DIMENSIONS = [
  {
    id: 1,
    name: '虚假、欺诈、隐瞒或引人误解的宣传内容',
    patterns: [
      '材料内部自相矛盾（如同时出现“0风险”与“R2风险等级”“业绩比较基准”）',
      '模糊表述掩盖限制条件（“最高可贷”不说明审批条件与担保要求）',
      '把“预期/演示/基准/分红演示”包装成“确定/保证”（如“有效应对利率下行”“现金分红添惊喜”）',
      '贷款宣传“无需用途证明/不用提供用途”等诱导规避用途监管的表述，直接判高'
    ],
    law: 'xb23'
  },
  {
    id: 2,
    name: '引用不真实/不准确数据，隐瞒限制条件，夸大过往业绩或产品收益',
    patterns: [
      '历史收益/成立以来收益/近一年涨幅未注明“过往业绩不代表未来”',
      '排名、涨幅无来源、无统计口径、无截至日期',
      '选择性统计（如“持有30日正收益概率100%”）构造稳赚暗示，判高',
      '极端数据（如涨幅84%）大字呈现却不提示波动风险',
      '同业对比（“工行建行最高快赎X万”“农行无同类产品”）无出处或含贬低性断言',
      '含占位符（“XX元权益”）属流程性缺陷，判高'
    ],
    law: 'xb23'
  },
  {
    id: 3,
    name: '利用监管部门审核或备案程序误导消费者认为已获监管保证',
    patterns: ['任何“监管批准/备案/审批通过＝产品安全/监管保证”的暗示，含“国家级/国家背书/监管认证/合规备案产品”等变体'],
    law: 'xb23'
  },
  {
    id: 4,
    name: '载明保本、无风险或保收益，对非保本产品作保证性承诺',
    patterns: [
      '明示：“保本保息”“0风险”“刚性兑付”',
      '暗示：“稳赚”“本金安心无忧”“收益天天净赚”“绝对安全”',
      '包装：把业绩比较基准、历史分红率、满期金折算年化表述为确定收益',
      '真实存款的“保本保息”原则上合规，但须核查存款保险适用范围（跨境存款需人工判断）；理财/基金/资管出现任何“保本”字样一律判高；分红险须区分保证利益与非保证演示，未区分判中高'
    ],
    law: 'xb23'
  },
  {
    id: 5,
    name: '“国家级”“最高级”“最佳”“唯一”等极限类用语',
    patterns: [
      '判断标准是该表述是否让消费者认为产品/服务无可比拟，不限于词表',
      '需识别变体、拆字、谐音、符号替代（“zui好”“最*佳”“No.1”）',
      '“独家/仅我行/行业头部/领跑”属排他性宣称，同判'
    ],
    law: 'ggf9'
  },
  {
    id: 6,
    name: '含有或隐含性别、种族、宗教信仰等歧视性用语',
    patterns: ['与性别、年龄、地域、种族、宗教信仰、身体状况相关的排斥性或贬低性表述，含隐含表述（如“专属女性理财”暗示性别排斥）'],
    law: 'xb23'
  },
  {
    id: 7,
    name: '其他违反消保及金融营销宣传法律法规的内容（含适当性侵犯）',
    patterns: [
      '诱导放弃法定权利（如劝阻客户“不一定需要提前还款”）',
      '以权益诱导资产归集而未做风险承受能力评估（“其他银行资金也可转来，资产越多权益越多”）',
      '饥饿营销施压（“好产品额度越有限，早做早踏实”）',
      '“无需用途证明/凭身份证即可贷/无视征信”等贷款用途监管规避'
    ],
    law: 'xfz10'
  },
  {
    id: 8,
    name: '限制消费者权利/加重义务事项缺乏显著特别标识，风险揭示不充分',
    patterns: [
      '风险提示位于页脚小字，而收益宣传以大字呈现',
      '外呼话术/短信涉及产品推荐，但无“理财非存款，产品有风险，投资须谨慎”类提示',
      '限制消费者权利或加重义务的事项（免密、自动续费、提前还款违约金、免首年年费条件）未用醒目方式标注'
    ],
    law: 'xb21'
  }
];

/* ============================================================
 * 规则库：四元组（category / pattern / examples / semantic_hint）
 * examples 仅作展示与回归参照，不参与穷举匹配
 * ============================================================ */
const RULE_LIBS = {
  extreme: {
    key: 'extreme',
    category: 5,
    label: '极限与排他用语',
    brief: '绝对化、排他性或最高级表述',
    law: 'ggf9',
    risk: '高',
    // 允许前置字符（如“中国第一”“全行唯一”），避免裸“最”误伤“最近/最终”
    pattern: /(?:最(?:好|优|佳|强|高|低|大|快|新|赚|牛|稳|安全))|(?:顶级|顶尖|极品|极致)|(?:第一|唯一|首个|首家|首推|独家|仅我行|国家级|世界级|全球级|史无前例|绝无仅有|行业头部|业内领先|全球领先|全国领先|销量第一|领跑|遥遥领先|领先同业)|(?:No\.?\s*1|NO\.?\s*1|N0\.1)|(?:zui\s*[好佳优强高低大快])|(?:最\s*[\*＊xX]\s*[佳好强])/gi,
    examples: ['最好', '最优', '最佳', '第一', '唯一', '独家', '国家级', 'zui高', 'No.1', '领跑'],
    guard: quantitativeGuard,
    exclude: /(?:最近|最终|最高人民|最高人民法院)/g,
    semantic_hint: '《广告法》禁止的是无法量化验证的定性绝对化用语（最好/最优/第一/唯一/国家级）。金融产品的“最高贷款额度/最长期限/最高收益率”属定量的业务参数上限，不构成绝对化用语；只有“收益最高”“最高级”“最佳产品”“全行唯一”这类修饰性质/等级/排名的表述才判违规。',
    conclude: (w) => `文中“${w}”属绝对化或排他性表述，使消费者对产品地位产生超出事实的认知，且无法提供客观依据。`,
    suggest: '删除该绝对化/排他性表述；如需体现竞争优势，改为可核查的客观描述（如“近一年同类产品规模排名第X位，数据来源：XX，截至XX年XX月”）。'
  },
  guarantee: {
    key: 'guarantee',
    category: 4,
    label: '保本与收益承诺',
    brief: '保本、无风险或收益确定的明示与暗示',
    law: 'xb23_4',
    risk: '高',
    pattern: /(?:保本|保息|保收益|保本保息|保本保收益|本金保障|本金安全|本金安心|本金无忧|安心无忧|无风险|零风险|0\s*风险|Ｏ\s*风险|稳赚|稳赢|必赚|保证收益|承诺收益|刚性兑付|兜底|绝对安全|稳赚不赔|100%\s*(?:有|的)?\s*(?:安全|收益|保本|保障|赚))/gi,
    examples: ['保本保息', '无风险', '0风险', '稳赚', '本金安心无忧', '100%有收益', '刚性兑付'],
    semantic_hint: '任何“本金不受损失、收益确定、风险为零”的明示或暗示，包括用“业绩比较基准/历史业绩/分红演示”包装成收益确定。',
    conclude: (w) => `文中“${w}”是对本金或收益的保证性承诺。资管产品不得承诺保本保收益，该表述可能使消费者误认为本金无损失风险，影响其知情权与自主选择权。`,
    suggest: '删除保证性表述，改为“业绩比较基准不代表实际收益，不构成收益承诺”，并按监管要求在显著位置揭示产品风险等级。'
  },
  induce: {
    key: 'induce',
    category: 1,
    label: '诱导性话术',
    brief: '制造紧迫感、降低决策门槛、弱化风险意识的诱导话术',
    law: 'xb23_1',
    risk: '中',
    pattern: /(?:低至|秒到账|秒批|秒放|限量|名额有限|先到先得|错过|速抢|仅剩|倒计时|最后\s*\d+\s*天|手慢无|告急|无成本|零成本|低门槛|无门槛|额度越有限|限时|抢购|火爆开售|火热开售|无需用途证明|不用提供用途|无需抵押|不看征信|凭身份证即可)/gi,
    examples: ['低至', '秒到账', '秒批', '名额有限', '手慢无', '额度告急', '无需用途证明'],
    semantic_hint: '制造紧迫感、降低决策门槛、弱化风险意识的话术；“低至X%起”属典型价格诱导——用最低利率吸引注意而实际审批利率可能远高于此。',
    conclude: (w) => `文中“${w}”属诱导性营销话术，通过制造紧迫感或降低决策门槛弱化风险意识，可能使消费者在信息不充分的情况下作出决策。`,
    suggest: '删除催促性、稀缺性话术；如涉及价格，改为“年化利率X%起，具体以审批结果为准”，并同时展示年化利率区间与适用条件。'
  },
  discriminate: {
    key: 'discriminate',
    category: 6,
    label: '歧视性用语',
    brief: '与性别、年龄、地域、民族、宗教等相关的排斥性或贬低性表述',
    law: 'xb23_6',
    risk: '高',
    pattern: /(?:仅限男性|仅限女性|男士专享|女士专享|仅限本地户口|本地户口优先|外地户口不|外地人不|年龄过大不予|残障人士不|少数民族不|不接待.{0,4}客户)/gi,
    examples: ['仅限男性', '女士专享', '本地户口优先'],
    semantic_hint: '与性别、年龄、地域、种族、宗教信仰、身体状况相关的排斥性或贬低性表述，含隐含表述。',
    conclude: (w) => `文中“${w}”含差别对待表述，可能构成对特定群体的歧视，违反金融营销宣传公平对待消费者的要求。`,
    suggest: '删除与性别、年龄、地域等相关的限制性或排斥性表述，改为与产品风险适配性相关的客观准入条件。'
  },
  rights: {
    key: 'rights',
    category: 8,
    label: '限制消费者权利事项',
    brief: '限制消费者权利或加重消费者义务的事项未以显著方式特别标识',
    law: 'xb21',
    risk: '中',
    pattern: /(?:最终解释权|解释权归|不予退还|不可撤销|提前还款违约金|自动续费|免密支付|售完即止|活动最终)/gi,
    examples: ['最终解释权', '不予退还', '自动续费', '提前还款违约金'],
    semantic_hint: '限制消费者权利或加重消费者义务的事项，必须以足以引起注意的文字、符号、字体、颜色特别标识，否则损害知情权。',
    conclude: (w) => `文中“${w}”涉及限制消费者权利或加重消费者义务的事项，需以足以引起注意的特别标识说明；若未加粗、未前置、字号偏小，可能损害消费者知情权。`,
    suggest: '将该条款前移至显著位置，使用加粗或反白等特别标识，字号不小于正文，并在文末重复提示。'
  }
};

/* ============================================================
 * 要素核查（不依赖词表）：数据引用四要素 / 特别标识显著性
 * ============================================================ */

const PLACEHOLDER = /(?:XX|xx|ＸＸ|××|\*\*|＿{2,}|_{2,}|某某|○○|[\(（]\s*[\)）])\s*(?:元|万|亿|%|％|份|人|名|倍|天|月|年)/;
const PLACEHOLDER_AMOUNT = /(?:最高|可得|获得|赠送|赠送价值|价值|立减|返现|权益)\s*(?:XX|xx|ＸＸ|××|某某|○○)/;
const DATA_TOKEN = /\d+(?:\.\d+)?\s*(?:%|％|万|亿|倍)/g;
const PERF_WORD = /(年化(?!\s*利率)|收益率|回报|涨幅|业绩比较基准|分红|正收益概率|历史业绩|成立以来|净值|排名)/;
const SOURCE_WORD = /(数据来源|来源[:：]|统计口径|口径|区间|据.{0,8}披露|说明书|官网|年报|季报|wind|Wind|同花顺)/;
const DATE_WORD = /(截至|截止)\s*\d|\d{4}\s*年|\d{4}\s*[-/]\s*\d{1,2}|近一年|近三年|近五年|今年以来|成立以来|\d{1,2}\s*月\s*\d{1,2}\s*日/;
const DISCLAIM_WORD = /(不代表|不构成|过往业绩|非承诺|仅供参考|不代表未来|历史数据不代表|不保证)/;
const PEER_WORD = /(工行|建行|农行|中行|招行|交行|邮储|他行|同业|同类产品|其他银行)/;
/* 维度二重构所需的三类特征词 */
const ABSOLUTE_WORD = /(稳赚|必得|必赚|保证|承诺|包赚|100%\s*(?:正收益|收益|保本|安全)|零风险|无风险|确保)/;
const PRODUCT_TERM = /(量化对冲|主投|投资于|债券|权益仓位|仓位约|久期|回撤|夏普|波动率|起购|起点金额|购买起点|期限|额度|担保方式|免担保|信用)/;
const VAGUE_QUAL = /(回撤相对较小|风控严格|运作稳健|稳健运作|业绩优良|收益稳健|表现稳健)/;

/* 极限词的“定量参数”守卫：区分“最高贷150万”（参数上限）与“收益最高5.8%”（绝对化） */
const QUANT_PARAM_AFTER = /^(?:额度|金额|期限|年龄|比例|收益率|利率|可贷|贷款|授信|期数|天数|年限|折扣|上限|限额|贷|借|万|元)/;
function quantitativeGuard(text, index, match) {
  const token = String(match || '');
  if (!/^(最高|最长|最多|最低|最大|最高级)$/.test(token)) return false;
  const before = text.slice(Math.max(0, index - 6), index);
  const after = text.slice(index + token.length, index + token.length + 10);
  // 谓词位置：收益/回报/涨幅 + 最高 → 属绝对化（如“收益最高5.8%”）
  if (/(收益|回报|涨幅|业绩|分红|排名)\s*$/.test(before)) return false;
  // “最高级”属等级用语，不豁免
  if (/^级/.test(after)) return false;
  // 紧跟参数名词 → 定量参数上限
  if (QUANT_PARAM_AFTER.test(after)) return true;
  // 紧跟数字+单位 → 定量参数上限
  if (/^\s*\d/.test(after)) return true;
  return false;
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。！？；\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* 数据引用核查 v2：先做特征门（A 无源 / B 隐瞒限制 / C 绝对保证），命中才判违规 */
function analyzeDataClaims(text) {
  const out = [];
  const sentences = splitSentences(text);
  sentences.forEach((sent) => {
    const tokens = sent.match(DATA_TOKEN);

    // 模糊定性描述：最多给一条低风险建议，不得判为夸大
    if (VAGUE_QUAL.test(sent) && !ABSOLUTE_WORD.test(sent)) {
      out.push({
        source: 'rule',
        checkType: 'data',
        ruleLabel: '要素核查 · 定性表述',
        hit: (sent.match(VAGUE_QUAL) || [''])[0],
        snippet: sent,
        dim: 2,
        risk: '低',
        conclusion: '文中使用"' + (sent.match(VAGUE_QUAL) || [''])[0] + '"等定性描述，未给出可核查的量化指标，建议补充数据支撑，不构成违规。',
        judgmentPath: '依据维度二豁免清单："回撤相对较小""风控严格"属模糊定性描述，最多提示补充量化数据。',
        suggestion: '建议补充量化数据（如近一年最大回撤 X%、波动率 X%），提升可核查性；如无数据可保持现状。',
        law: LAWS.xb23_2,
        lawKey: 'xb23_2',
        confidence: '中',
        needsHuman: false
      });
      return;
    }

    if (!tokens || !tokens.length) return;
    if (!PERF_WORD.test(sent) && !PEER_WORD.test(sent)) return;

    // 产品要素说明豁免（量化对冲/主投债券/仓位/起购金额等）
    const perfClaim = /(收益率|回报|涨幅|业绩比较基准|分红|正收益概率|历史业绩|成立以来|排名|净值)/.test(sent);
    if (PRODUCT_TERM.test(sent) && !perfClaim) return;

    const hasTime = DATE_WORD.test(sent);
    const hasSource = SOURCE_WORD.test(sent);
    const hasDisclaim = DISCLAIM_WORD.test(sent);
    const hasAbsolute = ABSOLUTE_WORD.test(sent);
    const placeholder = PLACEHOLDER.test(sent) || PLACEHOLDER_AMOUNT.test(sent);
    const selective = /(正收益概率|胜率|无亏损|零回撤)/.test(sent);
    const benchmark = /(业绩比较基准|分红演示|演示利益)/.test(sent);
    const certainAs = benchmark && /(确定为|保证|可达|即达|就是|保底|承诺)/.test(sent);
    const extreme = tokens.some((t) => /%|％/.test(t) && parseFloat(t) >= 30);

    // 特征门
    let risk = '';
    let feature = '';
    if (placeholder) { risk = '高'; feature = '占位符未填实（流程缺陷）'; }
    else if (selective) { risk = '高'; feature = 'C/选择性统计：以"正收益概率"等构造稳赚暗示'; }
    else if (hasAbsolute) { risk = '高'; feature = 'C 绝对保证：数据周围出现保证性承诺词'; }
    else if (certainAs) { risk = '高'; feature = 'B 隐瞒限制：把业绩基准/演示利益表述为确定收益'; }
    else if (extreme && !hasDisclaim) { risk = '高'; feature = 'B 隐瞒限制：只展示极端收益（≥30%）且无风险提示'; }
    else if (!hasTime && !hasSource && !hasDisclaim) { risk = '中'; feature = 'A 无源数据：无来源、无统计口径、无截止日期'; }
    else return; // 有明确时间/来源/免责限制 → 属客观数据陈述，不予判违规

    out.push({
      source: 'rule',
      checkType: 'data',
      ruleLabel: '要素核查 · 数据引用',
      hit: tokens.slice(0, 3).join('、'),
      snippet: sent,
      dim: 2,
      risk: risk,
      conclusion: '文中"' + tokens.slice(0, 3).join('、') + '"等数据：' + feature + '，可能使消费者对收益或比较结果产生错误预期。',
      judgmentPath: '依据维度二特征门判定：' + feature + '。' + (hasTime ? '（文中含时间标记，但' + feature + '）' : ''),
      suggestion: placeholder
        ? '填实占位金额/比例后再送审；送审环节应增加占位符自动检测。'
        : (risk === '高'
          ? '删除保证性/确定性表述，改为客观披露：注明数据来源、统计区间、截至日期，并标注"过往业绩不代表未来表现"。'
          : '补充数据来源与统计口径、标注截至日期；如为同类产品对比，注明数据出处。'),
      law: LAWS.xb23_2,
      lawKey: 'xb23_2',
      confidence: '高',
      needsHuman: false
    });
  });
  return out;
}

/* 额度/期限免责完整性：正文出现额度、期限、利率等参数，但全篇无“以最终审批为准”类声明 */
const PARAM_WORD = /(最高贷|可贷|额度|授信|期限|年化利率|利率|起购|起存)/;
const FINAL_DISCLAIM = /(以最终审批为准|以实际审批为准|以实际为准|最终以.{0,8}为准|具体以.{0,8}为准|审批结果为准)/;
function analyzeDisclaimers(text) {
  const out = [];
  const raw = String(text || '');
  const compact = raw.replace(/\s/g, '');
  if (compact.length < 30) return out;
  if (!PARAM_WORD.test(raw)) return out;
  if (FINAL_DISCLAIM.test(raw)) return out;
  const m = raw.match(PARAM_WORD);
  out.push({
    source: 'rule',
    checkType: 'disclaim',
    ruleLabel: '要素核查 · 免责声明',
    hit: '',
    param: m ? m[0] : '',
    snippet: splitSentences(raw).find((x) => PARAM_WORD.test(x)) || raw.slice(0, 40),
    dim: 8,
    risk: '低',
    conclusion: '材料提及授信额度/期限/利率等参数（如"' + (m ? m[0] : '额度') + '"），但全篇未见"以最终审批为准"类免责声明，建议在脚注统一补充，避免消费者将参数上限理解为确定承诺。',
    judgmentPath: '依据维度八"要素完整性核查"：存在额度/期限/利率参数，未检出"以最终审批为准"类统一免责声明。',
    suggestion: '建议在脚注统一补充："授信额度、利率及期限以最终审批结果为准"（正文无需逐处加注）。',
    law: LAWS.xb21,
    lawKey: 'xb21',
    confidence: '中',
    needsHuman: false
  });
  return out;
}

/* 特别标识显著性核查：定位风险提示，判断位置与充分性 */
function analyzeProminence(text, meta) {
  const out = [];
  const raw = String(text || '');
  const compact = raw.replace(/\s/g, '');
  const materialLevel = compact.length >= 80; // 完整材料才升为高危，片段视为摘录

  const isRiskDisclosure = (s) => /(投资须谨慎|投资有风险|产品有风险|风险提示|不代表|以实际为准|非保证|揭示书|理财非存款|谨慎投资)/.test(s)
    || (/风险/.test(s) && !/风险等级|风险评级|R\s?[1-5]/.test(s));
  const riskSentences = splitSentences(raw).filter(isRiskDisclosure);
  const hasRisk = riskSentences.length > 0;

  if (!hasRisk) {
    // 贷款类材料适用“理性借贷/征信”提示，不套用“理财非存款、投资须谨慎”类风险提示语
    if (meta && meta.line === '贷款') return out;
    out.push({
      source: 'rule',
      checkType: 'prominence',
      ruleLabel: '要素核查 · 风险揭示',
      hit: '',
      snippet: '（全文未见风险揭示表述）',
      dim: 8,
      risk: materialLevel ? '高' : '低',
      conclusion: '材料全文未出现任何风险揭示或“理财非存款、产品有风险、投资须谨慎”类提示，风险信息揭示不充分，可能使消费者低估产品风险。',
      judgmentPath: '依据维度八“风险揭示要素核查”：全文检索未发现含“风险/谨慎/不代表/以实际为准/非保证”语义的句子，风险提示要素缺失。',
      suggestion: '在版面显著位置补充风险提示语，字号不小于正文，颜色与背景形成明显对比，并在文末重复载明。',
      law: LAWS.xb21,
      lawKey: 'xb21',
      confidence: '高',
      needsHuman: false
    });
    return out;
  }

  // 风险提示仅出现在文本后段 → 疑似位于页底/脚注
  const firstRisk = riskSentences[0];
  const idx = compact.indexOf(firstRisk.replace(/\s/g, '').slice(0, 6));
  const ratio = compact.length ? idx / compact.length : 0;
  const shortRisk = firstRisk.length <= 14;
  if ((ratio > 0.7 && compact.length > 60) || (shortRisk && ratio > 0.55)) {
    out.push({
      source: 'rule',
      checkType: 'prominence',
      ruleLabel: '要素核查 · 风险揭示',
      hit: '',
      snippet: firstRisk.slice(0, 40),
      dim: 8,
      risk: '中',
      conclusion: `风险提示仅出现在材料靠后位置（约占全文 ${Math.round(ratio * 100)}%），且表述较短，存在“收益宣传大字、风险提示小字/页底”的显著性不足风险，可能使消费者忽略风险信息。`,
      judgmentPath: `依据维度八“特别标识显著性要素核查”：检索到风险提示“${firstRisk.slice(0, 20)}”，其位置占比 ${Math.round(ratio * 100)}%，长度 ${firstRisk.length} 字，未与收益宣传同层级呈现。`,
      suggestion: '将风险提示前置到首屏或收益信息同层级位置，字号不小于正文，使用加粗/反白等特别标识，并单独成行。',
      law: LAWS.xb21,
      lawKey: 'xb21',
      confidence: '中',
      needsHuman: meta && meta.isImage === true
    });
  }
  return out;
}

/* ---------- 内置示例（A-D 为原始示例，R1-R3 为泛化回归样例） ---------- */
const SAMPLES = {
  A: {
    line: '理财', type: '短信',
    text: 'XX理财重磅来袭！历史年化最高5.8%，保本保息，资金秒到账！全行唯一爆款，名额有限速抢！'
  },
  B: {
    line: '贷款', type: '海报',
    text: '低利率贷款无风险，秒批秒到账，贷款就选我们，错过再等一年！'
  },
  C: {
    line: '理财', type: '文案',
    text: 'XX理财产品，业绩比较基准3.5%-4.2%，不代表实际收益承诺。理财非存款、产品有风险、投资须谨慎。产品说明书及风险揭示书请至我行网点或官网查阅。'
  },
  D: {
    line: '理财', type: '海报',
    text: [
      '最好 最优 最佳',
      '进阶权益优选 资产有保障 真好贷',
      '五谷丰登 全新升级',
      '产品类型 固定收益类｜中国第一｜0风险｜R2',
      '升级后 业绩优良｜100%有收益',
      '封闭期 开放期 业绩比较基准 风险等级',
      '约1月 每月14日-17日 3% 二级',
      '有保障 高收益｜每月定期分红｜收益天天净赚',
      '国家级产品',
      '历史业绩汇报：聚鑫赢A十三月定开1号 成立以来年化收益率5.10%；昕泽稳健同享3号 成立以来年化收益率5.89%'
    ].join('\n')
  },
  R1: {
    line: '理财', type: '文案', tag: '回归',
    text: '鑫享理财火热开售！收益一路领跑，zui高年化6.2%，本金安心无忧，额度告急，手慢无！'
  },
  R2: {
    line: '理财', type: '文案', tag: '回归',
    text: '本产品为固定收益类，业绩比较基准3.0%-3.5%，历史年化收益稳定在3.2%左右，风险等级R2。投资有风险，详见产品说明书。'
  },
  R3: {
    line: '理财', type: '文案', tag: '回归',
    text: 'XX理财产品，业绩比较基准3.5%-4.2%，不代表实际收益承诺。理财非存款、产品有风险、投资须谨慎。产品说明书及风险揭示书请至我行网点或官网查阅。本产品风险等级为R2（中低风险）。'
  }
};

/* ---------- 工具函数 ---------- */
function norm(s) { return String(s || '').replace(/[\s，。；、！？""''（）()【】\[\]：:·\-—…"'.]/g, ''); }

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function similar(a, b) {
  const A = bigrams(norm(a)), B = bigrams(norm(b));
  if (!A.size || !B.size) return false;
  let inter = 0;
  A.forEach((g) => { if (B.has(g)) inter++; });
  return inter / Math.min(A.size, B.size) > 0.5;
}

function mergeSimilar(list) {
  const order = { 高: 3, 中: 2, 低: 1 };
  const addUnique = (base, extra, sep) => {
    if (!extra) return base;
    if (!base) return extra;
    if (base.indexOf(extra) >= 0) return base;
    if (extra.indexOf(base) >= 0) return extra;
    return base + sep + extra;
  };
  const kept = [];
  list.forEach((o) => {
    let dup = kept.find((k) => k.snippet === o.snippet);
    if (!dup) dup = kept.find((k) => k.dim === o.dim && similar(k.snippet, o.snippet));
    if (!dup) { kept.push(o); return; }
    if ((order[o.risk] || 0) > (order[dup.risk] || 0)) dup.risk = o.risk;
    if (o.hit && dup.hit && o.hit !== dup.hit && dup.hit.indexOf(o.hit) < 0 && o.hit.indexOf(dup.hit) < 0) {
      dup.hit = dup.hit + '、' + o.hit;
    } else if (o.hit && !dup.hit) {
      dup.hit = o.hit;
    }
    if (dup.snippet !== o.snippet && o.snippet.length > dup.snippet.length) dup.snippet = o.snippet;
    dup.typeName = addUnique(dup.typeName, o.typeName, '；');
    dup.law = addUnique(dup.law, o.law, '；');
    dup.conclusion = addUnique(dup.conclusion, o.conclusion, ' ');
    dup.judgmentPath = addUnique(dup.judgmentPath, o.judgmentPath, ' ');
    if (o.dim !== dup.dim) dup.dims = (dup.dims || [dup.dim]).concat(o.dim);
  });
  return kept;
}

/* ---------- 规则执行引擎 ---------- */
function runRules(rawText, meta) {
  const text = String(rawText || '');
  const flat = text.replace(/\s+/g, ' ');
  let out = [];
  const seen = new Set();

  const PUNC = /[，。；！？,;!?\n]/;
  const snippetOf = (idx, len) => {
    const pad = 22;
    const MAXLEN = 54;
    let s = Math.max(0, idx - pad);
    let e = Math.min(flat.length, idx + len + pad);
    const before = flat.slice(s, idx);
    for (let i = before.length - 1; i >= 0; i--) {
      if (PUNC.test(before[i])) { s = s + i + 1; break; }
    }
    const after = flat.slice(idx + len, e);
    for (let i = 0; i < after.length; i++) {
      if (PUNC.test(after[i])) { e = idx + len + i; break; }
    }
    if (e - s > MAXLEN) {
      const center = idx + Math.floor(len / 2);
      s = Math.max(s, center - Math.floor(MAXLEN / 2));
      e = Math.min(e, s + MAXLEN);
    }
    let seg = flat.slice(s, e).trim();
    seg = seg.replace(/^[，。；、！？,.;\s]+/, '').replace(/[，。；、,;\s]+$/, '');
    if (s > 0) seg = '…' + seg;
    if (e < flat.length) seg = seg + '…';
    return seg;
  };

  Object.keys(RULE_LIBS).forEach((key) => {
    const lib = RULE_LIBS[key];
    const re = new RegExp(lib.pattern.source, lib.pattern.flags);
    let m;
    let hits = 0;
    while ((m = re.exec(flat)) !== null && hits < 8) {
      const w = m[0];
      if (lib.exclude) {
        lib.exclude.lastIndex = 0;
        if (lib.exclude.test(flat.slice(Math.max(0, m.index - 2), m.index + w.length + 2))) continue;
      }
      // 极限词的定量参数守卫：最高贷150万 / 授信最长36个月 属参数上限，不算绝对化用语
      if (lib.guard && lib.guard(flat, m.index, w)) continue;
      const dedupeKey = key + '|' + w;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        source: 'rule',
        checkType: 'lib',
        ruleLabel: lib.label,
        libKey: key,
        hit: w,
        snippet: snippetOf(m.index, w.length),
        conclusion: lib.conclude(w),
        judgmentPath: `依据维度${['一', '二', '三', '四', '五', '六', '七', '八'][lib.category - 1]}判断模式「${lib.brief}」：原文“${w}”命中规则库『${lib.label}』的高置信度匹配，语义特征与该判断模式一致。`,
        typeName: '（' + ['一', '二', '三', '四', '五', '六', '七', '八'][lib.category - 1] + '）' + DIMENSIONS[lib.category - 1].name,
        dim: lib.category,
        law: LAWS[lib.law],
        lawKey: lib.law,
        suggestion: lib.suggest,
        risk: lib.risk,
        confidence: '高',
        needsHuman: false
      });
      hits++;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  });

  analyzeDataClaims(text).forEach((o) => out.push(o));
  analyzeDisclaimers(text).forEach((o) => out.push(o));
  analyzeProminence(text, meta).forEach((o) => out.push(o));

  out = mergeSimilar(out);

  // 数据引用类问题在长材料中会逐句触发：中风险项最多保留 3 条，其余合并为一条汇总意见
  const dataMid = out.filter((o) => o.checkType === 'data' && o.risk !== '高');
  if (dataMid.length > 3) {
    const extra = dataMid.slice(3);
    const keep = out.filter((o) => extra.indexOf(o) < 0);
    const samples = extra.slice(0, 3).map((o) => o.snippet.slice(0, 20)).join('；');
    const agg = {
      source: 'rule',
      checkType: 'data',
      ruleLabel: '要素核查 · 数据引用',
      hit: extra.map((o) => o.hit).join('、').slice(0, 40),
      snippet: samples + ' 等 ' + extra.length + ' 处',
      dim: 2,
      risk: '中',
      conclusion: '全文另有 ' + extra.length + ' 处数据引用同样缺少来源/统计口径/截至日期或“过往业绩不代表未来”类限制条件（如：' + samples + '），存在夸大过往业绩或隐瞒限制条件的风险。',
      judgmentPath: '依据维度二“数据引用四要素核查”：逐句校验全文数字与比较类表述，累计 ' + extra.length + ' 处分句未同时具备来源、统计口径、截至日期与限制条件，高度同质，合并为一条汇总意见。',
      suggestion: '统一在材料中标注数据来源、统计区间与截至日期，并在同层级注明“过往业绩不代表未来表现，不构成收益承诺”；同业对比数据须注明出处。',
      law: LAWS.xb23,
      lawKey: 'xb23',
      confidence: '高',
      needsHuman: false
    };
    keep.push(agg);
    out = keep;
  }

  // 同材料多条“建议类”（低风险）意见合并为一条，避免刷屏
  const lows = out.filter((o) => o.risk === '低');
  if (lows.length > 1) {
    const keep = lows[0];
    const rest = lows.slice(1);
    keep.conclusion = [keep.conclusion].concat(rest.map((o) => o.conclusion)).join(' ');
    keep.suggestion = [keep.suggestion].concat(rest.map((o) => o.suggestion)).join('；');
    keep.judgmentPath = [keep.judgmentPath].concat(rest.map((o) => o.judgmentPath)).join(' ');
    keep.mergedSuggestion = rest.length;
    out = out.filter((o) => rest.indexOf(o) < 0);
  }

  // 短文案（短信/短语）中同一规则库的多个命中归并为一张意见，避免同类问题刷屏
  if (flat.replace(/\s/g, '').length < 160) {
    const byLib = {};
    const grouped = [];
    out.forEach((o) => {
      if (o.checkType !== 'lib' || !o.libKey) { grouped.push(o); return; }
      const first = byLib[o.libKey];
      if (!first) { byLib[o.libKey] = o; grouped.push(o); return; }
      const order = { 高: 3, 中: 2, 低: 1 };
      if ((order[o.risk] || 0) > (order[first.risk] || 0)) first.risk = o.risk;
      String(o.hit).split('、').forEach((w) => {
        if (w && first.hit.indexOf(w) < 0) first.hit = first.hit + '、' + w;
      });
      if (o.snippet.length > first.snippet.length) first.snippet = o.snippet;
      if (o.conclusion.length > first.conclusion.length) first.conclusion = o.conclusion;
      first.judgmentPath = first.judgmentPath.split('；同类命中')[0] + '；同类命中：' + first.hit;
    });
    out = grouped;
  }

  out.forEach((o, i) => {
    o.id = 'R' + i;
    if (!o.typeName) o.typeName = '（' + ['一', '二', '三', '四', '五', '六', '七', '八'][(o.dim || 7) - 1] + '）' + DIMENSIONS[(o.dim || 7) - 1].name;
    if (!o.confidence) o.confidence = '高';
  });
  return out;
}
