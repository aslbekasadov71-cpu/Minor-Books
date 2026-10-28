// Minor Books — server API: admin amallari va buyurtma xabarnomasi.
// Admin bo'lishi Telegram initData imzosi (bot tokeni bilan) va mb_admins jadvali orqali tekshiriladi.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { lookupBook } from "./lookup.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (message: string, status = 400) => json({ error: message }, status);

let tokenCache: string | null = null;
async function botToken(): Promise<string> {
  if (tokenCache) return tokenCache;
  const { data, error } = await db.from("mb_secrets").select("value").eq("key", "bot_token").single();
  if (error || !data) throw new Error("Bot tokeni topilmadi");
  tokenCache = data.value;
  return tokenCache!;
}

const enc = new TextEncoder();
async function hmac(key: ArrayBuffer | Uint8Array, msg: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// Telegram Mini App initData imzosini tekshirish
async function tgUser(initData: string | undefined) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac(enc.encode("WebAppData"), await botToken());
  if (hex(await hmac(secret, check)) !== hash) return null;
  const age = Date.now() / 1000 - Number(p.get("auth_date") || 0);
  if (age > 7 * 24 * 3600) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch { return null; }
}
async function isAdmin(id?: number) {
  if (!id) return false;
  const { data } = await db.from("mb_admins").select("tg_id").eq("tg_id", id).maybeSingle();
  return !!data;
}

async function tgSend(chat_id: number, text: string, extra: Record<string, unknown> = {}) {
  const r = await fetch(`https://api.telegram.org/bot${await botToken()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra }),
  });
  return r.ok;
}
const h = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const som = (n: number) => Number(n || 0).toLocaleString("ru-RU").replace(/[\s,]/g, " ") + " so'm";
const STATUS: Record<string, string> = {
  new: "Yangi", confirmed: "Tasdiqlandi", shipped: "Yo'lda", done: "Yetkazildi", cancelled: "Bekor qilindi",
};

async function notifyOrder(order_no: string) {
  const { data: o } = await db.from("mb_orders").select("*, mb_order_items(title,price,qty)").eq("order_no", order_no).maybeSingle();
  if (!o || o.notified) return { sent: false };
  if (Date.now() - new Date(o.created_at).getTime() > 15 * 60 * 1000) return { sent: false };
  await db.from("mb_orders").update({ notified: true }).eq("id", o.id);
  const lines = (o.mb_order_items || []).map((i: any) => `• ${h(i.title)} × ${i.qty} — ${som(i.price * i.qty)}`).join("\n");
  const text = `🆕 <b>Yangi buyurtma ${h(o.order_no)}</b>\n\n` +
    `👤 ${h(o.customer_name)}${o.tg_username ? " (@" + h(o.tg_username) + ")" : ""}\n📞 ${h(o.phone)}\n` +
    `${o.delivery_type === "delivery" ? "🚚 Yetkazib berish: " + h(o.address) : "🏪 Do'kondan olib ketadi"}\n` +
    `${o.comment ? "💬 " + h(o.comment) + "\n" : ""}\n${lines}\n\n<b>Jami: ${som(o.total)}</b>`;
  const { data: admins } = await db.from("mb_admins").select("tg_id");
  // mijoz botda joylashuv yuborgan bo'lsa, xaritada ko'rsatish
  let loc: { lat: number; lon: number } | null = null;
  if (o.tg_user_id && o.delivery_type === "delivery") {
    const { data: c } = await db.from("mb_customers").select("lat,lon").eq("tg_id", o.tg_user_id).maybeSingle();
    if (c?.lat != null && c?.lon != null) loc = { lat: c.lat, lon: c.lon };
  }
  for (const a of admins || []) {
    await tgSend(a.tg_id, text).catch(() => {});
    if (loc) await fetch(`https://api.telegram.org/bot${await botToken()}/sendLocation`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: a.tg_id, latitude: loc.lat, longitude: loc.lon }),
    }).catch(() => {});
  }
  if (o.tg_user_id) {
    await tgSend(o.tg_user_id, `✅ Buyurtmangiz qabul qilindi: <b>${h(o.order_no)}</b>\nJami: ${som(o.total)}\n\nOperatorimiz tez orada ${h(o.phone)} raqamiga qo'ng'iroq qilib tasdiqlaydi.`).catch(() => {});
  }
  return { sent: true };
}

