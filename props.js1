// Vercel serverless function (CommonJS). Needs Node 18+ (global fetch).
// Env var needed: ODDS_API_KEY   (no stats key needed: game logs come from ESPN's unofficial public endpoints)
// Optional: BOOK (default "draftkings"), MAX_EVENTS (default 3), MAX_PLAYERS (default 12)
// Debug:  /api/props?debug=1            -> counts + why players were skipped
//         /api/props?probe=Jayson%20Tatum -> raw ESPN response shapes for one player

const ODDS = "https://api.the-odds-api.com/v4";
const ESPN = "https://site.web.api.espn.com/apis/common/v3";
const MARKETS = {
  player_points: ["Points", "PTS"],
  player_rebounds: ["Rebounds", "REB"],
  player_assists: ["Assists", "AST"],
  player_threes: ["3-Pointers", "3PT"],
};

const norm = (s) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ").trim();

// "LA Clippers" vs "Los Angeles Clippers": compare full name or last word (nickname)
const sameTeam = (a, b) => {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.split(" ").pop() === y.split(" ").pop();
};

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 EdgeBoard" } });
  if (!r.ok) throw new Error(r.status + " from " + url.split("?")[0]);
  return r.json();
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    })
  );
  return out;
}

// ---- ESPN helpers ----
async function findPlayer(name) {
  const s = await getJSON(
    `${ESPN}/search?query=${encodeURIComponent(name)}&limit=5&type=player&sport=basketball&league=nba`
  );
  const items = s.items || (s.results || []).flatMap((r) => r.contents || []);
  const hit = items.find((it) => norm(it.displayName || it.name || it.title) === norm(name));
  if (!hit) {
    const seen = items.slice(0, 3).map((it) => it.displayName || it.name || it.title).join(", ");
    return { error: "not found on ESPN (candidates: " + (seen || "none") + ")" };
  }
  const id = hit.id || ((String(hit.uid || "").match(/a:(\d+)/) || [])[1]);
  if (!id) return { error: "found on ESPN but no player id in search result" };
  const rel = hit.teamRelationships && hit.teamRelationships[0] && hit.teamRelationships[0].core;
  return { id: String(id), hit, team: rel ? { displayName: rel.displayName, abbreviation: rel.abbreviation || "" } : null };
}

async function findTeam(id) {
  const j = await getJSON(`${ESPN}/sports/basketball/nba/athletes/${id}`);
  const t = j.athlete && j.athlete.team;
  return t ? { displayName: t.displayName || t.name, abbreviation: t.abbreviation || "" } : null;
}

function parseGames(gl) {
  const labels = gl.labels || gl.names || [];
  const meta = gl.events || {};
  const col = (l) => labels.indexOf(l);
  const seen = new Set();
  const raw = [];
  for (const st of gl.seasonTypes || []) {
    if (/preseason/i.test(st.displayName || "")) continue;
    for (const cat of st.categories || []) {
      for (const ev of cat.events || []) {
        if (!ev || !ev.stats || seen.has(ev.eventId)) continue;
        seen.add(ev.eventId);
        const m = meta[ev.eventId] || {};
        raw.push({ id: ev.eventId, date: m.gameDate || "", stats: ev.stats });
      }
    }
  }
  const num = (g, label) => {
    const i = col(label);
    if (i < 0) return NaN;
    const s = g.stats[i];
    if (s == null) return NaN;
    return label === "3PT" ? Number(String(s).split("-")[0]) : Number(s);
  };
  return raw
    .map((g) => ({
      id: g.id,
      date: g.date,
      MIN: num(g, "MIN"),
      PTS: num(g, "PTS"),
      REB: num(g, "REB"),
      AST: num(g, "AST"),
      "3PT": num(g, "3PT"),
    }))
    .filter((g) => g.MIN > 0)
    .sort((a, b) => (a.date === b.date ? Number(a.id) - Number(b.id) : a.date < b.date ? -1 : 1)); // oldest -> newest
}

async function recentGames(id, seasonEnd) {
  let games = parseGames(await getJSON(`${ESPN}/sports/basketball/nba/athletes/${id}/gamelog`));
  if (games.length < 10) {
    try {
      const prev = parseGames(await getJSON(`${ESPN}/sports/basketball/nba/athletes/${id}/gamelog?season=${seasonEnd - 1}`));
      const ids = new Set(games.map((g) => g.id));
      games = prev.filter((g) => !ids.has(g.id)).concat(games);
    } catch (e) {
      // previous season unavailable, use what we have
    }
  }
  return games.slice(-10);
}

