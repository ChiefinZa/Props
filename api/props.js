// Vercel serverless function (CommonJS). Needs Node 18+ (global fetch).
// Env vars: ODDS_API_KEY, BALLDONTLIE_KEY
// Optional: BOOK (default "draftkings"), MAX_EVENTS (default 3), MAX_PLAYERS (default 12), DELAY_MS (default 1200)

const ODDS = "https://api.the-odds-api.com/v4";
const BDL = "https://api.balldontlie.io/v1";
const MARKETS = {
  player_points: ["Points", "pts"],
  player_rebounds: ["Rebounds", "reb"],
  player_assists: ["Assists", "ast"],
  player_threes: ["3-Pointers", "fg3m"],
};

const norm = (s) =>
  String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z ]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ").trim();

const mins = (m) => {
  if (!m) return 0;
  const [a, b] = String(m).split(":");
  return (+a || 0) + (+b || 0) / 60;
};

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(r.status + " from " + url.split("?")[0]);
  return r.json();
}

module.exports = async function handler(req, res) {
  try {
    const oddsKey = process.env.ODDS_API_KEY;
    const bdlKey = process.env.BALLDONTLIE_KEY;
    if (!oddsKey || !bdlKey) {
      return res.status(500).json({ error: "Missing ODDS_API_KEY or BALLDONTLIE_KEY" });
    }
    const maxEvents = +process.env.MAX_EVENTS || 3;
    const maxPlayers = +process.env.MAX_PLAYERS || 12;
    const delay = +process.env.DELAY_MS || 1200;
    const bookKey = process.env.BOOK || "draftkings";
    const auth = { Authorization: bdlKey };

    // 1) Upcoming games, then prop lines for each
    const events = (await getJSON(`${ODDS}/sports/basketball_nba/events?apiKey=${oddsKey}`)).slice(0, maxEvents);
    const lines = [];
    for (const ev of events) {
      const d = await getJSON(
        `${ODDS}/sports/basketball_nba/events/${ev.id}/odds?apiKey=${oddsKey}&regions=us&markets=${Object.keys(MARKETS).join(",")}&oddsFormat=american`
      );
      const books = d.bookmakers || [];
      const book = books.find((b) => b.key === bookKey) || books[0];
      if (!book) continue;
      for (const m of book.markets || []) {
        const seen = new Set();
        for (const o of m.outcomes || []) {
          if (o.name !== "Over" || o.point == null || seen.has(o.description)) continue;
          seen.add(o.description);
          lines.push({ player: o.description, market: m.key, line: o.point, home: ev.home_team, away: ev.away_team });
        }
      }
    }

    // 2) Look up each player once, pull recent game logs
    const names = [...new Set(lines.map((l) => l.player))].slice(0, maxPlayers);
    const info = {};
    const now = new Date();
    const season = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;

    for (const name of names) {
      try {
        const last = encodeURIComponent(name.split(" ").slice(-1)[0]);
        const found = await getJSON(`${BDL}/players?search=${last}&per_page=25`, auth);
        const p = (found.data || []).find((x) => norm(`${x.first_name} ${x.last_name}`) === norm(name));
        if (!p || !p.team) continue;
        await sleep(delay);
        const st = await getJSON(
          `${BDL}/stats?player_ids[]=${p.id}&seasons[]=${season}&seasons[]=${season - 1}&per_page=100`,
          auth
        );
        const games = (st.data || [])
          .filter((g) => g.game && mins(g.min) > 0)
          .sort((a, b) => (a.game.date < b.game.date ? 1 : -1))
          .slice(0, 10)
          .reverse(); // oldest -> newest
        if (games.length >= 5) info[name] = { team: p.team, games };
        await sleep(delay);
      } catch (e) {
        // skip this player, keep going
      }
    }

    // 3) Build rows in the shape the page expects
    const rows = [];
    for (const l of lines) {
      const i = info[l.player];
      if (!i) continue;
      const [label, field] = MARKETS[l.market];
      let opp;
      if (i.team.full_name === l.home) opp = l.away;
      else if (i.team.full_name === l.away) opp = l.home;
      else continue; // player's team doesn't match this game, skip
      const values = i.games.map((g) => Number(g[field]) || 0);
      const m = i.games.map((g) => mins(g.min));
      const role = Math.min(1.15, Math.max(0.85, avg(m.slice(-3)) / avg(m)));
      // context: [opportunity, pace, matchup, injury boost, status]
      // Only minutes trend is real here; the rest default to neutral until you add feeds.
      rows.push(["NBA", l.player, i.team.abbreviation, opp, label, l.line, values, [role, 1, 1, 1, "Healthy"]]);
    }

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    res.status(200).json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
