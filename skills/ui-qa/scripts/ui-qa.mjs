#!/usr/bin/env node
/*
 * ui-qa — комплексна UI/UX-перевірка сайту на всіх роздільностях перед деплоєм.
 *
 *   node ui-qa.mjs <папка-сайту | URL> [--out qa-report] [--quick] [--config ui-qa.config.json]
 *
 * Код виходу: 0 — блокерів немає (можна деплоїти), 1 — є блокери, 2 — збій запуску.
 * Без залежностей, крім Playwright (є в середовищі). PNG розбирається вбудованим zlib.
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
let chromium;
for (const p of ['playwright', '/opt/node-tools/node_modules/playwright', 'playwright-core']) {
  try { ({ chromium } = require(p)); break; } catch {}
}
if (!chromium) { console.error('Playwright не знайдено'); process.exit(2); }

// ───────── аргументи ─────────
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const target = args.find((a, i) => !a.startsWith('--') && !['--out', '--config', '--only'].includes(args[i - 1]));
if (!target) { console.error('Вкажіть папку сайту або URL'); process.exit(2); }
const OUT = path.resolve(opt('--out', 'qa-report'));
const QUICK = args.includes('--quick');
const cfgPath = opt('--config', [path.join(target, 'ui-qa.config.json'), path.join(target, '..', 'ui-qa.config.json'), 'ui-qa.config.json'].find((p) => fs.existsSync(p)) || '');
const CFG = cfgPath && fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
const IGNORE = CFG.ignore || [];            // селектори, які не перевіряти (свідомі виходи за край, декоративні шари)
const CONTRAST_IGNORE = CFG.contrastIgnore || [];
const INTERACTIONS = CFG.interactions || []; // [{ click: 'sel', wait: 600, viewports: 'mobile'|'desktop'|'all', close: 'sel' }]
const PRIMARY_CTA = CFG.primaryCta || null;

// ───────── матриця екранів ─────────
const ALL = [
  ['iPhone SE 1', 320, 568, 1], ['Android S', 360, 780, 1], ['iPhone SE', 375, 667, 1], ['iPhone 13/14', 390, 844, 1],
  ['iPhone 15 Pro', 393, 852, 1], ['Pixel 7', 412, 915, 1], ['iPhone Pro Max', 430, 932, 1],
  ['Phone landscape', 844, 390, 1], ['Pro Max landscape', 932, 430, 1],
  ['Small tablet', 600, 960, 1], ['iPad mini', 768, 1024, 1], ['iPad Air', 820, 1180, 1], ['iPad landscape', 1024, 768, 1], ['iPad Pro', 1024, 1366, 1],
  ['Laptop S', 1280, 720, 0], ['Laptop', 1366, 768, 0], ['MacBook Air', 1440, 900, 0], ['Laptop L', 1536, 864, 0], ['Full HD', 1920, 1080, 0], ['QHD', 2560, 1440, 0],
];
const QUICK_SET = ['iPhone SE 1', 'iPhone 13/14', 'iPhone Pro Max', 'iPad mini', 'iPad landscape', 'MacBook Air', 'Full HD'];
const ONLY = opt('--only', '');
const VIEWPORTS0 = (CFG.viewports || (QUICK ? ALL.filter((v) => QUICK_SET.includes(v[0])) : ALL)).map(([name, w, h, touch]) => ({ name, w, h, touch: !!touch }));
const VIEWPORTS = ONLY ? VIEWPORTS0.filter((v) => ONLY.split(',').includes(`${v.w}x${v.h}`)) : VIEWPORTS0;

// ───────── статичний сервер для папки ─────────
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.txt': 'text/plain' };
async function serve(dir) {
  const root = path.resolve(dir);
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = path.join(root, p);
    if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f = f + '.html';
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() };
}

// ───────── мінімальний PNG-декодер (8-біт RGB/RGBA без черезрядковості — так знімає Chromium) ─────────
function decodePNG(buf) {
  let pos = 8, w, h, ct, bd; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error('PNG: непідтримуваний формат ' + ct + '/' + bd);
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat)), px = Buffer.alloc(w * h * 3);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) { px[(y * w + x) * 3] = cur[x * bpp]; px[(y * w + x) * 3 + 1] = cur[x * bpp + 1]; px[(y * w + x) * 3 + 2] = cur[x * bpp + 2]; }
    [prev, cur] = [cur, prev];
  }
  return { w, h, px };
}
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

// контраст тексту з реальним фоном під ним (за пікселями знімка)
function pixelContrast(img, box, rgb, dpr) {
  const x0 = Math.max(0, Math.floor(box.x * dpr)), y0 = Math.max(0, Math.floor(box.y * dpr));
  const x1 = Math.min(img.w, Math.ceil((box.x + box.w) * dpr)), y1 = Math.min(img.h, Math.ceil((box.y + box.h) * dpr));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  const tl = lum(...rgb), bg = [];
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const i = (y * img.w + x) * 3, r = img.px[i], g = img.px[i + 1], b = img.px[i + 2];
    if (Math.abs(r - rgb[0]) + Math.abs(g - rgb[1]) + Math.abs(b - rgb[2]) > 90) bg.push(lum(r, g, b));
  }
  if (bg.length < 12) return null;
  bg.sort((a, b) => a - b);
  // беремо «найгірший реалістичний» фон: 85-й перцентиль для світлого тексту (світлі ділянки фону), 15-й для темного
  const q = tl > 0.5 ? bg[Math.floor(bg.length * 0.85)] : bg[Math.floor(bg.length * 0.15)];
  const med = bg[Math.floor(bg.length / 2)];
  return { worst: ratio(tl, q), median: ratio(tl, med) };
}

// чи стоїть іконка по центру свого кружка/кнопки
function iconCentering(img, box, dpr) {
  const x0 = Math.round(box.x * dpr), y0 = Math.round(box.y * dpr), w = Math.round(box.w * dpr), h = Math.round(box.h * dpr);
  if (x0 < 0 || y0 < 0 || x0 + w > img.w || y0 + h > img.h || w < 10 || h < 10) return null;
  const at = (x, y) => { const i = ((y0 + y) * img.w + x0 + x) * 3; return [img.px[i], img.px[i + 1], img.px[i + 2]]; };
  // фон — медіана пікселів на 22% від центру по діагоналях (між кантом і знаком)
  const samples = [];
  for (const [fx, fy] of [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]]) samples.push(at(Math.floor(w * fx), Math.floor(h * fy)));
  const bgc = [0, 1, 2].map((k) => samples.map((s) => s[k]).sort((a, b) => a - b)[1]);
  if (samples.some((p) => Math.abs(p[0] - bgc[0]) + Math.abs(p[1] - bgc[1]) + Math.abs(p[2] - bgc[2]) > 36)) return null; // фон неоднорідний (фото, градієнт) — не оцінюємо
  let sx = 0, sy = 0, n = 0;
  const inset = 0.18; // не рахуємо кант кружка
  for (let y = Math.floor(h * inset); y < h * (1 - inset); y++) for (let x = Math.floor(w * inset); x < w * (1 - inset); x++) {
    const p = at(x, y); if (Math.abs(p[0] - bgc[0]) + Math.abs(p[1] - bgc[1]) + Math.abs(p[2] - bgc[2]) > 80) { sx += x; sy += y; n++; }
  }
  if (n < 6) return null;
  return { dx: (sx / n - w / 2) / w, dy: (sy / n - h / 2) / h };
}

// ───────── збір даних зі сторінки (виконується в браузері) ─────────
function collect({ IGNORE, touch }) {
  const W = document.documentElement.clientWidth, H = innerHeight;
  const ign = (el) => IGNORE.some((s) => { try { return el.closest(s); } catch { return false; } });
  const vis = (el) => { if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) return false; const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity < 0.05) return false; for (let a = el.parentElement; a; a = a.parentElement) { const t = getComputedStyle(a); if (+t.opacity < 0.05 || t.visibility === 'hidden') return false; } return true; };
  const desc = (el) => { const id = el.id ? '#' + el.id : ''; const cls = [...el.classList].slice(0, 3).map((c) => '.' + c).join(''); const txt = (el.innerText || el.getAttribute('aria-label') || el.alt || '').trim().replace(/\s+/g, ' ').slice(0, 40); return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ` «${txt}»` : ''}`; };
  // частка елемента, яку реально видно крізь обрізання предків (згорнуті акордеони, маски, стрічки)
  const visibleFrac = (el, r) => {
    let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const t = getComputedStyle(a);
      if (t.overflowX !== 'visible' || t.overflowY !== 'visible' || t.clipPath !== 'none') { const q = a.getBoundingClientRect(); x0 = Math.max(x0, q.left); y0 = Math.max(y0, q.top); x1 = Math.min(x1, q.right); y1 = Math.min(y1, q.bottom); }
      if (x1 <= x0 || y1 <= y0) return 0;
    }
    return ((x1 - x0) * (y1 - y0)) / Math.max(1, r.width * r.height);
  };
  const inFixed = (el) => { for (let a = el; a && a !== document.body; a = a.parentElement) { const p = getComputedStyle(a).position; if (p === 'fixed') return a; } return null; };
  const clippedByAncestor = (el, r) => { for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) { const s = getComputedStyle(a); if (/(hidden|clip|auto|scroll)/.test(s.overflowX)) { const q = a.getBoundingClientRect(); if (q.right <= W + 1 && q.left >= -1) return true; } } return false; };
  const out = { overflow: [], textOverflow: [], overlap: [], tap: [], small: [], covered: [], images: [], texts: [], icons: [], clipped: [] };
  const all = [...document.querySelectorAll('body *')];
  const leafText = [];
  for (const el of all) {
    if (ign(el)) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    const tag = el.tagName.toLowerCase();
    const inView = r.bottom > 0 && r.top < H;
    // 1. вихід за край екрана
    if ((r.right > W + 1 || r.left < -1) && s.position !== 'fixed' && !clippedByAncestor(el, r) && vis(el)) out.overflow.push(`${desc(el)} [${Math.round(r.left)}…${Math.round(r.right)} при ширині ${W}]`);
    if (!inView || !vis(el) || visibleFrac(el, r) < 0.5) continue;
    // 2. текст вилазить з коробки
    if (s.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && !['svg', 'path', 'use', 'line', 'picture', 'img', 'input', 'video', 'canvas', 'textarea', 'select'].includes(tag) && el.children.length === 0) out.textOverflow.push(`${desc(el)} (вміст ${el.scrollWidth}px > коробка ${el.clientWidth}px)`);
    // 3. обрізаний текст (overflow hidden без три крапки)
    if (/(hidden|clip)/.test(s.overflowY + s.overflowX) && el.children.length === 0 && (el.innerText || '').trim().length > 2 && s.textOverflow !== 'ellipsis' && !s.webkitLineClamp?.match?.(/\d/) && (el.scrollHeight > el.clientHeight + 3 || el.scrollWidth > el.clientWidth + 3)) out.clipped.push(desc(el));
    // текстові листки
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (ownText && !['script', 'style', 'noscript', 'option'].includes(tag)) {
      const fs_ = parseFloat(s.fontSize), lh = s.lineHeight === 'normal' ? fs_ * 1.2 : parseFloat(s.lineHeight);
      if (!inFixed(el)) leafText.push({ el, r });
      let op = 1; for (let a = el; a && a !== document.documentElement; a = a.parentElement) op *= +getComputedStyle(a).opacity;
      const rg = document.createRange(); let tb = null;
      for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) { rg.selectNodeContents(n); for (const q of rg.getClientRects()) { if (!q.width) continue; tb = tb ? { l: Math.min(tb.l, q.left), t: Math.min(tb.t, q.top), r: Math.max(tb.r, q.right), b: Math.max(tb.b, q.bottom) } : { l: q.left, t: q.top, r: q.right, b: q.bottom }; } }
      const cx = tb ? (tb.l + tb.r) / 2 : 0, cy = tb ? (tb.t + tb.b) / 2 : 0;
      const topEl = tb && cx >= 0 && cy >= 0 && cx < W && cy < H ? document.elementFromPoint(cx, cy) : null;
      const underFixed = topEl && !el.contains(topEl) && !topEl.contains(el) && inFixed(topEl) && !inFixed(el);
      const ownBg = (() => { for (const a of [el, el.parentElement]) { if (!a) break; const t = getComputedStyle(a); const m = t.backgroundColor.match(/[\d.]+/g); if (t.backgroundImage === 'none' && m && (m[3] === undefined || +m[3] >= 0.9) && !(m.length === 4 && +m[3] === 0)) return m.slice(0, 3).map(Number); } return null; })();
      if (op >= 0.97 && tb && !underFixed) out.texts.push({ ownBg, id: (el.dataset.qa ||= String(Math.random()).slice(2, 10)), d: desc(el), rx: r.left, ry: r.top, box: { x: tb.l, y: tb.t, w: tb.r - tb.l, h: tb.b - tb.t }, color: s.color.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number), size: fs_, weight: +s.fontWeight, ign: false });
      // 4. дрібний шрифт
      if (fs_ < 11 && touch) out.small.push(`${desc(el)} — ${fs_}px`);
      // 5. рядки налізають один на один
      if (lh < fs_ * 0.95 && r.height > lh * 1.6) out.overlap.push(`${desc(el)}: перенос рядків при line-height ${Math.round(lh)}px < шрифт ${Math.round(fs_)}px — рядки накладаються`);
    }
    // 6. розмір зони натискання
    const interactive = el.matches('a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=radio], [role=switch], [tabindex="0"]');
    if (interactive && touch && s.pointerEvents !== 'none') {
      const inlineLink = tag === 'a' && s.display === 'inline' && el.closest('p, li');
      const min = Math.min(r.width, r.height);
      if (!inlineLink && min < 40 && !(tag === 'input' && ['checkbox', 'radio'].includes(el.type) && el.closest('label'))) out.tap.push({ d: desc(el), min: Math.round(min) });
    }
    // 7. перекриття фіксованими шарами (шапка, док) — лише для повністю видимих інтерактивних
    if (interactive && r.top >= 0 && r.bottom <= H && r.width > 8) {
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const top = document.elementFromPoint(Math.min(W - 1, Math.max(0, cx)), Math.min(H - 1, Math.max(0, cy)));
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        let fixed = null; for (let a = top; a; a = a.parentElement) { const t = getComputedStyle(a); if (t.position === 'fixed' || t.position === 'sticky') { fixed = a; break; } }
        let selfFixed = false; for (let a = el; a; a = a.parentElement) { const t = getComputedStyle(a); if (t.position === 'fixed' || t.position === 'sticky') { selfFixed = true; break; } }
        if (fixed && !selfFixed && !ign(fixed)) {
          const fr = fixed.getBoundingClientRect(), docH = document.documentElement.scrollHeight, absBottom = r.bottom + scrollY, absTop = r.top + scrollY;
          const atBottomBar = fr.top > H / 2, unreachable = atBottomBar ? docH - absBottom < fr.height + 8 : absTop < fr.bottom + 8;
          if (unreachable) out.covered.push(`${desc(el)} перекрито ${desc(fixed)} і прокруткою з-під нього не вивести`);
        }
      }
    }
    // 8. картинки
    if (tag === 'img') {
      if (el.complete && el.naturalWidth === 0 && el.currentSrc) out.images.push({ kind: 'broken', d: desc(el), src: el.currentSrc });
      else if (!el.complete || !el.currentSrc) { if (el.loading !== 'lazy' || r.top < H) out.images.push({ kind: 'notloaded', d: desc(el), src: el.getAttribute('src') || el.dataset.src || '' }); }
      else if (s.objectFit === 'fill' && el.naturalWidth) { const a1 = el.naturalWidth / el.naturalHeight, a2 = r.width / r.height; if (Math.abs(a1 - a2) / a1 > 0.04) out.images.push({ kind: 'distorted', d: desc(el), src: el.currentSrc }); }
    }
    // 9. кругла кнопка/знак без тексту — перевіримо центрування іконки за пікселями
    const br = parseFloat(s.borderTopLeftRadius);
    const square = r.width >= 18 && r.width <= 72 && Math.abs(r.width - r.height) <= 3;
    let opI = 1; for (let a = el; a && a !== document.documentElement; a = a.parentElement) { const t = getComputedStyle(a); opI *= +t.opacity; }
    const moving = el.getAnimations ? el.getAnimations({ subtree: true }).some((a) => a.playState === 'running') : false;
    const icx = r.left + r.width / 2, icy = r.top + r.height / 2;
    const atIcon = icx >= 0 && icy >= 0 && icx < W && icy < H ? document.elementFromPoint(icx, icy) : null;
    const iconUnderFixed = atIcon && !el.contains(atIcon) && !atIcon.contains(el) && inFixed(atIcon) && !inFixed(el);
    if (square && opI >= 0.97 && !moving && !iconUnderFixed && s.transform === 'none' && br >= r.width * 0.4 && !(el.innerText || '').trim() && el.children.length <= 3 && !['img', 'svg', 'input', 'video', 'picture'].includes(tag)) out.icons.push({ id: (el.dataset.qa ||= String(Math.random()).slice(2, 10)), d: desc(el), box: { x: r.left, y: r.top, w: r.width, h: r.height } });
  }
  // 10. текст, що накладається на інший текст
  for (let i = 0; i < leafText.length; i++) for (let j = i + 1; j < leafText.length; j++) {
    const a = leafText[i], b = leafText[j]; if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const ix = Math.max(0, Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)), iy = Math.max(0, Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top));
    const ar = ix * iy, sm = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
    if (sm > 0 && ar / sm > 0.25) out.overlap.push(`${desc(a.el)} ⟂ ${desc(b.el)}`);
  }
  out.scrollWidth = document.documentElement.scrollWidth; out.W = W;
  return out;
}

// ───────── прогін ─────────
const issues = []; // { level: 'blocker'|'warning', check, viewport, msg }
const add = (level, check, vp, msg) => { if (!issues.some((i) => i.check === check && i.msg === msg && i.viewport === vp)) issues.push({ level, check, viewport: vp, msg }); };

const srv = /^https?:/.test(target) ? null : await serve(target);
const URL0 = srv ? srv.url : target;
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const t0 = Date.now();

async function runViewport(vp, mode = 'normal') {
  const tag = `${vp.w}×${vp.h}${mode !== 'normal' ? ' ' + mode : ''}`;
  const dir = path.join(OUT, 'shots', `${vp.w}x${vp.h}${mode !== 'normal' ? '-' + mode : ''}`); fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: vp.touch && vp.w < 1100, hasTouch: vp.touch, deviceScaleFactor: 1, reducedMotion: mode === 'reduced-motion' ? 'reduce' : 'no-preference', javaScriptEnabled: mode !== 'no-js' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') add('blocker', 'Помилки консолі', tag, m.text().slice(0, 200)); });
  page.on('pageerror', (e) => add('blocker', 'Помилки JS', tag, e.message.slice(0, 200)));
  page.on('response', (r) => { if (r.status() >= 400) add('blocker', 'Запити з помилкою', tag, `${r.status()} ${r.url().replace(URL0, '/')}`); });
  page.on('requestfailed', (r) => { const f = r.failure()?.errorText || ''; if (!/ERR_ABORTED/.test(f)) add('blocker', 'Запити з помилкою', tag, `${f} ${r.url().replace(URL0, '/')}`); });
  await page.addInitScript(() => { window.__cls = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch {} });
  await page.goto(URL0, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => add('blocker', 'Завантаження', tag, e.message.slice(0, 160)));
  await page.waitForTimeout(mode === 'normal' ? 2500 : 1200);

  // перший екран
  const fold = await page.evaluate((cta) => {
    const h1 = document.querySelector('h1'); const H = innerHeight;
    const r = h1 && h1.getBoundingClientRect();
    const c = cta ? document.querySelector(cta) : [...document.querySelectorAll('a.btn, button.btn, a[class*=cta], button[class*=cta], [data-cta]')].find((e) => { const q = e.getBoundingClientRect(); return q.width && q.top < H; });
    const cr = c && c.getBoundingClientRect();
    return { h1: !!h1, h1Visible: !!(r && r.bottom > 0 && r.top < H && r.width), h1Count: document.querySelectorAll('h1').length, cta: !!(cr && cr.width && cr.top < H && cr.bottom > 0) };
  }, PRIMARY_CTA);
  if (!fold.h1) add('blocker', 'Перший екран', tag, 'немає H1'); else if (!fold.h1Visible && mode !== 'no-js') add('blocker', 'Перший екран', tag, 'H1 не видно на першому екрані');
  if (fold.h1Count > 1) add('warning', 'Доступність', tag, `H1 на сторінці: ${fold.h1Count}`);
  if (!fold.cta && mode === 'normal') add('blocker', 'Перший екран', tag, 'головна кнопка дії не видна на першому екрані');

  const loadCLS = await page.evaluate(() => window.__cls || 0);
  if (mode === 'normal' && loadCLS > 0.1) add('warning', 'Стрибки макета при завантаженні (CLS)', tag, `CLS ${loadCLS.toFixed(3)} (норма ≤ 0.1)`);
  // реальні джерела горизонтального скролу: тимчасово знімаємо clip/hidden з html і body
  const realSW = await page.evaluate(() => { const st = document.createElement('style'); st.id = '__qa'; st.textContent = 'html,body{overflow-x:visible!important}'; document.head.appendChild(st); const v = document.documentElement.scrollWidth; return v; });
  const W = await page.evaluate(() => document.documentElement.clientWidth);
  if (realSW > W + 1) add('blocker', 'Горизонтальний скрол', tag, `сторінка ширша за екран: ${realSW}px при ${W}px (на iOS це видно як скрол убік)`);

  // прохід по сторінці екран за екраном
  const H = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = Math.round(vp.h * 0.85);
  let n = 0;
  const shots = [];
  for (let y = 0; y < H + step; y += step) {
    await page.evaluate((y) => window.scrollTo(0, y), Math.min(y, H));
    await page.waitForTimeout(mode === 'normal' ? 1100 : 250);
    // чекаємо, поки стихнуть CSS-переходи
    await page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getComputedTiming?.().iterations !== Infinity), null, { timeout: 2500 }).catch(() => {});
    const data = await page.evaluate(collect, { IGNORE, touch: vp.touch });
    data.overflow.forEach((m) => add('blocker', 'Вихід за край екрана', tag, m));
    data.textOverflow.forEach((m) => add('blocker', 'Текст вилазить з коробки', tag, m));
    data.overlap.forEach((m) => add('blocker', 'Накладання тексту', tag, m));
    data.clipped.forEach((m) => add('warning', 'Обрізаний текст', tag, m));
    data.tap.forEach((t) => add(t.min < 32 ? 'blocker' : 'warning', 'Зона натискання', tag, `${t.d} — ${t.min}px (норма ≥ 44)`));
    data.small.forEach((m) => add(parseFloat(m.split('—')[1]) < 9 ? 'blocker' : 'warning', 'Дрібний шрифт', tag, m));
    data.covered.forEach((m) => add('blocker', 'Перекрито фіксованим шаром', tag, m));
    data.images.forEach((i) => add(i.kind === 'distorted' || mode === 'no-js' ? 'warning' : 'blocker', i.kind === 'broken' ? 'Бита картинка' : i.kind === 'distorted' ? 'Розтягнута картинка' : 'Картинка не завантажилась', tag, `${i.d} ${i.src}`));
    // пікселі: контраст і центрування іконок
    const png = await page.screenshot({ type: 'png' });
    const img = decodePNG(png);
    // що зрушило між замірами і знімком — не оцінюємо (рухоме)
    const moved = new Set(await page.evaluate((items) => items.filter((it) => { const el = document.querySelector(`[data-qa="${it.id}"]`); if (!el) return true; const r = el.getBoundingClientRect(); return Math.abs(r.top - it.y) > 1 || Math.abs(r.left - it.x) > 1; }).map((it) => it.id), [...data.texts, ...data.icons].map((t) => ({ id: t.id, x: t.rx ?? t.box.x, y: t.ry ?? t.box.y }))));
    data.texts = data.texts.filter((t) => !moved.has(t.id)); data.icons = data.icons.filter((t) => !moved.has(t.id));
    for (const t of data.texts) {
      if (CONTRAST_IGNORE.some((s) => t.d.includes(s))) continue;
      const c = t.ownBg ? (() => { const v = ratio(lum(...t.color), lum(...t.ownBg)); return { median: v, worst: v }; })() : pixelContrast(img, t.box, t.color, 1); if (!c) continue;
      const large = t.size >= 24 || (t.size >= 18.66 && t.weight >= 600);
      const need = large ? 3 : 4.5;
      if (c.median < (large ? 2.2 : 3)) add('blocker', 'Контраст тексту', tag, `${t.d}: ${c.median.toFixed(2)}:1 до фону (потрібно ≥ ${need})`);
      else if (c.worst < need * 0.75 && t.size >= 12) add('warning', 'Контраст тексту', tag, `${t.d}: місцями ${c.worst.toFixed(2)}:1 (фото/градієнт під текстом)`);
    }
    for (const ic of data.icons) {
      const c = iconCentering(img, ic.box, 1); if (!c) continue;
      const off = Math.max(Math.abs(c.dx), Math.abs(c.dy));
      if (off > 0.22) add('blocker', 'Іконка не по центру', tag, `${ic.d} @${Math.round(ic.box.x)},${Math.round(ic.box.y)} (прокрутка ${y}): зсув ${Math.round(c.dx * 100)}% / ${Math.round(c.dy * 100)}%`);
      else if (off > 0.14) add('warning', 'Іконка трохи не по центру', tag, `${ic.d}: зсув ${Math.round(c.dx * 100)}% / ${Math.round(c.dy * 100)}%`);
    }
    const f = path.join(dir, `${String(n).padStart(2, '0')}.jpg`);
    await page.screenshot({ path: f, type: 'jpeg', quality: 60 });
    shots.push(f); n++;
    if (y >= H) break;
  }

  // взаємодії: акордеони, меню, конфігуровані кроки — і повторна перевірка виходу за край
  if (mode === 'normal') {
    const toggles = await page.$$('summary, [aria-expanded="false"]');
    let opened = 0;
    for (const t of toggles.slice(0, 40)) {
      try {
        if (!(await t.isVisible())) continue;
        await t.scrollIntoViewIfNeeded(); await t.click({ timeout: 1500 }); opened++; await page.waitForTimeout(450);
        const d = await page.evaluate(collect, { IGNORE, touch: vp.touch });
        d.overflow.forEach((m) => add('blocker', 'Вихід за край (після відкриття)', tag, m));
        d.textOverflow.forEach((m) => add('blocker', 'Текст вилазить (після відкриття)', tag, m));
        const sw = await page.evaluate(() => document.documentElement.scrollWidth);
        if (sw > W + 1) add('blocker', 'Горизонтальний скрол', tag, `після відкриття елемента ширина ${sw}px`);
        if (await page.evaluate(() => document.body.style.overflow === 'hidden')) { await page.keyboard.press('Escape'); await page.waitForTimeout(400); }
      } catch {}
    }
    for (const it of INTERACTIONS) {
      if (it.viewports === 'mobile' && !vp.touch) continue; if (it.viewports === 'desktop' && vp.touch) continue;
      try {
        await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(700);
        const loc = page.locator(it.click).filter({ visible: true }).first();
        await loc.scrollIntoViewIfNeeded(); await page.waitForTimeout(400); await loc.click({ timeout: 4000 }); await page.waitForTimeout(it.wait || 700);
        const d = await page.evaluate(collect, { IGNORE, touch: vp.touch });
        d.overflow.concat(d.textOverflow).forEach((m) => add('blocker', `Після «${it.name || it.click}»`, tag, m));
        d.overlap.forEach((m) => add('blocker', `Накладання після «${it.name || it.click}»`, tag, m));
        const png = await page.screenshot({ type: 'png' }); const img = decodePNG(png);
        for (const ic of d.icons) { const c = iconCentering(img, ic.box, 1); if (c && Math.max(Math.abs(c.dx), Math.abs(c.dy)) > 0.22) add('blocker', 'Іконка не по центру', tag, `${ic.d}`); }
        const f = path.join(dir, `i-${(it.name || it.click).replace(/[^\wа-яіїєґ]+/gi, '_').slice(0, 30)}.jpg`);
        await page.screenshot({ path: f, type: 'jpeg', quality: 60 }); shots.push(f);
        if (it.close) { await page.locator(it.close).first().click({ timeout: 1500 }).catch(() => page.keyboard.press('Escape')); await page.waitForTimeout(500); }
      } catch (e) { add('warning', 'Взаємодія не вдалася', tag, `${it.name || it.click}: ${e.message.split('\n')[0].slice(0, 120)}`); }
    }
  }
  // доступність (раз на прогін достатньо, але дешево)
  const a11y = await page.evaluate(() => {
    const r = [];
    if (!document.documentElement.lang) r.push('немає <html lang>');
    document.querySelectorAll('img:not([alt])').forEach((i) => r.push(`img без alt: ${i.getAttribute('src') || i.dataset.src}`));
    document.querySelectorAll('button, a[href]').forEach((b) => { const n = [b.innerText, b.textContent, b.getAttribute('aria-label'), b.title, b.querySelector('img[alt]')?.alt].map((v) => (v || '').trim()).find(Boolean); if (!n && b.offsetParent) r.push(`кнопка/посилання без назви: ${b.outerHTML.slice(0, 80)}`); });
    document.querySelectorAll('input:not([type=hidden]):not([type=range]), textarea, select').forEach((i) => { const ok = i.labels?.length || i.getAttribute('aria-label') || i.getAttribute('aria-labelledby'); if (!ok && i.offsetParent) r.push(`поле без підпису: ${i.name || i.type}`); });
    return r.slice(0, 20);
  });
  a11y.forEach((m) => add('warning', 'Доступність', tag, m));
  await ctx.close();
  return shots;
}

const summary = [];
for (const vp of VIEWPORTS) {
  const s = Date.now();
  const shots = await runViewport(vp);
  summary.push({ vp, shots });
  process.stdout.write(`✓ ${vp.name} ${vp.w}×${vp.h} — ${((Date.now() - s) / 1000).toFixed(0)}с\n`);
}
// режими: без анімацій і без JS
for (const [mode, vps] of [['reduced-motion', [VIEWPORTS.find((v) => v.w === 390) || VIEWPORTS[0], VIEWPORTS.find((v) => v.w === 1440) || VIEWPORTS.at(-1)]], ['no-js', [VIEWPORTS.find((v) => v.w === 390) || VIEWPORTS[0]]]]) {
  for (const vp of vps) { await runViewport(vp, mode); process.stdout.write(`✓ ${mode} ${vp.w}×${vp.h}\n`); }
}

// контактні аркуші для перегляду очима (збираємо в браузері — без бібліотек)
const sheetsDir = path.join(OUT, 'sheets'); fs.mkdirSync(sheetsDir, { recursive: true });
const sp = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const sheets = [];
for (const { vp, shots } of summary) {
  const cols = vp.w < 700 ? 8 : vp.w < 1100 ? 5 : 4, cw = Math.floor(1560 / cols);
  const html = `<html><body style="margin:0;background:#222;font:14px sans-serif;color:#fff"><div style="padding:8px 12px">${vp.name} — ${vp.w}×${vp.h}</div><div style="display:grid;grid-template-columns:repeat(${cols},${cw}px);gap:6px;padding:0 12px 12px">${shots.map((f, i) => `<div><img src="file://${f}" style="width:${cw}px;display:block"><div style="font-size:11px;opacity:.7">${path.basename(f)}</div></div>`).join('')}</div></body></html>`;
  const hf = path.join(sheetsDir, `${vp.w}x${vp.h}.html`); fs.writeFileSync(hf, html);
  await sp.goto('file://' + hf); await sp.waitForTimeout(300);
  const jf = path.join(sheetsDir, `${String(vp.w).padStart(4, '0')}x${vp.h}.jpg`);
  await sp.screenshot({ path: jf, fullPage: true, type: 'jpeg', quality: 70 }); sheets.push(jf); fs.unlinkSync(hf);
}
await browser.close(); srv?.close();

// звіт
const blockers = issues.filter((i) => i.level === 'blocker'), warnings = issues.filter((i) => i.level === 'warning');
const group = (list) => { const m = new Map(); for (const i of list) { const k = `${i.check}: ${i.msg}`; if (!m.has(k)) m.set(k, []); m.get(k).push(i.viewport); } return [...m.entries()]; };
const fmt = (list) => group(list).map(([k, v]) => `- ${k}\n  ↳ ${v.length > 6 ? v.slice(0, 6).join(', ') + ` … ще ${v.length - 6}` : v.join(', ')}`).join('\n');
const md = `# UI-QA: ${blockers.length ? '❌ НЕ ГОТОВО' : '✅ ГОТОВО ДО ДЕПЛОЮ'}

Сайт: ${target} · екранів: ${VIEWPORTS.length} + режими без анімацій і без JS · ${((Date.now() - t0) / 1000).toFixed(0)} с

## Блокери (${group(blockers).length})
${fmt(blockers) || '—'}

## Попередження (${group(warnings).length})
${fmt(warnings) || '—'}

## Аркуші для перегляду очима
${sheets.map((s) => `- ${s}`).join('\n')}
`;
fs.writeFileSync(path.join(OUT, 'report.md'), md);
fs.writeFileSync(path.join(OUT, 'issues.json'), JSON.stringify(issues, null, 1));
console.log('\n' + md.split('## Аркуші')[0]);
console.log(`Звіт: ${path.join(OUT, 'report.md')}`);
process.exit(blockers.length ? 1 : 0);
