// GET /api/sights?city=Valencia
// Photos of a city's best-known sights.
// Candidates: Wikivoyage "See" listings (curated travel guide, incl. district pages for big cities)
// plus Wikipedia landmarks near the city centre. They are ranked by how many people read about
// each sight on Wikipedia in the last 30 days, so the famous ones come first.
// Every photo links to its Wikimedia Commons / Wikipedia page (author + licence). CDN-cached for a week.
const UA = { "user-agent": "Fridayaway/1.0 (https://fridayaway.vercel.app)" };
const get = (u) => fetch(u, { headers: UA }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const WV = (q) => get("https://en.wikivoyage.org/w/api.php?format=json&formatversion=2&" + q);
const WP = (q) => get("https://en.wikipedia.org/w/api.php?format=json&formatversion=2&" + q);
const ALIAS = { "Faro & Algarve": "Algarve", "Cyprus (Larnaca)": "Larnaca", "Salento (Brindisi)": "Lecce", "Calabria (Lamezia)": "Tropea", "Ibiza": "Ibiza Town", "Krakow": "Kraków" };
const BADIMG = /map|flag|coat.of.arms|logo|locator|icon|banner|seal|blank|diagram|\bplan\b|\bsign\b|\.svg/i;
const NOT = /railway|train station|metro station|bus station|airport|stadium|arena|university|school|college|hospital|hotel|company|football|parish|municipality|district|neighbou?rhood|quarter|freguesia|barrio|roundabout|society|diocese|archdiocese|bank\b|ministry|embassy|olympic|human settlement|village|commune|comune|frazione|island in|archipelago|province|region of|capital of|city in|town in|municipality in|administrative|festival|event\b|holiday|celebration|parade|fire of|disaster|earthquake|siege|battle|\bwar\b|list of|sport\b|football|game\b|dance|music|cuisine|dish\b|food|drink|beer|wine|tradition|custom|swimming|ball game|person|painter|sculptor|saint\b|king of|queen of|bishop|politician|writer|novel|film|song/i;
const LANDMARK = /cathedral|church|basilica|palace|castle|fortress|museum|monument|square|plaza|piazza|park|garden|tower|bridge|theat(re|er)|beach|mosque|temple|market|gallery|\bfort\b|abbey|monastery|citadel|alcazaba|alcázar|acropolis|ruins|archaeolog|lighthouse|viewpoint|promenade|gate|\barch\b|fountain|chapel|synagogue|aqueduct|harbou?r|old town|world heritage|cave|grotto|volcano|national park|mountain|lake|bay\b|cliff|canyon|tomb|mausoleum|landmark|attraction|historic/i;

// split a template body on top-level "|" (ignoring the ones inside [[...]] and {{...}})
function params(body) {
  const out = {}; let depth = 0, cur = "";
  const parts = [];
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === "[[" || two === "{{") { depth++; cur += two; i++; continue; }
    if ((two === "]]" || two === "}}") && depth > 0) { depth--; cur += two; i++; continue; }
    if (body[i] === "|" && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += body[i];
  }
  parts.push(cur);
  parts.forEach((p) => { const k = p.indexOf("="); if (k > 0) out[p.slice(0, k).trim().toLowerCase()] = p.slice(k + 1).trim(); });
  return out;
}
const clean = (s) => String(s || "").replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/\{\{[^}]*\}\}/g, "").replace(/'{2,}/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

function listings(wt) {
  const out = [];
  const re = /\{\{\s*(see|listing)\s*\|/gi;
  let m;
  while ((m = re.exec(wt))) {
    let i = re.lastIndex, depth = 1;
    while (i < wt.length && depth > 0) { const two = wt.slice(i, i + 2); if (two === "{{") { depth++; i += 2; } else if (two === "}}") { depth--; i += 2; } else i++; }
    const p = params(wt.slice(re.lastIndex, i - 2));
    if (m[1].toLowerCase() === "listing" && !/^see$/i.test(p.type || "")) continue;
    const name = clean(p.name), img = String(p.image || "").replace(/^(File|Image):/i, "").trim();
    if (name && name.length < 70) out.push({ name, file: /\.(jpe?g|webp)$/i.test(img) && !BADIMG.test(img) ? img : "", wd: p.wikidata || "" });
  }
  return out;
}

async function wikivoyage(city) {
  const p = await WV("action=parse&redirects=1&prop=wikitext|links&page=" + encodeURIComponent(city));
  if (!p.parse) return [];
  const title = p.parse.title;
  let list = listings(p.parse.wikitext || "");
  const subs = (p.parse.links || []).map((l) => l.title).filter((t) => t.startsWith(title + "/")).slice(0, 6);
  for (const s of subs) {
    if (list.length >= 45) break;
    const q = await WV("action=parse&prop=wikitext&page=" + encodeURIComponent(s));
    list = list.concat(listings((q.parse && q.parse.wikitext) || ""));
  }
  return list.slice(0, 50);
}

async function nearby(city) {
  const c = await WP("action=query&redirects=1&prop=coordinates&titles=" + encodeURIComponent(city));
  const pg = ((c.query && c.query.pages) || [])[0];
  const co = pg && pg.coordinates && pg.coordinates[0];
  if (!co) return [];
  const r = await WP(`action=query&list=geosearch&gscoord=${co.lat}|${co.lon}&gsradius=10000&gslimit=100`);
  return ((r.query && r.query.geosearch) || []).map((x) => x.title);
}

// Wikipedia facts for up to 50 titles: page views (fame), description, lead image
async function wpInfo(titles) {
  const out = {};
  for (let k = 0; k < titles.length; k += 50) {
    const chunk = titles.slice(k, k + 50);
    let cont = "";
    for (let guard = 0; guard < 4; guard++) {
      const r = await WP("action=query&redirects=1&prop=pageviews|pageimages|description|info&inprop=url&pvipdays=30&piprop=thumbnail|name&pithumbsize=640&titles=" + encodeURIComponent(chunk.join("|")) + cont);
      const q = r.query || {};
      const back = {}; (q.normalized || []).concat(q.redirects || []).forEach((n) => { back[n.to] = (back[n.to] || []).concat(n.from, back[n.from] || []); });
      (q.pages || []).forEach((p) => {
        if (p.missing) return;
        const views = Object.values(p.pageviews || {}).reduce((a, b) => a + (b || 0), 0);
        const rec = out[p.title] || { title: p.title, views: 0 };
        rec.views = Math.max(rec.views, views); rec.desc = p.description || rec.desc || "";
        if (p.thumbnail) { rec.img = p.thumbnail.source; rec.file = p.pageimage; }
        rec.url = p.fullurl;
        out[p.title] = rec; (back[p.title] || []).forEach((f) => (out[f] = rec));
      });
      if (!r.continue) break;
      cont = "&" + Object.entries(r.continue).map(([a, b]) => a + "=" + encodeURIComponent(b)).join("&");
    }
  }
  return out;
}

async function commonsUrls(files) {
  const out = {};
  if (!files.length) return out;
  const r = await WV("action=query&prop=imageinfo&iiprop=url&iiurlwidth=640&titles=" + encodeURIComponent(files.map((f) => "File:" + f).join("|")));
  const q = r.query || {};
  const norm = {}; (q.normalized || []).forEach((n) => (norm[n.to] = n.from));
  (q.pages || []).forEach((p) => { const ii = p.imageinfo && p.imageinfo[0]; if (ii && ii.thumburl) out[(norm[p.title] || p.title).replace(/^File:/, "")] = { img: ii.thumburl, page: ii.descriptionurl }; });
  return out;
}

module.exports = async (req, res) => {
  const raw = String((req.query && req.query.city) || "").slice(0, 60).trim();
  if (!raw || /[<>{}|[\]]/.test(raw)) return res.status(400).json({ error: { code: "bad_request", message: "city required" } });
  const city = ALIAS[raw] || raw;
  try {
    const [wv, near] = await Promise.all([wikivoyage(city), nearby(city)]);
    const names = [...new Set(wv.map((x) => x.name).concat(near))].slice(0, 150);
    const info = await wpInfo(names);
    const cityKey = city.toLowerCase();
    const cand = new Map();
    const add = (name, wvFile) => {
      const w = info[name];
      const key = (w ? w.title : name).toLowerCase();
      if (key === cityKey || key.startsWith(cityKey + "/")) return;
      const desc = (w && w.desc) || "";
      const fromGuide = wvFile !== undefined;
      if (NOT.test(desc) || /^list of/i.test(w ? w.title : name)) return;
      const sure = LANDMARK.test(desc + " " + (w ? w.title : name));
      if (!fromGuide && !sure) return;
      const prev = cand.get(key);
      const item = { name: w && sure ? w.title.replace(/\s*\([^)]*\)$/, "") : name, views: w && sure ? w.views : 0, wpImg: sure && w ? w.img : undefined, wvFile: wvFile || (prev && prev.wvFile) || "", wpFile: sure && w ? w.file : undefined, url: w && w.url };
      if (!prev || item.views > prev.views || (!prev.wvFile && item.wvFile)) cand.set(key, { ...prev, ...item });
    };
    wv.forEach((x) => add(x.name, x.file));
    near.forEach((n) => add(n));
    let ranked = [...cand.values()].filter((x) => x.wvFile || (x.wpImg && /\.jpe?g/i.test(x.wpImg) && !BADIMG.test(x.wpFile || ""))).sort((a, b) => b.views - a.views).slice(0, 6);
    const urls = await commonsUrls(ranked.filter((x) => x.wvFile).map((x) => x.wvFile));
    const sights = ranked.map((x) => {
      const c = x.wvFile && urls[x.wvFile];
      if (c) return { name: x.name, img: c.img, page: c.page };
      if (x.wpImg) return { name: x.name, img: x.wpImg, page: x.wpFile ? "https://commons.wikimedia.org/wiki/File:" + encodeURIComponent(x.wpFile) : x.url };
      return null;
    }).filter(Boolean);
    res.setHeader("cache-control", sights.length ? "public, s-maxage=604800, stale-while-revalidate=86400" : "public, s-maxage=3600");
    return res.status(200).json({ results: { city: raw, sights } });
  } catch (e) {
    res.setHeader("cache-control", "no-store");
    return res.status(502).json({ error: { code: "server_unavailable", message: String(e.message || e).slice(0, 200) } });
  }
};
