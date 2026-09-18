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
  const { pageLevel, debug } = await page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const result = { pageLevel: '', debug: '' };

    // 方式一：DOM 中找包含"记录等级"的元素，取其右侧/后续兄弟的文本
    const els = [...document.querySelectorAll('*')];
    const label = els.find(e =>
      e.children.length === 0 && e.textContent.includes('记录等级'));
    if (label) {
      // 同层级右侧兄弟
      const sib = label.parentElement;
      let value = '';
      if (sib) {
        // 值可能就是父容器的其他子元素，或父容器整体文本去掉标签
        const sibText = clean(sib.textContent).replace('记录等级', '').trim();
        if (sibText && sibText.length <= 30) value = sibText;
        // 或父容器的下一个兄弟元素
        if (!value && sib.nextElementSibling) {
          value = clean(sib.nextElementSibling.textContent);
        }
      }
      if (value) result.pageLevel = value;
      result.debug += '[DOM] label outerHTML: ' + label.outerHTML.slice(0, 200) + '\n';
      result.debug += '[DOM] parent outerHTML: ' + (sib ? sib.outerHTML.slice(0, 400) : '(无)') + '\n';
    } else {
      result.debug += '[DOM] 未找到含"记录等级"的叶子元素\n';
    }

    // 方式二：兜底，整页文本中"记录等级"后面的一段（不依赖换行，取 60 字符窗口）
    if (!result.pageLevel) {
      const text = document.body.innerText || '';
      const i = text.indexOf('记录等级');
      if (i >= 0) {
        const after = text.slice(i + 4, i + 64); // "记录等级"后 60 字符
        result.debug += '[TEXT] 后续文本: ' + JSON.stringify(after) + '\n';
        const m = after.match(/^\s*[：:•\-]?\s*([^\s]{1,20})/);
        if (m) result.pageLevel = clean(m[1]);
      } else {
        result.debug += '[TEXT] 整页文本中无"记录等级"字样\n';
        result.debug += '[TEXT] 页面文本前 500 字符: ' + JSON.stringify(text.slice(0, 500)) + '\n';
      }
    }
    return result;
  });
  console.log('页面显示的段位: ' + (pageLevel || '（未识别）'));
  if (!pageLevel) console.log('---- 调试信息 ----\n' + debug);

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