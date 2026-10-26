// GET /api/detail?o=MIL&d=BCN&f=2026-10-30&t=2026-11-01&a=2&h=8779
// Real details for one hotel in a flight + hotel package: photo gallery, description, address,
// check-in times, the package flights (with durations) and the room options with prices.
// CDN-cached for 15 minutes so swiping back and forth is instant.
const { callTool } = require("./_mcp");
const IATA = /^[A-Z]{3}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
const link = (s) => { const m = /\((https:\/\/[^)\s]+)\)/.exec(String(s || "")); return m ? m[1] : (/^https:\/\//.test(String(s || "")) ? String(s) : ""); };

module.exports = async (req, res) => {
  const q = req.query || {};
  const o = String(q.o || "").toUpperCase(), d = String(q.d || "").toUpperCase(), f = String(q.f || ""), t = String(q.t || ""), a = String(q.a || "2");
  const hid = Number(q.h);
  if (!IATA.test(o) || !IATA.test(d) || !DATE.test(f) || !DATE.test(t) || !/^[1-4]$/.test(a) || !(hid > 0))
    return res.status(400).json({ error: { code: "bad_request", message: "Invalid parameters" } });
  try {
    const r1 = await callTool("search_flight_and_hotel_package", { origin: o, destination: d, date_from: f, date_to: t, adults: a, max_results: 20, lang: "it", sort: "recommended" });
    const p1 = r1.payload || {};
    if (!p1.search_id) throw new Error("no search");
    const hit = (p1.products_summary || []).find((x) => x.internal_id_hotel === hid);
    const r2 = await callTool("select_hotel_options", { search_id: p1.search_id, hotel_internal_id: hid, date_from: f, date_to: t }, r1.sid);
    const p2 = r2.payload || {};
    if (!p2.success) throw new Error(p2.message || "hotel unavailable");
    const H = p2.hotel || {};
    const F = (x) => x ? { from: x.from, to: x.to, dep: String(x.departure_time || "").slice(11, 16), arr: String(x.arrival_time || "").slice(11, 16), min: x.duration_minutes || 0, carrier: x.carrier_code || "", num: x.flight_number || "", direct: !!x.direct } : null;
    const out = {
      at: Date.now(),
      hotel: {
        name: H.name || (hit && hit.name) || "", stars: H.stars || 0, address: H.address || "",
        checkIn: H.check_in_time || "", checkOut: H.check_out_time || "",
        description: String(H.description || "").slice(0, 700),
        photos: (H.gallery_links || []).map(link).filter(Boolean).slice(0, 8),
        image: (hit && hit.image) || "", km: hit ? hit.distance_km : null, rating: hit ? hit.rating : null, reviews: hit ? hit.reviews : null,
        facilities: (hit && hit.facilities) || [],
      },
      flights: { out: F(p2.flight_details && p2.flight_details.outbound), back: F(p2.flight_details && p2.flight_details.inbound) },
      rooms: (p2.room_options || []).map((x) => ({ name: String(x.room_name || "").trim(), meal: x.meal_plan, price: x.price, cancellation: x.cancellation })).sort((x, y) => x.price - y.price).slice(0, 6),
      price: hit ? hit.price_total : null,
    };
    res.setHeader("cache-control", "public, s-maxage=900, stale-while-revalidate=1800");
    return res.status(200).json({ results: out });
  } catch (e) {
    res.setHeader("cache-control", "no-store");
    return res.status(502).json({ error: { code: "server_unavailable", message: String(e.message || e).slice(0, 200) } });
  }
};
