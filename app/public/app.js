/* ============================================================
 * 金融营销宣传智能审查 · 前端主逻辑
 * 三层协同：规则引擎初筛 → 大模型语义审查 → 人工复核
 * ============================================================ */
'use strict';

/* ---------- 云服务配置（publicConfig，可安全置于前端） ---------- */
const CFG = {
  endpoint: 'https://consumer-review.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_FWj5e16RmGSAh7ZvO5UVVe_6Dkrl3vhZrj2G9VpmeQi1clqTWyJqUUO'
};

const SDK_SRC = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';

let cloud = null;
function initCloud() {
  if (cloud) return cloud;
  const G = window.WorkBuddyCloud;
  if (!G || typeof G.createWorkBuddyCloud !== 'function') return null;
  cloud = G.createWorkBuddyCloud({
    endpoint: CFG.endpoint,
    oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
    publishableKey: CFG.publishableKey
  });
  return cloud;
}

/* CDN 偶发失败时动态重试，避免静默降级成“只有规则库” */
async function ensureCloud() {
  if (cloud) return cloud;
  for (let i = 0; i < 3; i++) {
    try {
      if (!window.WorkBuddyCloud) await loadScript(SDK_SRC + (i ? '?r=' + Date.now() : ''));
      if (initCloud()) return cloud;
    } catch (e) { /* 下一轮重试 */ }
    await sleep(400);
  }
  throw new Error('审查引擎脚本未能加载，请检查网络后刷新页面重试');
}

/* ---------- 状态 ---------- */
const state = {
  step: 1,
  line: '理财',
  type: '海报',
  materialName: '',
  text: '',
  parseSource: '',
  opinions: [],
  startedAt: null,
  model: null,
  modelLabel: '—',
  overallConclusion: '',
  modelRiskLevel: '',
  blockCount: 0,
  complexPages: [],
  foundTotal: 0,
  riskStats: { 高: 0, 中: 0, 低: 0 },
  mergedGroups: [],
  mergedTotal: 0,
  dupRemoved: 0,
  rejected: [],
  stepReached: 1,
  log: [],
  undoStack: [],
  redoStack: [],
  reportExported: false
};

/* ---------- 小工具 ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RISK_ORDER = { 高: 3, 中: 2, 低: 1 };
const RISK_CLASS = { 高: 'high', 中: 'mid', 低: 'low' };
const STATUS_TEXT = { pending: '待复核', accepted: '已采纳', modified: '已修改采纳', rejected: '已驳回' };

let toastTimer = null;
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2200);
}

function setEnv(ok, text) {
  const d = $('#envDot');
  d.className = 'dot' + (ok === true ? ' on' : ok === false ? ' err' : '');
  $('#envText').textContent = text;
}

/* ---------- 步骤条 ---------- */
const ALL_PANELS = ['#panelSetup', '#panelRun', '#panelSummary', '#panelOpinions', '#panelReport'];

/* 只显示当前步骤所属面板，避免上游表单与结果页堆叠 */
function showPanels(ids) {
  ALL_PANELS.forEach((id) => { $(id).hidden = ids.indexOf(id) < 0; });
  if (ids.indexOf('#panelSetup') < 0) $('#parseCard').hidden = true;
}

function setStep(n) {
  state.step = n;
  state.stepReached = Math.max(state.stepReached || 1, n);
  renderStepper();
}

/* 已完成（到达过）的阶段可点击回退；未到达阶段不可点击 */
function renderStepper() {
  $$('.step').forEach((el) => {
    const s = +el.dataset.step;
    const reached = s <= (state.stepReached || 1);
    el.classList.toggle('is-active', s === state.step);
    el.classList.toggle('is-done', s < state.step);
    el.classList.toggle('is-reached', reached);
    el.setAttribute('title', reached ? (s < state.step ? '点击返回该阶段' : '') : '尚未到达');
    el.style.cursor = reached && s !== state.step ? 'pointer' : 'default';
  });
}

function showStepPanels(n) {
  if (n === 1) showPanels(['#panelSetup']);
  else if (n === 2) showPanels(['#panelRun']);
  else if (n === 3) showPanels(['#panelSummary', '#panelOpinions']);
  else showPanels(['#panelReport']);
}

/* ---------- 模型 ---------- */
let MODELS = null;
async function ensureModels() {
  if (MODELS) return MODELS;
  const c = await ensureCloud();
  const list = await c.llm.models.list();
  MODELS = Array.isArray(list) ? list : [];
  return MODELS;
}
/* 模型优选：审查任务要的是「快 + 稳」，优先非深度思考模型。
   auto/default 会路由到重推理模型（实测 90s 仅产出思考过程），因此排在最后。 */
const MODEL_PREF = [
  'deepseek-v4.1-flash', 'glm-5.3-flash', 'deepseek-v4-flash', 'deepseek-v4-pro',
  'glm-5.3', 'glm-5.2', 'kimi-k3.1-pro', 'kimi-k3-1', 'hunyuan-chat', 'default', 'auto'
];

function pickModel(vision) {
  const all = MODELS || [];
  const usable = all.filter((m) => m.disabled !== true && (!vision || m.supportsImages === true));
  if (!usable.length) return null;
  for (const id of MODEL_PREF) {
    const m = usable.find((x) => x.id === id);
    if (m) return m;
  }
  const plain = usable.filter((m) => m.supportsReasoning !== true && m.onlyReasoning !== true);
  return plain[0] || usable[0];
}

async function chat(messages, opts) {
  opts = opts || {};
  const c = await ensureCloud();
  const m = pickModel(!!opts.vision);
  if (!m) throw new Error('当前环境没有可用的审查模型');
  await ensureModels();
  state.model = m;
  state.modelLabel = m.name || m.id;
  const params = { model: m.id, messages, stream: true, temperature: opts.temperature == null ? 0.2 : opts.temperature };
  if (opts.json) params.response_format = { type: 'json_object' };

  const ms = opts.timeout == null ? 90000 : opts.timeout;
  const ac = new AbortController();
  params.signal = ac.signal;
  const timer = setTimeout(() => { try { ac.abort(); } catch (e) {} }, ms);
  let out = '';
  try {
    for await (const chunk of c.llm.chat.completions.create(params)) {
      const d = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (d && d.content) out += d.content;
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    if ((e && e.name === 'AbortError') || /abort|aborted/i.test(msg)) {
      throw new Error('模型响应超时（' + Math.round(ms / 1000) + ' 秒），请重试或改用其他材料');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/* ---------- 常量：上限与切图规则 ---------- */
const MAX_FILE = 25 * 1024 * 1024;   // 单文件上限
const BLOCK_MAX = 8;                 // 每块 / 每次大模型调用上限
const GLOBAL_MAX = 30;               // Reduce 归并后全局上限
const UI_MAX = 20;                   // 单屏展示上限
const CROP_TRIGGER = 2000;           // 长边超过则切图
const CROP_SIZE = 1500;              // 每块高度
const CROP_OVERLAP = 0.15;           // 重叠比例
const PDF_SCAN_CHARS = 50;           // 单页文本层少于该值 → 视为扫描页
const PDF_RENDER_WIDTH = 2000;       // 扫描页渲染宽度
const PDF_BATCH = 5;                 // 渲染批大小
const PDF_SCAN_PAGE_CAP = 30;        // 扫描页处理上限

/* 块标记：多块材料在解析结果中以该行分隔，人工可编辑，审查时按标记切块 */
const BLOCK_MARK = /^〖块(\d+)\|([^〗]+)〗$/;

function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('文件读取失败'));
    r.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('图片解码失败'));
    img.src = src;
  });
}

async function imageSize(dataUrl) {
  const img = await loadImage(dataUrl);
  return { w: img.width, h: img.height };
}

/* 等比缩放到指定最大边（不改变长宽比，不外扩） */
async function downscale(dataUrl, max) {
  max = max || 1500;
  try {
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    if (scale >= 1 && dataUrl.length < 900000) return dataUrl;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.92);
  } catch (e) { return dataUrl; }
}

/* 裁剪矩形区域（用于长图切块，保留原分辨率） */
async function cropImage(dataUrl, sx, sy, sw, sh) {
  const img = await loadImage(dataUrl);
  const c = document.createElement('canvas');
  c.width = Math.round(sw);
  c.height = Math.round(sh);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.95);
}

/* 视觉识别；失败降级本地 OCR */
async function ocrOnce(dataUrl, noteFn) {
  const img = await downscale(dataUrl, 2000);
  try {
    const t = await ocrByVision(img);
    if (t && t.replace(/\s/g, '').length >= 2) return { text: t, degraded: false };
    throw new Error('视觉识别未返回有效文字');
  } catch (e) {
    if (noteFn) noteFn('视觉识别不可用，正在降级本地 OCR…');
    const t = await ocrByTesseract(img);
    return { text: t, degraded: true, reason: e.message };
  }
}

async function ocrByVision(dataUrl) {
  await ensureModels();
  const usable = (MODELS || []).filter((m) => m.disabled !== true);
  const v = usable.find((m) => m.supportsImages === true) || usable[0];
  if (!v) throw new Error('没有可用的多模态模型');
  const msgs = [
    { role: 'system', content: '你是中文金融宣传材料的光学字符识别引擎。只输出识别到的原文，不做解释、不做总结、不输出任何前后缀说明。' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '请逐字转写这张图片上的全部中文文字（含标题、艺术字、小字、脚注免责声明、数字、百分比、风险提示、落款），按版面从上到下、从左到右分行输出。小字也要尽力识别。保留原有标点与数字；不要翻译、不要改写、不要补全；无法辨认处用〔模糊〕占位。' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }
  ];
  const out = await chat(msgs, { vision: true, temperature: 0.05, timeout: 120000 });
  return cleanModelText(out);
}

