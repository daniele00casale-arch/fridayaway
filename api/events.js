// GET /api/events?lat=..&lon=..&city=..&from=YYYY-MM-DD&to=YYYY-MM-DD
// What's on at the destination during the trip (concerts, sport, shows), from the Ticketmaster Discovery API.
// Needs the TM_KEY environment variable (free key from developer.ticketmaster.com); without it the app simply shows no events.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
module.exports = async (req, res) => {
  const q = req.query || {};
  const key = process.env.TM_KEY;
  if (!key) { res.setHeader("cache-control", "s-maxage=300"); return res.status(200).json({ results: { events: [], off: true } }); }
  const from = String(q.from || ""), to = String(q.to || "");
  if (!DAY.test(from) || !DAY.test(to)) return res.status(400).json({ error: { message: "bad dates" } });
  const lat = parseFloat(q.lat), lon = parseFloat(q.lon), city = String(q.city || "").slice(0, 60);
  const p = new URLSearchParams({ apikey: key, startDateTime: `${from}T00:00:00Z`, endDateTime: `${to}T23:59:59Z`, size: "40", sort: "relevance,desc", locale: "*" });
  if (isFinite(lat) && isFinite(lon)) { p.set("latlong", `${lat.toFixed(3)},${lon.toFixed(3)}`); p.set("radius", "30"); p.set("unit", "km"); }
  else if (city) p.set("city", city);
  else return res.status(400).json({ error: { message: "no place" } });
  try {
    const r = await fetch("https://app.ticketmaster.com/discovery/v2/events.json?" + p.toString());
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const seen = new Set(), out = [];
    for (const e of (j._embedded && j._embedded.events) || []) {
      const name = String(e.name || "").trim(); if (!name || seen.has(name.toLowerCase())) continue;
      if (e.dates && e.dates.status && /cancel|postpon/i.test(e.dates.status.code || "")) continue;
      seen.add(name.toLowerCase());
      const c = (e.classifications && e.classifications[0]) || {};
      const v = (e._embedded && e._embedded.venues && e._embedded.venues[0]) || {};
      const imgs = (e.images || []).filter((i) => i.ratio === "16_9").sort((a, b) => Math.abs(a.width - 640) - Math.abs(b.width - 640));
      out.push({
        name: name.slice(0, 90),
        date: (e.dates && e.dates.start && e.dates.start.localDate) || "",
        time: String((e.dates && e.dates.start && e.dates.start.localTime) || "").slice(0, 5),
        seg: (c.segment && c.segment.name !== "Undefined" && c.segment.name) || "",
        genre: (c.genre && c.genre.name !== "Undefined" && c.genre.name) || "",
        venue: String(v.name || "").slice(0, 60),
        url: e.url || "",
        img: (imgs[0] && imgs[0].url) || "",
      });
      if (out.length >= 20) break;
    }
    /* only events that really happen during the trip; concerts, sport and shows before museums and attractions */
    const rank = { Music: 0, Sports: 1, "Arts & Theatre": 2, Film: 3 };
    const keep = out.filter((e) => !e.date || (e.date >= from && e.date <= to))
      .map((e, i) => ({ e, i, r: rank[e.seg] !== undefined ? rank[e.seg] : 5 }))
      .sort((a, b) => (a.r >= 5) - (b.r >= 5) || a.i - b.i).map((x) => x.e).slice(0, 8);
    out.length = 0; out.push(...keep);
    res.setHeader("cache-control", "s-maxage=21600, stale-while-revalidate=86400");
    return res.status(200).json({ results: { events: out } });
  } catch (e) {
    res.setHeader("cache-control", "s-maxage=120");
    return res.status(200).json({ results: { events: [], error: String(e.message || e).slice(0, 120) } });
  }
};
