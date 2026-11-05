// /api/envios  -> récords enviados por los jugadores, esperando aprobación
//
//   POST   (header x-session)          { levelId, kind:"list"|"up"|"run", levelName, progress, from, video, note }
//   GET    (header x-session)          -> los envíos pendientes de ese jugador
//   GET    (header x-admin-password)   -> todos los envíos pendientes (moderadores)
//   DELETE ?id=<id> (admin, o el mismo jugador para cancelar el suyo)
//
// Cada envío es una clave "sub:<jugador>:<id>" y sus datos van en los metadatos,
// así la lista completa se lee con una sola consulta.

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const MAX_PENDING = 25;

// La sesión guarda "nombre|sid". Si la cuenta se borra y alguien la vuelve a crear,
// tendrá otro sid y las sesiones viejas ya no sirven.
async function sessionUser(request, env) {
  const t = request.headers.get("x-session") || "";
  if (!/^[a-f0-9]{64}$/.test(t)) return null;
  const v = await env.LIST.get("session:" + t);
  if (!v) return null;
  const [k, sid] = v.split("|");
  const u = await env.LIST.get("user:" + k, "json");
  if (!u || (sid ? u.sid !== sid : !!u.sid)) return null;
  return { k, name: u.name, token: t, user: u };
}
const isAdmin = (request, env) => !!env.ADMIN_PASSWORD && request.headers.get("x-admin-password") === env.ADMIN_PASSWORD;
const prefixFor = k => "sub:" + encodeURIComponent(k) + ":";

async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const r = await env.LIST.list({ prefix, cursor });
    for (const x of r.keys) if (x.metadata) out.push({ id: x.name, ...x.metadata });
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out.sort((a, b) => a.date - b.date);
}

export async function onRequestGet({ request, env }) {
  if (!env.LIST) return json({ error: "Falta vincular el KV con el nombre LIST." }, 500);
  if (isAdmin(request, env)) return json({ items: await listAll(env, "sub:") });
  const me = await sessionUser(request, env);
  if (!me) return json({ error: "Inicia sesión para ver tus envíos." }, 401);
  return json({ items: await listAll(env, prefixFor(me.k)) });
}

export async function onRequestPost({ request, env }) {
  if (!env.LIST) return json({ error: "Falta vincular el KV con el nombre LIST." }, 500);
  const me = await sessionUser(request, env);
  if (!me) return json({ error: "Inicia sesión para enviar récords." }, 401);
  let b;
  try { b = await request.json(); } catch { return json({ error: "Datos no válidos." }, 400); }

  const kind = ["up", "run", "copy"].includes(b.kind) ? b.kind : "list";
  const from = kind === "run" ? Math.round(Number(b.from)) : 0;
  const levelId = String(b.levelId || "").slice(0, 40);
  const levelName = String(b.levelName || "").replace(/[\u0000-\u001f]/g, "").slice(0, 60);
  const progress = Math.round(Number(b.progress));
  const video = String(b.video || "").trim().slice(0, 200);
  const note = String(b.note || "").replace(/[\u0000-\u001f]/g, " ").slice(0, 80);

  if (!levelId || !levelName) return json({ error: "Elige un nivel." }, 400);

  // Sugerencia de copia permitida (LDM, startpos, bugfix…): solo quien completó el nivel o tiene su list%
  if (kind === "copy") {
    const copyType = String(b.copyType || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 30);
    const gdId = String(b.gdId || "").trim();
    if (!copyType) return json({ error: "Elige el tipo de copia." }, 400);
    if (!/^\d{1,12}$/.test(gdId)) return json({ error: "La ID del nivel debe ser solo números." }, 400);
    const main = await env.LIST.get("main", "json");
    const d = main && Array.isArray(main.demons) ? main.demons.find(x => x.id === levelId) : null;
    if (!d) return json({ error: "Ese nivel no está en la lista." }, 404);
    const pk = n => String(n || "").trim().toLowerCase();
    if (!(pk(d.verifier) === me.k || (d.records || []).some(r => pk(r.player) === me.k)))
      return json({ error: "Solo quienes completaron el nivel o tienen su list% pueden sugerir copias." }, 403);
    const prefix = prefixFor(me.k);
    const mine = await env.LIST.list({ prefix });
    if (mine.keys.length >= MAX_PENDING) return json({ error: `Ya tienes ${MAX_PENDING} envíos pendientes. Espera a que los revisen.` }, 429);
    const id = prefix + Date.now().toString(36) + crypto.randomUUID().slice(0, 6);
    const meta = { player: me.name, kind, levelId, levelName, copyType, gdId, note, progress: 0, video: "", date: Date.now() };
    await env.LIST.put(id, "1", { metadata: meta });
    return json({ ok: true, item: { id, ...meta } });
  }

  if (!(progress >= 1 && progress <= 100)) return json({ error: "El progreso debe estar entre 1 y 100." }, 400);
  if (kind === "run" && !(from >= 0 && from < progress)) return json({ error: "El run debe empezar antes de donde termina (ej. 20 a 100)." }, 400);
  let host = "";
  try { const u = new URL(video); if (u.protocol === "https:" || u.protocol === "http:") host = u.hostname.toLowerCase(); } catch {}
  if (!/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return json({ error: "Pon el link de YouTube del video." }, 400);

  const prefix = prefixFor(me.k);
  const mine = await env.LIST.list({ prefix });
  if (mine.keys.length >= MAX_PENDING) return json({ error: `Ya tienes ${MAX_PENDING} envíos pendientes. Espera a que los revisen.` }, 429);

  const id = prefix + Date.now().toString(36) + crypto.randomUUID().slice(0, 6);
  const meta = { player: me.name, kind, levelId, levelName, progress, video, note, date: Date.now() };
  if (kind === "run") meta.from = from;
  await env.LIST.put(id, "1", { metadata: meta });
  return json({ ok: true, item: { id, ...meta } });
}

export async function onRequestDelete({ request, env }) {
  if (!env.LIST) return json({ error: "Falta vincular el KV con el nombre LIST." }, 500);
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!id.startsWith("sub:")) return json({ error: "Envío no válido." }, 400);
  if (!isAdmin(request, env)) {
    const me = await sessionUser(request, env);
    if (!me || !id.startsWith(prefixFor(me.k))) return json({ error: "No puedes borrar este envío." }, 401);
  }
  await env.LIST.delete(id);
  return json({ ok: true });
}