function cleanModelText(t) {
  return String(t || '')
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/```$/, '')
    .replace(/^\s*(以下是|识别结果[:：])\s*/m, '')
    .trim();
}

async function ocrByTesseract(dataUrl) {
  if (!window.Tesseract) {
    await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js');
  }
  const img = await preprocess(dataUrl);
  const r = await window.Tesseract.recognize(img, 'chi_sim', { logger: () => {} });
  return cleanModelText(r && r.data ? r.data.text : '');
}

/* 灰度化 + 二值化 + 对比度增强 + 2x 放大，供本地 OCR 使用 */
function preprocess(dataUrl) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const c = document.createElement('canvas');
      c.width = img.width * scale;
      c.height = img.height * scale;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const p = d.data;
      for (let i = 0; i < p.length; i += 4) {
        const g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
        const v = g > 175 ? 255 : g < 95 ? 0 : (g - 95) * 3.2;
        p[i] = p[i + 1] = p[i + 2] = v;
      }
      ctx.putImageData(d, 0, 0);
      res(c.toDataURL('image/png'));
    };
    img.onerror = () => res(dataUrl);
    img.src = dataUrl;
  });
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('脚本加载失败：' + src));
    document.head.appendChild(s);
  });
}

const PDF_BASES = [
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/',
  'https://unpkg.com/pdfjs-dist@3.11.174/build/',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'
];
let pdfBase = null;

async function ensurePdfJs() {
  if (window.pdfjsLib) {
    if (!pdfBase) pdfBase = PDF_BASES[0];
    return window.pdfjsLib;
  }
  for (const base of PDF_BASES) {
    try {
      await loadScript(base + 'pdf.min.js');
      if (window.pdfjsLib) { pdfBase = base; return window.pdfjsLib; }
    } catch (e) { /* 换下一个源 */ }
  }
  throw new Error('PDF 解析组件加载失败，请改用截图按图片上传');
}

async function serverParse(file, ext) {
  const res = await fetch('/api/parse?ext=' + encodeURIComponent(ext) + '&name=' + encodeURIComponent(file.name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || '解析失败');
  return j;
}

/* ============================================================
 * 块模型：所有解析产物统一为 { location, text, kind }
 * ============================================================ */

function assembleText(blocks) {
  const plain = blocks.length === 1 && (blocks[0].kind === 'text' || blocks[0].kind === 'pdf-text');
  if (plain) return blocks[0].text;
  return blocks.map((b, i) => '〖块' + (i + 1) + '|' + b.location + '〗\n' + b.text).join('\n\n');
}

function splitBlocks(raw) {
  const lines = String(raw || '').split('\n');
  const blocks = [];
  let cur = null;
  lines.forEach((line) => {
    const m = line.trim().match(BLOCK_MARK);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { location: m[2].trim(), text: '' };
    } else {
      if (!cur) cur = { location: '正文', text: '' };
      cur.text += (cur.text ? '\n' : '') + line;
    }
  });
  if (cur) blocks.push(cur);
  return blocks
    .map((b) => ({ location: b.location, text: b.text.trim() }))
    .filter((b) => b.text.length > 0 || /图片|表格|页/.test(b.location));
}

/* 长图 / 横幅切块：按长边切分，相邻块 15% 重叠，禁止零重叠硬切 */
async function sliceImage(dataUrl, locationPrefix) {
  const { w, h } = await imageSize(dataUrl);
  const longEdge = Math.max(w, h);
  if (longEdge <= CROP_TRIGGER) {
    return [{ location: locationPrefix, dataUrl: dataUrl, kind: 'img' }];
  }
  const vertical = h >= w;
  const step = Math.round(CROP_SIZE * (1 - CROP_OVERLAP));
  const pieces = [];
  if (vertical) {
    for (let y = 0, i = 0; y < h; y += step, i++) {
      const sh = Math.min(CROP_SIZE, h - y);
      if (sh < 40) break;
      pieces.push({ location: '长图切块' + (i + 1), dataUrl: await cropImage(dataUrl, 0, y, w, sh), kind: 'crop' });
      if (y + sh >= h) break;
    }
  } else {
    for (let x = 0, i = 0; x < w; x += step, i++) {
      const sw = Math.min(CROP_SIZE, w - x);
      if (sw < 40) break;
      pieces.push({ location: '横幅切块' + (i + 1), dataUrl: await cropImage(dataUrl, x, 0, sw, h), kind: 'crop' });
      if (x + sw >= w) break;
    }
  }
  return pieces;
}

/* 重叠区去重：去掉当前块开头与上一块结尾重复的行 */
function dedupeOverlap(prevText, text) {
  if (!prevText) return text;
  const prevLines = prevText.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const curLines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let cut = 0;
  for (let k = Math.min(6, prevLines.length, curLines.length); k > 0; k--) {
    const tail = prevLines.slice(-k).join('');
    const head = curLines.slice(0, k).join('');
    if (tail && head && (tail === head || tail.indexOf(head) >= 0 || head.indexOf(tail) >= 0)) { cut = k; break; }
  }
  return curLines.slice(cut).join('\n');
}

/* ============================================================
 * 解析入口：产出块列表
 * ============================================================ */
async function handleFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const isImg = /^(jpg|jpeg|png|webp|bmp)$/.test(ext);
  if (!isImg && ['docx', 'pdf', 'txt', 'pptx'].indexOf(ext) < 0) {
    toast('暂不支持该格式：' + ext);
    return;
  }
  if (file.size > MAX_FILE) {
    $('#parseCard').hidden = false;
    $('#parseName').textContent = file.name;
    $('#parseChars').textContent = '已拦截';
    $('#parseSource').textContent = '超限';
    $('#parseText').value = '';
    const w0 = $('#parseWarn');
    w0.hidden = false;
    w0.className = 'warn error';
    w0.textContent = '文件超过 25MB 上限（当前 ' + (file.size / 1024 / 1024).toFixed(1) + 'MB），请压缩图片或拆分后上传。';
    toast('文件超过 25MB 上限，请压缩图片或拆分后上传');
    return;
  }

  state.materialName = file.name;
  state.complexPages = [];
  // 新材料 = 新会话：清空上一轮意见、撤销栈与操作日志
  state.opinions = [];
  state.log = [];
  state.undoStack = [];
  state.redoStack = [];
  state.overallConclusion = '';
  state.rejected = [];
  state.reportExported = false;
  state.stepReached = 1;
  renderLog();
  renderTrace();
  refreshReviewUI();
  traceNode('业务部门上传待审材料：' + file.name + '（' + $('#lineSel').value + ' / ' + $('#typeSel').value + '）', 'node');
  const warns = [];
  const blocks = [];
  let source = '';

  $('#parseCard').hidden = false;
  $('#parseName').textContent = file.name;
  $('#parseChars').textContent = '解析中…';
  $('#parseText').value = '';
  $('#parseSource').textContent = '解析中';

  const note = (msg) => { $('#parseChars').textContent = msg; };

  try {
    if (isImg) {
      source = '图片 · 视觉识别';
      const dataUrl = await fileToDataURL(file);
      const pieces = await sliceImage(dataUrl, '图片');
      if (pieces.length > 1) {
        source = '图片 · 视觉识别（长图切块 ' + pieces.length + ' 块）';
        warns.push('长图已切成 ' + pieces.length + ' 块识别，切块间保留 15% 重叠区，重叠文本已自动去重');
      }
      let degraded = false;
      let prev = '';
      for (let i = 0; i < pieces.length; i++) {
        note('识别中 ' + (i + 1) + '/' + pieces.length + ' 块…');
        const r = await ocrOnce(pieces[i].dataUrl, (m) => note(m));
        if (r.degraded) degraded = true;
        const txt = dedupeOverlap(prev, r.text || '');
        prev = r.text || '';
        blocks.push({ location: pieces[i].location, text: txt, kind: pieces[i].kind });
      }
      if (degraded) {
        source = '图片 · 本地 OCR（识别率有限）';
        warns.push('本地 OCR 对中文艺术字、复杂排版识别率较低，请逐字核对下方文本后再提交审查');
      }
    } else if (ext === 'pdf') {
      const r = await pdfBlocks(file, note, warns);
      blocks.push.apply(blocks, r.blocks);
      source = r.source;
    } else if (ext === 'docx') {
      const j = await serverParse(file, ext);
      const imgTotal = (j.images || []).length;
      const vec = j.vector || 0;
      if (j.text) blocks.push({ location: '正文', text: j.text, kind: 'text' });
      let recognized = 0;
      let degraded = false;
      for (let i = 0; i < imgTotal; i++) {
        note('识别 docx 内嵌图片 ' + (i + 1) + '/' + imgTotal + '…');
        const im = j.images[i];
        const dataUrl = 'data:' + im.mime + ';base64,' + im.b64;
        try {
          const r = await ocrOnce(dataUrl, (m) => note(m));
          if (r.degraded) degraded = true;
          if (r.text && r.text.replace(/\s/g, '').length >= 2) {
            blocks.push({ location: 'docx内嵌图片第' + (i + 1) + '张', text: r.text, kind: 'docx-img' });
            recognized++;
          }
        } catch (e) {
          warns.push('docx 内嵌图片第' + (i + 1) + '张识别失败：' + e.message);
        }
      }
      const tidbits = [];
      if (j.text) tidbits.push('正文 ' + j.text.replace(/\s/g, '').length + ' 字');
      tidbits.push('表格 ' + (j.tables || 0) + ' 个');
      tidbits.push('内嵌图片 ' + imgTotal + ' 张，已识别 ' + recognized + ' 张');
      source = 'DOCX · 服务端解析（' + tidbits.join('、') + '）';
      if (vec) warns.push('检测到 ' + vec + ' 个 Office 矢量图（EMF/WMF 等），浏览器无法解析，内文需人工复核');
      if (degraded) warns.push('部分内嵌图片降级为本地 OCR，识别率有限，请逐字核对');
      if (imgTotal && !recognized) warns.push('内嵌图片均未识别出文字，请人工核对图片内容');
    } else if (ext === 'pptx') {
      const j = await serverParse(file, ext);
      const slides = j.slides || [];
      let complexPages = [];
      slides.forEach((sl) => {
        if (sl.text) {
          blocks.push({
            location: '第' + sl.page + '页-' + (sl.kinds || '文本框'),
            text: sl.text,
            kind: 'pptx-slide'
          });
        }
        if (sl.charts) complexPages.push(sl.page);
      });
      source = 'PPTX · 服务端解析（' + slides.length + ' 页）';
      if (complexPages.length) {
        warns.push('第 ' + complexPages.join('、') + ' 页检测到复杂图形（图表/SmartArt），内文需人工复核');
        state.complexPages = complexPages;
      }
      if (!blocks.length) warns.push('未提取到任何页文字，请注意版式与母版文字不参与审查');
    } else {
      const j = await serverParse(file, ext);
      blocks.push({ location: '正文', text: j.text, kind: 'text' });
      source = 'TXT · 服务端解析';
      (j.warnings || []).forEach((w) => warns.push(w));
    }

    if (!blocks.length) throw new Error('未提取到任何文字，请更换文件或改为图片上传');

    const text = assembleText(blocks);
    state.text = text;
    state.blockCount = blocks.length;
    state.parseSource = source;
    $('#parseSource').textContent = source;
    $('#parseText').value = text;
    $('#parseChars').textContent = text.replace(BLOCK_MARK, '').replace(/\s/g, '').length + ' 字 · ' + blocks.length + ' 个内容块';
    traceNode('系统解析完成（' + source + '；提取文本 ' + text.replace(BLOCK_MARK, '').replace(/\s/g, '').length + ' 字，' + blocks.length + ' 个内容块）', 'node');
    if (warns.length) {
      const w = $('#parseWarn');
      w.hidden = false;
      w.className = 'warn';
      w.textContent = warns.join('；');
    } else {
      $('#parseWarn').hidden = true;
    }
  } catch (e) {
    $('#parseChars').textContent = '解析失败';
    const w = $('#parseWarn');
    w.hidden = false;
    w.className = 'warn error';
    w.textContent = e.message || '解析失败';
    $('#parseSource').textContent = '失败';
  } finally {
    const inp = $('#fileInput');
    if (inp) inp.value = '';
  }
}

/* pdf.js 逐字返回文本项：按行/坐标拼接，避免中文被拆成“保 本 保 息” */
function textItemsToText(tc) {
  const items = (tc && tc.items) || [];
  const lines = [];
  let cur = [];
  let curY = null;
  const CJK = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/;
  const alnum = /[A-Za-z0-9]/;
  const push = (str) => {
    if (!str) return;
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const a = prev.slice(-1);
      const b = str.slice(0, 1);
      const needSpace = alnum.test(a) && alnum.test(b);
      cur.push((needSpace ? ' ' : '') + str);
    } else {
      cur.push(str);
    }
  };
  const flush = () => {
    const line = cur.join('').replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
    cur = [];
  };
  items.forEach((it) => {
    const str = it.str;
    if (!str) { if (it.hasEOL) flush(); return; }
    const y = it.transform ? Math.round(it.transform[5]) : null;
    if (curY !== null && y !== null && Math.abs(y - curY) > 2) { flush(); }
    curY = y;
    push(str);
    if (it.hasEOL) flush();
  });
  flush();
  // NFKC + 部首补充区还原：PDF 字体子集常把汉字映射成兼容汉字/部首（如“唯⼀”“⻛险”）
  let out = lines.join('\n');
  try { out = out.normalize('NFKC'); } catch (e) { /* 忽略 */ }
  const RADICAL = { '⻛': '风', '⻓': '长', '⻔': '门', '⻉': '贝', '⻋': '车', '⻢': '马', '⻦': '鸟', '⻥': '鱼', '⻚': '页', '⻜': '飞', '⻩': '黄', '⻰': '龙', '⻳': '龟', '⻘': '青', '⻙': '韦', '⻮': '齿', '⻅': '见', '⻆': '角', '⻈': '讠', '⻐': '钅' };
  out = out.replace(/[⻛⻓⻔⻉⻋⻢⻦⻥⻚⻜⻩⻰⻳⻘⻙⻮⻅⻆⻈⻐]/g, (c) => RADICAL[c] || c);
  return out;
}

/* PDF：逐页判断文本层，扫描页渲染为图片识别；每 5 页一批 */
async function pdfBlocks(file, note, warns) {
  const lib = await ensurePdfJs();
  lib.GlobalWorkerOptions.workerSrc = pdfBase + 'pdf.worker.min.js';
  const buf = await file.arrayBuffer();
  const doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
  const total = doc.numPages;
  const pages = [];
  for (let i = 1; i <= total; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const line = textItemsToText(tc);
    pages.push({ no: i, text: line, chars: line.replace(/\s/g, '').length });
  }

  const scanNos = pages.filter((p) => p.chars < PDF_SCAN_CHARS).map((p) => p.no);
  const blocks = [];
  let degradedAny = false;

  // 文字页直接进入内容块
  pages.forEach((p) => {
    if (p.chars >= PDF_SCAN_CHARS) {
      blocks.push({ no: p.no, location: 'PDF第' + p.no + '页', text: p.text, kind: 'pdf-text' });
    }
  });

  if (scanNos.length) {
    const capped = scanNos.slice(0, PDF_SCAN_PAGE_CAP);
    if (scanNos.length > PDF_SCAN_PAGE_CAP) {
      warns.push('材料较长，扫描页共 ' + scanNos.length + ' 页，已自动处理前 ' + PDF_SCAN_PAGE_CAP + ' 页，其余建议拆分上传');
    }
    for (let b = 0; b < capped.length; b += PDF_BATCH) {
      const batch = capped.slice(b, b + PDF_BATCH);
      for (let k = 0; k < batch.length; k++) {
        const no = batch[k];
        note('扫描页转图片识别：第 ' + no + ' 页（' + (b + k + 1) + '/' + capped.length + '）');
        const page = await doc.getPage(no);
        const vp1 = page.getViewport({ scale: 1 });
        const scale = Math.min(3, PDF_RENDER_WIDTH / vp1.width);
        const vp = page.getViewport({ scale: scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const dataUrl = canvas.toDataURL('image/png');
        const r = await ocrOnce(dataUrl, (m) => note(m));
        if (r.degraded) degradedAny = true;
        blocks.push({ no: no, location: 'PDF第' + no + '页（扫描）', text: r.text || '', kind: 'pdf-scan' });
      }
      await sleep(30); // 释放内存，避免大 PDF 渲染溢出
    }
    warns.push('扫描版 PDF，第 ' + capped.join('、') + ' 页无文本层，已自动转为图片识别');
  }

  blocks.sort((a, b) => a.no - b.no);
  if (degradedAny) warns.push('部分扫描页降级为本地 OCR（灰度+二值化+2倍放大），识别率有限，请逐字核对');

  const mixed = scanNos.length > 0 && scanNos.length < total;
  const source = 'PDF · ' + (mixed ? '文本层+图片混合识别' : scanNos.length ? '图片识别' : '文本层提取') + '（' + total + ' 页' + (scanNos.length ? '，扫描 ' + scanNos.length + ' 页' : '') + '）';
  return {
    blocks: blocks.filter((b) => (b.text || '').trim().length > 0 || b.kind === 'pdf-scan'),
    source: source
  };
}

/* ---------- 审查 ---------- */
function stageSet(k, cls, note) {
  const li = document.querySelector('.progress li[data-k="' + k + '"]');
  if (!li) return;
  li.classList.remove('running', 'done');
  if (cls) li.classList.add(cls);
  if (note) li.querySelector('em').textContent = note;
}

const DIM_CN = ['一', '二', '三', '四', '五', '六', '七', '八'];

/* ============================================================
 * 审查判断说明书（system prompt 核心）
 * 说明：注入的是「判断模式」而非违规词表，词会变、模式不会变
 * ============================================================ */
function buildSystemPrompt() {
  const L = [];
  L.push('# 角色');
  L.push('你是银行消保审查专家，精通以下法规，必须精确引用条款号，禁止编造条款号：');
  ['xfz10', 'xfz20', 'ggf9', 'ggf13', 'xb21', 'xb23', 'yf316', 'lcs', 'gdk', 'bxpl', 'pbc3'].forEach((k, i) => {
    L.push((i + 1) + '. ' + LAWS[k]);
  });
  L.push('');
  L.push('# 任务');
  L.push('对输入材料按以下 8 个维度逐项穷尽式审查。漏报后果远重于误报：宁可多报并标注“需人工判断”，不得遗漏可疑点。');
  L.push('每个维度必须先判断「是否存在该类表述」，再判断「是否构成违规」，禁止脱离判断模式自由发挥。材料超过 1000 字时分块逐段覆盖全部维度。');
  L.push('');
  L.push('# 八个维度与判断模式（按模式识别，不要只匹配关键词）');
  DIMENSIONS.forEach((d) => {
    L.push('维度' + DIM_CN[d.id - 1] + '（' + d.name + '）：');
    d.patterns.forEach((p) => L.push('  - ' + p));
    L.push('  法规锚点：' + LAWS[d.law]);
  });
  L.push('');
  L.push('# 输出格式（只输出一个 JSON 对象，不输出任何其他文字，不使用 Markdown 代码块）');
  L.push('{"overall_conclusion":"整体审查结论1-2句，含风险等级",');
  L.push(' "risk_level":"高/中/低/合规",');
  L.push(' "summary_stats":{"total":0,"high":0,"medium":0,"low":0},');
  L.push(' "rule_verdicts":[{"candidate_id":"C1","verdict":"confirm 或 reject",');
  L.push('   "risk_level":"高/中/低","violation_type":"","legal_basis":"","reason":"confirm 写违规理由；reject 写豁免依据",');
  L.push('   "suggestion":"合规时写“无”","judgment_path":""}],');
  L.push(' "findings":[{"original_text":"原文片段（逐字引用，禁止改写拼接）",');
  L.push('  "dimension":"维度X 名称",');
  L.push('  "violation_type":"对应七类禁止内容中的类别，或“语义疑似风险”",');
  L.push('  "judgment_path":"依据维度X的‘XX判断模式’，原文中‘XX’与‘XX’的语义特征（矛盾/包装/缺失要素/显著性不足）构成该类违规",');
  L.push('  "legal_basis":"《法规名》第X条第（X）项+关键内容摘引",');
  L.push('  "reason":"文中‘XX’存在XX因素，可能使消费者误认为…，影响消费者XX权",');
  L.push('  "suggestion":"具体修改操作（删除什么/替换为什么标准表述/补充什么要素）",');
  L.push('  "risk_level":"高/中/低",');
  L.push('  "source":"规则库命中/大模型语义分析",');
  L.push('  "confidence":"高/中/低",');
  L.push('  "need_human_review":true}]}');
  L.push('');
  L.push('置信度定义：高＝判断模式完全匹配且原文特征明确；中＝依据明确判断模式得出；低＝语义存在歧义——此时 reason 必须写“疑似风险，需人工判断”，不得写“明确违规”。');
  L.push('一致性要求：risk_level 与 summary_stats 必须与 findings 实际条目一致（存在高风险即“高”，无高但有中风险即“中”，其余为“低”或“合规”），overall_conclusion 中不得出现与之一致的更高风险等级表述。');
  L.push('');
  L.push('# 判断纪律（必须遵守）');
  L.push('1. original_text 必须逐字来自原文，不得改写、拼接或编造；无法在原文检索到的片段一律不得输出。');
  L.push('2. legal_basis 必须来自上面的法规清单，禁止编造条款号，必须具体到条款项。');
  L.push('3. 标准合规提示语本身（“理财非存款，产品有风险，投资须谨慎”“过往业绩不代表未来表现”“详见产品说明书”）不得报为问题，但可以报告“其显著性是否不足”。');
  L.push('4. 已标注“不代表实际收益/不构成收益承诺”的业绩比较基准属合规披露，不得单独报为违规。');
  L.push('5. 输出前自检：八个维度是否都过了一遍？高危信号（保本/0风险/100%/最X级/无需用途证明/正收益概率/占位符XX元）是否逐一核查？同一处原文是否重复出多条意见（须合并）？');
  L.push('6. 同一处原文若同时触犯多个维度，合并为一条意见，dimension 写主要维度，violation_type 用“；”并列。');
  L.push('7. 称呼语、问候语、自我介绍、业务流程说明（如“您好，请问是X先生吗”“我是您的客户经理”）本身不构成违规，不得作为意见输出；只有当其与误导性内容结合时才可引用。');
  L.push('8. 宁可不报，也不得为凑数而输出无法落到具体判断模式的意见；每条意见都必须能被审查人员按 judgment_path 复核到原文特征。');
  L.push('');
  L.push('# 规则初筛的定位：你拥有最终定性权（False Positive Filter）');
  L.push('user 消息里的【规则初筛结果】只是“疑似命中”预警，不是结论。你必须对每一条 candidate_id 给出裁决：');
  L.push('- confirm：确认构成违规，可自行调整风险等级、违规类型、法规依据与改进建议；');
  L.push('- reject：判定为误报，必须在 reason 写明豁免依据（如“最高贷150万元属定量业务参数上限”）。');
  L.push('凡是语境合规、属产品要素或定量参数的命中，一律 reject，不得为了“凑数”而保留。findings 只写你自己发现的、规则层未提示的问题。');
  L.push('');
  L.push('# 维度五的判定边界（必须严格遵守，这是最主要的误报来源）');
  L.push('《广告法》第九条第（三）项禁止的是“无法量化验证的绝对化用语”。判别口诀：');
  L.push('- 最高/最长/最多/最低 + 数字单位或参数名词 = 定量业务参数上限 → 不构成违规。');
  L.push('  例：“单人最高贷150万元”“金额最高30万”“授信最长36个月”“最长期限5年”“最高收益率5.8%”“年龄不超过60岁”“起购金额40.2万”。');
  L.push('- 收益/回报/涨幅/业绩/分红/排名 + 最高，或 最高级/最佳产品/全行唯一/行业第一/国家级 → 修饰性质、等级、排名、排他性 → 构成违规。');
  L.push('  例：“收益最高5.8%”“全行唯一爆款”“最高级配置”“行业第一”。');
  L.push('');
  L.push('# 维度二的判定边界（三个特征门，缺一不判违规）');
  L.push('只有命中以下任一特征才输出违规：');
  L.push('A 无源数据：引用排名或收益，且无来源、无统计口径、无时间标记（无年份/近一年/成立以来/截至日期）；');
  L.push('B 隐瞒限制：把业绩比较基准/分红演示表述为确定收益，或只给极端收益（≥30%）且全文无任何风险提示；');
  L.push('C 绝对保证：数据周围出现“稳赚/必得/保证/100%正收益”等承诺性词汇。');
  L.push('以下一律不判违规（合规豁免）：');
  L.push('- “2025年收益11.99%”“成立以来收益4%”“近一年涨幅10.6%”等带时间标记的客观历史数据陈述；');
  L.push('- “量化对冲策略”“主投债券”“权益仓位约20%”“纯信用免担保”“起购金额40.2万”等产品要素说明；');
  L.push('- “回撤相对较小”“风控严格”等模糊定性描述，最多提示补充量化数据（低风险），不得判为高危。');
  L.push('');
  L.push('# 禁止过度审查与乱改原文');
  L.push('1. 不得对客观产品要素做“泛道德化/政治正确”式改写：夫妻共贷、单人贷款、纯信用免担保、起购金额、期限等属合法产品结构，不得建议改成“多名符合条件的借款人”之类表述。');
  L.push('2. 原文合规时，suggestion 必须输出“无”，不得强行提出修改。');
  L.push('3. 若 user 消息标注【已检出统一免责声明】，说明脚注已有“以最终审批为准”，不得再建议正文逐处加注额度/利率免责。');
  L.push('4. 候选标注为“要素核查·免责声明/定性表述”等低风险建议类时，只要材料确实缺少该要素，应 confirm，不得 reject。');
  L.push('5. 贷款用途类违规只认明示表述（“无需用途证明”“不用提供用途”“无视征信”“凭身份证即可贷”）。不得仅凭“自主支付额度高”“额度上限大”推断存在用途违规，也不得因此输出维度一/维度七意见。');
  L.push('');
  L.push('# 少样本示例（仅校准判断尺度，禁止照抄进输出）');
  L.push('例1：材料同现“0风险”与“风险等级R2”→ 维度一，judgment_path：“依据内部矛盾模式，‘0风险’与‘R2’同框构成自相矛盾”，suggestion：“删除‘0风险’，保留‘R2（中低风险）’并加注‘本产品不保本不保收益’”，高风险。');
  L.push('例2：“持有30日正收益概率100%”→ 维度二，依据选择性统计模式，判高，suggestion：“删除该表述；如保留须注明统计区间、样本量及‘不代表未来’”。');
  L.push('例3：“自主支付高达100万元，无需用途证明”→ 维度一，依据用途规避模式，判高，suggestion：“删除‘无需用途证明’，改为‘消费用途贷款，按监管要求提供用途资料’”。');
  L.push('例4：“资产提升最高可获得XX元权益”→ 维度二，依据占位符模式，判高（流程缺陷），suggestion：“填实金额并注明活动规则，送审环节应增加占位符自动检测”。');
  L.push('例5：“固定收益类”作最大字号产品标注→ 维度一，依据包装误导模式，判中，suggestion：“旁加注‘指产品投向分类，非收益承诺’”。');
  L.push('例6：“单人最高贷150万元”→ 维度五 reject：最高+数字单位修饰贷款额度，属定量参数上限，suggestion：“无”。');
  L.push('例7：“收益最高5.8%”→ 维度五 confirm：收益+最高属修饰收益水平的绝对化表述，判高。');
  L.push('例8：“2025年收益11.99%，量化对冲策略，回撤相对较小”→ 维度二不判违规，至多 1 条低风险建议“补充回撤量化数据”。');
  return L.join('\n');
}

const SYSTEM_PROMPT = buildSystemPrompt();

function buildPrompt(text, ruleHits, meta) {
  const FINAL_DISCLAIM = /(以最终审批为准|以实际审批为准|以实际为准|最终以.{0,8}为准|具体以.{0,8}为准|审批结果为准)/;
  const hasFinalDisclaim = FINAL_DISCLAIM.test(text);
  const cand = ruleHits.length
    ? ruleHits.map((r) => [
      r.cid + '｜维度' + DIM_CN[(r.dim || 7) - 1] + '｜' + (r.ruleLabel || r.typeName || ''),
      '｜命中“' + (r.hit || '整篇') + '”',
      '｜要点：' + String(r.conclusion || '').slice(0, 34),
      '｜原文：' + (r.snippet || '').slice(0, 50)
    ].join(' ')).join('\n')
    : '（无）';
  return [
    '【送审材料】业务条线：' + meta.line + '；材料类型：' + meta.type + (meta.name ? '；材料名称：' + meta.name : '') + (meta.location ? '；内容块：' + meta.location : ''),
    '',
    '【规则初筛结果（疑似命中，需你逐条裁决：confirm / reject）】',
    cand,
    '',
    '【材料免责声明检测】' + (hasFinalDisclaim
      ? '已检出统一免责声明（如“以最终审批为准”），不得再建议正文逐处加注额度/利率免责。'
      : '未检出“以最终审批为准”类统一免责声明；若材料含额度/期限/利率参数，可给 1 条低风险建议。'),
    '',
    '【材料正文（原文，findings.original_text 必须逐字引用这里的内容）】',
    text.slice(0, 6000),
    '',
    '【要求】',
    '1. 先对上面每条 candidate_id 给出 verdict（confirm 或 reject），reject 必须写明豁免依据；',
    '2. 再用 findings 补充规则层未发现的语义问题（内部矛盾、包装暗示、限制条件缺失、显著性不足、适当性侵犯）；',
    '3. 维度五只抓“收益最高/最高级/最佳/唯一/国家级”这类绝对化表述，“最高贷150万/最长36个月”属定量参数，必须 reject；',
    '4. 维度二按 A/B/C 三个特征门判定，带时间标记的客观历史数据与产品要素说明不得判违规；',
    '5. 原文合规时 suggestion 输出“无”，禁止对夫妻共贷、纯信用免担保等产品结构做泛道德化改写。'
  ].join('\n');
}

function safeParseJSON(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  const tryParse = (t) => { try { return JSON.parse(t); } catch (e) { return null; } };
  let v = tryParse(s);
  if (!v) {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) v = tryParse(s.slice(a, b + 1));
  }
  if (!v) {
    const a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a >= 0 && b > a) {
      const arr = tryParse(s.slice(a, b + 1));
      if (arr) v = { opinions: arr };
    }
  }
  if (!v) {
    // 兜底：字符串内出现裸换行等控制字符时做一次修复后重试
    const repaired = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
    v = tryParse(repaired);
    if (!v) {
      const a = repaired.indexOf('{'), b = repaired.lastIndexOf('}');
      if (a >= 0 && b > a) v = tryParse(repaired.slice(a, b + 1));
    }
  }
  if (!v) return null;
  if (Array.isArray(v)) return { findings: v, opinions: v };
  if (Array.isArray(v.findings)) return v;
  if (Array.isArray(v.opinions)) return { ...v, findings: v.opinions };
  if (Array.isArray(v.data)) return { ...v, findings: v.data };
  if (Array.isArray(v.意见)) return { ...v, findings: v.意见 };
  return null;
}

function norm(s) {
  return String(s || '').replace(/[\s，。；、！？""''（）()【】\[\]：:·\-—…"'.]/g, '');
}
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
/* 平衡版相似度：短片段对长窗口不会恒为 1 */
function dice(a, b) {
  const A = bigrams(norm(a)), B = bigrams(norm(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((g) => { if (B.has(g)) inter++; });
  return (2 * inter) / (A.size + B.size);
}
function dimOf(name) {
  const m = String(name || '').match(/^（([一二三四五六七八])）/);
  if (!m) return 0;
  return '一二三四五六七八'.indexOf(m[1]) + 1;
}

/* 与大模型结果合并：同维度且片段被规则窗口覆盖 → 视为重复；
   不同维度时只在高度重合时才丢弃，避免误杀大模型独有发现 */
function residualLen(sn, covered) {
  let s = norm(sn);
  covered.forEach((w) => { if (w) s = s.split(norm(w)).join(''); });
  return s.length;
}

function isDupWithKept(item, kept, covered) {
  const dim = item.dim || 0;
  const sn = norm(item.snippet);
  const isLlm = item.source === 'llm';

  // 「已覆盖词剩余量」只用于大模型意见的复述判重；
  // 规则层是确定性命中，即便片段很短也必须保留（否则高风险项会被吞掉）
  if (isLlm && residualLen(item.snippet, covered) <= 3) return true;

  return kept.some((k) => {
    const kd = k.dim || dimOf(k.typeName);
    const ks = norm(k.snippet);
    const diceScore = dice(k.snippet, item.snippet);
    if (isLlm) {
      if (sn.length >= 4 && ks.length >= 4 && (sn.indexOf(ks) >= 0 || ks.indexOf(sn) >= 0)) return true;
      if (dim && kd && dim === kd && diceScore > 0.72) return true;
      return diceScore > 0.85;
    }
    // 规则层之间：仅同维度且高度重合才算重复，避免不同违规类型互相吞并
    if (dim && kd && dim !== kd) return false;
    if (sn.length >= 4 && ks.length >= 4 && (sn.indexOf(ks) >= 0 || ks.indexOf(sn) >= 0)) return true;
    return diceScore > 0.75;
  });
}

/* 合规披露用语不应被判为违规：提示词之外再做一层兜底过滤。
   但片段中同时含保本/绝对化表述时不做豁免，避免漏判。 */
const COMPLIANT_GUARD = [
  /不代表|不构成|非承诺|过往业绩/,
  /理财非存款|产品有风险|投资须谨慎|投资有风险|风险自担/,
  /风险揭示书|产品说明书|销售文件|官网查阅|网点查阅/
];
function isCompliantSnippet(snippet) {
  const s = String(snippet || '');
  if (!s) return false;
  if (/(保本|保息|保证收益|无风险|零风险|稳赚|包赚|绝对|一定|必然|最高|最佳|最优|第一|唯一)/.test(s)) return false;
  return COMPLIANT_GUARD.some((re) => re.test(s));
}

/* 引用校验：大模型给出的原文片段必须能在材料原文中检索到，否则视为编造并剔除 */
function verifyQuote(snippet, materialText) {
  const src = String(materialText || '').replace(/\s+/g, '');
  const q = String(snippet || '').replace(/\s+/g, '');
  if (q.length < 4) return { ok: false, text: '' };
  if (src.indexOf(q) >= 0) return { ok: true, text: snippet };
  for (let len = q.length - 1; len >= 6; len--) {
    const part = q.slice(0, len);
    const i = src.indexOf(part);
    if (i >= 0) return { ok: true, text: src.slice(i, i + len) };
  }
  return { ok: false, text: '' };
}

/* 维度识别：兼容“维度二 夸大业绩”“（二）…”“维度2”等写法 */
function dimFromText(t) {
  const s = String(t || '');
  let m = s.match(/维度\s*([一二三四五六七八1-8])/);
  if (m) {
    const c = m[1];
    const n = '12345678'.indexOf(c);
    if (n >= 0) return n + 1;
    const i = '一二三四五六七八'.indexOf(c);
    if (i >= 0) return i + 1;
  }
  m = s.match(/^[（(]?\s*([一二三四五六七八])\s*[）)]?/);
  if (m) {
    const i = '一二三四五六七八'.indexOf(m[1]);
    if (i >= 0) return i + 1;
  }
  return 0;
}

/* 维度证据门：每条意见必须在本维度上有可核验的语义证据，
   否则视为“脱离判断模式的自由发挥”予以剔除（守纪律，不守则会误报）。 */
const DIM_EVIDENCE = {
  2: /(\d|%|％|万|亿|倍|排名)/,
  3: /(监管|银保监|证监会|人民银行|央行|国家|备案|批准|审核|认证|背书)/,
  4: /(保本|保息|保收益|无风险|零风险|刚性兑付|稳赚|稳赢|必赚|保证|承诺|100%|本金|兑付|兜底|收益|回报|增值|安全|保障|赚)/,
  5: /(最|极|顶|第一|唯一|独家|国家级|世界级|全球|NO\.?\s?1|N0\.1|领跑|领先|首[个家推]|销量)/i,
  6: /(男|女|性别|年龄|户口|本地|外地|民族|宗教|信仰|残障|残疾|地域|籍贯)/,
  7: /(无需用途|不用提供用途|用途证明|无视征信|不看征信|凭身份证|提前还款|转过来|归集|权益|额度越有限|早做早踏实|风险测评|风险评估|放弃)/,
  8: /(风险|谨慎|提示|说明|解释权|违约金|免密|续费|显著|标注|揭示)/
};
function hasDimEvidence(dim, snippet) {
  const re = DIM_EVIDENCE[dim];
  if (!re) return true; // 维度一/七为语义综合判断，不做词面拦截
  return re.test(String(snippet || ''));
}

/* 将模型返回的 findings（英文 schema）归一化为内部意见对象 */
function normalizeLLM(list, ruleOpinions, materialText, stats) {
  stats = stats || { dropped: 0 };
  const kept = ruleOpinions.slice();
  const covered = [];
  ruleOpinions.forEach((r) => {
    String(r.hit || '').split(/[、,，\s]+/).forEach((w) => { if (w && w.length >= 2) covered.push(w); });
  });
  covered.sort((a, b) => b.length - a.length);
  const out = [];

  (list || []).forEach((o) => {
    const snippet = String(o.original_text || o['原文片段'] || o.snippet || '').trim();
    let reason = String(o.reason || o['审查结论'] || o.conclusion || '').trim();
    if (!snippet && !reason) return;

    const vq = verifyQuote(snippet, materialText);
    if (!vq.ok) { stats.dropped++; return; }

    const dimText = String(o.dimension || o['维度'] || '').trim();
    const typeRaw = String(o.violation_type || o['违规类型'] || '').trim();
    const dim = dimFromText(dimText) || dimFromText(typeRaw) || 7;
    const dimName = DIMENSIONS[dim - 1] ? DIMENSIONS[dim - 1].name : DIMENSIONS[6].name;
    const typeName = typeRaw
      ? (/^[（(]/.test(typeRaw) ? typeRaw : '（' + DIM_CN[dim - 1] + '）' + typeRaw)
      : '（' + DIM_CN[dim - 1] + '）' + dimName;

    const riskRaw = String(o.risk_level || o['风险等级'] || '中').trim();
    const risk = riskRaw.indexOf('高') >= 0 ? '高' : riskRaw.indexOf('低') >= 0 ? '低' : '中';
    const confRaw = String(o.confidence || o['置信度'] || '中').trim();
    const confidence = confRaw.indexOf('高') >= 0 ? '高' : confRaw.indexOf('低') >= 0 ? '低' : '中';

    if (isCompliantSnippet(snippet)) return;
    if (!hasDimEvidence(dim, vq.text)) { stats.evidence = (stats.evidence || 0) + 1; return; }

    let judgmentPath = String(o.judgment_path || o['判断路径'] || '').trim();
    if (!judgmentPath) {
      judgmentPath = '依据维度' + DIM_CN[dim - 1] + '判断模式：原文“' + vq.text.slice(0, 16) + '”具备该类违规的语义特征（模型未给出细节，需复核）。';
    }

    let needsHuman = o.need_human_review === true || o['需人工判断'] === true;
    if (confidence === '低' && !/需人工判断/.test(reason)) {
      reason = '疑似风险，需人工判断：' + (reason || '该表述与所选维度的判断模式部分吻合，建议结合上下文确认。');
      needsHuman = true;
    }
    if (/需人工判断/.test(reason)) needsHuman = true;

    const item = {
      id: 'L' + out.length,
      source: 'llm',
      ruleLabel: '大模型语义分析',
      checkType: 'llm',
      hit: '',
      snippet: vq.text,
      conclusion: reason || '需人工判断：该表述与所选维度存在语义关联，建议结合上下文确认。',
      typeName: typeName,
      dim: dim,
      dimName: dimText || ('维度' + DIM_CN[dim - 1] + ' ' + dimName),
      judgmentPath: judgmentPath,
      law: String(o.legal_basis || o['法律法规依据'] || o.law || LAWS[dimNameLaw(dim)]).trim(),
      lawKey: dimNameLaw(dim),
      suggestion: String(o.suggestion || o['改进建议'] || '建议修改为客观、可核查的表述，并在显著位置补充风险提示与限制条件。').trim(),
      risk: risk,
      confidence: confidence,
      needsHuman: needsHuman
    };

    // 后置证据门：带时间标记的客观历史数据不得判为违规，最多降为低风险建议
    if (item.dim === 2 && typeof DATE_WORD !== 'undefined' && DATE_WORD.test(item.snippet)
      && !(typeof ABSOLUTE_WORD !== 'undefined' && ABSOLUTE_WORD.test(item.snippet))) {
      item.risk = '低';
      item.confidence = '中';
      if (!/建议|补充/.test(item.suggestion)) {
        item.suggestion = '建议补充数据来源与统计口径，并在同层级标注“过往业绩不代表未来表现”。';
      }
      item.judgmentPath = (item.judgmentPath || '') + '（带时间标记的客观历史数据，按维度二豁免规则降为提示）';
    }
    // 片段级材料不判“风险提示缺失”高风险
    if (item.dim === 8 && norm(materialText).length < 80
      && /(风险提示|风险揭示|未见风险|显著)/.test(String(item.snippet || '') + String(item.conclusion || ''))) {
      item.risk = '低';
      item.confidence = '低';
    }

    if (isDupWithKept(item, kept, covered)) return;
    kept.push(item);
    out.push(item);
  });
  return out;
}

/* 维度 → 兜底法条（精确到项） */
const DIM_LAW_KEY = ['xb23_1', 'xb23_2', 'xb23_3', 'xb23_4', 'ggf9', 'xb23_6', 'xfz10', 'xb21'];
function dimNameLaw(dim) {
  return DIM_LAW_KEY[dim - 1] || 'xb23';
}

/* ---------- 分块审查（Map）与归并（Reduce） ---------- */

/* 每块独立审查：规则层 + 大模型（每块上限 8 条） */
async function reviewBlock(block, idx, total) {
  const isImage = /图片|切块|扫描/.test(block.location);
  stageSet('rules', 'running', '块 ' + idx + '/' + total + ' · ' + block.location.slice(0, 14));
  // 规则层只产“疑似命中”，交给大模型做最终定性
  const candidates = runRules(block.text, { isImage: isImage, blockLocation: block.location });
  candidates.forEach((c, i) => { c.cid = 'C' + (i + 1); });

  stageSet('semantic', 'running', '块 ' + idx + '/' + total + ' 语境校验中');
  let ruleOps = [];
  let llmOps = [];
  let rejected = [];
  let dropNote = '';
  try {
    await ensureModels();
    const raw = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPrompt(block.text, candidates, { line: state.line, type: state.type, name: state.materialName, location: block.location }) }
      ],
      { json: true, temperature: 0.2 }
    );
    const parsed = safeParseJSON(raw);
    if (!parsed) throw new Error('模型返回内容无法解析为 JSON');
    const stats = { dropped: 0 };

    // 1) 逐条裁决规则初筛结果
    const vmap = {};
    (parsed.rule_verdicts || []).forEach((v) => {
      const id = String(v.candidate_id || v.id || '').toUpperCase().replace(/[^C0-9]/g, '');
      if (id) vmap[id] = v;
    });
    candidates.forEach((c) => {
      const v = vmap[c.cid];
      if (!v) {
        // 模型未逐条裁决：保留规则命中，降置信度并标注待确认
        ruleOps.push(Object.assign({}, c, {
          sourceLabel: '规则初筛（模型未逐条裁决）',
          confidence: '中',
          judgmentPath: (c.judgmentPath || '') + '（大模型未逐条裁决，保留规则命中待人工复核）'
        }));
        return;
      }
      const verdictStr = String(v.verdict || '').toLowerCase();
      const isReject = /reject|误报|不成立|pass|false|否/.test(verdictStr);
      if (isReject) {
        rejected.push({ cid: c.cid, dim: c.dim, hit: c.hit, snippet: c.snippet, reason: v.reason || v.judgment_path || '语境合规，判定为误报' });
        return;
      }
      const riskRaw = String(v.risk_level || '').trim();
      const risk = riskRaw.indexOf('高') >= 0 ? '高' : riskRaw.indexOf('低') >= 0 ? '低' : (riskRaw.indexOf('中') >= 0 ? '中' : c.risk);
      const sug = String(v.suggestion || '').trim();
      ruleOps.push(Object.assign({}, c, {
        risk: risk,
        sourceLabel: '规则初筛+大模型确认',
        conclusion: String(v.reason || '').trim() || c.conclusion,
        typeName: String(v.violation_type || '').trim() || c.typeName,
        law: String(v.legal_basis || '').trim() || c.law,
        suggestion: /^(无|none|n\/a)$/i.test(sug) ? '无（原文表述合规，建议保持）' : (sug || c.suggestion),
        judgmentPath: (c.judgmentPath || '') + '；大模型语境校验：' + (String(v.judgment_path || '').trim() || String(v.reason || '').trim() || '确认违规'),
        confidence: '高',
        needsHuman: v.need_human_review === true
      }));
    });

    // 2) 大模型自发现的语义问题
    const findings = (parsed.findings || parsed.opinions || []).slice(0, BLOCK_MAX);
    llmOps = normalizeLLM(findings, ruleOps, block.text, stats).slice(0, BLOCK_MAX);
    llmOps.forEach((o) => { o.sourceLabel = '纯大模型语义发现'; });

    state.overallConclusion = String(parsed.overall_conclusion || state.overallConclusion || '').trim();
    state.modelRiskLevel = String(parsed.risk_level || '').trim();

    const notes = [];
    if (stats.dropped) notes.push('无法在原文检索到引用的 ' + stats.dropped + ' 条（防编造）');
    if (stats.evidence) notes.push('与本维度判断模式不匹配的 ' + stats.evidence + ' 条');
    if (notes.length) dropNote = '〔' + block.location + '〕已剔除' + notes.join('、');
  } catch (e) {
    dropNote = '〔' + block.location + '〕语义审查未完成：' + (e.message || e);
    // 模型不可用时退回规则命中，但标注为未确认，避免静默丢失
    ruleOps = candidates.map((c) => Object.assign({}, c, {
      sourceLabel: '规则初筛（未经大模型确认）',
      confidence: '中'
    }));
  }

  return {
    ruleOps: ruleOps.map((o) => Object.assign(o, { location: block.location })),
    llmOps: llmOps.map((o) => Object.assign(o, { location: block.location })),
    rejected: rejected.map((r) => Object.assign(r, { location: block.location })),
    dropNote: dropNote
  };
}

/* Reduce：跨块去重 → 风险排序 → 30 条上限并合并同类 */
function reduceOpinions(items) {
  const sorted = items.slice().sort((a, b) => {
    const d = (RISK_ORDER[b.risk] || 0) - (RISK_ORDER[a.risk] || 0);
    if (d) return d;
    return a.source === b.source ? 0 : a.source === 'rule' ? -1 : 1;
  });
  const covered = [];
  sorted.forEach((o) => {
    String(o.hit || '').split(/[、,，\s]+/).forEach((w) => { if (w && w.length >= 2) covered.push(w); });
  });
  covered.sort((a, b) => b.length - a.length);

  const kept = [];
  let dupRemoved = 0;
  sorted.forEach((o) => {
    if (isDupWithKept(o, kept, covered)) { dupRemoved++; return; }
    // 同一原文片段、不同违规类型的规则命中：合并为一张卡，避免同一句话出现多条
    if (o.source === 'rule') {
      const same = kept.find((k) => k.source === 'rule' && norm(k.snippet) === norm(o.snippet) && k.dim !== o.dim);
      if (same) {
        same.typeName = same.typeName.indexOf(o.typeName) >= 0 ? same.typeName : same.typeName + '；' + o.typeName;
        if ((RISK_ORDER[o.risk] || 0) > (RISK_ORDER[same.risk] || 0)) same.risk = o.risk;
        if (o.hit && same.hit.indexOf(o.hit) < 0) same.hit = same.hit ? same.hit + '、' + o.hit : o.hit;
        return;
      }
    }
    kept.push(o);
  });

  let final = kept;
  let mergedTotal = 0;
  const mergedGroups = [];
  if (kept.length > GLOBAL_MAX) {
    final = kept.slice(0, GLOBAL_MAX);
    const tail = kept.slice(GLOBAL_MAX);
    mergedTotal = tail.length;
    tail.forEach((o) => {
      const host = final.find((k) => k.dim === o.dim)
        || final.find((k) => k.dim === o.dim && k.typeName === o.typeName);
      if (host) {
        host.mergedCount = (host.mergedCount || 0) + 1;
        return;
      }
      const g = mergedGroups.find((x) => x.dim === o.dim);
      if (g) { g.count++; g.samples.push(o.snippet.slice(0, 18)); }
      else mergedGroups.push({ dim: o.dim, count: 1, samples: [o.snippet.slice(0, 18)] });
    });
  }
  const riskStats = { 高: 0, 中: 0, 低: 0 };
  kept.forEach((o) => { riskStats[o.risk] = (riskStats[o.risk] || 0) + 1; });
  return { final, dupRemoved, mergedTotal, mergedGroups, found: kept.length, riskStats };
}

async function runReview() {
  const rawText = $('#parseText').value.trim();
  if (!rawText) { toast('没有可审查的文本'); return; }
  const blocks = splitBlocks(rawText);

  setStep(2);
  showPanels(['#panelRun']);
  traceNode('业务部门发起审查申请，材料进入智能审查引擎（' + blocks.length + ' 个内容块）', 'start');
  toast('材料已进入智能审查引擎，正在执行规则扫描与语义分析…', 2600);
  $('#runError').hidden = true;
  $('#btnReview').disabled = true;
  ['parse', 'rules', 'semantic', 'merge'].forEach((k) => stageSet(k, '', '待执行'));
  $('#panelRun').scrollIntoView({ behavior: 'smooth', block: 'start' });

  state.startedAt = new Date();
  state.line = $('#lineSel').value;
  state.type = $('#typeSel').value;
  state.opinions = [];
  state.mergedGroups = [];
  state.mergedTotal = 0;
  state.dupRemoved = 0;
  state.expanded = false;

  const t0 = Date.now();
  try {
    stageSet('parse', 'done', '已切分 ' + blocks.length + ' 个内容块');
    await sleep(120);

    const all = [];
    const warns = [];
    let ruleCount = 0;
    let llmCount = 0;
    const rejectedAll = [];
    for (let i = 0; i < blocks.length; i++) {
      const r = await reviewBlock(blocks[i], i + 1, blocks.length);
      all.push.apply(all, r.ruleOps);
      all.push.apply(all, r.llmOps);
      ruleCount += r.ruleOps.length;
      llmCount += r.llmOps.length;
      if (r.rejected) rejectedAll.push.apply(rejectedAll, r.rejected);
      if (r.dropNote) warns.push(r.dropNote);
    }
    state.rejected = rejectedAll;
    traceNode('规则层初筛完成（疑似命中 ' + (ruleCount + rejectedAll.length) + ' 条，待大模型语境校验）', 'node');
    if (rejectedAll.length) {
      const dims = {};
      rejectedAll.forEach((r) => { const k = '维度' + DIM_CN[(r.dim || 7) - 1]; dims[k] = (dims[k] || 0) + 1; });
      traceNode('已拦截规则误报 ' + rejectedAll.length + ' 条（' + Object.keys(dims).map((k) => k + '×' + dims[k]).join('、') + '）：大模型语境校验判定不构成违规，未进入审查意见', 'filter');
    }
    traceNode('大模型语境校验完成（确认违规 ' + ruleCount + ' 条，语义新发现 ' + llmCount + ' 条）', 'node');

    // pptx 复杂图形：无法抽取文字 → 生成人工复核提示
    if (state.complexPages && state.complexPages.length) {
      state.complexPages.forEach((pg) => {
        all.push({
          source: 'rule',
          ruleLabel: '格式提示',
          checkType: 'format',
          hit: '',
          location: '第' + pg + '页-复杂图形',
          snippet: '（第' + pg + '页含图表/SmartArt，文字无法自动抽取）',
          dim: 8,
          risk: '低',
          confidence: '高',
          conclusion: '该页存在图表或 SmartArt 等复杂图形，内部文字无法自动提取，可能存在未覆盖的宣传表述，需人工复核该页图形内容。',
          judgmentPath: '依据解析能力边界：pptx 图表/SmartArt 的文字不在 <a:t> 文本节点内，无法抽取，转为人工复核提示。',
          suggestion: '请人工打开该页核对图表、SmartArt 中的文字，或将图形截图后按图片单独上传审查。',
          law: LAWS.yf316,
          lawKey: 'yf316',
          needsHuman: true,
          typeName: '（八）限制消费者权利/加重义务事项缺乏显著特别标识，风险揭示不充分'
        });
      });
    }

    // 风险揭示是否缺失属材料级判断：任一块含合规提示，就不应在其它块上判“全文缺失”
    const RISK_TIP = /(投资须谨慎|投资有风险|产品有风险|风险提示|不代表|以实际为准|非保证|揭示书|理财非存款)/;
    const materialHasRiskTip = blocks.some((b) => RISK_TIP.test(b.text));
    const filtered = materialHasRiskTip
      ? all.filter((o) => !(o.checkType === 'prominence' && /未见风险揭示/.test(o.snippet || '')))
      : all;

    stageSet('merge', 'running', '跨块去重与排序');
    await sleep(160);
    const red = reduceOpinions(filtered);
    red.final.forEach((o, i) => {
      o.id = 'O' + (i + 1);
      o.status = 'pending';
      o.original = { conclusion: o.conclusion, law: o.law, suggestion: o.suggestion };
      o.edited = null;
      o.rejectReason = '';
    });
    state.opinions = red.final;
    state.mergedGroups = red.mergedGroups;
    state.mergedTotal = red.mergedTotal;
    state.dupRemoved = red.dupRemoved;
    state.foundTotal = red.found;
    state.riskStats = red.riskStats;
    state.elapsed = Math.round((Date.now() - t0) / 1000);
    stageSet('merge', 'done', '归并 ' + red.final.length + ' 条 / 原始 ' + all.length + ' 条');
    traceNode('审查意见生成并归并（共 ' + red.final.length + ' 条，原始 ' + all.length + ' 条，待人工复核）', 'node');

    if (warns.length) {
      const w = $('#runError');
      w.hidden = false;
      w.className = 'warn';
      w.textContent = warns.join('；');
    }

    renderSummary();
    renderOpinions();
    setStep(3);
    showPanels(['#panelSummary', '#panelOpinions']);
    $('#panelSummary').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    const w = $('#runError');
    w.hidden = false;
    w.className = 'warn error';
    w.textContent = '审查未完成：' + (e.message || e);
  } finally {
    $('#btnReview').disabled = false;
  }
}

/* ---------- 汇总 ---------- */
function counts() {
  const c = { 高: 0, 中: 0, 低: 0, rule: 0, llm: 0, accepted: 0, modified: 0, rejected: 0, pending: 0, merged: 0 };
  state.opinions.forEach((o) => {
    c[o.risk] = (c[o.risk] || 0) + 1;
    if (o.mergedCount) c.merged += o.mergedCount;
    c[o.source] = (c[o.source] || 0) + 1;
    if (o.status === 'accepted') c.accepted++;
    else if (o.status === 'modified') c.modified++;
    else if (o.status === 'rejected') c.rejected++;
    else c.pending++;
  });
  return c;
}

function verdictOf(ops) {
  const alive = ops.filter((o) => o.status !== 'rejected');
  const high = alive.filter((o) => o.risk === '高').length;
  const mid = alive.filter((o) => o.risk === '中').length;
  if (high > 0) return { text: '建议退回补充材料', cls: 'v-back', note: '存在 ' + high + ' 条高风险问题，材料修订后需重新送审' };
  if (mid > 0) return { text: '需修改', cls: 'v-fix', note: '存在 ' + mid + ' 条中风险问题，按意见修订后可申请复审' };
  return { text: '通过', cls: 'v-pass', note: '未发现高风险与中风险问题，可进入发布流程' };
}

function fmtTime(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function renderSummary() {
  const c = counts();
  const v = verdictOf(state.opinions);
  const ver = $('#sumVerdict');
  ver.textContent = v.text;
  ver.className = 'sum-verdict ' + v.cls;
  $('#sumSub').innerHTML = esc(v.note) + (state.overallConclusion ? '<span class="sum-model">模型整体结论：' + esc(state.overallConclusion) + '</span>' : '');
  $('#sumName').textContent = state.materialName || '未命名材料';
  $('#sumLine').textContent = state.line + ' / ' + state.type;
  $('#sumTime').textContent = fmtTime(state.startedAt || new Date());
  $('#sumCount').textContent = state.opinions.length + ' 条';
  $('#cHigh').textContent = c['高'];
  $('#cMid').textContent = c['中'];
  $('#cLow').textContent = c['低'];
  $('#sumSource').textContent = '规则初筛+大模型确认 ' + c.rule + ' · 纯大模型语义发现 ' + c.llm
    + (c.llm && state.modelLabel ? '（' + state.modelLabel + '）' : '')
    + (state.rejected && state.rejected.length ? ' · 已拦截规则误报 ' + state.rejected.length + ' 条' : '');
  const found = state.foundTotal || state.opinions.length;
  const rs = state.riskStats || c;
  const cap = $('#sumCap');
  if (found > UI_MAX || state.mergedTotal > 0) {
    cap.hidden = false;
    const parts = ['本次审查共发现 <b>' + found + '</b> 条（高危 ' + (rs['高'] || 0) + ' / 中危 ' + (rs['中'] || 0) + ' / 低危 ' + (rs['低'] || 0) + '）'];
    parts.push('当前展示前 ' + Math.min(UI_MAX, state.opinions.length) + ' 条');
    if (state.mergedTotal > 0) parts.push('另有 ' + state.mergedTotal + ' 条同类问题已合并进对应意见');
    parts.push('完整报告请导出');
    cap.innerHTML = parts.join('，') + '。';
  } else {
    cap.hidden = true;
  }
}

/* ---------- 意见卡片 ---------- */
function highlight(snippet, hit) {
  const s = esc(snippet);
  if (!hit) return s;
  const h = esc(hit);
  return s.split(h).join('<mark>' + h + '</mark>');
}

function renderOpinions() {
  const box = $('#opList');
  box.innerHTML = '';
  if (!state.opinions.length) {
    box.innerHTML = '<div class="op-empty">未发现违规表述：规则库与语义审查均未命中，材料可按流程发布。</div>';
  }
  const shown = state.expanded ? state.opinions : state.opinions.slice(0, UI_MAX);
  shown.forEach((o, i) => {
    const el = document.createElement('div');
    el.className = 'op' + (o.status !== 'pending' ? ' done' : '');
    el.dataset.id = o.id;
    const cur = o.edited || o.original;
    const srcCls = o.source === 'llm' ? 'llm' : '';
    const srcText = o.sourceLabel || (o.source === 'llm' ? '纯大模型语义发现' : '规则初筛+大模型确认');
    el.innerHTML = [
      '<div class="op-h">',
      '<span class="op-idx">#' + (i + 1) + '</span>',
      '<span class="op-src ' + srcCls + '">' + srcText + '</span>',
      '<span class="op-dim">维度' + DIM_CN[(o.dim || 7) - 1] + '</span>',
      '<span class="op-type">' + esc(o.typeName) + '</span>',
      '<span class="op-conf conf-' + (o.confidence || '中') + '">置信度' + (o.confidence || '中') + '</span>',
      '<span class="op-risk ' + RISK_CLASS[o.risk] + '">' + o.risk + '风险</span>',
      '</div>',
      '<div class="op-b">',
      '<div class="op-row"><label>来源定位</label><div class="loc">' + esc(o.location || '正文') + '</div></div>',
      '<div class="op-row"><label>原文片段</label><div><div class="quote">' + highlight(o.snippet, o.hit) + '</div></div></div>',
      '<div class="op-row"><label>判断路径</label><div class="path">' + esc(o.judgmentPath || '—') + '</div></div>',
      '<div class="op-row"><label>审查结论</label><div>' + esc(cur.conclusion) + (o.needsHuman ? ' <span class="op-note">需人工判断</span>' : '') + '</div></div>',
      '<div class="op-row"><label>法规依据</label><div class="law">' + esc(cur.law) + '</div></div>',
      '<div class="op-row"><label>改进建议</label><div>' + esc(cur.suggestion) + '</div></div>',
      o.status === 'rejected' && o.rejectReason ? '<div class="op-row"><label>驳回理由</label><div style="color:#b91c1c">' + esc(o.rejectReason) + '</div></div>' : '',
      o.status === 'modified' ? '<div class="op-row"><label>修改记录</label><div style="color:#1d4ed8">审查人员已修改结论/依据/建议后采纳</div></div>' : '',
      o.mergedCount ? '<div class="op-row"><label>合并说明</label><div class="loc">同维度另有 ' + o.mergedCount + ' 条同类问题已合并进本条，原文不再逐条展示</div></div>' : '',
      '</div>',
      '<div class="op-foot">',
      o.status === 'pending'
        ? '<button class="btn sm" data-act="accept">采纳</button><button class="btn sm" data-act="modify">修改</button><button class="btn sm" data-act="reject">驳回</button>'
        : '<button class="btn sm ghost" data-act="undo">撤回操作</button>',
      '<span class="op-state s-' + o.status + '">' + (STATUS_TEXT[o.status] || '待复核') + (o.recalled ? '（已撤回）' : '') + '</span>',
      '</div>'
    ].join('');
    el.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => onAction(o.id, b.dataset.act));
    });
    box.appendChild(el);
  });

  const c = counts();
  const hidden = state.expanded ? 0 : Math.max(0, state.opinions.length - UI_MAX);
  const blocking = state.opinions.filter((o) => o.status === 'pending' && !o.recalled).length;
  const recalledPending = state.opinions.filter((o) => o.status === 'pending' && o.recalled).length;
  let hint = c.pending > 0
    ? ('尚有 ' + c.pending + ' 条待处理' + (recalledPending ? '（其中 ' + recalledPending + ' 条为已撤回，可直接完结）' : ''))
    : '全部意见已处理，可生成报告';
  if (hidden > 0) hint += '（其中 ' + hidden + ' 条未展开）';
  $('#opFooterHint').textContent = hint;
  $('#btnFinish').disabled = blocking > 0;

  const exp = $('#btnExpand');
  if (hidden > 0) {
    exp.hidden = false;
    exp.textContent = '展开其余 ' + hidden + ' 条';
  } else if (state.expanded) {
    exp.hidden = false;
    exp.textContent = '收起（仅看前 ' + UI_MAX + ' 条）';
  } else {
    exp.hidden = true;
  }
}

let currentOpId = null;
function onAction(id, act) {
  const o = state.opinions.find((x) => x.id === id);
  if (!o) return;
  if (act === 'undo') {
    const e = applyStatus(id, 'pending', null, { recalled: true });
    if (e) logAction('审查人员撤回意见#' + opIndex(id) + '的处理（从“' + e.fromLabel + '”恢复为“待复核”）', 'recall');
    toast('该条意见已撤回，恢复为待复核');
    return;
  }
  if (act === 'accept') {
    const e = applyStatus(id, 'accepted');
    if (e) logAction('审查人员采纳意见#' + opIndex(id) + '（原状态“' + e.fromLabel + '”）', 'accept');
    afterAction();
    toast('意见已采纳，进入最终报告');
  } else if (act === 'modify') {
    currentOpId = id;
    const cur = o.edited || o.original;
    $('#editConclusion').value = cur.conclusion;
    $('#editLaw').value = cur.law;
    $('#editSuggestion').value = cur.suggestion;
    $('#modalEdit').hidden = false;
  } else if (act === 'reject') {
    currentOpId = id;
    $('#rejectReason').value = '';
    $('#modalReject').hidden = false;
  }
}

function afterAction() {
  refreshReviewUI();
  const c = counts();
  if (c.pending === 0) toast('全部意见已处理，可生成审查报告');
}

/* ---------- 报告 ---------- */
function buildReportText() {
  const c = counts();
  const v = verdictOf(state.opinions);
  const L = [];
  L.push('金融营销宣传智能审查报告');
  L.push('='.repeat(46));
  L.push('材料名称：' + (state.materialName || '未命名材料'));
  L.push('业务条线：' + state.line + '　　材料类型：' + state.type);
  L.push('审查时间：' + fmtTime(state.startedAt || new Date()));
  L.push('审查引擎：规则库 + 大模型语义分析（模型：' + state.modelLabel + '）');
  L.push('');
  L.push('一、审查汇总');
  L.push('意见总数：' + state.opinions.length + ' 条（规则库命中 ' + c.rule + ' 条，大模型语义分析 ' + c.llm + ' 条）');
  L.push('风险分布：高 ' + c['高'] + ' / 中 ' + c['中'] + ' / 低 ' + c['低']);
  L.push('处理结果：采纳 ' + c.accepted + ' 条，修改后采纳 ' + c.modified + ' 条，驳回 ' + c.rejected + ' 条');
  L.push('审查结论：' + v.text);
  const found = state.foundTotal || state.opinions.length;
  if (found > UI_MAX || state.mergedTotal > 0) {
    L.push('数量说明：共发现 ' + found + ' 条，本报告完整包含 ' + state.opinions.length + ' 条，'
      + (state.mergedTotal ? '另有 ' + state.mergedTotal + ' 条同类问题已合并（见文末合并说明）' : '单屏仅展示前 ' + UI_MAX + ' 条'));
  }
  L.push('内容块：' + (splitBlocks(state.text || '').length) + ' 个（' + (state.parseSource || '') + '）');
  if (state.rejected && state.rejected.length) {
    L.push('规则误报拦截：' + state.rejected.length + ' 条（规则初筛命中但经大模型语境校验判定不构成违规，未列入上述意见）');
    state.rejected.forEach((r) => L.push('  - 维度' + DIM_CN[(r.dim || 7) - 1] + '｜' + (r.snippet || '').slice(0, 30) + '｜' + (r.reason || '').slice(0, 60)));
  }
  L.push('');
  L.push('二、审查意见明细');
  const decided = state.opinions.filter((o) => o.status !== 'pending');
  const undecided = state.opinions.filter((o) => o.status === 'pending');
  decided.forEach((o, i) => {
    const cur = o.edited || o.original;
    L.push('');
    L.push('【意见 ' + (i + 1) + '】' + o.typeName + '｜' + o.risk + '风险｜' + (o.sourceLabel || (o.source === 'llm' ? '纯大模型语义发现' : '规则初筛+大模型确认')) + '｜置信度' + (o.confidence || '中'));
    L.push('  维度：维度' + DIM_CN[(o.dim || 7) - 1] + ' ' + (DIMENSIONS[(o.dim || 7) - 1] || {}).name + '｜置信度' + (o.confidence || '中'));
    L.push('  来源定位：' + (o.location || '正文'));
    L.push('  原文片段：' + o.snippet);
    L.push('  判断路径：' + (o.judgmentPath || '—'));
    L.push('  审查结论：' + cur.conclusion);
    L.push('  法规依据：' + cur.law);
    L.push('  改进建议：' + cur.suggestion);
    L.push('  处理状态：' + (STATUS_TEXT[o.status] || '待处理') + (o.status === 'rejected' && o.rejectReason ? '（驳回理由：' + o.rejectReason + '）' : '') + (o.status === 'modified' ? '（审查人员已修改结论/依据/建议）' : ''));
    if (o.mergedCount) L.push('  合并说明：同维度另有 ' + o.mergedCount + ' 条同类问题已合并进本条');
  });
  if (state.mergedGroups && state.mergedGroups.length) {
    L.push('');
    L.push('【同类问题合并说明】');
    state.mergedGroups.forEach((g) => {
      L.push('  维度' + DIM_CN[g.dim - 1] + '：另有 ' + g.count + ' 条同类问题因全局 30 条上限合并（示例：' + g.samples.join('；') + '）');
    });
  }
  if (undecided.length) {
    L.push('');
    L.push('【未纳入审查结论的意见（已撤回/未复核）】');
    undecided.forEach((o) => {
      L.push('  意见#' + opIndex(o.id) + '｜维度' + DIM_CN[(o.dim || 7) - 1] + '｜' + (o.snippet || '').slice(0, 30)
        + '｜' + (o.recalled ? '已撤回' : '未复核'));
    });
  }
  L.push('');
  L.push('三、后续动作');
  L.push(v.text === '通过' ? '材料可进入发布流程，审查记录归档留存，供监管报送与事后追溯。' : '审查意见已推送业务部门，材料修订后需重新送审，进入下一轮智能审查。');
  L.push('审查记录归档：已留存本次审查材料、意见与人工处理痕迹。');
  L.push('');
  if (state.log.length) {
    L.push('');
    L.push('四、业务链路追踪（含回退、撤回与撤销记录）');
    state.log.forEach((x, i) => L.push('  ' + (i + 1) + '. [' + fmtTime(x.t) + '] ' + x.text + (x.rolledBack ? '（已回退）' : '')));
  }
  L.push('');
  L.push('—— 本报告由消保智能审查工作台生成，审查意见供人工复核参考，最终结论以审查人员判定为准。');
  L.push(REVIEW_BASIS);
  return L.join('\n');
}

function buildReportHTML() {
  const c = counts();
  const v = verdictOf(state.opinions);
  const rows = state.opinions.map((o, i) => {
    const cur = o.edited || o.original;
    return '<div class="r-op"><b>意见 ' + (i + 1) + '：' + esc(o.typeName) + '</b>'
      + '<div class="r-row"><label>来源 / 风险</label><span>' + (o.source === 'llm' ? '大模型语义分析' : '规则库命中') + ' ｜ ' + o.risk + '风险</span></div>'
      + '<div class="r-row"><label>维度 / 置信度</label><span>维度' + DIM_CN[(o.dim || 7) - 1] + '　·　置信度' + esc(o.confidence || '中') + '</span></div>'
      + '<div class="r-row"><label>来源定位</label><span>' + esc(o.location || '正文') + '</span></div>'
      + '<div class="r-row"><label>原文片段</label><span>' + esc(o.snippet) + '</span></div>'
      + '<div class="r-row"><label>判断路径</label><span>' + esc(o.judgmentPath || '—') + '</span></div>'
      + '<div class="r-row"><label>审查结论</label><span>' + esc(cur.conclusion) + '</span></div>'
      + '<div class="r-row"><label>法规依据</label><span>' + esc(cur.law) + '</span></div>'
      + '<div class="r-row"><label>改进建议</label><span>' + esc(cur.suggestion) + '</span></div>'
      + '<div class="r-row"><label>处理状态</label><span>' + (STATUS_TEXT[o.status] || '待处理') + (o.status === 'rejected' && o.rejectReason ? '（' + esc(o.rejectReason) + '）' : '') + '</span></div>'
      + '</div>';
  }).join('');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>审查报告 · ' + esc(state.materialName) + '</title>'
    + '<style>body{font:14px/1.85 "PingFang SC","Microsoft YaHei",sans-serif;color:#1e293b;max-width:860px;margin:40px auto;padding:0 20px}'
    + 'h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 10px;border-left:3px solid #1d4ed8;padding-left:9px}'
    + '.meta{color:#64748b;font-size:12.5px;margin-bottom:18px}'
    + '.r-row{display:flex;gap:10px;font-size:13px;padding:2px 0}.r-row label{width:84px;flex:none;color:#94a3b8}'
    + '.r-op{border-top:1px dashed #e2e8f0;padding:10px 0}.r-op:first-child{border-top:0}'
    + '.kpi{display:flex;gap:18px;flex-wrap:wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;font-size:13px}'
    + '</style></head><body>'
    + '<h1>金融营销宣传智能审查报告</h1>'
    + '<div class="meta">' + esc(state.materialName) + ' ｜ ' + state.line + ' / ' + state.type + ' ｜ ' + fmtTime(state.startedAt || new Date()) + '</div>'
    + '<div class="kpi"><span>意见总数 <b>' + state.opinions.length + '</b></span><span>风险分布 高 ' + c['高'] + ' / 中 ' + c['中'] + ' / 低 ' + c['低'] + '</span>'
    + '<span>采纳 ' + c.accepted + ' ｜ 修改 ' + c.modified + ' ｜ 驳回 ' + c.rejected + '</span><span>审查结论 <b>' + v.text + '</b></span></div>'
    + '<h2>审查意见明细</h2>' + rows
    + '<h2>后续动作</h2><p>' + (v.text === '通过' ? '材料可进入发布流程，审查记录归档留存。' : '审查意见已推送业务部门，修订后需重新送审。') + '</p>'
    + '<p style="color:#94a3b8;font-size:12px">本报告由消保智能审查工作台生成，审查意见供人工复核参考，最终结论以审查人员判定为准。</p>'
    + '<p style="color:#475569;font-size:12px;margin-top:10px">' + esc(REVIEW_BASIS) + '</p>'
    + '</body></html>';
}

function renderReport() {
  const c = counts();
  const v = verdictOf(state.opinions);
  const decidedHtml = state.opinions.filter((o) => o.status !== 'pending');
  const undecidedHtml = state.opinions.filter((o) => o.status === 'pending');
  const ops = decidedHtml.map((o, i) => {
    const cur = o.edited || o.original;
    return '<div class="r-op"><b>意见 ' + (i + 1) + '：' + esc(o.typeName) + '　'
      + '<span class="pill ' + RISK_CLASS[o.risk] + '" style="font-size:11px">' + o.risk + '</span>　'
      + '<span style="font-size:12px;color:' + (o.source === 'llm' ? '#6d28d9' : '#1d4ed8') + '">' + esc(o.sourceLabel || (o.source === 'llm' ? '纯大模型语义发现' : '规则初筛+大模型确认')) + '</span></b>'
      + '<div class="r-row"><label>维度 / 置信度</label><span>维度' + DIM_CN[(o.dim || 7) - 1] + '　·　置信度' + esc(o.confidence || '中') + '</span></div>'
      + '<div class="r-row"><label>来源定位</label><span>' + esc(o.location || '正文') + '</span></div>'
      + '<div class="r-row"><label>原文片段</label><span>' + esc(o.snippet) + '</span></div>'
      + '<div class="r-row"><label>判断路径</label><span>' + esc(o.judgmentPath || '—') + '</span></div>'
      + '<div class="r-row"><label>审查结论</label><span>' + esc(cur.conclusion) + '</span></div>'
      + '<div class="r-row"><label>法规依据</label><span class="law">' + esc(cur.law) + '</span></div>'
      + '<div class="r-row"><label>改进建议</label><span>' + esc(cur.suggestion) + '</span></div>'
      + '<div class="r-row"><label>处理状态</label><span style="font-weight:600">' + (STATUS_TEXT[o.status] || '待处理')
      + (o.status === 'rejected' && o.rejectReason ? '（' + esc(o.rejectReason) + '）' : '') + '</span></div>'
      + (o.mergedCount ? '<div class="r-row"><label>合并说明</label><span>同维度另有 ' + o.mergedCount + ' 条同类问题已合并进本条</span></div>' : '')
      + '</div>';
  }).join('');

  $('#reportBody').innerHTML = [
    '<div class="r-block">',
    '<h3>一、材料信息</h3>',
    '<div class="r-row"><label>材料名称</label><span>' + esc(state.materialName) + '</span></div>',
    '<div class="r-row"><label>业务条线</label><span>' + state.line + ' / ' + state.type + '</span></div>',
    '<div class="r-row"><label>审查时间</label><span>' + fmtTime(state.startedAt || new Date()) + '</span></div>',
    '<div class="r-row"><label>审查引擎</label><span>规则库 + 大模型语义分析（' + esc(state.modelLabel) + '）</span></div>',
    '</div>',
    '<div class="r-block">',
    '<h3>二、审查汇总</h3>',
    '<div class="r-row"><label>意见总数</label><span>' + state.opinions.length + ' 条（规则库 ' + c.rule + ' 条 / 大模型 ' + c.llm + ' 条）</span></div>',
    '<div class="r-row"><label>风险分布</label><span>高 ' + c['高'] + ' ／ 中 ' + c['中'] + ' ／ 低 ' + c['低'] + '</span></div>',
    '<div class="r-row"><label>处理结果</label><span>采纳 ' + c.accepted + ' 条，修改后采纳 ' + c.modified + ' 条，驳回 ' + c.rejected + ' 条</span></div>',
    '<div class="r-row"><label>审查结论</label><span style="font-weight:700">' + v.text + '</span></div>',
    state.overallConclusion ? '<div class="r-row"><label>模型整体结论</label><span>' + esc(state.overallConclusion) + '</span></div>' : '',
    '<div class="r-row"><label>内容块 / 来源</label><span>' + splitBlocks(state.text || '').length + ' 个内容块　·　' + esc(state.parseSource || '—') + '</span></div>',
    (state.rejected && state.rejected.length)
      ? '<div class="r-row"><label>规则误报拦截</label><span>已拦截 ' + state.rejected.length + ' 条规则初筛误报（经大模型语境校验否决）：'
        + esc(state.rejected.map((r) => '维度' + DIM_CN[(r.dim || 7) - 1] + '「' + (r.snippet || '').slice(0, 16) + '」').join('；')) + '</span></div>'
      : '',
    '</div>',
    '<div class="r-block"><h3>三、审查意见明细</h3>' + (ops || '<div class="op-empty">未发现违规表述，无需逐条复核。</div>') + '</div>',
    undecidedHtml.length
      ? '<div class="r-block"><h3>未纳入审查结论的意见</h3>'
        + undecidedHtml.map((o) => '<div class="r-row"><label>意见#' + opIndex(o.id) + '</label><span>' + esc((o.snippet || '').slice(0, 30)) + '　（' + (o.recalled ? '已撤回' : '未复核') + '）</span></div>').join('')
        + '</div>'
      : '',
    state.log.length
      ? '<div class="r-block"><h3>四、业务链路追踪（含回退、撤回与撤销记录）</h3>'
        + state.log.map((x, i) => '<div class="r-row"><label>' + (i + 1) + '</label><span>[' + fmtTime(x.t) + '] ' + esc(x.text) + (x.rolledBack ? '（已回退）' : '') + '</span></div>').join('')
        + '</div>'
      : '',
    (state.mergedGroups && state.mergedGroups.length)
      ? '<div class="r-block"><h3>五、同类问题合并说明</h3>'
        + state.mergedGroups.map((g) => '<div class="r-row"><label>维度' + DIM_CN[g.dim - 1] + '</label><span>另有 ' + g.count + ' 条同类问题因全局 30 条上限合并（示例：' + esc(g.samples.join('；')) + '）</span></div>').join('')
        + '</div>'
      : ''
  ].join('');

  renderTrace();
  $('#rfAccept').textContent = c.accepted;
  $('#rfModify').textContent = c.modified;
  $('#rfReject').textContent = c.rejected;
  $('#rfRule').textContent = c.rule;
  $('#rfLlm').textContent = c.llm;
}

/* ---------- 导出 ---------- */
function download(name, content, mime) {
  const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ============================================================
 * 回退 / 撤回 / 撤销 / 再次发起：状态管理
 * 所有状态变更都走 applyStatus 与 refreshReviewUI，保证
 * 意见卡、顶部统计、stepper、操作日志、报告内容始终一致
 * ============================================================ */
const REVIEW_BASIS = '审查依据：《中华人民共和国消费者权益保护法》《中华人民共和国广告法》《银行保险机构消费者权益保护管理办法》《关于进一步规范金融营销宣传行为的通知》（银发〔2019〕316号）';
const STATUS_LABEL = { pending: '待复核', accepted: '已采纳', modified: '已修改采纳', rejected: '已驳回' };
const HIST_KEY = 'consumer-review-history';

function confirmDialog(opts) {
  return new Promise((resolve) => {
    const m = $('#modalConfirm');
    $('#cfTitle').textContent = opts.title || '确认';
    $('#cfBody').textContent = opts.body || '';
    const foot = $('#cfFoot');
    foot.innerHTML = '';
    (opts.buttons || [{ label: '取消', value: null }, { label: '确定', value: true, cls: 'primary' }]).forEach((b) => {
      const el = document.createElement('button');
      el.className = 'btn ' + (b.cls || '');
      el.textContent = b.label;
      el.addEventListener('click', () => { m.hidden = true; resolve(b.value); });
      foot.appendChild(el);
    });
    $('#modalConfirm').querySelectorAll('[data-cf-close]').forEach((x) => {
      x.onclick = () => { m.hidden = true; resolve(null); };
    });
    m.hidden = false;
  });
}

/* 业务链路节点：所有系统动作与人工动作都写进同一条链路，供面板与报告导出 */
function logAction(text, kind) {
  state.log.push({ t: new Date(), text: text, kind: kind || '' });
  renderLog();
  renderTrace();
}
function traceNode(text, kind) { logAction(text, kind || 'node'); }

function renderLog() {
  const cnt = $('#logCount');
  if (cnt) cnt.textContent = state.log.length;
  const box = $('#logBox');
  if (!box) return;
  box.innerHTML = state.log.length
    ? state.log.map((x, i) => '<div class="log-item ' + (x.kind || '') + '"><b>' + (i + 1) + '.</b> ' + esc(x.text)
      + (x.rolledBack ? '<span class="trace-tag">已回退</span>' : '') + '<em>' + fmtTime(x.t) + '</em></div>').join('')
    : '<div class="log-empty">暂无操作记录</div>';
}

/* 业务链路追踪面板（报告页底部，可折叠） */
function renderTrace() {
  const box = $('#traceBody');
  if (!box) return;
  box.innerHTML = state.log.length
    ? state.log.map((x) => '<div class="trace-item ' + (x.kind || 'node') + '">'
      + '<span class="trace-dot"></span>'
      + '<span class="trace-t">' + fmtTime(x.t) + '</span>'
      + '<span class="trace-txt">' + esc(x.text) + (x.rolledBack ? '<span class="trace-tag">已回退</span>' : '') + '</span>'
      + '</div>').join('')
    : '<div class="log-empty">暂无链路记录</div>';
}

function opIndex(id) {
  const i = state.opinions.findIndex((o) => o.id === id);
  return i < 0 ? '?' : i + 1;
}

function snapOp(o) {
  return { status: o.status, edited: o.edited, rejectReason: o.rejectReason, recalled: !!o.recalled };
}

function restoreOp(o, s) {
  o.status = s.status;
  o.edited = s.edited;
  o.rejectReason = s.rejectReason;
  o.recalled = !!s.recalled;
}

/* 统一的状态刷新入口：卡片 + 统计 + stepper + 撤销按钮 + 日志 */
function refreshReviewUI() {
  if (state.opinions.length || state.step === 3) {
    renderOpinions();
    renderSummary();
  }
  renderStepper();
  const canUndo = state.undoStack.length > 0;
  const canRedo = state.redoStack.length > 0;
  if ($('#btnUndo')) $('#btnUndo').disabled = !canUndo;
  if ($('#btnRedo')) $('#btnRedo').disabled = !canRedo;
  renderLog();
}

/* 核心：变更单条意见状态，并记录撤销栈 */
function applyStatus(id, status, payload, opts) {
  opts = opts || {};
  const o = state.opinions.find((x) => x.id === id);
  if (!o) return null;
  const before = snapOp(o);
  const beforeLabel = STATUS_LABEL[o.status] || '待复核';

  o.status = status;
  o.recalled = !!opts.recalled;
  if (payload) {
    if ('edited' in payload) o.edited = payload.edited;
    if ('rejectReason' in payload) o.rejectReason = payload.rejectReason;
  }
  if (status === 'pending') { o.edited = null; o.rejectReason = ''; }

  const entry = {
    id: id,
    from: before,
    to: snapOp(o),
    fromLabel: beforeLabel,
    toLabel: STATUS_LABEL[status] || '待复核'
  };
  state.undoStack.push(entry);
  if (state.undoStack.length > 10) state.undoStack.shift();
  state.redoStack = [];

  refreshReviewUI();
  return entry;
}

function doUndo() {
  const e = state.undoStack.pop();
  if (!e) { toast('没有可撤销的操作'); return; }
  const o = state.opinions.find((x) => x.id === e.id);
  if (!o) return;
  restoreOp(o, e.from);
  state.redoStack.push(e);
  logAction('撤销：将意见#' + opIndex(e.id) + '从“' + e.toLabel + '”恢复为“' + e.fromLabel + '”', 'undo');
  refreshReviewUI();
  toast('已撤销上一步');
}

function doRedo() {
  const e = state.redoStack.pop();
  if (!e) { toast('没有可重做的操作'); return; }
  const o = state.opinions.find((x) => x.id === e.id);
  if (!o) return;
  restoreOp(o, e.to);
  state.undoStack.push(e);
  logAction('重做：将意见#' + opIndex(e.id) + '从“' + e.fromLabel + '”恢复为“' + e.toLabel + '”', 'redo');
  refreshReviewUI();
  toast('已重做');
}

/* ---------- 再次发起 / 回退到发起页 ---------- */
function saveHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    arr.unshift({
      name: state.materialName || '未命名材料',
      line: state.line + ' / ' + state.type,
      count: state.opinions.length,
      verdict: verdictOf(state.opinions).text,
      time: fmtTime(new Date())
    });
    localStorage.setItem(HIST_KEY, JSON.stringify(arr.slice(0, 3)));
  } catch (e) { /* localStorage 不可用时忽略 */ }
}

function renderHistory() {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) { arr = []; }
  const box = $('#historyBody');
  if (!arr.length) {
    box.innerHTML = '<div class="log-empty">暂无历史审查记录（完成一次审查后自动留存最近 3 次摘要）</div>';
    return;
  }
  box.innerHTML = arr.map((h, i) => '<div class="hist-item"><div class="hist-h"><b>#' + (i + 1) + ' ' + esc(h.name) + '</b><span>' + esc(h.time) + '</span></div>'
    + '<div class="hist-b">' + esc(h.line) + '　·　意见 ' + h.count + ' 条　·　结论：<b>' + esc(h.verdict) + '</b></div></div>').join('')
    + '<p class="hint" style="margin-top:10px">仅保留摘要，不恢复当时的人工复核操作。</p>';
}

/* 清空到发起审查页；clearMaterial=false 时保留材料与解析文本 */
function resetToSetup(clearMaterial) {
  state.opinions = [];
  const box1 = $('#opList'); if (box1) box1.innerHTML = '';
  state.undoStack = [];
  state.redoStack = [];
  state.overallConclusion = '';
  state.mergedGroups = [];
  state.mergedTotal = 0;
  state.foundTotal = 0;
  state.reportExported = false;
  state.expanded = false;
  $('#panelSummary').hidden = true;
  $('#panelOpinions').hidden = true;
  $('#panelReport').hidden = true;
  $('#panelRun').hidden = true;
  if (clearMaterial) {
    state.text = '';
    state.materialName = '';
    state.parseSource = '';
    state.blockCount = 0;
    $('#parseText').value = '';
    $('#parseCard').hidden = true;
    $('#parseChars').textContent = '0 字';
    $('#parseName').textContent = '—';
    $('#parseSource').textContent = '—';
    $('#parseWarn').hidden = true;
    traceNode('用户回退至发起审查阶段（清空当前材料与审查结果）', 'rollback');
  } else {
    $('#parseCard').hidden = !state.text;
    traceNode('用户回退至发起审查阶段（保留材料与解析文本）', 'rollback');
  }
  state.stepReached = 1;
  setStep(1);
  showPanels(['#panelSetup']);
  refreshReviewUI();
}

function hardResetAll() {
  saveHistory();
  state.opinions = [];
  state.rejected = [];
  const box2 = $('#opList'); if (box2) box2.innerHTML = '';
  state.log = [];
  state.undoStack = [];
  state.redoStack = [];
  state.overallConclusion = '';
  state.modelRiskLevel = '';
  state.mergedGroups = [];
  state.mergedTotal = 0;
  state.foundTotal = 0;
  state.dupRemoved = 0;
  state.text = '';
  state.materialName = '';
  state.parseSource = '';
  state.blockCount = 0;
  state.complexPages = [];
  state.reportExported = false;
  state.expanded = false;
  state.startedAt = null;
  $('#parseText').value = '';
  $('#parseCard').hidden = true;
  $('#parseChars').textContent = '0 字';
  $('#parseName').textContent = '—';
  $('#parseSource').textContent = '—';
  $('#parseWarn').hidden = true;
  $('#pushTip').hidden = true;
  $('#btnPush').disabled = false;
  $('#btnPush').textContent = '推送业务部门';
  $('#panelRun').hidden = true;
  $('#panelReport').hidden = true;
  $('#panelSummary').hidden = true;
  $('#panelOpinions').hidden = true;
  state.stepReached = 1;
  setStep(1);
  showPanels(['#panelSetup']);
  refreshReviewUI();
  renderTrace();
  toast('已重置所有状态，请上传新材料开始新的审查');
}

/* ---------- 步骤条导航 ---------- */
async function onStepClick(target) {
  const cur = state.step;
  if (target === cur) return;
  if (target > (state.stepReached || 1)) { toast('该阶段尚未到达'); return; }
  if (target > cur) { setStep(target); showStepPanels(target); refreshReviewUI(); return; }

  if (cur === 3 && target === 2) {
    const ok = await confirmDialog({
      title: '返回智能审查',
      body: '返回将重新执行智能审查，当前人工复核的操作（采纳/修改/驳回）将被清空，是否继续？',
      buttons: [{ label: '取消', value: null }, { label: '确认返回', value: true, cls: 'primary' }]
    });
    if (!ok) return;
    state.opinions.forEach((o) => { o.status = 'pending'; o.edited = null; o.rejectReason = ''; o.recalled = false; });
    // 历史记录保留，仅对已被回退覆盖的人工操作打标记
    const humanKinds = { accept: 1, modify: 1, reject: 1, recall: 1, undo: 1, redo: 1 };
    state.log.forEach((x) => { if (humanKinds[x.kind]) x.rolledBack = true; });
    state.undoStack = [];
    state.redoStack = [];
    traceNode('用户回退至智能审查阶段，重新执行审查（此前人工复核记录保留并标记“已回退”）', 'rollback');
    setStep(2);
    showStepPanels(2);
    const li = document.querySelector('.progress li[data-k="semantic"] em');
    if (li) li.textContent = '已回退，待重新复核';
    refreshReviewUI();
    toast('人工复核操作已清空，点击步骤③可继续复核');
    return;
  }

  if (cur === 4 && target === 3) {
    const ok = await confirmDialog({
      title: '返回人工复核',
      body: '返回后报告将按当前复核结果重新生成，是否继续？',
      buttons: [{ label: '取消', value: null }, { label: '返回复核', value: true, cls: 'primary' }]
    });
    if (!ok) return;
    setStep(3);
    showStepPanels(3);
    refreshReviewUI();
    return;
  }

  if (target === 1) {
    const choice = await confirmDialog({
      title: '返回发起审查',
      body: '返回将清空当前审查结果，是否需要保留已上传材料和解析文本？',
      buttons: [
        { label: '取消', value: null },
        { label: '清空并返回', value: 'clear' },
        { label: '保留材料仅返回上一步', value: 'keep', cls: 'primary' }
      ]
    });
    if (!choice) return;
    resetToSetup(choice === 'clear');
    return;
  }

  setStep(target);
  showStepPanels(target);
}

async function onRestart() {
  if (!state.reportExported) {
    const c = await confirmDialog({
      title: '报告尚未导出',
      body: '当前报告尚未导出，建议先导出报告再重新发起。仍要继续吗？',
      buttons: [
        { label: '取消', value: null },
        { label: '先导出', value: 'export', cls: 'primary' },
        { label: '仍要继续', value: 'go', cls: 'danger' }
      ]
    });
    if (!c) return;
    if (c === 'export') { exportReportAs('txt'); toast('已导出报告，如需重新发起请再次点击“再次发起审查”'); return; }
    hardResetAll();
    return;
  }
  const ok = await confirmDialog({
    title: '再次发起审查',
    body: '将清空当前审查记录并开始新的审查，当前报告已导出可忽略。是否继续？',
    buttons: [{ label: '取消', value: null }, { label: '继续', value: true, cls: 'primary' }]
  });
  if (!ok) return;
  hardResetAll();
}

/* ---------- 导出助手 ---------- */
function exportReportAs(kind) {
  const base = '审查报告-' + (state.materialName || 'material').replace(/[\\/:*?"<>|]/g, '_');
  if (kind === 'html') download(base + '.html', buildReportHTML(), 'text/html;charset=utf-8');
  else download(base + '.txt', buildReportText());
  state.reportExported = true;
}

/* ---------- 事件绑定 ---------- */
function bind() {
  // 步骤条：已完成阶段可点击回退
  $$('.step').forEach((el) => el.addEventListener('click', () => onStepClick(+el.dataset.step)));

  const drop = $('#drop');
  const input = $('#fileInput');
  drop.addEventListener('click', () => input.click());
  // 注意：不能在 handleFile 读取完成前清空 input.value，Chromium 会释放 blob 导致 FileReader 报错
  input.addEventListener('change', () => { if (input.files[0]) handleFile(input.files[0]); });
  ['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (ev) => {
    const f = ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  $('#lineSel').addEventListener('change', (e) => { state.line = e.target.value; });
  $('#typeSel').addEventListener('change', (e) => { state.type = e.target.value; });

  $$('[data-sample]').forEach((b) => {
    b.addEventListener('click', () => {
      const s = SAMPLES[b.dataset.sample];
      if (!s) return;
      $('#lineSel').value = s.line;
      $('#typeSel').value = s.type;
      state.line = s.line;
      state.type = s.type;
      state.materialName = '示例' + b.dataset.sample + ' · ' + s.line + s.type;
      state.text = s.text;
      state.parseSource = s.tag === '回归' ? '回归样例' : '内置示例';
      $('#parseCard').hidden = false;
      $('#parseName').textContent = state.materialName;
      $('#parseChars').textContent = s.text.replace(/\s/g, '').length + ' 字';
      $('#parseText').value = s.text;
      $('#parseSource').textContent = state.parseSource;
      $('#parseWarn').hidden = true;
      // 内置样例同样走一条完整业务链：新材料=新会话
      state.opinions = [];
      state.log = [];
      state.undoStack = [];
      state.redoStack = [];
      state.stepReached = 1;
      state.reportExported = false;
      traceNode('业务部门选择内置示例：' + state.materialName + '（' + s.line + ' / ' + s.type + '）', 'node');
      traceNode('系统解析完成（内置示例文本；提取 ' + s.text.replace(/\s/g, '').length + ' 字，1 个内容块）', 'node');
      refreshReviewUI();
      $('#parseCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });

  $('#btnReview').addEventListener('click', runReview);

  $$('[data-close]').forEach((b) => b.addEventListener('click', () => {
    $('#modalEdit').hidden = true;
    $('#modalReject').hidden = true;
  }));

  $('#btnSaveEdit').addEventListener('click', () => {
    const o = state.opinions.find((x) => x.id === currentOpId);
    if (!o) return;
    const edited = {
      conclusion: $('#editConclusion').value.trim() || o.original.conclusion,
      law: $('#editLaw').value.trim() || o.original.law,
      suggestion: $('#editSuggestion').value.trim() || o.original.suggestion
    };
    const e = applyStatus(o.id, 'modified', { edited: edited });
    if (e) logAction('审查人员修改后采纳意见#' + opIndex(o.id) + '（原状态“' + e.fromLabel + '”）', 'modify');
    $('#modalEdit').hidden = true;
    afterAction();
    toast('意见已修改并采纳，纳入最终报告');
  });

  $('#btnSaveReject').addEventListener('click', () => {
    const o = state.opinions.find((x) => x.id === currentOpId);
    const reason = $('#rejectReason').value.trim();
    if (!o) return;
    if (!reason) { toast('请填写驳回理由'); return; }
    const e = applyStatus(o.id, 'rejected', { rejectReason: reason });
    if (e) logAction('审查人员驳回意见#' + opIndex(o.id) + '（原状态“' + e.fromLabel + '”，理由：' + reason + '）', 'reject');
    $('#modalReject').hidden = true;
    afterAction();
    toast('意见已驳回，理由已记入链路');
  });

  $('#btnExpand').addEventListener('click', () => {
    state.expanded = !state.expanded;
    renderOpinions();
    if (!state.expanded) $('#panelOpinions').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('#btnFinish').addEventListener('click', async () => {
    const recalledPending = state.opinions.filter((o) => o.status === 'pending' && o.recalled);
    if (recalledPending.length) {
      const ok = await confirmDialog({
        title: '存在已撤回意见',
        body: '有 ' + recalledPending.length + ' 条意见已撤回且未重新复核，完结后这些意见不进入报告结论，是否继续？',
        buttons: [{ label: '取消', value: null }, { label: '继续完结', value: true, cls: 'primary' }]
      });
      if (!ok) return;
    }
    setStep(4);
    saveHistory();
    renderReport();
    traceNode('审查完结，报告已生成（结论：' + verdictOf(state.opinions).text + '，共 ' + state.opinions.length + ' 条意见）', 'done');
    toast('审查完结，报告已生成');
    showPanels(['#panelReport']);
    $('#panelReport').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#pushTip').hidden = true;
    $('#btnPush').disabled = false;
  });

  $('#btnPush').addEventListener('click', () => {
    $('#pushTip').hidden = false;
    $('#btnPush').disabled = true;
    $('#btnPush').textContent = '已推送';
    traceNode('审查意见已推送业务部门，等待业务部门修订后重新送审', 'node');
    toast('审查意见已推送，等待业务部门修订后重新送审');
  });

  $('#btnCopy').addEventListener('click', async () => {
    const text = buildReportText();
    try {
      await navigator.clipboard.writeText(text);
      toast('报告已复制到剪贴板');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('报告已复制');
    }
  });

  $('#btnTxt').addEventListener('click', () => { exportReportAs('txt'); toast('报告已导出（.txt）'); });

  $('#btnHtml').addEventListener('click', () => { exportReportAs('html'); toast('报告已导出（.html）'); });

  // 撤销 / 重做 / 操作日志
  $('#btnUndo').addEventListener('click', doUndo);
  $('#btnRedo').addEventListener('click', doRedo);
  $('#btnLog').addEventListener('click', () => {
    const box = $('#logBox');
    box.hidden = !box.hidden;
  });

  // 快捷键：Ctrl/⌘+Z 撤销，Ctrl/⌘+Shift+Z 或 Ctrl+Y 重做
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA/.test(tag) || (e.target && e.target.isContentEditable)) return;
    if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
    } else if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      doRedo();
    }
  });

  $('#btnRestart').addEventListener('click', onRestart);

  $('#btnTrace').addEventListener('click', () => {
    const card = $('#traceCard');
    const collapsed = card.classList.toggle('collapsed');
    $('#btnTrace').textContent = collapsed ? '展开' : '收起';
  });

  $('#btnHistory').addEventListener('click', () => {
    renderHistory();
    $('#modalHistory').hidden = false;
  });
}

/* ---------- 启动 ---------- */
async function boot() {
  bind();
  setStep(1);
  renderTrace();
  try {
    await ensureCloud();
  } catch (e) {
    setEnv(false, e.message);
    return;
  }
  try {
    await ensureModels();
    const m = pickModel(false) || pickModel(true);
    if (!m) { setEnv(false, '无可用审查模型'); return; }
    state.model = m;
    state.modelLabel = m.name || m.id;
    setEnv(true, '审查引擎就绪 · ' + (m.name || m.id) + (m.supportsImages === true ? ' · 支持图片识别' : ''));
  } catch (e) {
    setEnv(false, '引擎初始化失败：' + (e.message || e));
  }
}

document.addEventListener('DOMContentLoaded', boot);
