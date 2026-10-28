// Minor Books — Telegram bot webhook: /start ga do'konni ochish tugmasi bilan javob beradi.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

async function secrets() {
  const { data } = await db.from("mb_secrets").select("key,value").in("key", ["bot_token", "webhook_secret", "app_url"]);
  return Object.fromEntries((data || []).map((r) => [r.key, r.value])) as Record<string, string>;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const s = await secrets();
  if (!s.webhook_secret || req.headers.get("x-telegram-bot-api-secret-token") !== s.webhook_secret) {
    return new Response("forbidden", { status: 403 });
  }
  const upd = await req.json().catch(() => null);
  const msg = upd?.message;
  if (!msg?.chat?.id) return new Response("ok");
  const text = String(msg.text || "");
  const call = (method: string, payload: unknown) =>
    fetch(`https://api.telegram.org/bot${s.bot_token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });

  if (text.startsWith("/start") || text.startsWith("/shop") || text.startsWith("/menu")) {
    const name = msg.from?.first_name ? `, ${msg.from.first_name}` : "";
    const reply: Record<string, unknown> = {
      chat_id: msg.chat.id,
      text: `Assalomu alaykum${name}! 📚\n\nminor.books — diniy kitoblar do'koni. Kitoblarni ko'rish va buyurtma berish uchun quyidagi tugmani bosing.`,
    };
    if (s.app_url) reply.reply_markup = { inline_keyboard: [[{ text: "📚 Do'konni ochish", web_app: { url: s.app_url } }]] };
    else reply.text += "\n\nDo'kon tez orada ochiladi.";
    await call("sendMessage", reply);
  } else if (text.startsWith("/id")) {
    await call("sendMessage", { chat_id: msg.chat.id, text: `Sizning Telegram ID: ${msg.from?.id}` });
  }
  return new Response("ok");
});
