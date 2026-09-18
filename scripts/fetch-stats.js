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
    locale: 'zh-CN', // 无头默认 en-US，页面会渲染英文界面导致中文标签匹配不到
    extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
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

  // 取页面"记录等级"标签右侧的文本（页面前端已渲染好段位名，无需自己映射）
  const { pageLevel, debug } = await page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const result = { pageLevel: '', debug: '' };

    // 找段位标签（兼容中英文界面）
    const labelRe = /^(记录等级|段位|等级|Rank|Level)$/i;
    const label = [...document.querySelectorAll('td,th,span,div,dt')].find(e =>
      !e.children.length && labelRe.test(clean(e.textContent)));

    if (label) {
      result.debug += '[DOM] 标签: <' + label.tagName + '> "' + clean(label.textContent) + '"\n';
      const row = label.closest('tr');
      if (row) {
        // 标签在表格里 → 取同行下一个单元格（值可能是文本或徽章图片）
        const cells = [...row.children];
        const cell = label.closest('td,th') || label;
        const next = cells[cells.indexOf(cell) + 1];
        if (next) {
          let v = clean(next.textContent);
          if (!v) {
            const img = next.querySelector('img');
            if (img) v = img.alt || img.title || '';
          }
          if (v) result.pageLevel = v;
        }
        result.debug += '[DOM] 行内容: ' + cells.map(c => clean(c.textContent)).join(' | ') + '\n';
      }
      // 不在表格里 → 取标签父元素的下一个兄弟元素
      if (!result.pageLevel && label.parentElement && label.parentElement.nextElementSibling) {
        result.pageLevel = clean(label.parentElement.nextElementSibling.textContent);
      }
    } else {
      result.debug += '[DOM] 未找到段位标签（记录等级/段位/等级/Rank/Level）\n';
    }

    // 兜底：整页文本匹配
    if (!result.pageLevel) {
      const text = document.body.innerText || '';
      const m = text.match(/(?:记录等级|段位|等级|Rank|Level)\s*[：:]?\s*([^\n\t]{1,20})/i);
      if (m) {
        result.pageLevel = clean(m[1]);
        result.debug += '[TEXT] 匹配到: ' + JSON.stringify(m[0]) + '\n';
      } else {
        result.debug += '[TEXT] 无匹配\n';
      }
    }

    // 调试：输出可能的段位徽章图片（段位若是纯图片无文本，从这里找线索）
    const imgs = [...document.querySelectorAll('img')].slice(0, 30)
      .map(i => ({ alt: i.alt || '', title: i.title || '', src: (i.src || '').split('/').pop() }))
      .filter(i => i.alt || i.title || /rank|level/i.test(i.src));
    if (imgs.length) result.debug += '[IMG] ' + JSON.stringify(imgs) + '\n';

    return result;
  });
  console.log('页面显示的段位: ' + (pageLevel || '（未识别）'));
  console.log('---- 调试信息 ----\n' + debug);

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