// GET /api/stats?key=...   Aggregated, anonymous usage of Fridayaway (only for the owner: needs STATS_KEY).
const { list, put } = require("@vercel/blob");
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const key = String((req.query && req.query.key) || "");
  if (!process.env.STATS_KEY || key !== process.env.STATS_KEY) return res.status(401).json({ error: "wrong key" });
  // Read events fast: past days are merged once into one summary file each (agg/DAY.json), only today is read file by file
  if (req.query && req.query.subs) { // Thursday alert sign-ups (latest record per email)
    const sb = []; let c; do { const r = await list({ prefix: "subs/", limit: 1000, cursor: c }); sb.push(...r.blobs); c = r.hasMore ? r.cursor : undefined; } while (c);
    const recs = (await Promise.all(sb.map((b) => fetch(b.url).then((r) => (r.ok ? r.json() : null)).catch(() => null)))).filter(Boolean);
    const by = {}; recs.forEach((r) => { if (!by[r.email] || r.at > by[r.email].at) by[r.email] = r; });
    return res.status(200).json({ count: Object.keys(by).length, subscribers: Object.values(by).sort((a, b) => b.at - a.at) });
  }
  const blobs = []; let cursor;
  do { const r = await list({ prefix: "ev/", limit: 1000, cursor }); blobs.push(...r.blobs); cursor = r.hasMore ? r.cursor : undefined; } while (cursor);
  const aggs = {}; cursor = undefined;
  do { const r = await list({ prefix: "agg/", limit: 1000, cursor }); r.blobs.forEach((b) => { const m = /^agg\/(\d{4}-\d{2}-\d{2})/.exec(b.pathname); if (m && (!aggs[m[1]] || b.uploadedAt > aggs[m[1]].uploadedAt)) aggs[m[1]] = b; }); cursor = r.hasMore ? r.cursor : undefined; } while (cursor);
  const byDay = {};
  blobs.forEach((b) => { const m = /^ev\/(\d{4}-\d{2}-\d{2})\//.exec(b.pathname); const d = m ? m[1] : "other"; (byDay[d] = byDay[d] || []).push(b); });
  const getJSON = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const readAll = async (list) => { const out = []; for (let i = 0; i < list.length; i += 100) { const part = await Promise.all(list.slice(i, i + 100).map((b) => getJSON(b.url))); out.push(...part.filter(Boolean)); } return out; };
  const today = new Date().toISOString().slice(0, 10);
  const recs = [];
  await Promise.all(Object.entries(byDay).map(async ([day, list]) => {
    if (day < today && aggs[day]) { const a = await getJSON(aggs[day].url); if (a && a.count === list.length && Array.isArray(a.recs)) { recs.push(...a.recs); return; } }
    const r = await readAll(list); recs.push(...r);
    if (day < today && day !== "other") { try { await put(`agg/${day}.json`, JSON.stringify({ count: list.length, recs: r }), { access: "public", addRandomSuffix: true, contentType: "application/json" }); } catch (e) {} }
  }));
  const S = {};
  const EXCL = new Set(String(process.env.STATS_EXCLUDE || "").split(",").map((x) => x.trim()).filter(Boolean));
  recs.filter((r) => !String(r.sid).startsWith("selftest") && !EXCL.has(r.sid) && !(r.uid && EXCL.has(r.uid))).forEach((r) => { const s = S[r.sid] || (S[r.sid] = { sid: r.sid, uid: r.uid || "", dev: r.dev, os: r.os, country: r.country, first: r.at, ev: [] }); s.first = Math.min(s.first, r.at); if (r.uid) s.uid = r.uid; s.ev.push(...r.ev); });
  const sessions = Object.values(S);
  const inc = (o, k, n = 1) => { if (k === undefined || k === null || k === "") k = "?"; o[k] = (o[k] || 0) + n; };
  const out = { sessions: sessions.length, events: 0, sources: {}, sourceFunnel: {}, byType: {}, byDay: {}, devices: {}, os: {}, countries: {}, origins: {}, budgets: {}, flyFilter: {},
    funnel: { opened: 0, searched: 0, swiped: 0, openedDetails: 0, pressedBook: 0, openedCheckout: 0 },
    cities: {}, checkouts: [], together: { games: 0, finished: 0, matches: 0 }, swipesPerSession: 0, installs: 0 };
  let swipeTotal = 0;
  sessions.forEach((s) => {
    inc(out.devices, s.dev); inc(out.os, s.os); inc(out.countries, s.country); inc(out.byDay, new Date(s.first).toISOString().slice(0, 10));
    const has = (t) => s.ev.some((e) => e.t === t);
    const op = s.ev.find((e) => e.t === "open"), d0 = (op && op.d) || {};
    const src = d0.g ? d0.g : d0.ref ? (/facebook|fb\.|m\.facebook/.test(d0.ref) ? "facebook (no tag)" : /instagram/.test(d0.ref) ? "instagram (no tag)" : /linkedin|lnkd/.test(d0.ref) ? "linkedin (no tag)" : d0.ref) : "direct / WhatsApp / unknown";
    inc(out.sources, src); const sf = out.sourceFunnel[src] || (out.sourceFunnel[src] = { visits: 0, swiped: 0, time: 0 }); sf.visits++; if (has("swipe")) sf.swiped++;
    const tt = s.ev.filter((e) => e.t === "time").map((e) => (e.d && e.d.s) || 0); sf.time += Math.min(tt.length ? Math.max(...tt) : 0, 1800);
    if (has("open")) out.funnel.opened++; if (has("search")) out.funnel.searched++; if (has("swipe")) out.funnel.swiped++;
    if (has("sheet")) out.funnel.openedDetails++; if (has("book")) out.funnel.pressedBook++; if (has("checkout")) out.funnel.openedCheckout++;
    s.ev.forEach((e) => {
      out.events++; inc(out.byType, e.t); const d = e.d || {};
      if (e.t === "search") { inc(out.origins, d.o); if (d.b) inc(out.budgets, d.b <= 500 ? "≤€500" : d.b <= 800 ? "€501–800" : d.b <= 1200 ? "€801–1200" : ">€1200"); else inc(out.budgets, "no limit"); }
      if (e.t === "ready" && d.ms) { (out._ready = out._ready || []).push(d.ms); if (d.snap) out._readySnap = (out._readySnap || 0) + 1; }
      if (e.t === "alert_signup") out.alertSignups = (out.alertSignups || 0) + 1;
      if (e.t === "fly_filter") inc(out.flyFilter, d.m ? d.m / 60 + "h" : "any");
      if (e.t === "swipe") { swipeTotal++; const c = out.cities[d.c] || (out.cities[d.c] = { saved: 0, skipped: 0, details: 0, book: 0, checkout: 0 }); d.like ? c.saved++ : c.skipped++; }
      if (["sheet", "book", "checkout"].includes(e.t) && d.c) { const c = out.cities[d.c] || (out.cities[d.c] = { saved: 0, skipped: 0, details: 0, book: 0, checkout: 0 }); c[e.t === "sheet" ? "details" : e.t]++; }
      if (e.t === "checkout") out.checkouts.push({ c: d.c, p: d.p, at: e.ts });
      if (e.t === "together_start") out.together.games++;
      if (e.t === "together_end") { out.together.finished++; out.together.matches += d.m || 0; }
      if (e.t === "install") out.installs++;
    });
  });
  /* time spent: active seconds reported by the app ("time" events); older sessions fall back to first→last event */
  const durs = sessions.map((s) => {
    const t = s.ev.filter((e) => e.t === "time").map((e) => (e.d && e.d.s) || 0);
    let sec = t.length ? Math.max(...t) : (s.ev.length > 1 ? (Math.max(...s.ev.map((e) => e.ts)) - Math.min(...s.ev.map((e) => e.ts))) / 1000 : 0);
    /* a tab left open in the background must not distort the average: one session counts at most 30 minutes */
    return { key: s.uid || s.sid, sec: Math.min(Math.round(sec), 30 * 60), measured: t.length > 0 };
  });
  const users = {}; durs.forEach((d) => { users[d.key] = (users[d.key] || 0) + d.sec; });
  const uv = Object.values(users), sv = durs.map((d) => d.sec).sort((a, b) => a - b);
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
  const buckets = { "< 30 s": 0, "30 s – 2 min": 0, "2 – 5 min": 0, "5 – 15 min": 0, "> 15 min": 0 };
  sv.forEach((x) => buckets[x < 30 ? "< 30 s" : x < 120 ? "30 s – 2 min" : x < 300 ? "2 – 5 min" : x < 900 ? "5 – 15 min" : "> 15 min"]++);
  out.time = { avgPerSession: avg(sv), medianPerSession: sv.length ? sv[Math.floor(sv.length / 2)] : 0, avgPerUser: avg(uv), users: uv.length, measured: durs.filter((d) => d.measured).length, buckets };
  out.swipesPerSession = sessions.length ? Math.round((swipeTotal / sessions.length) * 10) / 10 : 0;
  if (req.query && req.query.detail === "1") out.list = sessions.map((s, i) => ({ sid: s.sid, uid: s.uid, dev: s.dev, os: s.os, country: s.country, first: new Date(s.first).toISOString(), n: s.ev.length, types: [...new Set(s.ev.map((e) => e.t))].join(","), span: Math.round((Math.max(...s.ev.map((e) => e.ts)) - Math.min(...s.ev.map((e) => e.ts))) / 1000) }));
  Object.values(out.sourceFunnel).forEach((x) => { x.avgTime = x.visits ? Math.round(x.time / x.visits) : 0; delete x.time; });
  /* return rate: a visitor (same browser) who comes back at least 30 minutes after the previous visit; "another day" = visits on 2+ days */
  const byUser = {};
  sessions.forEach((s) => { if (!s.uid) return; const ts = s.ev.map((e) => e.ts).filter(Boolean); if (!ts.length) return; (byUser[s.uid] = byUser[s.uid] || []).push({ a: Math.min(...ts), b: Math.max(...ts) }); });
  let tracked = 0, back = 0, backDay = 0, visits = 0;
  Object.values(byUser).forEach((list) => {
    list.sort((x, y) => x.a - y.a); tracked++;
    const v = [list[0]]; list.slice(1).forEach((x) => { const last = v[v.length - 1]; if (x.a - last.b >= 30 * 60 * 1000) v.push(x); else last.b = Math.max(last.b, x.b); });
    visits += v.length; if (v.length > 1) back++;
    if (new Set(v.map((x) => new Date(x.a + 3600e3).toISOString().slice(0, 10))).size > 1) backDay++;
  });
  out.returning = { users: tracked, returned: back, returnedOtherDay: backDay, rate: tracked ? Math.round((back / tracked) * 100) : 0, rateOtherDay: tracked ? Math.round((backDay / tracked) * 100) : 0, visitsPerUser: tracked ? Math.round((visits / tracked) * 10) / 10 : 0 };
  try { const sb = []; let c; do { const r = await list({ prefix: "subs/", limit: 1000, cursor: c }); sb.push(...r.blobs); c = r.hasMore ? r.cursor : undefined; } while (c); out.subscribers = new Set(sb.map((b) => b.pathname.split("/")[1].split("-")[0])).size; } catch (e) { out.subscribers = 0; }
  { const r = (out._ready || []).sort((x, y) => x - y); out.ready = { n: r.length, median: r.length ? r[Math.floor(r.length / 2)] : 0, instant: out._readySnap || 0 }; delete out._ready; delete out._readySnap; }
  out.updated = Date.now(); out.files = blobs.length;
  return res.status(200).json(out);
};
