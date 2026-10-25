// Shared MCP client for the public lastminute.com server (Streamable HTTP).
// One session per warm serverless instance, re-opened automatically when it expires.

const ENDPOINT = process.env.LM_MCP_URL || "https://mcp.lastminute.com/mcp";
const PROTOCOL = "2025-03-26";
let shared = null; // { sid, at }

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
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "fridayaway", version: "2.0" } },
  });
  if (msg && msg.error) throw new Error("initialize failed: " + JSON.stringify(msg.error).slice(0, 200));
  try { await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid); } catch (e) {}
  return sid;
}

let opening = null;
async function sharedSid(force) {
  if (!force && shared && Date.now() - shared.at < 20 * 60 * 1000) return shared.sid;
  if (!opening) opening = openSession().then((sid) => { shared = { sid, at: Date.now() }; return sid; }).finally(() => { opening = null; });
  return opening;
}

function toPayload(result) {
  if (!result) return null;
  const txt = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  if (txt) { try { return JSON.parse(txt); } catch (e) {} }
  if (result.structuredContent) return result.structuredContent.result ?? result.structuredContent;
  return txt ? { text: txt } : null;
}

// callTool(tool, args, sid?) -> { sid, payload } | { sid, error }
async function callTool(tool, args, sid) {
  const useShared = !sid;
  if (!sid) sid = await sharedSid();
  const body = () => ({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method: "tools/call", params: { name: tool, arguments: args || {} } });
  let out;
  try {
    out = await rpc(body(), sid);
  } catch (e) {
    if (e.status === 404 || e.status === 400 || e.status === 401) {
      sid = useShared ? await sharedSid(true) : await openSession();
      out = await rpc(body(), sid);
    } else throw e;
  }
  const m = out.msg || {};
  if (m.error) return { sid: out.sid, error: { code: "tool_error", message: m.error.message || "Tool error" } };
  if (m.result && m.result.isError) return { sid: out.sid, error: { code: "tool_error", message: (toPayload(m.result) || {}).text || "Tool error" } };
  return { sid: out.sid, payload: toPayload(m.result) };
}

// Run fn over items with a concurrency limit
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: String(e.message || e).slice(0, 200) }; } }
  }));
  return out;
}

module.exports = { callTool, openSession, pool, ENDPOINT };
