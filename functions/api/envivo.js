// /api/envivo  -> "Progresos en vivo": lee el canal de Discord donde el mod
// "What is he doing?" (Geode) manda los new bests, completaciones, runs y muertes de los jugadores.
//
// Necesita en Cloudflare (Settings > Variables and Secrets del proyecto):
//   DISCORD_BOT_TOKEN   (secreto)  token del bot que puede leer ese canal
//   DISCORD_CHANNEL_ID  (texto)    ID del canal donde llegan los mensajes del mod
//
//   GET                                     -> { configured, items:[...], error? }
//   DELETE ?id=<mensaje> (x-admin-password) -> oculta un progreso (por ejemplo, si es falso)
//
// Las capturas no se copian a la página: se muestran desde Discord. Los links de Discord
// caducan, así que se renuevan con el bot cuando están por vencer.
// Los datos se guardan en el KV "LIST" con la clave "live:feed".

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const isAdmin = (request, env) => !!env.ADMIN_PASSWORD && request.headers.get("x-admin-password") === env.ADMIN_PASSWORD;

const KEY = "live:feed";
const MAX_ITEMS = 800;
const SHOW = 300;
const EVERY_MS = 45 * 1000;          // como mucho una lectura de Discord cada 45 s
const SAVE_EVERY_MS = 10 * 60 * 1000; // si no hay nada nuevo, se guarda como mucho cada 10 min (el plan gratis limita las escrituras)
const API = "https://discord.com/api/v10";
const big = id => { try { return BigInt(id); } catch { return 0n; } };
const clean = s => String(s || "").replace(/\\([*_~`|>\\])/g, "$1").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80);
const headers = env => ({ authorization: "Bot " + String(env.DISCORD_BOT_TOKEN || "").trim(), "user-agent": "DemonListSV (pages.dev, 1.1)" });
let lastSync = 0; // memoria de este servidor, para no preguntar a Discord en cada visita

function textOf(m) {
  const parts = [m.content || ""];
  for (const e of m.embeds || []) {
    parts.push(e.title || "", e.description || "", (e.footer && e.footer.text) || "", (e.author && e.author.name) || "");
    for (const f of e.fields || []) parts.push(f.name || "", f.value || "");
  }
  return parts.join("\n");
}
// La captura viene como imagen del embed o como archivo "screenshot.png"
function shotOf(m) {
  for (const e of m.embeds || []) if (e.image && /^https:\/\//.test(e.image.url || "")) return e.image.url;
  const a = (m.attachments || []).find(x => /^screenshot/i.test(x.filename || "") && /^https:\/\//.test(x.url || ""));
  return a ? a.url : "";
}
const expOf = u => { try { return parseInt(new URL(u).searchParams.get("ex") || "0", 16) || 0; } catch { return 0; } };

// Convierte un mensaje del mod en un progreso. Devuelve null si no es un progreso.
export function parseMessage(m) {
  const t = textOf(m);
  const titles = (m.embeds || []).map(e => e.title || "").join(" ");
  const idm = t.match(/Level ID:\s*(\d{1,12})/i);
  const base = { id: String(m.id), t: Date.parse(m.timestamp) || 0, levelId: idm ? idm[1] : "", img: shotOf(m) };
  let r;
  if ((r = t.match(/\*\*(.+?)\*\* reached a new best of \*\*(\d{1,3})%\*\* on \*\*(.+?)\*\* by \*\*(.+?)\*\*/)))
    return { ...base, type: "best", player: clean(r[1]), pct: Math.min(100, +r[2]), level: clean(r[3]), creator: clean(r[4]) };
  if ((r = t.match(/\*\*(.+?)\*\* got a \*\*(\d{1,3})-(\d{1,3})%\*\* run on \*\*(.+?)\*\* by \*\*(.+?)\*\*/)))
    return { ...base, type: "run", player: clean(r[1]), from: Math.min(100, +r[2]), pct: Math.min(100, +r[3]), level: clean(r[4]), creator: clean(r[5]), died: /died/i.test(titles) };
  if ((r = t.match(/\*\*(.+?)\*\* died at \*\*(\d{1,3})%\*\* on \*\*(.+?)\*\* by \*\*(.+?)\*\*/)))
    return { ...base, type: "death", player: clean(r[1]), pct: Math.min(100, +r[2]), level: clean(r[3]), creator: clean(r[4]) };
  if ((r = t.match(/\*\*(.+?)\*\* beat \*\*(.+?)\*\* by \*\*(.+?)\*\*!/))) {
    if (/practice|startpos/i.test(titles)) return null; // las completaciones en práctica no cuentan
    return { ...base, type: "beat", player: clean(r[1]), pct: 100, level: clean(r[2]), creator: clean(r[3]) };
  }
  return null;
}

async function sync(env, feed) {
  const ch = String(env.DISCORD_CHANNEL_ID || "").trim();
  if (!/^\d{5,25}$/.test(ch)) return { err: "DISCORD_CHANNEL_ID no es una ID de canal válida.", added: 0 };
  const have = new Set(feed.items.map(x => x.id));
  let after = feed.last || "", err = "", added = 0;
  for (let page = 0; page < 5; page++) {
    const r = await fetch(`${API}/channels/${ch}/messages?limit=100${after ? "&after=" + after : ""}`, { headers: headers(env) });
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
      if (!it) continue;
      if (it.img) { feed.imgs[it.id] = { u: it.img, exp: expOf(it.img) }; }
      delete it.img; it.hasImg = !!feed.imgs[it.id];
      feed.items.push(it); have.add(it.id); added++;
    }
    if (!after) break;                 // la primera vez solo se leen los 100 mensajes más recientes
    if (msgs.length < 100) break;
    after = feed.last;
  }
  feed.items.sort((a, b) => (big(b.id) > big(a.id) ? 1 : -1));
  feed.items = feed.items.slice(0, MAX_ITEMS);
  return { err, added };
}

// Renueva los links de las capturas que ya vencieron o vencen en menos de 1 hora
async function refreshShots(env, feed) {
  const now = Date.now() / 1000;
  const need = feed.items.slice(0, SHOW).filter(x => feed.imgs[x.id] && feed.imgs[x.id].exp - now < 3600).slice(0, 150);
  let changed = 0;
  for (let i = 0; i < need.length; i += 50) {
    const chunk = need.slice(i, i + 50);
    const r = await fetch(`${API}/attachments/refresh-urls`, {
      method: "POST", headers: { ...headers(env), "content-type": "application/json" },
      body: JSON.stringify({ attachment_urls: chunk.map(x => feed.imgs[x.id].u) })
    });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const map = new Map((d.refreshed_urls || []).map(x => [x.original, x.refreshed]));
    for (const x of chunk) {
      const nu = map.get(feed.imgs[x.id].u);
      if (nu) { feed.imgs[x.id] = { u: nu, exp: expOf(nu) }; changed++; }
    }
  }
  return changed;
}

export async function onRequestGet({ env }) {
  if (!env.LIST) return json({ error: "Falta vincular el KV con el nombre LIST." }, 500);
  const configured = !!(env.DISCORD_BOT_TOKEN && env.DISCORD_CHANNEL_ID);
  const feed = (await env.LIST.get(KEY, "json")) || {};
  feed.items = feed.items || []; feed.hidden = feed.hidden || []; feed.imgs = feed.imgs || {};
  let error = feed.error || "";
  const now = Date.now();
  if (configured && now - Math.max(feed.at || 0, lastSync) > EVERY_MS) {
    lastSync = now;
    let added = 0, renewed = 0;
    try { const s = await sync(env, feed); error = s.err; added = s.added; } catch { error = "No se pudo conectar con Discord."; }
    try { if (!error) renewed = await refreshShots(env, feed); } catch {}
    // quitar capturas de progresos que ya no se guardan
    const keep = new Set(feed.items.map(x => x.id));
    for (const k of Object.keys(feed.imgs)) if (!keep.has(k)) delete feed.imgs[k];
    if (added || renewed || error !== (feed.error || "") || now - (feed.at || 0) > SAVE_EVERY_MS) {
      feed.at = now; feed.error = error;
      await env.LIST.put(KEY, JSON.stringify(feed));
    }
  }
  const items = feed.items.slice(0, SHOW).map(x => feed.imgs[x.id] ? { ...x, img: feed.imgs[x.id].u } : x);
  return json({ configured, error, items });
}

export async function onRequestDelete({ request, env }) {
  if (!isAdmin(request, env)) return json({ error: "Contraseña incorrecta." }, 401);
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^\d{5,25}$/.test(id)) return json({ error: "Progreso no válido." }, 400);
  const feed = (await env.LIST.get(KEY, "json")) || {};
  feed.items = (feed.items || []).filter(x => x.id !== id);
  feed.hidden = [...(feed.hidden || []), id].slice(-500);
  if (feed.imgs) delete feed.imgs[id];
  await env.LIST.put(KEY, JSON.stringify(feed));
  return json({ ok: true });
}
