// /api/opiniones  -> opiniones y enjoyment de los niveles de la lista
//
//   GET    ?level=<id>                         -> { items:[{name, score, text, date}], avg, count }
//   POST   (header x-session) { level, score, text } -> guarda o cambia la opinión del jugador
//   DELETE ?level=<id>  (header x-session)    -> borra la opinión propia
//   DELETE ?level=<id>&name=<n> (header x-admin-password) -> un moderador borra cualquier opinión
//
// Solo pueden opinar quienes verificaron el nivel o tienen un récord en él
// (los récords solo se aceptan desde el list% o al 100%).
// Cada nivel se guarda en la clave "rev:<id>".

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const pkey = n => String(n || "").trim().toLowerCase();
const isAdmin = (request, env) => !!env.ADMIN_PASSWORD && request.headers.get("x-admin-password") === env.ADMIN_PASSWORD;
const okId = id => /^[\w-]{1,40}$/.test(id);

async function sessionUser(request, env) {
  const t = request.headers.get("x-session") || "";
  if (!/^[a-f0-9]{64}$/.test(t)) return null;
  const v = await env.LIST.get("session:" + t);
  if (!v) return null;
  const [k, sid] = v.split("|");
  const u = await env.LIST.get("user:" + k, "json");
  if (!u || (sid ? u.sid !== sid : !!u.sid)) return null;
  return { k, name: u.name };
}

function summary(map) {
  const items = Object.values(map || {}).sort((a, b) => b.date - a.date);
  const avg = items.length ? Math.round(items.reduce((s, x) => s + x.score, 0) / items.length * 10) / 10 : null;
  return { items, avg, count: items.length };
}

export async function onRequestGet({ request, env }) {
  if (!env.LIST) return json({ error: "Falta vincular el KV con el nombre LIST." }, 500);
  const level = new URL(request.url).searchParams.get("level") || "";
  if (!okId(level)) return json({ error: "Nivel no válido." }, 400);
  return json(summary(await env.LIST.get("rev:" + level, "json")));
}

export async function onRequestPost({ request, env }) {
  if (!env.LIST) return json({ error: "Falta vincular el KV con el nombre LIST." }, 500);
  const me = await sessionUser(request, env);
  if (!me) return json({ error: "Inicia sesión para opinar." }, 401);
  let b;
  try { b = await request.json(); } catch { return json({ error: "Datos no válidos." }, 400); }
  const level = String(b.level || "");
  const score = Math.round(Number(b.score));
  const text = String(b.text || "").replace(/\r/g, "").trim().slice(0, 500);
  if (!okId(level)) return json({ error: "Nivel no válido." }, 400);
  if (!(score >= 1 && score <= 100)) return json({ error: "El enjoyment debe ser de 1 a 100." }, 400);

  const main = await env.LIST.get("main", "json");
  const d = main && Array.isArray(main.demons) ? main.demons.find(x => x.id === level) : null;
  if (!d) return json({ error: "Ese nivel no está en la lista." }, 404);
  const can = pkey(d.verifier) === me.k || (d.records || []).some(r => pkey(r.player) === me.k);
  if (!can) return json({ error: "Solo pueden opinar quienes completaron el nivel o tienen su list%." }, 403);

  const map = (await env.LIST.get("rev:" + level, "json")) || {};
  map[me.k] = { name: me.name, score, text, date: Date.now() };
  await env.LIST.put("rev:" + level, JSON.stringify(map));
  return json({ ok: true, ...summary(map) });
}

export async function onRequestDelete({ request, env }) {
  if (!env.LIST) return json({ error: "Falta vincular el KV con el nombre LIST." }, 500);
  const url = new URL(request.url);
  const level = url.searchParams.get("level") || "";
  if (!okId(level)) return json({ error: "Nivel no válido." }, 400);
  let k;
  if (isAdmin(request, env) && url.searchParams.get("name")) k = pkey(url.searchParams.get("name"));
  else {
    const me = await sessionUser(request, env);
    if (!me) return json({ error: "Inicia sesión." }, 401);
    k = me.k;
  }
  const map = (await env.LIST.get("rev:" + level, "json")) || {};
  delete map[k];
  await env.LIST.put("rev:" + level, JSON.stringify(map));
  return json({ ok: true, ...summary(map) });
}
