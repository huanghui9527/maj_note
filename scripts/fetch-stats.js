// 抓取牌谱屋（amae-koromo）玩家段位与分数
// 牌谱屋 API 有 WASM 工作量证明反爬，无法直接请求；
// 用 Playwright 真实加载页面（浏览器自动通过验证），拦截 API 响应提取数据。
const { chromium } = require('playwright');
const fs = require('fs');

// 目标玩家页面（mode 12 = 三人南）
const PLAYER_URL = 'https://amae-koromo.sapk.ch/player/17417542/12';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const captured = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/player_(stats|extend)/.test(url)) return;
    try {
      const body = await resp.json();
      captured.push({ url, body });
    } catch (e) {
      console.log('忽略非 JSON 响应: ' + url);
    }
  });

  console.log('打开页面: ' + PLAYER_URL);
  await page.goto(PLAYER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 等待反爬验证通过、数据渲染完成
  try {
    await page.waitForSelector('table', { timeout: 60000 });
  } catch (e) {
    console.log('等待表格渲染超时，尝试用已捕获的数据继续');
  }
  await page.waitForTimeout(5000); // 等剩余 API 响应到齐

  // 直接取页面"记录等级"右侧的文本（页面前端已渲染好段位名，无需自己映射）
  const pageLevel = await page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, '');
    // 方式一：在 DOM 中找"记录等级"标签，取同行右侧单元格的文本
    const els = [...document.querySelectorAll('td, th, span, div')];
    const label = els.find(e => !e.children.length && clean(e.textContent) === '记录等级');
    if (label) {
      const row = label.closest('tr') || label.parentElement;
      const cells = [...row.children];
      const value = cells.slice(cells.indexOf(label) + 1)
        .map(c => clean(c.textContent)).filter(Boolean).join(' ');
      if (value) return value;
    }
    // 方式二：兜底，从整页文本中匹配"记录等级"后面的内容
    const m = (document.body.innerText || '').match(/记录等级[：:\s]*([^\n]+)/);
    return m ? clean(m[1]) : '';
  });
  console.log('页面显示的段位: ' + (pageLevel || '（未识别）'));

  await browser.close();

  console.log('捕获到的响应 URL:');
  for (const c of captured) console.log('  ' + c.url);

  const extend = captured.filter((c) => /player_extend/.test(c.url)).pop();
  const statsList = captured.filter(
    (c) => /player_stats/.test(c.url) && c.body && c.body.level && c.body.level.id != null
  );
  // 多个 stats 时优先选当前页面模式（12 = 三人南）的，否则取最后一个
  const stats =
    statsList.find((c) => /mode=12\b|mode=12\./.test(c.url)) || statsList.pop();

  if (!stats) {
    console.error('未捕获到 player_stats 数据（可能反爬验证未通过或页面结构变化）');
    process.exit(1);
  }

  const { score } = stats.body.level;
  const out = {
    name: (extend && extend.body && extend.body.nickname) || '',
    level: pageLevel, // 页面直接显示的段位原文
    score: String(score),
    updated: new Date().toISOString(),
  };

  fs.writeFileSync('stats.json', JSON.stringify(out, null, 2) + '\n');
  console.log('已写入 stats.json:');
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});