const BOOK_FIELDS = ["title", "author", "category_id", "price", "old_price", "pages", "publisher", "stock", "is_new", "is_active", "cover_url", "description"];
function cleanBook(b: any) {
  const out: Record<string, unknown> = {};
  for (const k of BOOK_FIELDS) if (k in b) out[k] = b[k] === "" ? null : b[k];
  if (!out.title || String(out.title).trim() === "") throw new Error("Kitob nomini yozing");
  for (const k of ["price", "old_price", "pages", "stock", "category_id"]) {
    if (out[k] != null) { const n = Math.round(Number(out[k])); if (!Number.isFinite(n) || n < 0) throw new Error("Raqamlar noto'g'ri"); out[k] = n; }
  }
  if (out.price == null) throw new Error("Narxni yozing");
  if (out.stock == null) out.stock = 0;
  if (out.old_price != null && Number(out.old_price) <= Number(out.price)) out.old_price = null;
  out.updated_at = new Date().toISOString();
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail("POST kerak", 405);
  let body: any;
  try { body = await req.json(); } catch { return fail("JSON noto'g'ri"); }
  const action = body.action;

  try {
    // ochiq amal: yangi buyurtma haqida xabar
    if (action === "notify") return json(await notifyOrder(String(body.order_no || "")));

    // xizmat tekshiruvi (faqat maxfiy kalit bilan): kitob qidiruvini sinash
    if (action === "lookup_test") {
      const { data: sec } = await db.from("mb_secrets").select("value").eq("key", "webhook_secret").single();
      if (!sec || body.secret !== sec.value) return fail("forbidden", 403);
      const out = [];
      for (const t of (body.items || []).slice(0, 20)) out.push({ q: t, r: await lookupBook(t.title, t.author || null).catch((e) => ({ error: String(e) })) });
      return json({ out });
    }

    const user = await tgUser(body.initData);
    const admin = await isAdmin(user?.id);
    if (action === "whoami") return json({ admin, user: user ? { id: user.id, first_name: user.first_name } : null });
    if (action === "profile") {
      if (!user) return json({ profile: null });
      const { data } = await db.from("mb_customers").select("phone,full_name,lat,lon,address,step").eq("tg_id", user.id).maybeSingle();
      return json({ profile: data, admin });
    }
    if (!admin) return fail("Bu amal faqat admin uchun", 403);

    switch (action) {
      case "list_books": {
        const { data, error } = await db.from("mb_books").select("*").order("id", { ascending: false });
        if (error) throw error;
        return json({ books: data });
      }
      case "save_book": {
        const b = cleanBook(body.book || {});
        const id = body.book?.id;
        const q = id ? db.from("mb_books").update(b).eq("id", id).select().single() : db.from("mb_books").insert(b).select().single();
        const { data, error } = await q;
        if (error) throw error;
        return json({ book: data });
      }
      case "delete_book": {
        const { error } = await db.from("mb_books").delete().eq("id", body.id);
        if (error) throw error;
        return json({ ok: true });
      }
      case "save_category": {
        const name = String(body.name || "").trim();
        if (!name) throw new Error("Bo'lim nomini yozing");
        const q = body.id
          ? db.from("mb_categories").update({ name }).eq("id", body.id).select().single()
          : db.from("mb_categories").insert({ name, sort: 100 }).select().single();
        const { data, error } = await q;
        if (error) throw error;
        return json({ category: data });
      }
      case "list_orders": {
        const { data, error } = await db.from("mb_orders").select("*, mb_order_items(title,price,qty)").order("id", { ascending: false }).limit(100);
        if (error) throw error;
        return json({ orders: data });
      }
      case "set_order_status": {
        const status = String(body.status);
        if (!STATUS[status]) throw new Error("Holat noto'g'ri");
        const { data, error } = await db.from("mb_orders").update({ status }).eq("id", body.id).select().single();
        if (error) throw error;
        if (data.tg_user_id && body.notify !== false) {
          await tgSend(data.tg_user_id, `📦 Buyurtma <b>${h(data.order_no)}</b> holati: <b>${STATUS[status]}</b>`).catch(() => {});
        }
        return json({ order: data });
      }
      case "lookup_book": {
        const r: any = await lookupBook(String(body.title || ""), body.author ? String(body.author) : null);
        // muqovani o'z omborimizga ko'chiramiz (begona sayt rasmi keyinchalik o'chib ketmasligi uchun)
        if (r.found && r.cover && body.want_cover) {
          try {
            const img = await fetch(r.cover, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(9000) });
            const type = (img.headers.get("content-type") || "image/jpeg").split(";")[0];
            const bytes = new Uint8Array(await img.arrayBuffer());
            if (img.ok && bytes.length > 2000 && bytes.length < 5 * 1024 * 1024 && type.startsWith("image/")) {
              const path = `books/${crypto.randomUUID()}.${type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg"}`;
              const { error } = await db.storage.from("mb-covers").upload(path, bytes, { contentType: type, upsert: false });
              if (!error) r.cover = db.storage.from("mb-covers").getPublicUrl(path).data.publicUrl;
            }
          } catch { /* muqovasiz qaytaramiz */ }
        }
        return json(r);
      }
      case "upload_cover": {
        const type = String(body.contentType || "image/jpeg");
        if (!["image/jpeg", "image/png", "image/webp"].includes(type)) throw new Error("Faqat JPG, PNG yoki WEBP rasm");
        const bytes = Uint8Array.from(atob(String(body.base64 || "")), (c) => c.charCodeAt(0));
        if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error("Rasm hajmi 5 MB dan oshmasin");
        const path = `books/${crypto.randomUUID()}.${type.split("/")[1].replace("jpeg", "jpg")}`;
        const { error } = await db.storage.from("mb-covers").upload(path, bytes, { contentType: type, upsert: false });
        if (error) throw error;
        return json({ url: db.storage.from("mb-covers").getPublicUrl(path).data.publicUrl });
      }
      default:
        return fail("Noma'lum amal");
    }
  } catch (e) {
    return fail((e as Error).message || "Xatolik yuz berdi", 500);
  }
});
