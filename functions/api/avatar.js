// GET /api/avatar?yt=<canal de YouTube>   -> foto de perfil del canal
// GET /api/avatar?dc=<ID de usuario de Discord> -> foto de perfil de Discord
//
// Discord solo entrega la foto real si configuras el secreto DISCORD_BOT_TOKEN
// (ver LEEME.md). Sin él se muestra el avatar por defecto de Discord.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function ytPageUrl(input) {
  let v = String(input || "").trim();
  if (!v) return null;
  try {
    if (/^https?:\/\//i.test(v)) {
      const u = new URL(v);
      if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return null;
      const path = u.pathname.split("/").filter(Boolean);
      if (!path.length) return null;
      if (path[0].startsWith("@")) return "https://www.youtube.com/" + path[0];
      if (["channel", "c", "user"].includes(path[0]) && path[1]) return "https://www.youtube.com/" + path[0] + "/" + path[1];
      return null;
    }
  } catch { return null; }
  if (/^UC[\w-]{22}$/.test(v)) return "https://www.youtube.com/channel/" + v;
  v = v.replace(/^@/, "");
  if (!/^[\w.\-]{2,100}$/.test(v)) return null;
  return "https://www.youtube.com/@" + v;
}

async function youtubeAvatar(input) {
  const page = ytPageUrl(input);
  if (!page) return null;
  const r = await fetch(page, {
    headers: { "user-agent": UA, "accept-language": "es-ES,es;q=0.9,en;q=0.8", cookie: "CONSENT=YES+1; SOCS=CAI" }
  });
  if (!r.ok) return null;
  const html = await r.text();
  let m = html.match(/"avatar":\{"thumbnails":\[\{"url":"(https:[^"]+)"/);
  if (!m) m = html.match(/<meta property="og:image" content="([^"]+)"/);
  if (!m) return null;
  return m[1].replace(/\\u0026/g, "&").replace(/=s\d+(-[^"&]*)?$/, "=s176-c-k-c0x00ffffff-no-rj");
}

async function discordAvatar(id, env) {
  if (!/^\d{15,22}$/.test(id)) return null;
  if (env.DISCORD_BOT_TOKEN) {
    const r = await fetch("https://discord.com/api/v10/users/" + id, { headers: { authorization: "Bot " + env.DISCORD_BOT_TOKEN } });
    if (r.ok) {
      const u = await r.json();
      if (u.avatar) return `https://cdn.discordapp.com/avatars/${id}/${u.avatar}.${u.avatar.startsWith("a_") ? "gif" : "png"}?size=128`;
    }
  }
  const idx = Number((BigInt(id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const yt = url.searchParams.get("yt"), dc = url.searchParams.get("dc");
  const cache = caches.default;
  const key = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;

  let target = null;
  try {
    if (yt) target = await youtubeAvatar(yt);
    else if (dc) target = await discordAvatar(dc, env);
  } catch { target = null; }

  const miss = () => new Response("No encontrada", { status: 404, headers: { "cache-control": "public, max-age=1800" } });
  if (!target) return miss();
  const img = await fetch(target, { headers: { "user-agent": UA } });
  if (!img.ok) return miss();

  const res = new Response(img.body, {
    headers: { "content-type": img.headers.get("content-type") || "image/jpeg", "cache-control": "public, max-age=86400" }
  });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
