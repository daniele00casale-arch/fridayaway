// GET /api/sights?city=Valencia
// Photos of the main sights of a city, from Wikivoyage "See" listings (curated, named),
// topped up with nearby Wikipedia landmarks when a guide lists too few.
// Every photo links to its Wikimedia Commons page (author + licence). Cached on the CDN for a week.
const UA = { "user-agent": "Fridayaway/1.0 (https://fridayaway.vercel.app)" };
const j = (u) => fetch(u, { headers: UA }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const WV = (q) => j("https://en.wikivoyage.org/w/api.php?format=json&formatversion=2&" + q);
const WP = (q) => j("https://en.wikipedia.org/w/api.php?format=json&formatversion=2&" + q);
const clean = (s) => String(s || "").replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/'{2,}/g, "").replace(/<[^>]+>/g, "").replace(/\{\{[^}]*\}\}/g, "").trim();
const BAD = /map|flag|coat|logo|locator|icon|banner|seal|blank|diagram|plan\b|sign\b|svg$/i;

function listings(wt) {
  const out = [], re = /\{\{\s*(?:see|do|listing\s*\|[^}]*?type\s*=\s*(?:see|do))\b([\s\S]*?)\}\}/gi;
  let m;
  while ((m = re.exec(wt))) {
    const b = m[1];
    const name = clean((/\|\s*name\s*=\s*([^|\n]+)/.exec(b) || [])[1]);
    const img = String((/\|\s*image\s*=\s*([^|\n]+)/.exec(b) || [])[1] || "").trim();
    if (name && img && /\.(jpe?g|webp)$/i.test(img) && !BAD.test(img)) out.push({ name, file: img.replace(/^(File|Image):/i, "") });
  }
  return out;
}

async function fromWikivoyage(city) {
  const p = await WV("action=parse&redirects=1&prop=wikitext|links&page=" + encodeURIComponent(city));
  if (!p.parse) return { list: [], title: city };
  const title = p.parse.title;
  let list = listings(p.parse.wikitext || "");
  if (list.length < 4) {
    // big cities keep their sights in district pages ("Lisbon/Baixa"...)
    const subs = (p.parse.links || []).map((l) => l.title).filter((t) => t.startsWith(title + "/")).slice(0, 4);
    for (const s of subs) {
      const q = await WV("action=parse&prop=wikitext&page=" + encodeURIComponent(s));
      list = list.concat(listings((q.parse && q.parse.wikitext) || ""));
      if (list.length >= 8) break;
    }
  }
  const seen = new Set(); list = list.filter((x) => !seen.has(x.file) && seen.add(x.file)).slice(0, 8);
  if (!list.length) return { list: [], title };
  const info = await WV("action=query&prop=imageinfo&iiprop=url&iiurlwidth=640&titles=" + encodeURIComponent(list.map((x) => "File:" + x.file).join("|")));
  const byName = {};
  ((info.query && info.query.pages) || []).forEach((pg) => {
    const ii = pg.imageinfo && pg.imageinfo[0];
    if (ii && ii.thumburl) byName[pg.title.replace(/^File:/, "").replace(/_/g, " ")] = { img: ii.thumburl, page: ii.descriptionurl };
  });
  const norm = ((info.query && info.query.normalized) || []).reduce((a, n) => ((a[n.from.replace(/^File:/, "")] = n.to.replace(/^File:/, "")), a), {});
  return {
    title,
    list: list.map((x) => { const k = (norm[x.file] || x.file).replace(/_/g, " "); const v = byName[k] || byName[k.charAt(0).toUpperCase() + k.slice(1)]; return v ? { name: x.name, img: v.img, page: v.page } : null; }).filter(Boolean),
  };
}

const LANDMARK = /cathedral|church|basilica|palace|castle|fortress|museum|monument|square|plaza|piazza|park|garden|tower|bridge|theatre|theater|beach|mosque|temple|market|gallery|fort\b|abbey|monastery|citadel|alcazaba|acropolis|ruins|archaeological|lighthouse|viewpoint|promenade|gate|arch\b|fountain|chapel|synagogue|aqueduct|harbou?r|old town|world heritage|cave|grotto|volcano|national park|mountain|lake|island|bay\b/i;
const NOT = /district|neighbou?rhood|municipality|station|airport|stadium|arena|university|school|hospital|hotel|company|football|metro|railway|parish|barrio|quarter|freguesia|street|road|avenue|roundabout|society|diocese|bank|ministry|embassy|olympic|human settlement|village|town in|city in|commune|frazione|comune/i;

async function fromWikipedia(city) {
  const c = await WP("action=query&redirects=1&prop=coordinates&titles=" + encodeURIComponent(city));
  const pg = ((c.query && c.query.pages) || [])[0];
  const co = pg && pg.coordinates && pg.coordinates[0];
  if (!co) return [];
  const r = await WP(`action=query&generator=geosearch&ggscoord=${co.lat}|${co.lon}&ggsradius=10000&ggslimit=100&prop=pageimages|description|pageviews|info&inprop=url&piprop=thumbnail|name&pithumbsize=640&pvipdays=30`);
  return ((r.query && r.query.pages) || [])
    .filter((p) => p.thumbnail && /\.jpe?g/i.test(p.thumbnail.source) && LANDMARK.test((p.description || "") + " " + p.title) && !NOT.test(p.description || "") && !BAD.test(p.pageimage || ""))
    .map((p) => ({ name: p.title.replace(/\s*\(.*\)$/, ""), img: p.thumbnail.source, page: p.pageimage ? "https://commons.wikimedia.org/wiki/File:" + encodeURIComponent(p.pageimage) : p.fullurl, v: Object.values(p.pageviews || {}).reduce((a, b) => a + (b || 0), 0) }))
    .sort((a, b) => b.v - a.v)
    .map(({ v, ...x }) => x);
}

module.exports = async (req, res) => {
  const city = String((req.query && req.query.city) || "").slice(0, 60).trim();
  if (!city || /[<>{}|[\]]/.test(city)) return res.status(400).json({ error: { code: "bad_request", message: "city required" } });
  try {
    const wv = await fromWikivoyage(city);
    let list = wv.list;
    if (list.length < 4) {
      const extra = await fromWikipedia(city);
      const have = new Set(list.map((x) => x.name.toLowerCase()));
      list = list.concat(extra.filter((x) => !have.has(x.name.toLowerCase())));
    }
    list = list.slice(0, 6);
    res.setHeader("cache-control", list.length ? "public, s-maxage=604800, stale-while-revalidate=86400" : "public, s-maxage=3600");
    return res.status(200).json({ results: { city, source: wv.list.length ? "https://en.wikivoyage.org/wiki/" + encodeURIComponent(wv.title.replace(/ /g, "_")) : "", sights: list } });
  } catch (e) {
    res.setHeader("cache-control", "no-store");
    return res.status(502).json({ error: { code: "server_unavailable", message: String(e.message || e).slice(0, 200) } });
  }
};
