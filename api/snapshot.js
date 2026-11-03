// GET /api/snapshot?o=MIL&f=YYYY-MM-DD&t=YYYY-MM-DD&a=1  -> prices pre-calculated overnight (see prewarm.js), or 404
const { list } = require("@vercel/blob");
module.exports = async (req, res) => {
  const q = req.query || {};
  const o = String(q.o || "").toUpperCase(), f = String(q.f || ""), t = String(q.t || ""), a = String(q.a || "");
  if (!/^[A-Z]{3}$/.test(o) || !/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t) || !/^[1-4]$/.test(a)) return res.status(400).json({ error: "bad request" });
  try {
    const r = await list({ prefix: `snap/${o}-${f}-${t}-${a}.json`, limit: 1 });
    if (!r.blobs.length) { res.setHeader("cache-control", "s-maxage=300"); return res.status(404).json({ error: "none" }); }
    const j = await fetch(r.blobs[0].url + "?v=" + (+new Date(r.blobs[0].uploadedAt))).then((x) => x.json());
    if (!j || Date.now() - j.at > 30 * 3600e3) { res.setHeader("cache-control", "s-maxage=300"); return res.status(404).json({ error: "old" }); }
    res.setHeader("cache-control", "public, s-maxage=900, stale-while-revalidate=3600");
    return res.status(200).json({ results: j.results, at: j.at });
  } catch (e) { return res.status(500).json({ error: "snapshot failed" }); }
};
