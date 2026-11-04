// ==UserScript==
// @name         Mortal 恶手标注 (mjai.ekyu.moe)
// @namespace    local.mjai.blunder
// @version      2.0.0
// @description  在 mjai.ekyu.moe 牌谱检讨页标注"恶手"（π 低于阈值的手），显示恶手率与恶手清单
// @author       you
// @match        *://mjai.ekyu.moe/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * =====================================================================
 * 实现说明（完全独立，不依赖任何第三方脚本 / 扩展 / 服务）
 * ---------------------------------------------------------------------
 * mjai-reviewer 的服务端会把 Mortal 的完整决策表直接渲染进 HTML，
 * 每个决策点是一个 <details class="collapse entry">，内部有一张
 * <table class="data">，三列分别是：
 *     Action (a) | Q^π(s,a) | π_τ(a|s) × 100
 * 表格按 π 降序排列，第一行就是 Mortal 认为的最优动作。
 * 数值被拆成两个 <span>：<span class=int>85.</span><span class=frac>03146</span>，
 * 拼接后就是 85.03146（注意已经是 ×100 后的百分数）。
 *
 * 本脚本只做三件事：
 *   1. 遍历每个 entry，读出玩家实际动作（"玩家:" 后面那段）与整张决策表；
 *   2. 在表里找到玩家动作对应的 π 值；π < 阈值 即判为恶手；
 *   3. 在 entry 上打红色"恶手"标签、在元数据里写入恶手率、并生成清单浮窗。
 * 不拦截网络请求、不写死牌名映射、不引用任何外部库。
 * =====================================================================
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------
  // 配置
  // ---------------------------------------------------------------
  const STORAGE_KEY = 'mbl-threshold';
  const DEFAULT_THRESHOLD = 5.0; // 单位：百分比（表格里的 π 已 ×100）。社区约定 5% 以下为恶手。

  const HONOR = { e: '東', s: '南', w: '西', n: '北', p: '白', f: '發', c: '中' };

  // ---------------------------------------------------------------
  // 基础工具
  // ---------------------------------------------------------------
  function tileName(id) {
    if (!id) return '?';
    if (HONOR[id]) return HONOR[id];
    const m = /^([0-9])([mps])$/.exec(id);
    if (m) return (m[1] === '0' ? '赤5' : m[1]) + m[2];
    return id;
  }

  // 把一段 DOM 规范化成纯文本：牌图标 <svg class=tile><use href=#pai-7m> => "{7m}"
  function normText(el) {
    let s = '';
    (function walk(node) {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) {
          s += c.textContent;
        } else if (c.nodeType === 1) {
          const tag = (c.tagName || '').toLowerCase();
          if (tag === 'svg') {
            const u = c.querySelector('use');
            if (u) {
              const href = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
              s += '{' + href.replace('#pai-', '') + '}';
              continue;
            }
          }
          walk(c);
        }
      }
    })(el);
    return s.replace(/\s+/g, '');
  }

  // "{7m}{東}打" => "7m東打"
  function readable(s) {
    return s.replace(/\{([a-z0-9]+)\}/g, (_, id) => tileName(id));
  }

  // 读单元格里的 int+frac，得到完整数值
  function cellNumber(td) {
    if (!td) return null;
    const t = td.textContent.replace(/\s+/g, '');
    const v = parseFloat(t);
    return isNaN(v) ? null : v;
  }

  // ---------------------------------------------------------------
  // 解析单个 entry
  // ---------------------------------------------------------------
  function readEntry(entry) {
    const roles = entry.querySelectorAll('span.role');
    if (roles.length < 2) return null; // 玩家行 / Mortal 行

    // ---- 玩家实际动作 ----
    const clone = roles[0].parentElement.cloneNode(true);
    clone.querySelectorAll('span.role').forEach((n) => n.remove());
    const playerAct = normText(clone);

    // ---- 决策表 ----
    const table = entry.querySelector('table.data');
    if (!table) return null;

    const rows = [];
    for (const tr of table.querySelectorAll('tr')) {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 3) continue; // 跳过只有 <th> 的表头
      rows.push({
        act: normText(tds[0]),
        q: cellNumber(tds[1]),
        pi: cellNumber(tds[2]),
      });
    }
    if (!rows.length) return null;

    const sum = entry.querySelector('summary');
    const sumText = (sum ? sum.textContent : '').replace(/\s+/g, ' ').trim();

    return { entry, sum, sumText, playerAct, rows, best: rows[0] };
  }

  // ---------------------------------------------------------------
  // 应用标注
  // ---------------------------------------------------------------
  function apply(threshold) {
    const entries = document.querySelectorAll('details.collapse.entry');
    if (!entries.length) return;

    // 清理上一次的标注
    document.querySelectorAll('details.entry.mbl-blunder').forEach((e) => {
      e.classList.remove('mbl-blunder');
      const b = e.querySelector(':scope > summary > .mbl-badge');
      if (b) b.remove();
    });

    const blunders = [];
    let total = 0;

    for (const entry of entries) {
      const info = readEntry(entry);
      if (!info) continue;
      total++;

      const row = info.rows.find((r) => r.act === info.playerAct);
      const pi = row ? row.pi : null;

      if (pi !== null && pi < threshold) {
        info.entry.classList.add('mbl-blunder');
        if (info.sum) {
          const badge = document.createElement('span');
          badge.className = 'mbl-badge';
          badge.textContent = '恶手';
          info.sum.appendChild(badge);
        }
        blunders.push({
          entry: info.entry,
          turn: info.sumText,
          act: info.playerAct,
          pi,
          best: info.best,
        });
      }
    }

    const rate = total ? (blunders.length / total) * 100 : 0;
    updateMeta(blunders.length, total, rate);
    updatePanel(blunders, total, rate, threshold);
  }

  // ---------------------------------------------------------------
  // 元数据里写恶手率
  // ---------------------------------------------------------------
  let metaAdded = false;
  function updateMeta(count, total, rate) {
    if (metaAdded) return;
    let dl = null;
    for (const d of document.querySelectorAll('details.collapse')) {
      const s = d.querySelector(':scope > summary');
      if (s && /元数据/.test(s.textContent)) {
        dl = d.querySelector('dl');
        break;
      }
    }
    if (!dl) return;
    const dt = document.createElement('dt');
    dt.textContent = '恶手率';
    const dd = document.createElement('dd');
    dd.id = 'mbl-meta-rate';
    dl.appendChild(dt);
    dl.appendChild(dd);
    metaAdded = true;
    const target = document.getElementById('mbl-meta-rate');
    if (target) target.textContent = `${count} / ${total} = ${rate.toFixed(1)}%`;
  }

  // ---------------------------------------------------------------
  // 浮窗面板
  // ---------------------------------------------------------------
  let panel;

  function buildPanel() {
    if (panel) return;

    const box = document.createElement('div');
    box.id = 'mbl-panel';
    box.innerHTML = `
      <div id="mbl-panel-head">
        <span id="mbl-panel-title">恶手面板</span>
        <span id="mbl-panel-rate">-</span>
        <span id="mbl-panel-toggle" title="折叠/展开">▾</span>
      </div>
      <div id="mbl-panel-body">
        <div class="mbl-row">
          <label>阈值 π &lt;</label>
          <input id="mbl-threshold" type="number" step="0.5" min="0" max="100">
          <span>%</span>
          <button id="mbl-expand" title="展开全部恶手">展开全部</button>
        </div>
        <div id="mbl-list"></div>
      </div>`;

    document.body.appendChild(box);
    panel = box;

    box.querySelector('#mbl-panel-head').addEventListener('click', () => {
      box.classList.toggle('mbl-collapsed');
    });
    box.querySelector('#mbl-expand').addEventListener('click', (ev) => {
      ev.stopPropagation();
      panel.querySelectorAll('#mbl-list .mbl-item').forEach((it) => {
        const e = it._entry;
        if (e) e.open = true;
        if (e) e.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });

    const input = box.querySelector('#mbl-threshold');
    input.addEventListener('change', () => {
      let v = parseFloat(input.value);
      if (isNaN(v) || v < 0) v = DEFAULT_THRESHOLD;
      try { localStorage.setItem(STORAGE_KEY, String(v)); } catch (e) {}
      apply(v);
    });
  }

  function updatePanel(blunders, total, rate, threshold) {
    buildPanel();
    panel.style.display = '';
    panel.querySelector('#mbl-panel-rate').textContent = `${blunders.length} 手 (${rate.toFixed(1)}%)`;
    const input = panel.querySelector('#mbl-threshold');
    if (document.activeElement !== input) input.value = String(threshold);

    const list = panel.querySelector('#mbl-list');
    list.textContent = '';
    if (!blunders.length) {
      const d = document.createElement('div');
      d.className = 'mbl-empty';
      d.textContent = `没有 π < ${threshold}% 的恶手`;
      list.appendChild(d);
      return;
    }
    for (const b of blunders) {
      const item = document.createElement('div');
      item.className = 'mbl-item';
      item._entry = b.entry;

      const turn = document.createElement('div');
      turn.className = 'mbl-turn';
      turn.textContent = b.turn || '';

      const line = document.createElement('div');
      line.className = 'mbl-line';
      line.innerHTML =
        `<span class="mbl-act">${readable(b.act)}</span>` +
        `<span class="mbl-pi">π=${b.pi.toFixed(3)}%</span>` +
        `<span class="mbl-best">→ ${readable(b.best.act)} (π=${b.best.pi === null ? '?' : b.best.pi.toFixed(1)}%)</span>`;

      item.appendChild(turn);
      item.appendChild(line);

      item.addEventListener('click', () => {
        b.entry.open = true;
        b.entry.scrollIntoView({ behavior: 'smooth', block: 'center' });
        item.classList.add('mbl-flash');
        setTimeout(() => item.classList.remove('mbl-flash'), 800);
      });

      list.appendChild(item);
    }
  }

  // ---------------------------------------------------------------
  // 样式
  // ---------------------------------------------------------------
  function injectStyle() {
    const css = `
      .mbl-badge{display:inline-block;margin-left:6px;padding:0 6px;border-radius:3px;
        background:#d33;color:#fff;font-size:12px;line-height:18px;vertical-align:middle;font-weight:700;}
      details.entry.mbl-blunder{border-left:3px solid #d33;padding-left:6px;}
      #mbl-panel{position:fixed;top:10px;right:10px;width:340px;max-width:46vw;z-index:2147483000;
        font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
        background:#fff;color:#222;border:1px solid #c9c9c9;border-radius:8px;
        box-shadow:0 4px 18px rgba(0,0,0,.25);overflow:hidden;}
      #mbl-panel-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;
        background:#2b2b2b;color:#fff;user-select:none;}
      #mbl-panel-title{font-weight:700;flex:1;}
      #mbl-panel-rate{color:#ff9c9c;font-weight:700;}
      #mbl-panel-toggle{opacity:.8;}
      #mbl-panel.mbl-collapsed #mbl-panel-body{display:none;}
      #mbl-panel-body{padding:8px 10px;max-height:60vh;overflow:auto;}
      #mbl-panel .mbl-row{display:flex;align-items:center;gap:6px;margin-bottom:8px;
        padding-bottom:8px;border-bottom:1px solid #eee;}
      #mbl-panel .mbl-row label{color:#555;}
      #mbl-threshold{width:64px;padding:2px 4px;border:1px solid #bbb;border-radius:4px;}
      #mbl-expand{margin-left:auto;padding:3px 8px;border:1px solid #bbb;border-radius:4px;
        background:#f4f4f4;cursor:pointer;}
      #mbl-expand:hover{background:#e8e8e8;}
      #mbl-list{display:flex;flex-direction:column;gap:6px;}
      .mbl-item{padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;cursor:pointer;background:#fafafa;}
      .mbl-item:hover{background:#eef4ff;border-color:#9bc2ff;}
      .mbl-item.mbl-flash{background:#ffecec;border-color:#d33;}
      .mbl-turn{color:#888;font-size:12px;margin-bottom:2px;}
      .mbl-line{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;}
      .mbl-act{font-weight:700;color:#c22;}
      .mbl-pi{color:#c22;}
      .mbl-best{color:#0a7a3f;}
      .mbl-empty{color:#888;padding:6px 2px;}
    `;
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ---------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------
  function boot() {
    if (!document.querySelector('details.collapse.entry')) return; // 非检讨报告页
    injectStyle();
    let threshold = DEFAULT_THRESHOLD;
    try {
      const saved = parseFloat(localStorage.getItem(STORAGE_KEY));
      if (!isNaN(saved)) threshold = saved;
    } catch (e) {}
    apply(threshold);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();