// GET /api/search?o=MIL&f=2026-10-30&t=2026-11-01&a=2&d=BCN,LIS,...
// Package search (flight + hotel) for many destinations in one request, run in parallel on the server.
// Cached on Vercel's CDN, so the same weekend is instant for the next visitors.
const { callTool, pool } = require("./_mcp");
const IATA = /^[A-Z]{3}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = async (req, res) => {
  const q = req.query || {};
  const o = String(q.o || "MIL").toUpperCase(), f = String(q.f || ""), t = String(q.t || ""), a = String(q.a || "2");
  const ds = String(q.d || "").toUpperCase().split(",").filter((x) => IATA.test(x)).slice(0, 40);
  if (!IATA.test(o) || !DATE.test(f) || !DATE.test(t) || !/^[1-4]$/.test(a) || !ds.length)
    return res.status(400).json({ error: { code: "bad_request", message: "Invalid parameters" } });
  const results = await pool(ds, 20, async (d) => {
    if (d === o) return { d, products: [] };
    const r = await callTool("search_flight_and_hotel_package", { origin: o, destination: d, date_from: f, date_to: t, adults: a, max_results: 6, lang: "it", sort: "recommended" });
    if (r.error) return { d, error: r.error.message };
    return { d, products: (r.payload && r.payload.products_summary) || [] };
  });
  const out = {};
  results.forEach((x, k) => { out[ds[k]] = x && !x.error ? x.products : null; });
  const failed = Object.values(out).filter((v) => v === null).length;
  res.setHeader("cache-control", failed > ds.length / 2 ? "no-store" : "public, s-maxage=900, stale-while-revalidate=3600");
  return res.status(200).json({ results: out });
};
