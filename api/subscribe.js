// POST /api/subscribe {email, b, o, a, l, uid, g}  ->  Thursday deals alert sign-up (one file per email address)
const { put } = require("@vercel/blob");
const crypto = require("crypto");
module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } } b = b || {};
  const email = String(b.email || "").trim().toLowerCase().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return res.status(400).json({ error: "invalid email" });
  const rec = { email, budget: Math.max(0, Math.min(5000, Number(b.b) || 0)), origin: String(b.o || "MIL").replace(/[^A-Z]/g, "").slice(0, 3), adults: Math.max(1, Math.min(4, Number(b.a) || 1)),
    lang: b.l === "it" ? "it" : "en", source: String(b.g || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40), uid: String(b.uid || "").replace(/[^a-z0-9]/gi, "").slice(0, 32), at: Date.now(), consent: true, test: b.t === true };
  try {
    const id = crypto.createHash("sha1").update(email).digest("hex").slice(0, 20);
    await put(`subs/${id}.json`, JSON.stringify(rec), { access: "public", addRandomSuffix: true, contentType: "application/json" });
    return res.status(204).end();
  } catch (e) { return res.status(500).json({ error: "save failed" }); }
};