module.exports = async function handler(req, res) {
  try {
    const q = req.query || {};

    // Probe mode: show raw ESPN shapes for one player so parsing can be verified
    if (q.probe) {
      const name = String(q.probe);
      const out = {};
      const s = await getJSON(
        `${ESPN}/search?query=${encodeURIComponent(name)}&limit=5&type=player&sport=basketball&league=nba`
      );
      out.searchTopLevelKeys = Object.keys(s);
      const items = s.items || (s.results || []).flatMap((r) => r.contents || []);
      out.searchFirstItem = items[0] || null;
      const p = await findPlayer(name);
      out.player = p.error ? p : { id: p.id, teamFromSearch: p.team };
      if (p.id) {
        try { out.teamFromAthleteEndpoint = await findTeam(p.id); } catch (e) { out.teamError = String(e.message); }
        try {
          const gl = await getJSON(`${ESPN}/sports/basketball/nba/athletes/${p.id}/gamelog`);
          out.gamelogKeys = Object.keys(gl);
          out.labels = gl.labels || gl.names;
          const k = Object.keys(gl.events || {})[0];
          out.sampleEventMeta = k ? gl.events[k] : null;
          const st = (gl.seasonTypes || []).map((t) => ({
            displayName: t.displayName,
            categories: (t.categories || []).map((c) => ({ type: c.type, displayName: c.displayName, events: (c.events || []).length })),
          }));
          out.seasonTypes = st;
          const firstCat = ((gl.seasonTypes || [])[0] || {}).categories;
          out.sampleCategoryEvent = firstCat && firstCat[0] && firstCat[0].events ? firstCat[0].events[0] : null;
          out.parsedGameCount = parseGames(gl).length;
          out.parsedLast3 = parseGames(gl).slice(-3);
        } catch (e) { out.gamelogError = String(e.message); }
      }
      return res.status(200).json(out);
    }

    const oddsKey = process.env.ODDS_API_KEY;
    if (!oddsKey) return res.status(500).json({ error: "Missing ODDS_API_KEY" });
    const maxEvents = +process.env.MAX_EVENTS || 3;
    const maxPlayers = +process.env.MAX_PLAYERS || 12;
    const bookKey = process.env.BOOK || "draftkings";

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

    // 2) Look up each player on ESPN and pull recent game logs (a few at a time, to stay fast)
    const names = [...new Set(lines.map((l) => l.player))].slice(0, maxPlayers);
    const info = {};
    const skipped = [];
    const now = new Date();
    const seasonEnd = now.getMonth() >= 8 ? now.getFullYear() + 1 : now.getFullYear(); // ESPN names 2026-27 as 2027

    await pool(names, 4, async (name) => {
      try {
        const p = await findPlayer(name);
        if (p.error) return skipped.push(name + ": " + p.error);
        let team = p.team;
        if (!team) {
          try { team = await findTeam(p.id); } catch (e) { /* handled below */ }
        }
        if (!team) return skipped.push(name + ": couldn't determine team");
        const games = await recentGames(p.id, seasonEnd);
        if (games.length < 5) return skipped.push(name + ": only " + games.length + " usable games");
        info[name] = { team, games };
      } catch (e) {
        skipped.push(name + ": " + String(e.message || e));
      }
    });

    // 3) Build rows in the shape the page expects
    const rows = [];
    for (const l of lines) {
      const i = info[l.player];
      if (!i) continue;
      const [label, field] = MARKETS[l.market];
      let opp;
      if (sameTeam(i.team.displayName, l.home)) opp = l.away;
      else if (sameTeam(i.team.displayName, l.away)) opp = l.home;
      else continue; // player's team doesn't match this game, skip
      const values = i.games.map((g) => g[field]);
      if (values.some((v) => !Number.isFinite(v))) {
        skipped.push(l.player + ": missing " + label + " values");
        continue;
      }
      const m = i.games.map((g) => g.MIN);
      const role = Math.min(1.15, Math.max(0.85, avg(m.slice(-3)) / avg(m)));
      // context: [opportunity, pace, matchup, injury boost, status]
      // Only the minutes trend is real here; the rest stay neutral until you add feeds.
      rows.push(["NBA", l.player, i.team.abbreviation || norm(i.team.displayName).split(" ").pop().slice(0, 3).toUpperCase(), opp, label, l.line, values, [role, 1, 1, 1, "Healthy"]]);
    }

    if (q.debug) {
      return res.status(200).json({ events: events.length, lines: lines.length, players: names.length, withStats: Object.keys(info).length, rows: rows.length, skipped });
    }
    if (!rows.length) {
      const why = !events.length
        ? "No upcoming NBA games returned by the odds API."
        : !lines.length
        ? "Games found, but no player prop lines (props may not be posted yet, or your odds plan excludes them)."
        : "Found " + lines.length + " lines but no usable player stats. First problems: " + skipped.slice(0, 3).join(" | ");
      return res.status(500).json({ error: why });
    }

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    res.status(200).json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
