// 抓取 M-League 前一日（日本时间）队伍及个人得分情况
// 数据源：M-League 官网数据接口（底层为麻雀王国API，无需鉴权、无反爬）
//   https://m-league.jp/api/mleague/data?kind=games    全季赛程与逐场结果（含每位选手素点pt与顺位）
//   https://m-league.jp/api/mleague/data?kind=ranking  最新队伍/个人总排名
// 有比赛时统计当日结果，写入 mleague.json 供页面展示；无比赛时 hasGames=false。
const fs = require('fs');

const API = 'https://m-league.jp/api/mleague/data?kind=';
const JST = 9 * 3600 * 1000; // 日本时间 UTC+9

// API 日期转日本时间日期（如 2026-11-23T15:00Z => 2026-11-24 JST）
const jstDate = (iso) => new Date(new Date(iso).getTime() + JST).toISOString().slice(0, 10);

const round1 = (n) => Math.round(n * 10) / 10;

async function getJSON(kind) {
  const res = await fetch(API + kind, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`kind=${kind} HTTP ${res.status}`);
  const j = await res.json();
  if (j.stale) throw new Error(`kind=${kind} 数据暂不可用`);
  return j;
}

// ---------- 麻雀ウォッチ（mj-news.net）逐把明细 ----------
// 每场比赛的スタッツ页（https://mj-news.net/mleague/games/日期-a1 等）含：
//   内嵌 JSON：四人座位顺序与每局结束持点（相邻差值即该把得点失点）
//   <li> 明细：每把和了者/ツモ・ロン/点数/役/符翻，或流局与テンパイ名单
const MJW = { headers: { 'User-Agent': 'Mozilla/5.0' } };
const stripTags = (h) => h.replace(/<[^>]+>/g, ' ').trim();
const normName = (s) => s.replace(/\s+/g, '');

