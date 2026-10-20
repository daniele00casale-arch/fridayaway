// Fridayaway – server-side proxy to the public lastminute.com MCP server.
// The browser calls POST /api/lm {tool, args, sid}; this function speaks MCP (Streamable HTTP) to lastminute.com
// and returns {payload, sid}. The MCP session id is handed back to the browser so that multi-step tools
// (select_hotel_options → generate_booking_link → get_alternative_flights → change_flight) share one session.

const ENDPOINT = process.env.LM_MCP_URL || "https://mcp.lastminute.com/mcp";
const ALLOWED = new Set([
  "search_flight_and_hotel_package",
  "select_hotel_options",
  "generate_booking_link",
  "get_alternative_flights",
  "change_flight",
  "search_flights",
]);
const PROTOCOL = "2025-03-26";

async function rpc(body, sid) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL,
  };
  if (sid) headers["mcp-session-id"] = sid;
  const r = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) });
  const newSid = r.headers.get("mcp-session-id") || sid;
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`MCP HTTP ${r.status}: ${text.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  if (!text) return { msg: null, sid: newSid };
  let msg = null;
  if ((r.headers.get("content-type") || "").includes("text/event-stream")) {
    // take the last JSON-RPC message carried in "data:" lines
    for (const block of text.split(/\n\n/)) {
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data) continue;
      try { const m = JSON.parse(data); if (m.id === body.id || m.result || m.error) msg = m; } catch (e) {}
    }
  } else {
    try { msg = JSON.parse(text); } catch (e) {}
  }
  return { msg, sid: newSid };
}

async function openSession() {
  const { msg, sid } = await rpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "fridayaway", version: "1.0" } },
  });
  if (msg && msg.error) throw new Error("initialize failed: " + JSON.stringify(msg.error).slice(0, 200));
  try { await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid); } catch (e) {}
  return sid;
}

function toPayload(result) {
  if (!result) return null;
  const txt = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  if (txt) { try { return JSON.parse(txt); } catch (e) {} }
  if (result.structuredContent) return result.structuredContent.result ?? result.structuredContent;
  return txt ? { text: txt } : null;
}

async function callTool(tool, args, sid) {
  if (!sid) sid = await openSession();
  let out;
  try {
    out = await rpc({ jsonrpc: "2.0", id: Date.now() % 1e9, method: "tools/call", params: { name: tool, arguments: args || {} } }, sid);
  } catch (e) {
    if (e.status === 404 || e.status === 400) { // session expired → new session, retry once
      sid = await openSession();
      out = await rpc({ jsonrpc: "2.0", id: Date.now() % 1e9, method: "tools/call", params: { name: tool, arguments: args || {} } }, sid);
    } else throw e;
  }
  const m = out.msg || {};
  if (m.error) return { sid: out.sid, error: { code: "tool_error", message: m.error.message || "Tool error" } };
  if (m.result && m.result.isError) return { sid: out.sid, error: { code: "tool_error", message: (toPayload(m.result) || {}).text || "Tool error" } };
  return { sid: out.sid, payload: toPayload(m.result) };
}

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
