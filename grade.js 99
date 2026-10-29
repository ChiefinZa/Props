// Vercel serverless function (CommonJS). Grades tracked picks using ESPN game logs. No key needed.
// POST /api/grade   body: { picks: [{ id, player, stat, line, side, start }] }
//   stat: "Points" | "Rebounds" | "Assists" | "3-Pointers"     side: "Over" | "Under"     start: ISO game start time
// Returns { results: [{ id, status: "hit" | "miss" | "push" | "void" | "pending", actual }] }
//   pending = game not finished (or log not available yet); void = game long over but the player has no log (did not play)

const ESPN = "https://site.web.api.espn.com/apis/common/v3";
const FIELD = { Points: "PTS", Rebounds: "REB", Assists: "AST", "3-Pointers": "3PT" };
const HOURS = 3600e3;

const norm = (s) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ").trim();

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 EdgeBoard" } });
  if (!r.ok) throw new Error(r.status + " from " + url.split("?")[0]);
  return r.json();
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        await fn(items[k]);
      }
    })
  );
}

async function findPlayerId(name) {
  const s = await getJSON(
    `${ESPN}/search?query=${encodeURIComponent(name)}&limit=5&type=player&sport=basketball&league=nba`
  );
  const items = s.items || (s.results || []).flatMap((r) => r.contents || []);
  const hit = items.find((it) => norm(it.displayName || it.name || it.title) === norm(name));
  if (!hit) throw new Error("not found on ESPN");
  const id = hit.id || ((String(hit.uid || "").match(/a:(\d+)/) || [])[1]);
  if (!id) throw new Error("no player id");
  return String(id);
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
    .map((g) => ({ id: g.id, date: g.date, MIN: num(g, "MIN"), PTS: num(g, "PTS"), REB: num(g, "REB"), AST: num(g, "AST"), "3PT": num(g, "3PT") }))
    .filter((g) => g.MIN > 0);
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Send a POST with a JSON body: { picks: [...] }" });
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { body = null; }
    }
    const picks = body && Array.isArray(body.picks) ? body.picks : null;
    if (!picks || !picks.length) return res.status(400).json({ error: "No picks provided" });
    if (picks.length > 200) return res.status(400).json({ error: "Too many picks (max 200 per request)" });

    const byPlayer = {};
    for (const p of picks) {
      const ok = p && p.id && p.player && FIELD[p.stat] && Number.isFinite(+p.line) && (p.side === "Over" || p.side === "Under") && Number.isFinite(Date.parse(p.start));
      if (!ok) continue;
      (byPlayer[p.player] = byPlayer[p.player] || []).push(p);
    }

    const now = Date.now();
    const results = [];
    await pool(Object.keys(byPlayer), 6, async (name) => {
      const list = byPlayer[name];
      const pending = (p) => results.push({ id: p.id, status: "pending", actual: null });
      const due = list.filter((p) => now >= Date.parse(p.start) + 4 * HOURS);
      list.filter((p) => !due.includes(p)).forEach(pending); // games not finished yet: no lookup needed
      if (!due.length) return;

      let games = null;
      try {
        const id = await findPlayerId(name);
        games = parseGames(await getJSON(`${ESPN}/sports/basketball/nba/athletes/${id}/gamelog`));
      } catch (e) {
        due.forEach(pending); // lookup failed: try again later instead of guessing
        return;
      }
      for (const p of due) {
        const start = Date.parse(p.start);
        const g = games.find((x) => Math.abs(Date.parse(x.date) - start) < 8 * HOURS);
        if (g) {
          const v = g[FIELD[p.stat]];
          if (!Number.isFinite(v)) { pending(p); continue; }
          const line = +p.line;
          const status = v === line ? "push" : (p.side === "Over" ? v > line : v < line) ? "hit" : "miss";
          results.push({ id: p.id, status, actual: v });
        } else if (now > start + 30 * HOURS) {
          results.push({ id: p.id, status: "void", actual: null }); // game long over, no log: did not play
        } else {
          pending(p); // ESPN may not have posted the log yet
        }
      }
    });

    res.status(200).json({ results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
