// GET /api/verify?o=MIL&f=...&t=...&a=2&tOut=18:00&tIn=16:00&b=750&d=BCN,LIS,...
// For each destination: is there a real flight + hotel package whose flights leave after the chosen times?
// Returns the matching legs, or false. Everything runs on the server in parallel and is CDN-cached.
const { callTool, pool } = require("./_mcp");
const IATA = /^[A-Z]{3}$/, DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const hm = (s) => { const [h, m] = String(s || "0:0").split(":").map(Number); return h + (m || 0) / 60; };
const ok = (t, min) => !min || !t || hm(t) >= hm(min);
const iso = (x) => (x ? String(x).slice(11, 16) : "");

async function legAfter(dep, arr, date, t, a) {
  const r = await callTool("search_flights", { departure: dep, arrival: arr, start_date: date, departure_time_start: t, departure_time_end: "23:59", adults: Number(a), max_results: 3 });
  const list = ((r.payload && r.payload.flights) || []).filter((x) => x && x.departure);
  if (!list.length) return null;
  const f = list.slice().sort((x, y) => hm(String(x.departure).split(" ")[1]) - hm(String(y.departure).split(" ")[1]))[0];
  const [ap, tm] = String(f.departure).split(" ");
  return { ap, t: tm, to: String(f.arrival || ""), air: f.airline || "", stops: f.stops || "" };
}

async function pkgVerify(o, d, f, t, a, tOut, tIn, budget) {
  const r1 = await callTool("search_flight_and_hotel_package", { origin: o, destination: d, date_from: f, date_to: t, adults: a, max_results: 20, lang: "it", sort: "recommended" });
  const p1 = r1.payload || {};
  const list = (p1.products_summary || []).slice().sort((x, y) => x.price_total - y.price_total);
  if (!list.length || !p1.search_id) return false;
  const hit = (budget && list.find((x) => x.price_total <= budget)) || list[0];
  const sid = r1.sid;
  const r2 = await callTool("select_hotel_options", { search_id: p1.search_id, hotel_internal_id: hit.internal_id_hotel, date_from: f, date_to: t }, sid);
  const p2 = r2.payload || {};
  if (!p2.success) return false;
  const fo = p2.flight_details && p2.flight_details.outbound, fi = p2.flight_details && p2.flight_details.inbound;
  const L = (x) => (x ? { ap: x.from, t: iso(x.departure_time), to: `${x.to} ${iso(x.arrival_time)}`, air: x.carrier_code || "", stops: x.direct ? "Direct" : "1 stop" } : null);
  if (ok(iso(fo && fo.departure_time), tOut) && ok(iso(fi && fi.departure_time), tIn)) return { o: L(fo), i: L(fi), extra: 0 };
  const room0 = (p2.room_options || [])[0];
  const rate = room0 && room0.rate_id;
  if (!rate) return false;
  await callTool("generate_booking_link", { pricing_id: p2.pricing_id, rate_id: rate }, sid);
  const r3 = await callTool("get_alternative_flights", { pricing_id: p2.pricing_id }, sid);
  const fl = (r3.payload && r3.payload.flights) || [];
  const m = fl.filter((x) => ok(x.outbound.departure.time, tOut) && ok(x.inbound.departure.time, tIn)).sort((x, y) => x.price.total - y.price.total)[0];
  if (!m) return false;
  const A = (x) => ({ ap: x.departure.airport, t: x.departure.time, to: `${x.arrival.airport} ${x.arrival.time}`, air: x.carrier.code, stops: x.stops });
  // extra = what the time-matching flights add on top of the package price (same flights for every hotel in this city)
  const extra = room0 && room0.price ? Math.max(0, Math.round((m.price.total - room0.price) * 100) / 100) : 0;
  return { o: A(m.outbound), i: A(m.inbound), extra };
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const o = String(q.o || "MIL").toUpperCase(), f = String(q.f || ""), t = String(q.t || ""), a = String(q.a || "2");
  const tOut = q.tOut && TIME.test(q.tOut) ? q.tOut : "", tIn = q.tIn && TIME.test(q.tIn) ? q.tIn : "";
  const budget = Number(q.b) > 0 ? Number(q.b) : 0;
  const ds = String(q.d || "").toUpperCase().split(",").filter((x) => IATA.test(x)).slice(0, 25);
  if (!IATA.test(o) || !DATE.test(f) || !DATE.test(t) || !/^[1-4]$/.test(a) || !ds.length || (!tOut && !tIn))
    return res.status(400).json({ error: { code: "bad_request", message: "Invalid parameters" } });
  const results = await pool(ds, 12, async (d) => {
    const [lo, li] = await Promise.all([tOut ? legAfter(o, d, f, tOut, a) : true, tIn ? legAfter(d, o, t, tIn, a) : true]);
    if (!lo || !li) return false;
    return await pkgVerify(o, d, f, t, a, tOut, tIn, budget);
  });
  const out = {};
  let errors = 0;
  results.forEach((x, k) => { if (x && x.error) { errors++; out[ds[k]] = false; } else out[ds[k]] = x || false; });
  res.setHeader("cache-control", errors > ds.length / 2 ? "no-store" : "public, s-maxage=900, stale-while-revalidate=3600");
  return res.status(200).json({ results: out });
};
