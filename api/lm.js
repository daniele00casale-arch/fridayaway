// Fridayaway – server-side proxy to the public lastminute.com MCP server.
// The browser calls POST /api/lm {tool, args, sid}; this function speaks MCP (Streamable HTTP) to lastminute.com
// and returns {payload, sid}. The MCP session id is handed back to the browser so that multi-step tools
// (select_hotel_options → generate_booking_link → get_alternative_flights → change_flight) share one session.

const { callTool, openSession, ENDPOINT } = require("./_mcp");
const ALLOWED = new Set(["search_flight_and_hotel_package","select_hotel_options","generate_booking_link","get_alternative_flights","change_flight","search_flights"]);

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  try {
    if (req.method === "GET") {
      // Health check: /api/lm?test=1 runs one small real search
      if (req.query && req.query.test) {
        const d = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
        const d2 = new Date(Date.now() + 12 * 864e5).toISOString().slice(0, 10);
        const t0 = Date.now();
        const r = await callTool("search_flight_and_hotel_package", { origin: "MIL", destination: "BCN", date_from: d, date_to: d2, adults: "2", max_results: 2, lang: "it", sort: "recommended" });
        const list = (r.payload && r.payload.products_summary) || [];
        return res.status(200).json({ ok: !!list.length, ms: Date.now() - t0, endpoint: ENDPOINT, error: r.error || null, sample: list.slice(0, 2).map((x) => ({ name: x.name, price_total: x.price_total })) });
      }
      return res.status(200).json({ ok: true });
    }
    if (req.method !== "POST") return res.status(405).json({ error: { code: "method", message: "POST only" } });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    if (body.init) return res.status(200).json({ sid: await openSession() });
    if (!ALLOWED.has(body.tool)) return res.status(400).json({ error: { code: "tool_error", message: "Tool not allowed" } });
    if (JSON.stringify(body.args || {}).length > 4000) return res.status(400).json({ error: { code: "tool_error", message: "Arguments too large" } });
    const out = await callTool(body.tool, body.args, body.sid);
    return res.status(out.error ? 502 : 200).json(out);
  } catch (e) {
    return res.status(502).json({ error: { code: "server_unavailable", message: String(e.message || e).slice(0, 300) } });
  }
};
