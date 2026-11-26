#!/usr/bin/env node
// Проверка сайта перед сдачей: node qa.cjs <url | папка site/> [папка-отчёта]
//
// Открывает страницу в Chromium на 390, 768 и 1440 и проверяет то, что
// человек не заметит, пока клиент не наткнётся сам: ошибки в консоли,
// битые запросы, поперечную прокрутку, мёртвые ссылки и якоря, форму без
// подсказок, картинки без alt и тяжелее, чем нужно, скорость первого экрана
// на телефоне и доступность (axe-core, WCAG 2.2 AA).
//
// Папка вместо адреса — поднимает локальный сервер (как Vercel cleanUrls).
// Пишет report.md, report.json и снимки страницы целиком на трёх ширинах.
// Код выхода 1, если есть блокеры: ошибки консоли, 4xx/5xx, поперечная
// прокрутка, мёртвая ссылка, критичное нарушение доступности.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const AXE = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js';
const WIDTHS = [
  { name: 'mobile', width: 390, height: 844, mobile: true },
  { name: 'tablet', width: 768, height: 1024, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
];
// Шум, который к сайту отношения не имеет: пиксели, аналитика, расширения.
const NOISE = /facebook\.(net|com)\/tr|connect\.facebook|google-analytics|googletagmanager|doubleclick|clarity\.ms|hotjar|chrome-extension:/i;

const [, , target, outArg] = process.argv;
if (!target) {
  console.error('Использование: node qa.cjs <url | папка> [папка-отчёта]');
  process.exit(2);
}
const outDir = path.resolve(outArg || 'qa');
fs.mkdirSync(outDir, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json' };

function serve(dir) {
  const root = path.resolve(dir);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const clean = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const base = path.normalize(path.join(root, clean));
      if (!base.startsWith(root)) { res.writeHead(403).end(); return; }
      const candidates = [base, base + '.html', path.join(base, 'index.html')];
      const file = candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
      if (!file) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

async function checkUrl(url) {
  try {
    let r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (r.status === 405 || r.status === 403 || r.status === 400) {
      r = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15000) });
    }
    return r.status;
  } catch (e) {
    return 'нет ответа';
  }
}

async function perfMobile(browser, url) {
  // Медленный 4G и вчетверо слабее процессор — как средний телефон.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  let bytes = 0;
  page.on('response', async (r) => { try { const b = await r.body(); bytes += b.length; } catch {} });
  await page.addInitScript(() => {
    window.__lcp = 0; window.__cls = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 90000 }).catch(() => {});
  const load = Date.now() - t0;
  await page.waitForTimeout(2500);
  await page.mouse.wheel(0, 1200).catch(() => {});
  await page.waitForTimeout(1000);
  const m = await page.evaluate(() => ({ lcp: Math.round(window.__lcp), cls: Math.round(window.__cls * 1000) / 1000 }));
  await ctx.close();
  return { ...m, load, mb: Math.round(bytes / 1024 / 102.4) / 10 };
}

