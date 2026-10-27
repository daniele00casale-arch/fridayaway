// GET /api/stats?key=...   Aggregated, anonymous usage of Fridayaway (only for the owner: needs STATS_KEY).
const { list } = require("@vercel/blob");
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const key = String((req.query && req.query.key) || "");
  if (!process.env.STATS_KEY || key !== process.env.STATS_KEY) return res.status(401).json({ error: "wrong key" });
  const blobs = []; let cursor;
  do { const r = await list({ prefix: "ev/", limit: 1000, cursor }); blobs.push(...r.blobs); cursor = r.hasMore ? r.cursor : undefined; } while (cursor);
  const recs = [];
  for (let i = 0; i < blobs.length; i += 25) {
    const part = await Promise.all(blobs.slice(i, i + 25).map((b) => fetch(b.url).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
    recs.push(...part.filter(Boolean));
  }
  const S = {};
  recs.forEach((r) => { const s = S[r.sid] || (S[r.sid] = { dev: r.dev, os: r.os, country: r.country, first: r.at, ev: [] }); s.first = Math.min(s.first, r.at); s.ev.push(...r.ev); });
  const sessions = Object.values(S);
  const inc = (o, k, n = 1) => { if (k === undefined || k === null || k === "") k = "?"; o[k] = (o[k] || 0) + n; };
  const out = { sessions: sessions.length, events: 0, byType: {}, byDay: {}, devices: {}, os: {}, countries: {}, origins: {}, budgets: {}, flyFilter: {},
    funnel: { opened: 0, searched: 0, swiped: 0, openedDetails: 0, pressedBook: 0, openedCheckout: 0 },
    cities: {}, checkouts: [], together: { games: 0, finished: 0, matches: 0 }, swipesPerSession: 0, installs: 0 };
  let swipeTotal = 0;
  sessions.forEach((s) => {
    inc(out.devices, s.dev); inc(out.os, s.os); inc(out.countries, s.country); inc(out.byDay, new Date(s.first).toISOString().slice(0, 10));
    const has = (t) => s.ev.some((e) => e.t === t);
    if (has("open")) out.funnel.opened++; if (has("search")) out.funnel.searched++; if (has("swipe")) out.funnel.swiped++;
    if (has("sheet")) out.funnel.openedDetails++; if (has("book")) out.funnel.pressedBook++; if (has("checkout")) out.funnel.openedCheckout++;
    s.ev.forEach((e) => {
      out.events++; inc(out.byType, e.t); const d = e.d || {};
      if (e.t === "search") { inc(out.origins, d.o); if (d.b) inc(out.budgets, d.b <= 500 ? "≤€500" : d.b <= 800 ? "€501–800" : d.b <= 1200 ? "€801–1200" : ">€1200"); else inc(out.budgets, "no limit"); }
      if (e.t === "fly_filter") inc(out.flyFilter, d.m ? d.m / 60 + "h" : "any");
      if (e.t === "swipe") { swipeTotal++; const c = out.cities[d.c] || (out.cities[d.c] = { saved: 0, skipped: 0, details: 0, book: 0, checkout: 0 }); d.like ? c.saved++ : c.skipped++; }
      if (["sheet", "book", "checkout"].includes(e.t) && d.c) { const c = out.cities[d.c] || (out.cities[d.c] = { saved: 0, skipped: 0, details: 0, book: 0, checkout: 0 }); c[e.t === "sheet" ? "details" : e.t]++; }
      if (e.t === "checkout") out.checkouts.push({ c: d.c, p: d.p, at: e.ts });
      if (e.t === "together_start") out.together.games++;
      if (e.t === "together_end") { out.together.finished++; out.together.matches += d.m || 0; }
      if (e.t === "install") out.installs++;
    });
  });
  out.swipesPerSession = sessions.length ? Math.round((swipeTotal / sessions.length) * 10) / 10 : 0;
  out.updated = Date.now();
  return res.status(200).json(out);
};
