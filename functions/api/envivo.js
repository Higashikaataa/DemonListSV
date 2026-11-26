// /api/envivo  -> "Progresos en vivo": lee el canal de Discord donde el mod
// "What is he doing?" (Geode) manda los new bests y completaciones de los jugadores.
//
// Necesita en Cloudflare (Settings > Variables and Secrets del proyecto):
//   DISCORD_BOT_TOKEN   (secreto)  token del bot que puede leer ese canal
//   DISCORD_CHANNEL_ID  (texto)    ID del canal donde llegan los mensajes del mod
//
//   GET                                   -> { configured, items:[...], error? }  (lee mensajes nuevos cada 45 s como mucho)
//   DELETE ?id=<mensaje> (x-admin-password) -> oculta un progreso (por ejemplo, si es falso)
//
// Los datos se guardan en el KV "LIST" con la clave "live:feed".

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const isAdmin = (request, env) => !!env.ADMIN_PASSWORD && request.headers.get("x-admin-password") === env.ADMIN_PASSWORD;

const KEY = "live:feed";
const MAX_ITEMS = 800;
const EVERY_MS = 45 * 1000;
const big = id => { try { return BigInt(id); } catch { return 0n; } };
const clean = s => String(s || "").replace(/\\([*_~`|>\\])/g, "$1").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80);

// Junta todo el texto del mensaje (contenido y embeds)
function textOf(m) {
  const parts = [m.content || ""];
  for (const e of m.embeds || []) {
    parts.push(e.title || "", e.description || "", (e.footer && e.footer.text) || "", (e.author && e.author.name) || "");
    for (const f of e.fields || []) parts.push(f.name || "", f.value || "");
  }
  return parts.join("\n");
}

// Convierte un mensaje del mod en un progreso. Devuelve null si no es un progreso.
export function parseMessage(m) {
  const t = textOf(m);
  const titles = (m.embeds || []).map(e => e.title || "").join(" ");
  const idm = t.match(/Level ID:\s*(\d{1,12})/i);
  const base = { id: String(m.id), t: Date.parse(m.timestamp) || 0, levelId: idm ? idm[1] : "" };
  let r;
  if ((r = t.match(/\*\*(.+?)\*\* reached a new best of \*\*(\d{1,3})%\*\* on \*\*(.+?)\*\* by \*\*(.+?)\*\*/)))
    return { ...base, type: "best", player: clean(r[1]), pct: Math.min(100, +r[2]), level: clean(r[3]), creator: clean(r[4]) };
  if ((r = t.match(/\*\*(.+?)\*\* got a \*\*(\d{1,3})-(\d{1,3})%\*\* run on \*\*(.+?)\*\* by \*\*(.+?)\*\*/)))
    return { ...base, type: "run", player: clean(r[1]), from: Math.min(100, +r[2]), pct: Math.min(100, +r[3]), level: clean(r[4]), creator: clean(r[5]) };
  if ((r = t.match(/\*\*(.+?)\*\* beat \*\*(.+?)\*\* by \*\*(.+?)\*\*!/))) {
    if (/practice/i.test(titles) || /practice/i.test(t.split("\n")[0])) return null; // las completaciones en práctica no cuentan
    if (/startpos/i.test(titles)) return null;
    return { ...base, type: "beat", player: clean(r[1]), pct: 100, level: clean(r[2]), creator: clean(r[3]) };
  }
  return null;
}

async function sync(env, feed) {
  const token = String(env.DISCORD_BOT_TOKEN || "").trim(), ch = String(env.DISCORD_CHANNEL_ID || "").trim();
  if (!token || !/^\d{5,25}$/.test(ch)) return "Faltan DISCORD_BOT_TOKEN o DISCORD_CHANNEL_ID en Cloudflare.";
  const have = new Set(feed.items.map(x => x.id));
  let after = feed.last || "", err = "";
  for (let page = 0; page < 5; page++) {
    const url = `https://discord.com/api/v10/channels/${ch}/messages?limit=100${after ? "&after=" + after : ""}`;
    const r = await fetch(url, { headers: { authorization: "Bot " + token, "user-agent": "DemonListSV (pages.dev, 1.0)" } });
    if (!r.ok) {
      err = r.status === 401 ? "El token del bot no es válido."
        : r.status === 403 ? "El bot no tiene permiso para leer ese canal (Ver canal y Leer el historial de mensajes)."
        : r.status === 404 ? "No se encontró el canal. Revisa DISCORD_CHANNEL_ID."
        : r.status === 429 ? "" : "Discord respondió con error " + r.status + ".";
      break;
    }
    const msgs = (await r.json()).sort((a, b) => (big(a.id) < big(b.id) ? -1 : 1));
    for (const m of msgs) {
      if (big(m.id) > big(feed.last || "0")) feed.last = m.id;
      if (have.has(String(m.id)) || (feed.hidden || []).includes(String(m.id))) continue;
      const it = parseMessage(m);
      if (it) { feed.items.push(it); have.add(it.id); }
    }
    if (!after) break;                 // la primera vez solo se leen los 100 mensajes más recientes
    if (msgs.length < 100) break;
    after = feed.last;
  }
  feed.items.sort((a, b) => (big(b.id) > big(a.id) ? 1 : -1));
  feed.items = feed.items.slice(0, MAX_ITEMS);
  return err;
}

export async function onRequestGet({ env }) {
  if (!env.LIST) return json({ error: "Falta vincular el KV con el nombre LIST." }, 500);
  const configured = !!(env.DISCORD_BOT_TOKEN && env.DISCORD_CHANNEL_ID);
  const feed = (await env.LIST.get(KEY, "json")) || { last: "", at: 0, items: [], hidden: [] };
  let error = "";
  if (configured && Date.now() - (feed.at || 0) > EVERY_MS) {
    feed.at = Date.now();
    try { error = await sync(env, feed); } catch { error = "No se pudo conectar con Discord."; }
    feed.error = error;
    await env.LIST.put(KEY, JSON.stringify(feed));
  } else error = feed.error || "";
  return json({ configured, error, items: feed.items.slice(0, 300) });
}

export async function onRequestDelete({ request, env }) {
  if (!isAdmin(request, env)) return json({ error: "Contraseña incorrecta." }, 401);
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^\d{5,25}$/.test(id)) return json({ error: "Progreso no válido." }, 400);
  const feed = (await env.LIST.get(KEY, "json")) || { last: "", at: 0, items: [], hidden: [] };
  feed.items = feed.items.filter(x => x.id !== id);
  feed.hidden = [...(feed.hidden || []), id].slice(-500);
  await env.LIST.put(KEY, JSON.stringify(feed));
  return json({ ok: true });
}
