// Runs every night (Vercel Cron, see vercel.json): pre-calculates next weekend's flight + hotel prices
// from Milan for 1 and 2 adults and saves them, so the app can show the cards instantly (/api/snapshot).
const { put } = require("@vercel/blob");
const { callTool, pool } = require("./_mcp");
const CODES = "BCN,LIS,VLC,AGP,PMO,NAP,CAG,ATH,OPO,TFS,PRG,BUD,VIE,PAR,SPU,AMS,CPH,MAD,SVQ,PMI,IBZ,MAH,ALC,BIO,GRX,LPA,ACE,FUE,FAO,FNC,LYS,MRS,NCE,BOD,LON,EDI,DUB,BRU,BER,MUC,HAM,STO,OSL,HEL,REK,RIX,TLL,WAW,KRK,GDN,DBV,ZAD,ZAG,TIA,BEG,SOF,OTP,JTR,JMK,HER,RHO,CFU,SKG,MLA,LCA,IST,RAK,ROM,CTA,BRI,BDS,OLB,AHO,SUF".split(",");
const nextWeekend = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7 || 7)); const f = d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + 2); return [f, d.toISOString().slice(0, 10)]; };
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const ua = String(req.headers["user-agent"] || ""), q = req.query || {};
  const allowed = /vercel-cron/i.test(ua) || (process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`) || (process.env.STATS_KEY && q.key === process.env.STATS_KEY);
  if (!allowed) return res.status(401).json({ error: "not allowed" });
  const [f, t] = nextWeekend(), o = String(q.o || "MIL").toUpperCase(), t0 = Date.now(), done = {};
  for (const a of String(q.a || "1,2").split(",")) {
    if (Date.now() - t0 > 150000) break;
    const results = {};
    const rows = await pool(CODES, 20, async (d) => {
      if (d === o) return [d, []];
      const r = await callTool("search_flight_and_hotel_package", { origin: o, destination: d, date_from: f, date_to: t, adults: a, max_results: 6, lang: "it", sort: "recommended" });
      return [d, r.error ? null : (r.payload && r.payload.products_summary) || []];
    });
    rows.forEach((x) => { if (x && x[1]) results[x[0]] = x[1]; });
    const n = Object.keys(results).length;
    if (n >= 20) await put(`snap/${o}-${f}-${t}-${a}.json`, JSON.stringify({ at: Date.now(), o, f, t, a, results }), { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
    done[a] = n;
  }
  return res.status(200).json({ ok: true, from: f, to: t, cities: done, ms: Date.now() - t0 });
};
