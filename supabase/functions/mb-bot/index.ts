// Minor Books — Telegram bot webhook.
// Mijoz: /start → telefon raqam → ism-familiya → joylashuv → "Do'konni ochish" tugmasi.
// Admin: /start → "Do'kon" va "Admin panel" tugmalari.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

let S: Record<string, string> | null = null;
async function secrets() {
  if (S) return S;
  const { data } = await db.from("mb_secrets").select("key,value").in("key", ["bot_token", "webhook_secret", "app_url"]);
  S = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  return S!;
}
const call = async (method: string, payload: unknown) => {
  const s = await secrets();
  return fetch(`https://api.telegram.org/bot${s.bot_token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
};
const send = (chat_id: number, text: string, reply_markup?: unknown) =>
  call("sendMessage", { chat_id, text, parse_mode: "HTML", ...(reply_markup ? { reply_markup } : {}) });
const h = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

async function isAdmin(id: number) {
  const { data } = await db.from("mb_admins").select("tg_id").eq("tg_id", id).maybeSingle();
  return !!data;
}
async function getCustomer(id: number) {
  const { data } = await db.from("mb_customers").select("*").eq("tg_id", id).maybeSingle();
  return data;
}
async function saveCustomer(id: number, patch: Record<string, unknown>) {
  await db.from("mb_customers").upsert({ tg_id: id, ...patch, updated_at: new Date().toISOString() }, { onConflict: "tg_id" });
}

const REMOVE = { remove_keyboard: true };
const askPhone = (chat: number, name: string) =>
  send(chat, `Assalomu alaykum${name ? ", " + h(name) : ""}! 📚\n\n<b>minor.books</b> — diniy kitoblar do'koni.\n\nBuyurtmalaringizni tez rasmiylashtirish uchun avval telefon raqamingizni yuboring. Pastdagi tugmani bosing 👇`,
    { keyboard: [[{ text: "📱 Telefon raqamni yuborish", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true, is_persistent: true });
const askName = (chat: number, suggestion: string) =>
  send(chat, "Rahmat! ✅\n\nEndi <b>ism va familiyangizni</b> yozing.\nMasalan: <i>Abdulloh Karimov</i>",
    suggestion ? { keyboard: [[{ text: suggestion }]], resize_keyboard: true, one_time_keyboard: true } : REMOVE);
const askLocation = (chat: number) =>
  send(chat, "Yaxshi! ✅\n\nOxirgi qadam: kitoblarni yetkazib berishimiz uchun <b>joylashuvingizni</b> yuboring. Pastdagi tugmani bosing 👇\n\nDo'kondan o'zingiz olib ketsangiz, ikkinchi tugmani tanlang.",
    { keyboard: [[{ text: "📍 Joylashuvni yuborish", request_location: true }], [{ text: "🏪 Do'kondan olib ketaman" }]], resize_keyboard: true, one_time_keyboard: true, is_persistent: true });

async function shopButtons(chat: number, admin: boolean, intro: string) {
  const s = await secrets();
  // Telegram URL'dagi #hash qismini o'z ma'lumotlari bilan almashtiradi, shuning uchun rejim ?mode= orqali beriladi.
  // v= — Telegram eski sahifani keshdan ochmasligi uchun.
  const base = s.app_url.split("#")[0], sep = base.includes("?") ? "&" : "?", V = "v=3";
  const rows: unknown[][] = [[{ text: "📚 Do'konni ochish", web_app: { url: `${base}${sep}${V}` } }]];
  if (admin) rows.push([{ text: "⚙️ Admin panel", web_app: { url: `${base}${sep}${V}&mode=admin` } }]);
  // avval oddiy klaviaturani olib tashlaymiz, keyin tugmali xabar
  await send(chat, intro, REMOVE);
  await send(chat, admin ? "Do'konni ochish yoki do'konni boshqarish uchun tugmani tanlang:" : "Kitoblarni ko'rish va buyurtma berish uchun bosing:", { inline_keyboard: rows });
}

async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&accept-language=uz,ru`, {
      headers: { "User-Agent": "minorbooks-telegram-bot/1.0" }, signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const a = j.address || {};
    const parts = [a.city || a.town || a.village || a.state, a.city_district || a.suburb || a.county, a.road || a.neighbourhood, a.house_number].filter(Boolean);
    return parts.length ? parts.join(", ") : (j.display_name || null);
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const s = await secrets();
  if (!s.webhook_secret || req.headers.get("x-telegram-bot-api-secret-token") !== s.webhook_secret) {
    return new Response("forbidden", { status: 403 });
  }
  const upd = await req.json().catch(() => null);
  const msg = upd?.message;
  if (!msg?.chat?.id || msg.chat.type !== "private") return new Response("ok");
  const chat = msg.chat.id, from = msg.from || {}, id = from.id as number;
  const text = String(msg.text || "").trim();
  const tgName = [from.first_name, from.last_name].filter(Boolean).join(" ");

  try {
    const admin = await isAdmin(id);
    let c = await getCustomer(id);

    if (text.startsWith("/id")) { await send(chat, `Sizning Telegram ID: <code>${id}</code>`); return new Response("ok"); }

    if (text.startsWith("/start") || text.startsWith("/shop")) {
      if (admin && text.startsWith("/start")) {
        await shopButtons(chat, true, `Assalomu alaykum, ${h(from.first_name || "admin")}! Siz do'kon egasisiz 🔑`);
        return new Response("ok");
      }
      if (c?.step === "done") { await shopButtons(chat, admin, `Xush kelibsiz, ${h(c.full_name || from.first_name || "")}! 📚`); return new Response("ok"); }
      await saveCustomer(id, { username: from.username || null, step: c?.phone ? (c?.full_name ? "location" : "name") : "phone" });
      c = await getCustomer(id);
      if (c.step === "phone") await askPhone(chat, from.first_name || "");
      else if (c.step === "name") await askName(chat, tgName);
      else await askLocation(chat);
      return new Response("ok");
    }
    if (text.startsWith("/admin") && admin) { await shopButtons(chat, true, "Admin panel 🔑"); return new Response("ok"); }
    if (text.startsWith("/profil") || text.startsWith("/profile")) {
      await saveCustomer(id, { step: "phone" });
      await askPhone(chat, "");
      return new Response("ok");
    }

    const step = c?.step || "phone";

    if (step === "phone") {
      if (msg.contact) {
        if (msg.contact.user_id && msg.contact.user_id !== id) { await send(chat, "Iltimos, o'zingizning raqamingizni tugma orqali yuboring 👇"); return new Response("ok"); }
        let phone = String(msg.contact.phone_number || "").replace(/[^\d+]/g, "");
        if (!phone.startsWith("+")) phone = "+" + phone;
        await saveCustomer(id, { phone, username: from.username || null, step: "name" });
        await askName(chat, tgName);
      } else await askPhone(chat, "");
      return new Response("ok");
    }
    if (step === "name") {
      if (text && !text.startsWith("/") && text.length >= 2 && text.length <= 60) {
        await saveCustomer(id, { full_name: text, step: "location" });
        await askLocation(chat);
      } else await send(chat, "Ism va familiyangizni matn ko'rinishida yozing. Masalan: <i>Abdulloh Karimov</i>");
      return new Response("ok");
    }
    if (step === "location") {
      if (msg.location) {
        const { latitude: lat, longitude: lon } = msg.location;
        const address = await reverseGeocode(lat, lon);
        await saveCustomer(id, { lat, lon, address, step: "done" });
        await shopButtons(chat, admin, `Rahmat, hammasi tayyor! ✅\n\n📍 Manzil: ${h(address || "joylashuv saqlandi")}\n\nBuyurtma berganingizda ma'lumotlaringiz o'zi to'ldiriladi. Ularni /profil buyrug'i bilan yangilashingiz mumkin.`);
      } else if (text.includes("olib ketaman")) {
        await saveCustomer(id, { lat: null, lon: null, address: null, step: "done" });
        await shopButtons(chat, admin, "Rahmat, hammasi tayyor! ✅\n\nBuyurtma berganingizda ma'lumotlaringiz o'zi to'ldiriladi.");
      } else await askLocation(chat);
      return new Response("ok");
    }
    // ro'yxatdan o'tgan foydalanuvchi boshqa narsa yozsa
    await shopButtons(chat, admin, "Kitob tanlash uchun do'konni oching 👇");
  } catch (e) {
    console.error(e);
  }
  return new Response("ok");
});
