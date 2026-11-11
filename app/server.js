'use strict';
/**
 * 金融营销宣传智能审查 —— 轻量后端
 * 职责：静态托管 + Office 文本解析（docx / pptx / txt）
 * 无第三方依赖，纯 Node 内置模块，避免部署期依赖安装失败。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 25 * 1024 * 1024; // 25MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* ---------------- ZIP / Office 解析 ---------------- */

function findEOCD(buf) {
  const sig = 0x06054b50;
  const start = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === sig) return i;
  }
  return -1;
}

function unzip(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('文件不是合法的 Office 压缩包');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString('utf8');
    if (lho + 30 <= buf.length) {
      const lnlen = buf.readUInt16LE(lho + 26);
      const lelen = buf.readUInt16LE(lho + 28);
      const dstart = lho + 30 + lnlen + lelen;
      const data = buf.slice(dstart, dstart + csize);
      if (method === 0) out.set(name, data);
      else if (method === 8) {
        try { out.set(name, zlib.inflateRawSync(data)); } catch (e) { /* 跳过损坏条目 */ }
      }
    }
    off += 46 + nlen + elen + clen;
  }
  return out;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}

function tidy(text) {
  return text
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

const IMG_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif'
};
const VECTOR_EXT = /^(emf|wmf|tif|tiff|svg|eps)$/i;

/* docx：正文 + 表格数 + word/media 内嵌图片 */
function docxParse(buf) {
  const zip = unzip(buf);
  const xml = zip.get('word/document.xml');
  if (!xml) throw new Error('docx 结构异常：缺少 word/document.xml');
  let s = xml.toString('utf8');
  const tables = (s.match(/<w:tbl>/g) || []).length;
  const drawings = (s.match(/<w:drawing>/g) || []).length;
  const charts = (s.match(/<c:chart\s/g) || []).length;
  s = s.replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tc>/g, '\t');
  const text = tidy(decodeXml(s.replace(/<[^>]+>/g, '')));

  const images = [];
  let vector = 0;
  let oversize = 0;
  [...zip.keys()].forEach((name) => {
    if (!/^word\/media\//i.test(name)) return;
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (VECTOR_EXT.test(ext)) { vector++; return; }
    if (!IMG_MIME[ext]) { vector++; return; }
    const data = zip.get(name);
    if (!data || !data.length) return;
    if (data.length > 8 * 1024 * 1024) { oversize++; return; }
    images.push({
      name: name.split('/').pop(),
      mime: IMG_MIME[ext],
      bytes: data.length,
      b64: data.toString('base64')
    });
  });
  images.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  return { text, tables, drawings, charts, images, vector, oversize };
}

/* pptx：逐页提取文本框 / 组合形状 / 表格；母版、版式、备注一律不读 */
function pptxParse(buf) {
  const zip = unzip(buf);
  const names = [...zip.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/(\d+)/)[1], 10) - parseInt(b.match(/(\d+)/)[1], 10));
  if (!names.length) throw new Error('pptx 结构异常：未找到幻灯片');

  const slides = names.map((name, idx) => {
    const xml = zip.get(name).toString('utf8');
    // <a:t> 覆盖普通文本框、组合形状(p:grpSp)内部 sp、表格(a:tbl)单元格
    const texts = [];
    const re = /<a:t>([\s\S]*?)<\/a:t>/g;
    let m;
    while ((m = re.exec(xml))) {
      const t = decodeXml(m[1]).replace(/\s+/g, ' ').trim();
      if (t) texts.push(t);
    }
    const groups = (xml.match(/<p:grpSp>/g) || []).length;
    const tables = (xml.match(/<a:tbl>/g) || []).length;
    // 图表 / SmartArt 无法抽取文字，标记为复杂对象，交由人工复核
    const complex = (xml.match(/<c:chart\s/g) || []).length
      + (xml.match(/graphicData[^>]*uri="[^"]*diagram/g) || []).length;
    const kinds = [];
    if (texts.length) kinds.push(tables ? '文本框/表格' : '文本框');
    else if (tables) kinds.push('表格');
    return { page: idx + 1, text: texts.join('\n'), groups, tables, charts: complex, kinds: kinds.join('') };
  });

  const pageText = slides
    .filter((sl) => sl.text)
    .map((sl) => '【第 ' + sl.page + ' 页】\n' + sl.text)
    .join('\n\n');
  return { text: tidy(pageText), slides };
}

/* ---------------- HTTP ---------------- */

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': (ext === '.html' || ext === '.js' || ext === '.css') ? 'no-store' : 'public, max-age=300'
    });
    res.end(data);
  });
}

function handleParse(req, res, url) {
  const ext = (url.searchParams.get('ext') || '').toLowerCase();
  const name = url.searchParams.get('name') || '材料';
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      req.destroy();
      send(res, 413, JSON.stringify({ ok: false, error: '文件超过 25MB，请压缩后重试' }));
    } else chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    try {
      const buf = Buffer.concat(chunks);
      let text = '';
      const warnings = [];
      const meta = {};
      if (ext === 'txt') {
        text = buf.toString('utf8');
        if (text.includes('\uFFFD')) warnings.push('文件可能不是 UTF-8 编码，个别字符可能显示异常');
      } else if (ext === 'docx') {
        const d = docxParse(buf);
        text = d.text;
        meta.tables = d.tables;
        meta.images = d.images;
        meta.vector = d.vector;
        meta.charts = d.charts;
        if (d.oversize) warnings.push(d.oversize + ' 张内嵌图片超过 8MB，已跳过（请单独压缩后按图片上传）');
      } else if (ext === 'pptx') {
        const d = pptxParse(buf);
        text = d.text;
        meta.slides = d.slides;
      } else {
        throw new Error('后端不支持的格式：' + ext);
      }
      text = tidy(text);
      if (!text && !(meta.images && meta.images.length) && !(meta.slides && meta.slides.length)) {
        throw new Error('未提取到文字，可能是空白文档或纯图片文档');
      }
      send(res, 200, JSON.stringify(Object.assign({ ok: true, name, ext, text, chars: text.length, warnings }, meta)));
    } catch (e) {
      send(res, 200, JSON.stringify({ ok: false, error: e.message || '解析失败' }));
    }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/api/parse') return handleParse(req, res, url);
  if (url.pathname === '/api/health') {
    return send(res, 200, JSON.stringify({ ok: true, node: process.version, ts: Date.now() }));
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
  send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('consumer-review listening on ' + PORT);
});