// 从月度日程页找指定日期所有比赛的スタッツ页链接
async function mjStatsLinks(date) {
  const html = await fetch(`https://mj-news.net/mleague/schedule/${date.slice(0, 7)}`, MJW).then((r) => r.text());
  const out = [];
  for (const m of html.matchAll(/href="(https:\/\/mj-news\.net\/mleague\/games\/(\d{4}-\d{2}-\d{2})-[ab]\d)"/g)) {
    if (m[2] === date && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// 解析一场比赛的逐把数据
function parseMJStats(html) {
  const pm =
    html.match(/<div class="progwrap">[\s\S]*?<script type=['"]application\/json['"]>([\s\S]*?)<\/script>/) ||
    html.match(/<script type=['"]application\/json['"]>([\s\S]*?)<\/script>/);
  if (!pm) return null;
  const prog = JSON.parse(pm[1]);
  const seats = prog.teams.map((t) => t[0]); // 東南西北座位顺序
  const hands = [];
  for (let k = 1; k < prog.v.length; k++) {
    hands.push({ kyoku: prog.dates[k] || `#${k}`, delta: prog.v[k].map((x, i) => x - prog.v[k - 1][i]) });
  }

  // 逐把明细（和了/流局），按局名归组（ダブロン时同一局有多条）
  const byKyoku = {};
  for (const lm of html.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const seg = lm[1];
    const hl = seg.match(/class="hl">([^<]+)</);
    if (!hl) continue;
    const ev = {};
    const winner = seg.match(/<b>([^<]+)<\/b>/);
    const hend = (seg.match(/class="hend[^"]*">([^<]+)</) || [])[1];
    if (winner) {
      ev.winner = winner[1];
      ev.type = hend || '';
      const hpt = seg.match(/class="hpt">([^<]+)</);
      if (hpt) ev.points = parseInt(hpt[1].replace(/,/g, ''), 10);
      const hy = seg.match(/class="hy">([\s\S]*?)<\/small>/);
      if (hy) {
        const yaku = [...hy[1].matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);
        if (yaku.length) ev.yaku = yaku.join('・');
        const hf = hy[1].match(/class="hf">([^<]+)</);
        if (hf) ev.fu = hf[1];
      }
    } else {
      ev.type = hend || '流局';
      const htp = seg.match(/class="htp">([^<]+)</);
      if (htp) ev.tenpai = htp[1].replace(/^テンパイ\s*/, '');
    }
    (byKyoku[hl[1]] ||= []).push(ev);
  }
  for (const h of hands) if (byKyoku[h.kyoku]) h.events = byKyoku[h.kyoku];

  // 个人统计（和了/放銃/リーチ/副露/最高打点）
  let playerStats;
  try {
    const i = html.indexOf('アガリ');
    const start = i > 0 ? html.lastIndexOf('<table', i) : -1;
    const end = i > 0 ? html.indexOf('</table>', i) : -1;
    if (start >= 0 && end > i) {
      const rows = [];
      for (const rm of html.slice(start, end).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
        const nm = rm[1].match(/class="pname"[^>]*>([^<]+)</);
        if (!nm) continue;
        const cells = [...rm[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => stripTags(x[1]));
        const nums = cells.filter((c) => /^[0-9,]+$|^[-—]+$/.test(c));
        const seat = cells.find((c) => /^[東南西北]$/.test(c));
        rows.push({ name: nm[1], seat, agari: nums[0], houjuu: nums[1], riichi: nums[2], furu: nums[3], max: nums[4] });
      }
      if (rows.length === 4) playerStats = rows;
    }
  } catch (e) {}

  return {
    nameKey: seats.map(normName).sort().join('|'),
    seats,
    hands,
    playerStats,
  };
}

// 为官方当日比赛匹配逐把明细（按四位选手姓名集合匹配）
async function attachPerHand(games, date) {
  let links;
  try {
    links = await mjStatsLinks(date);
  } catch (e) {
    console.log(`mj-news 日程页获取失败：${e.message}（跳过逐把明细）`);
    return;
  }
  const parsed = [];
  for (const url of links) {
    try {
      const html = await fetch(url, MJW).then((r) => r.text());
      const st = parseMJStats(html);
      if (st) parsed.push({ url, ...st });
    } catch (e) {
      console.log(`mj-news スタッツ页获取失败 ${url}：${e.message}`);
    }
  }
  let matched = 0;
  for (const g of games) {
    const key = (g.players || []).map((p) => normName(p.name)).sort().join('|');
    const hit = parsed.find((s) => s.nameKey === key);
    if (hit) {
      Object.assign(g, { statsUrl: hit.url, seats: hit.seats, hands: hit.hands, playerStats: hit.playerStats });
      matched++;
    }
  }
  return matched;
}

(async () => {
  const games = await getJSON('games');
  const ranking = await getJSON('ranking');

  // 日本时间的“昨天”
  const yesterday = new Date(Date.now() + JST - 86400000).toISOString().slice(0, 10);
  const dayGames = (games.games || [])
    .filter((g) => g.complete && g.date && jstDate(g.date) === yesterday)
    .sort((a, b) => (a.desk - b.desk) || (a.no - b.no)); // 先按卓位再按局次

  // 当日各队得分汇总
  const teams = {};
  for (const g of dayGames) {
    for (const p of g.players || []) {
      const t = (teams[p.team] ||= { team: p.team, img: p.teamImage || '', points: 0, games: 0, tops: 0, lasts: 0 });
      t.points += p.point;
      t.games += 1;
      if (p.rank === 1) t.tops += 1;
      if (p.rank === 4) t.lasts += 1;
    }
  }
  const teamDay = Object.values(teams)
    .map((t) => ({ ...t, points: round1(t.points) }))
    .sort((a, b) => b.points - a.points);

  // 逐把明细（麻雀ウォッチ，失败时自动跳过，不影响主数据）
  const matched = (await attachPerHand(dayGames, yesterday)) || 0;
  if (matched) console.log(`已匹配 ${matched} 场逐把明细`);

  // 当日个人最佳（单局最高得分）
  const allPlayers = dayGames.flatMap((g) =>
    (g.players || []).map((p) => ({ ...p, desk: g.desk, no: g.no }))
  );
  const mvp = allPlayers.slice().sort((a, b) => b.point - a.point)[0] || null;

  // 最新总排名（groups 里第一组为个人スコア排名）
  const r = ranking.ranking || {};
  const scoreGroup = (r.groups || []).find((g) => /個人スコア/.test(g.name)) || (r.groups || [])[0];

  const out = {
    fetchedAt: new Date().toISOString(),
    date: yesterday, // 日本时间
    hasGames: dayGames.length > 0,
    gamesCount: dayGames.length,
    games: dayGames.map((g) => ({
      id: g.id,
      desk: g.desk, // 0=A卓 1=B卓
      no: g.no, // 当日第几局
      players: (g.players || [])
        .slice()
        .sort((a, b) => a.rank - b.rank)
        .map((p) => ({ rank: p.rank, name: p.name, team: p.team, img: p.teamImage || '', point: round1(p.point) })),
      ...(g.hands ? { statsUrl: g.statsUrl, seats: g.seats, hands: g.hands, playerStats: g.playerStats } : {}),
    })),
    teamDay,
    dayMVP: mvp && { name: mvp.name, team: mvp.team, img: mvp.teamImage || '', point: round1(mvp.point) },
    standings: {
      teams: (r.teams || []).map((t) => ({ rank: t.rank, name: t.name, img: t.image || '', points: t.points, games: t.games })),
      players: ((scoreGroup && scoreGroup.rows) || []).map((p) => ({ rank: p.rank, name: p.name, points: p.value })),
    },
  };

  fs.writeFileSync('mleague.json', JSON.stringify(out, null, 2) + '\n');
  console.log(`日本时间 ${yesterday}：${dayGames.length} 场比赛`);
  if (out.hasGames) {
    console.log('当日队伍得分:');
    for (const t of teamDay) console.log(`  ${t.team} ${t.points > 0 ? '+' : ''}${t.points}（${t.tops}着/${t.lasts}着）`);
    if (out.dayMVP) console.log(`当日最佳: ${out.dayMVP.name}（${out.dayMVP.team}）${out.dayMVP.point > 0 ? '+' : ''}${out.dayMVP.point}`);
  }
  console.log('已写入 mleague.json');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});