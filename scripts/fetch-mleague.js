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
      const t = (teams[p.team] ||= { team: p.team, points: 0, games: 0, tops: 0, lasts: 0 });
      t.points += p.point;
      t.games += 1;
      if (p.rank === 1) t.tops += 1;
      if (p.rank === 4) t.lasts += 1;
    }
  }
  const teamDay = Object.values(teams)
    .map((t) => ({ ...t, points: round1(t.points) }))
    .sort((a, b) => b.points - a.points);

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
        .map((p) => ({ rank: p.rank, name: p.name, team: p.team, point: round1(p.point) })),
    })),
    teamDay,
    dayMVP: mvp && { name: mvp.name, team: mvp.team, point: round1(mvp.point) },
    standings: {
      teams: (r.teams || []).map((t) => ({ rank: t.rank, name: t.name, points: t.points, games: t.games })),
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