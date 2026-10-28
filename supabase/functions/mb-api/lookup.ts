// Kitob ma'lumotlarini internetdan topish: avval hilolnashr.uz (o'zbek diniy kitoblarining asosiy nashriyoti),
// topilmasa Open Library. Natija lotin yozuvida qaytariladi: tavsif, sahifalar soni, muallif, nashriyot, muqova.

const UA = { "User-Agent": "Mozilla/5.0 (compatible; MinorBooksBot/1.0)", "Accept-Language": "uz,ru;q=0.8" };
const HILOL = "https://hilolnashr.uz";

const C2L: Record<string, string> = {
  "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo", "ж": "j", "з": "z", "и": "i", "й": "y",
  "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f",
  "х": "x", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sh", "ъ": "'", "ы": "i", "ь": "", "э": "e", "ю": "yu", "я": "ya",
  "ў": "o'", "қ": "q", "ғ": "g'", "ҳ": "h",
};
const VOWEL_OR_START = /[\s«»"'(\-—–.,!?:;/аеёиоуўэюяaeiou]/i;

/** O'zbek kirill → lotin. Lotin matnga tegmaydi. */
export function cyr2lat(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], lo = ch.toLowerCase();
    let r = C2L[lo];
    if (r === undefined) { out += ch; continue; }
    if (lo === "е" && (i === 0 || VOWEL_OR_START.test(s[i - 1]))) r = "ye";
    if (lo === "ц" && (i === 0 || VOWEL_OR_START.test(s[i - 1]))) r = "s";
    if (ch !== lo && r) {
      const next = s[i + 1] || "";
      const nextUpper = /\p{L}/u.test(next) && next === next.toUpperCase() && next !== next.toLowerCase();
      r = nextUpper ? r.toUpperCase() : r[0].toUpperCase() + r.slice(1);
    }
    out += r;
  }
  return out.replace(/[ʼ’`]/g, "'");
}

/** Lotin → kirill (faqat qidiruv uchun, taxminiy). */
export function lat2cyr(s: string): string {
  s = s.toLowerCase().replace(/[‘’ʻʼ`]/g, "'");
  const pairs: [string, string][] = [["o'", "ў"], ["g'", "ғ"], ["sh", "ш"], ["ch", "ч"], ["yo", "ё"], ["yu", "ю"], ["ya", "я"], ["ye", "е"]];
  const one: Record<string, string> = {
    a: "а", b: "б", d: "д", e: "е", f: "ф", g: "г", h: "ҳ", i: "и", j: "ж", k: "к", l: "л", m: "м", n: "н", o: "о",
    p: "п", q: "қ", r: "р", s: "с", t: "т", u: "у", v: "в", x: "х", y: "й", z: "з", "'": "ъ",
  };
  let o = "";
  for (let i = 0; i < s.length;) {
    const p = pairs.find(([a]) => s.startsWith(a, i));
    if (p) { o += p[1]; i += p[0].length; continue; }
    const c = s[i];
    o += c === "e" && (i === 0 || /[\s(«"\-]/.test(s[i - 1])) ? "э" : (one[c] ?? c);
    i++;
  }
  return o;
}

const STOP = new Set(["va", "jild", "jildlik", "juz", "juzlar", "qutida", "kitob", "kitobi", "lotin", "yozuvida", "kirill",
  "muqova", "yumshoq", "qattiq", "nashr", "the", "and", "uchun", "bilan", "bir", "ham"]);
export function tokens(s: string): string[] {
  return cyr2lat(s || "").toLowerCase().replace(/[‘’ʻʼ`]/g, "'").replace(/[^a-z0-9' ]+/g, " ")
    .split(" ").map((w) => w.replace(/^'+|'+$/g, "")).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}
function score(query: string[], cand: string[]): number {
  if (!query.length || !cand.length) return 0;
  const c = new Set(cand);
  const hit = query.filter((w) => c.has(w) || [...c].some((x) => x.length > 4 && w.length > 4 && (x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5))))).length;
  return hit / query.length - Math.max(0, cand.length - query.length) * 0.04;
}

const ENT: Record<string, string> = { nbsp: " ", laquo: "«", raquo: "»", quot: '"', amp: "&", apos: "'", lt: "<", gt: ">", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };
function decode(s: string) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
function htmlToText(html: string) {
  return decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
}

async function get(url: string, ms = 9000) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms), redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

type Cand = { url: string; name: string; img: string | null; s: number };
async function hilolSearch(q: string): Promise<Cand[]> {
  const html = await get(`${HILOL}/index.php?route=product/search&search=${encodeURIComponent(q)}&limit=30`);
  const i = html.indexOf('id="content"');
  const body = i >= 0 ? html.slice(i) : html;
  const out: Cand[] = [];
  const re = /<a href="([^"]+)" class="product-img[^"]*">\s*<div>\s*<img src="([^"]+)"(?:\s+srcset="([^"]*)")?[\s\S]*?<div class="name"><a href="[^"]+">([^<]+)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) && out.length < 30) {
    const big = (m[3] || "").split(",").map((x) => x.trim().split(" ")[0]).filter(Boolean).pop() || m[2];
    out.push({ url: m[1].split("?")[0], name: decode(m[4]).trim(), img: big || null, s: 0 });
  }
  return out;
}

function sumPages(t: string): number | null {
  const seg = (t.match(/Hajmi[^\n]*:?([\s\S]{0,400}?)(?:ISBN|O'lchami|Muqova|Sana|\n\n|$)/i) || [])[1] || "";
  const nums = [...seg.matchAll(/(\d{2,4})\s*(?:bet|sahifa|стр)/gi)].map((x) => +x[1]).filter((n) => n >= 8 && n <= 3000);
  if (nums.length) return nums.reduce((a, b) => a + b, 0);
  const any = t.match(/(\d{2,4})\s*(?:bet|sahifa)\b/i);
  return any ? +any[1] : null;
}
function field(t: string, label: RegExp) {
  const m = t.match(new RegExp(`(?:^|\\n)\\s*${label.source}\\s*:?\\s*([^\\n]{2,120})`, "i"));
  return m ? m[1].replace(/^[:\s]+/, "").replace(/\s+/g, " ").trim() : null;
}
function shorten(s: string, max = 700) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf(".\n"));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…").trim();
}
const cleanPub = (p: string | null) => p ? p.replace(/«|»|"/g, "").replace(/\s*nashriyot-matbaasi|\s*nashriyoti/gi, "").replace(/^\s*[HN]ilol[\s-]*nashr\s*$/i, "Hilol-nashr").trim() || null : null;

async function hilolProduct(c: Cand) {
  const html = await get(c.url);
  const s = html.indexOf('block-content expand-content">');
  let block = s >= 0 ? html.slice(s + 30, s + 40000) : "";
  // tavsif bloki maydonlardan (Муаллиф:, Ҳажми: ...) keyingi birinchi </div> bilan tugaydi;
  // matn ichida imzo uchun alohida <div>lar bo'lishi mumkin
  const f = block.search(/Ҳажми|Ҳажм:|Hajmi|ISBN|Муаллиф:|Muallif:/);
  const e = block.indexOf("</div>", f > 0 ? f : 0);
  if (e > 0) block = block.slice(0, e);
  const text = cyr2lat(htmlToText(block));
  const big = (html.match(/data-largeimg="([^"]+)"/) || [])[1] || c.img;
  const metaDesc = cyr2lat(decode((html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || ""));
  const author = field(text, /Muallif(?:i|lar)?/);
  const publisher = cleanPub(field(text, /Nashriyot/));
  const pages = sumPages(text);
  // tavsif: maydonlar ("Muallif:", "Nashriyot:" ...) boshlanguncha bo'lgan matn
  const stopAt = text.search(/\n\s*(Muallif|Nashriyot|Tarjimon|Sana|Hajmi|ISBN)[^\n]{0,20}:/i);
  let desc = (stopAt > 0 ? text.slice(0, stopAt) : text).split("\n").map((x) => x.trim()).filter(Boolean)
    .filter((x) => !/^\d{1,2}\.\d{1,2}\.\d{4}/.test(x));
  const nameTok = tokens(c.name);
  // birinchi qatordagi sarlavha va "Risola haqida" kabi bosh qatorlarni olib tashlash
  while (desc.length && (desc[0].length < 60 && (score(nameTok, tokens(desc[0])) > 0.6 || /^[A-Z'\s«»!?.-]+$/.test(desc[0]) || /haqida$/i.test(desc[0])))) desc.shift();
  // oxiridagi imzo (so'zboshi muallifi ismi) qatorlarini olib tashlash
  while (desc.length > 1 && desc[desc.length - 1].length < 45 && !/[.!?:…»]$/.test(desc[desc.length - 1])) desc.pop();
  let description = desc.join("\n").replace(/\n{2,}/g, "\n").trim();
  if (description.length < 40) description = metaDesc;
  return {
    title: cyr2lat(c.name).replace(/^«|»$/g, "").replace(/«|»/g, "").trim(),
    author, publisher, pages, description: description ? shorten(description) : null, cover: big || null, source: c.url,
  };
}

async function openLibrary(title: string, author: string | null) {
  const q = new URLSearchParams({ title, limit: "5", fields: "title,author_name,number_of_pages_median,publisher,cover_i,key,first_sentence" });
  if (author) q.set("author", author);
  const j = JSON.parse(await get(`https://openlibrary.org/search.json?${q}`, 7000));
  const qt = tokens(title);
  const d = (j.docs || []).map((x: any) => ({ x, s: score(qt, tokens(x.title)) })).sort((a: any, b: any) => b.s - a.s)[0];
  if (!d || d.s < 0.75) return null;
  const x = d.x;
  return {
    title: x.title, author: x.author_name?.[0] || null, publisher: x.publisher?.[0] || null, pages: x.number_of_pages_median || null,
    description: Array.isArray(x.first_sentence) ? x.first_sentence[0] : null,
    cover: x.cover_i ? `https://covers.openlibrary.org/b/id/${x.cover_i}-L.jpg` : null, source: `https://openlibrary.org${x.key}`,
  };
}

// to'plam so'ralganda bitta juz/jild (masalan "28-juz") mos emas
export function partPenalty(query: string, name: string): number {
  const q = cyr2lat(query).toLowerCase().replace(/[–—]/g, "-"), n = cyr2lat(name).toLowerCase().replace(/[–—]/g, "-");
  const one = n.match(/(\d+)\s*-\s*(juz|jild|qism|kitob)/);
  if (!one) return 0;
  // to'plam (qutida, 1-4 juz, ...) so'ralgan, nomzod esa bitta qism
  if (/qutida|to'plam|jildlik|\d+\s*-\s*\d+/.test(q) && !/qutida|to'plam|\d+\s*,\s*\d+/.test(n)) return 0.5;
  const same = new RegExp(`(^|\\D)${one[1]}\\s*-?\\s*${one[2]}`).test(q) || new RegExp(`(^|\\D)${one[1]}(\\D|$)`).test(q.replace(/\d+\s*-\s*\d+/g, " "));
  return same ? 0 : 0.5;
}

export async function lookupBook(title: string, author: string | null) {
  title = String(title || "").trim();
  if (title.length < 3) return { found: false, reason: "Kitob nomi juda qisqa" };
  const qt = tokens(title);
  const at = tokens(author || "");
  if (!qt.length) return { found: false, reason: "Kitob nomi juda qisqa" };
  // qidiruv so'zlari: eng uzun 2 ta so'z (kirill va lotinda)
  const key = [...qt].sort((a, b) => b.length - a.length).slice(0, 2).join(" ");
  const queries = [lat2cyr(key), key, lat2cyr(qt[0])];
  const seen = new Map<string, Cand>();
  const lists = await Promise.allSettled(queries.map(hilolSearch));
  for (const l of lists) if (l.status === "fulfilled") for (const c of l.value) if (!seen.has(c.url)) seen.set(c.url, c);
  // kitob uchun aksessuarlar (jild, muqova, quti) kitobning o'zi emas
  const ACC = /(^|\s|\()(jild|muqova|g'ilof|quti|xatcho'p)\b[^)]*\buchun\b|^jild\b|^g'ilof\b|^xatcho'p/i;
  const wantsAcc = /\b(jild|g'ilof|xatcho'p)\b/i.test(title) && /uchun/i.test(title);
  const cands = [...seen.values()].filter((c) => wantsAcc || !ACC.test(cyr2lat(c.name).toLowerCase()))
    .map((c) => ({ ...c, s: score(qt, tokens(c.name)) - partPenalty(title, c.name) })).sort((a, b) => b.s - a.s);
  let best: any = null;
  const top = cands.slice(0, 3).filter((c) => c.s >= 0.6);
  const pages = await Promise.allSettled(top.map(hilolProduct));
  for (let i = 0; i < top.length; i++) {
    const c = top[i], pr = pages[i];
    if (pr.status !== "fulfilled") continue;
    {
      const p = pr.value;
      if (!p.description && !p.pages) continue;
      // muallif yozilgan bo'lsa, mos kelgani ustun
      const adj = c.s + (at.length && p.author ? (score(at, tokens(p.author)) > 0 ? 0.2 : -0.25) : 0)
        + (p.pages ? 0.06 : 0) + (p.author ? 0.03 : 0);
      if (!best || adj > best.adj) best = { adj, p, s: c.s };
    }
  }
  if (best && best.adj >= 0.55) return { found: true, ...best.p, match: Math.round(best.s * 100) };
  try {
    const o = await openLibrary(title, author);
    if (o && (o.pages || (o.description && o.description.length > 40))) return { found: true, ...o, publisher: cleanPub(o.publisher), match: 80 };
  } catch { /* e'tiborsiz */ }
  return { found: false, reason: "Internetda bu kitob haqida ma'lumot topilmadi" };
}