async function runWidth(browser, url, w) {
  const ctx = await browser.newContext({ viewport: { width: w.width, height: w.height }, deviceScaleFactor: 1, isMobile: w.mobile, hasTouch: w.mobile });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const failed = [];
  page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors.push(('JS: ' + e.message).slice(0, 200)));
  page.on('response', (r) => { if (r.status() >= 400 && !NOISE.test(r.url())) failed.push(`${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => { if (!NOISE.test(r.url()) && !/ERR_ABORTED/.test(r.failure()?.errorText || '')) failed.push(`${r.failure()?.errorText} ${r.url()}`); });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => page.goto(url, { waitUntil: 'load', timeout: 60000 }));
  // Проехать страницу до конца, чтобы ленивые картинки и анимации по скроллу отработали.
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += Math.round(innerHeight * 0.8)) {
      scrollTo(0, y); await new Promise((r) => setTimeout(r, 120));
    }
    scrollTo(0, 0);
  });
  await page.waitForTimeout(800);

  const layout = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const over = document.documentElement.scrollWidth - vw;
    const culprits = [];
    if (over > 1) {
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > vw + 1 && getComputedStyle(el).position !== 'fixed') {
          culprits.push((el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '')) + ` → ${Math.round(r.right)}px`);
          if (culprits.length >= 5) break;
        }
      }
    }
    const imgs = [...document.images];
    const noAlt = imgs.filter((i) => !i.hasAttribute('alt')).map((i) => i.currentSrc || i.src).slice(0, 10);
    const heavy = imgs.filter((i) => i.naturalWidth && i.clientWidth && i.naturalWidth > i.clientWidth * devicePixelRatio * 2.5 && i.naturalWidth > 1200)
      .map((i) => `${(i.currentSrc || i.src).split('/').pop()} ${i.naturalWidth}px при ${i.clientWidth}px`).slice(0, 10);
    const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src)).map((i) => i.currentSrc || i.src).slice(0, 10);
    // Мелкие нажимаемые цели — только на телефоне имеет смысл.
    const small = innerWidth < 600 ? [...document.querySelectorAll('a, button, [role=button], input, select')]
      .filter((el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && s.visibility !== 'hidden' && (r.width < 24 || r.height < 24) && el.offsetParent; })
      .map((el) => (el.innerText || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 30)).filter((v, i, a) => a.indexOf(v) === i).slice(0, 8) : [];
    return { overflow: Math.max(0, over), culprits, noAlt, heavy, broken, small };
  });

  const shot = path.join(outDir, `${w.name}-${w.width}.jpg`);
  await page.screenshot({ path: shot, fullPage: true, type: 'jpeg', quality: 60 }).catch(() => {});
  await ctx.close();
  return { width: w.width, consoleErrors: [...new Set(consoleErrors)], failed: [...new Set(failed)], ...layout, shot };
}

async function linksAndForms(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  const info = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.getAttribute('href'), abs: a.href, text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 40) }));
    const deadAnchors = links.filter((l) => l.href.startsWith('#') && l.href.length > 1 && !document.getElementById(decodeURIComponent(l.href.slice(1)))).map((l) => `${l.href} («${l.text}»)`);
    const emptyHref = links.filter((l) => l.href === '#' || l.href === '' || l.href.startsWith('javascript:')).map((l) => `«${l.text}»`);
    const wa = links.filter((l) => /wa\.me|whatsapp\.com/.test(l.abs)).map((l) => l.abs);
    const tel = links.filter((l) => l.abs.startsWith('tel:')).map((l) => l.abs);
    const external = [...new Set(links.map((l) => l.abs).filter((h) => /^https?:/.test(h) && !/wa\.me|whatsapp\.com/.test(h)))];
    const forms = [...document.querySelectorAll('form')].map((f, i) => ({
      i, fields: [...f.querySelectorAll('input:not([type=hidden]), select, textarea')].length,
      required: [...f.querySelectorAll('[required]')].length,
      unlabeled: [...f.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea')]
        .filter((el) => !(el.labels && el.labels.length) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')).map((el) => el.name || el.id || el.type),
    }));
    return { deadAnchors, emptyHref, wa, tel, external, forms };
  });

  // Пустая отправка каждой формы: страница должна подсказать, а не уйти или промолчать.
  for (const f of info.forms) {
    const before = page.url();
    const res = await page.evaluate((i) => {
      const form = document.querySelectorAll('form')[i];
      const ok = form.checkValidity();
      return { passesEmpty: ok };
    }, f.i);
    f.passesEmpty = res.passesEmpty;
    f.stayed = page.url() === before;
  }
  await ctx.close();

  const statuses = {};
  const queue = info.external.slice(0, 60);
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) { const u = queue.shift(); statuses[u] = await checkUrl(u); }
  }));
  // Соцсети часто отвечают 4xx роботам на живые страницы — их не считаем мёртвыми.
  const SOCIAL = /instagram\.com|facebook\.com|tiktok\.com|linkedin\.com|x\.com|twitter\.com|threads\.net|maps\.app\.goo\.gl|google\.[a-z.]+\/maps/;
  const dead = Object.entries(statuses).filter(([u, s]) => (s === 'нет ответа' || s >= 400) && !SOCIAL.test(u)).map(([u, s]) => `${s} ${u}`);
  const social = Object.entries(statuses).filter(([u, s]) => (s === 'нет ответа' || s >= 400) && SOCIAL.test(u)).map(([u, s]) => `${s} ${u}`);
  const badWa = info.wa.filter((u) => !/wa\.me\/\d{8,15}|phone=\d{8,15}/.test(u));
  return { ...info, dead, social, badWa, checked: Object.keys(statuses).length };
}

async function axe(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1500);
  try {
    await page.addScriptTag({ url: AXE });
    const r = await page.evaluate(async () => {
      const res = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
      return res.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, help: v.help, where: v.nodes.slice(0, 2).map((n) => n.target.join(' ')) }));
    });
    await ctx.close();
    return r;
  } catch (e) {
    await ctx.close();
    return { error: 'axe не загрузился: ' + e.message.slice(0, 120) };
  }
}

(async () => {
  let server = null;
  let url = target;
  if (!/^https?:\/\//.test(target)) {
    if (!fs.existsSync(target)) { console.error('Нет такой папки: ' + target); process.exit(2); }
    ({ server, url } = await serve(target));
  }
  const browser = await chromium.launch();
  const widths = [];
  for (const w of WIDTHS) widths.push(await runWidth(browser, url, w));
  const links = await linksAndForms(browser, url);
  const perf = await perfMobile(browser, url);
  const a11y = await axe(browser, url);
  await browser.close();
  if (server) server.close();

  const blockers = [];
  const fixes = [];
  // Одна и та же ошибка на нескольких ширинах — одна строка со списком ширин.
  const at = (pick) => widths.filter((w) => pick(w)).map((w) => w.width + 'px').join(', ');
  const per = [
    [(w) => w.consoleErrors.length, 'ошибки консоли'],
    [(w) => w.failed.length, 'битые запросы'],
    [(w) => w.broken.length, 'не загрузились картинки'],
  ];
  for (const [pick, label] of per) {
    const where = at(pick);
    if (where) blockers.push(`${label} (${Math.max(...widths.map(pick))}) — ${where}`);
  }
  for (const w of widths) if (w.overflow) blockers.push(`поперечная прокрутка на ${w.overflow}px — ${w.width}px`);
  if (links.dead.length) blockers.push(`мёртвые ссылки (${links.dead.length})`);
  if (links.deadAnchors.length) blockers.push(`якоря ведут в никуда (${links.deadAnchors.length})`);
  if (links.badWa.length) blockers.push('ссылка WhatsApp без номера');
  const a11yList = Array.isArray(a11y) ? a11y : [];
  const critical = a11yList.filter((v) => v.impact === 'critical');
  if (critical.length) blockers.push(`доступность: критичных нарушений ${critical.length}`);
  if (a11yList.length > critical.length) fixes.push(`доступность: ещё ${a11yList.length - critical.length} нарушений`);
  if (perf.lcp > 4000) blockers.push(`первый экран на телефоне ${perf.lcp} мс (норма до 2500)`);
  else if (perf.lcp > 2500) fixes.push(`первый экран на телефоне ${perf.lcp} мс (норма до 2500)`);
  if (perf.cls > 0.25) blockers.push(`вёрстка прыгает при загрузке: CLS ${perf.cls}`);
  else if (perf.cls > 0.1) fixes.push(`вёрстка прыгает при загрузке: CLS ${perf.cls} (норма до 0.1)`);
  if (perf.mb > 5) fixes.push(`страница весит ${perf.mb} МБ`);
  for (const f of links.forms) {
    if (f.passesEmpty && f.fields > 1) fixes.push(`форма ${f.i + 1} отправляется пустой — нет обязательных полей`);
    if (f.unlabeled.length) fixes.push(`форма ${f.i + 1}: поля без подписи (${f.unlabeled.join(', ')})`);
  }
  if (links.emptyHref.length) fixes.push(`кнопки-ссылки без адреса (${links.emptyHref.length})`);
  const noAlt = [...new Set(widths.flatMap((w) => w.noAlt))];
  if (noAlt.length) fixes.push(`картинки без alt (${noAlt.length})`);
  const heavy = [...new Set(widths.flatMap((w) => w.heavy))];
  if (heavy.length) fixes.push(`картинки тяжелее нужного (${heavy.length})`);
  const small = [...new Set(widths.filter((w) => w.width < 600).flatMap((w) => w.small))];
  if (small.length) fixes.push(`мелкие цели для пальца на телефоне (${small.length})`);

  const verdict = blockers.length ? 'НЕ СДАЁМ' : fixes.length ? 'СДАЁМ С ПРАВКАМИ' : 'СДАЁМ';
  const L = [];
  L.push(`# Проверка перед сдачей — ${target}`, '', `**Вердикт: ${verdict}** · блокеров ${blockers.length}, правок ${fixes.length}`, '');
  if (blockers.length) L.push('## Блокеры', ...blockers.map((b) => `- ${b}`), '');
  if (fixes.length) L.push('## Поправить', ...fixes.map((b) => `- ${b}`), '');
  L.push('## Скорость (телефон, медленный 4G, слабый процессор)',
    `- первый экран (LCP): ${perf.lcp} мс · прыжки вёрстки (CLS): ${perf.cls} · загрузка: ${perf.load} мс · вес: ${perf.mb} МБ`, '');
  L.push('## Ширины');
  for (const w of widths) {
    L.push(`### ${w.width}px`, `- консоль: ${w.consoleErrors.length ? w.consoleErrors.join(' | ') : 'чисто'}`,
      `- запросы: ${w.failed.length ? w.failed.slice(0, 8).join(' | ') : 'все целы'}`,
      `- поперечная прокрутка: ${w.overflow ? w.overflow + 'px, выпирают: ' + w.culprits.join('; ') : 'нет'}`,
      `- снимок: ${w.shot}`);
    if (w.small.length) L.push(`- мелкие цели: ${w.small.join(', ')}`);
  }
  L.push('', '## Ссылки и формы',
    `- внешних ссылок проверено: ${links.checked}; мёртвых: ${links.dead.length ? links.dead.join(' | ') : 'нет'}`,
    `- соцсети не ответили роботу (проверить руками): ${links.social.length ? links.social.join(' | ') : 'нет'}`,
    `- якоря в никуда: ${links.deadAnchors.length ? links.deadAnchors.join(', ') : 'нет'}`,
    `- WhatsApp: ${links.wa.length ? [...new Set(links.wa)].slice(0, 3).join(' | ') : 'ссылок нет'}${links.badWa.length ? ' ⚠️ без номера' : ''}`,
    `- телефон: ${links.tel.length ? [...new Set(links.tel)].join(', ') : 'ссылок нет'}`,
    `- формы: ${links.forms.length ? links.forms.map((f) => `№${f.i + 1}: полей ${f.fields}, обязательных ${f.required}, пустой ${f.passesEmpty ? 'проходит ⚠️' : 'не проходит ✓'}`).join('; ') : 'нет'}`);
  if (heavy.length) L.push(`- тяжёлые картинки: ${heavy.join('; ')}`);
  if (noAlt.length) L.push(`- без alt: ${noAlt.slice(0, 5).join('; ')}`);
  L.push('', '## Доступность (axe-core, WCAG 2.2 AA; автоматом ловится 30–40% проблем)');
  if (!Array.isArray(a11y)) L.push(`- ${a11y.error}`);
  else if (!a11y.length) L.push('- нарушений не найдено');
  else for (const v of a11y) L.push(`- [${v.impact}] ${v.id} ×${v.count}: ${v.help} — ${v.where.join(', ')}`);
  L.push('', 'Не проверено скриптом и остаётся глазами: текст и смысл, работа формы до конца (готовое сообщение в WhatsApp), анимации, переход клавиатурой.');

  const md = L.join('\n');
  fs.writeFileSync(path.join(outDir, 'report.md'), md);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ target, verdict, blockers, fixes, perf, widths, links, a11y }, null, 2));
  console.log(md);
  process.exit(blockers.length ? 1 : 0);
})().catch((e) => { console.error('Проверка упала: ' + e.message); process.exit(2); });
