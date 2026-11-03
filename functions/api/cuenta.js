// /api/cuenta  -> cuentas de jugadores
//
// POST con JSON { action, ... }:
//   register { name, password }  -> crea la cuenta (si ese nombre no tiene una) y devuelve { token, name }
//   login    { name, password }  -> devuelve { token, name }
//   me                            -> (header x-session) devuelve { name, profile }
//   logout                        -> (header x-session) cierra la sesión
//   profile  { profile }          -> (header x-session) guarda foto, canal, color, banner y descripción
//   password { password, newPassword } -> (header x-session) cambia la contraseña
//   reset    { name }             -> (header x-admin-password) borra la cuenta para que se pueda volver a crear
//
// Datos en el KV "LIST":
//   user:<nombre en minúsculas>   -> { name, salt, hash, iter }
//   session:<token>               -> nombre en minúsculas (dura 1 año)
//   profiles                      -> { "<nombre en minúsculas>": { avatar, youtube, nameColor, banner, bio } }

const ITER = 10000; // bajo a propósito: el plan gratis de Cloudflare limita el tiempo de CPU
const SESSION_TTL = 60 * 60 * 24 * 365;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const pkey = n => String(n || "").trim().toLowerCase();
const cleanName = n => String(n || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();

function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""); }
async function hashPw(password, saltHex, iter) {
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return hex(bits);
}
function sameStr(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function newSession(env, k, sid) {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await env.LIST.put("session:" + token, sid ? k + "|" + sid : k, { expirationTtl: SESSION_TTL });
  return token;
}
// Índice de nombres con cuenta, para que salgan en el leaderboard aunque no tengan récords
async function addAccount(env, name) {
  const list = (await env.LIST.get("accounts", "json")) || [];
  if (list.some(n => pkey(n) === pkey(name))) return;
  list.push(name);
  await env.LIST.put("accounts", JSON.stringify(list));
}
async function removeAccount(env, k) {
  const list = (await env.LIST.get("accounts", "json")) || [];
  const next = list.filter(n => pkey(n) !== k);
  if (next.length !== list.length) await env.LIST.put("accounts", JSON.stringify(next));
}

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
async function blockedList(env) { return (await env.LIST.get("blocked", "json")) || []; }

// Solo se aceptan imágenes subidas al sitio o links https
const okImg = v => { v = String(v || "").trim(); return (/^\/api\/img\/[a-f0-9]{32}$/.test(v) || /^https:\/\/[^\s"'<>()]{4,400}$/.test(v)) ? v : ""; };
const DEPTS = ["ahuachapan","santa-ana","sonsonate","chalatenango","la-libertad","san-salvador","cuscatlan","la-paz","cabanas","san-vicente","usulutan","san-miguel","morazan","la-union"];
function cleanProfile(p) {
  p = p || {};
  return {
    avatar: okImg(p.avatar),
    banner: okImg(p.banner),
    youtube: String(p.youtube || "").trim().slice(0, 200).replace(/[\s"'<>]/g, ""),
    nameColor: /^#[0-9a-f]{6}$/i.test(p.nameColor || "") ? p.nameColor : "",
    bio: String(p.bio || "").replace(/\r/g, "").slice(0, 400).trim(),
    dept: DEPTS.includes(p.dept) ? p.dept : ""
  };
}

export async function onRequestPost({ request, env }) {
  if (!env.LIST) return json({ error: "Falta vincular el KV con el nombre LIST." }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Datos no válidos." }, 400); }
  const action = body.action;

  if (action === "register" || action === "login") {
    const name = cleanName(body.name), k = pkey(name), pw = String(body.password || "");
    if (name.length < 2 || name.length > 40) return json({ error: "El nombre debe tener entre 2 y 40 caracteres." }, 400);
    if (pw.length < 6 || pw.length > 200) return json({ error: "La contraseña debe tener al menos 6 caracteres." }, 400);
    const existing = await env.LIST.get("user:" + k, "json");

    if (action === "register") {
      if (existing) return json({ error: "Ese nombre ya tiene cuenta. Usa “Iniciar sesión”." }, 409);
      if ((await blockedList(env)).some(n => pkey(n) === k)) return json({ error: "Ese nombre no está disponible." }, 403);
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      const sid = hex(crypto.getRandomValues(new Uint8Array(8)));
      await env.LIST.put("user:" + k, JSON.stringify({ name, salt, hash: await hashPw(pw, salt, ITER), iter: ITER, sid, created: Date.now() }));
      await addAccount(env, name);
      return json({ token: await newSession(env, k, sid), name });
    }
    if (!existing) return json({ error: "Ese nombre todavía no tiene cuenta. Usa “Crear cuenta”." }, 404);
    const h = await hashPw(pw, existing.salt, existing.iter || ITER);
    if (!sameStr(h, existing.hash)) return json({ error: "Contraseña incorrecta." }, 401);
    await addAccount(env, existing.name);
    return json({ token: await newSession(env, k, existing.sid), name: existing.name });
  }

  // Moderadores: eliminar una cuenta definitivamente (cuenta, perfil y envíos pendientes)
  if (action === "delete") {
    if (!isAdmin(request, env)) return json({ error: "Contraseña incorrecta." }, 401);
    const name = cleanName(body.name), k = pkey(name);
    if (!k) return json({ error: "Falta el nombre." }, 400);
    await env.LIST.delete("user:" + k);
    await removeAccount(env, k);
    const profiles = (await env.LIST.get("profiles", "json")) || {};
    if (profiles[k]) { delete profiles[k]; await env.LIST.put("profiles", JSON.stringify(profiles)); }
    const subs = await env.LIST.list({ prefix: "sub:" + encodeURIComponent(k) + ":" });
    await Promise.all(subs.keys.map(x => env.LIST.delete(x.name)));
    if (body.block) {
      const list = await blockedList(env);
      if (!list.some(n => pkey(n) === k)) { list.push(name); await env.LIST.put("blocked", JSON.stringify(list)); }
    }
    return json({ ok: true, removedSubs: subs.keys.length });
  }
  if (action === "blocked") {
    if (!isAdmin(request, env)) return json({ error: "Contraseña incorrecta." }, 401);
    return json({ names: await blockedList(env) });
  }
  if (action === "unblock") {
    if (!isAdmin(request, env)) return json({ error: "Contraseña incorrecta." }, 401);
    const k = pkey(body.name);
    await env.LIST.put("blocked", JSON.stringify((await blockedList(env)).filter(n => pkey(n) !== k)));
    return json({ ok: true });
  }

  if (action === "reset") {
    if (!env.ADMIN_PASSWORD || request.headers.get("x-admin-password") !== env.ADMIN_PASSWORD) return json({ error: "Contraseña incorrecta." }, 401);
    const k = pkey(body.name);
    if (!k) return json({ error: "Falta el nombre." }, 400);
    await env.LIST.delete("user:" + k);
    await removeAccount(env, k);
    return json({ ok: true });
  }

  const me = await sessionUser(request, env);
  if (!me) return json({ error: "Tu sesión terminó. Inicia sesión otra vez." }, 401);

  if (action === "me") {
    await addAccount(env, me.name); // cuentas creadas antes de este cambio
    const profiles = (await env.LIST.get("profiles", "json")) || {};
    return json({ name: me.name, profile: profiles[me.k] || {} });
  }
  if (action === "logout") {
    await env.LIST.delete("session:" + me.token);
    return json({ ok: true });
  }
  if (action === "profile") {
    const profiles = (await env.LIST.get("profiles", "json")) || {};
    profiles[me.k] = cleanProfile(body.profile);
    await env.LIST.put("profiles", JSON.stringify(profiles));
    return json({ ok: true, profile: profiles[me.k] });
  }
  if (action === "password") {
    const now = await hashPw(String(body.password || ""), me.user.salt, me.user.iter || ITER);
    if (!sameStr(now, me.user.hash)) return json({ error: "La contraseña actual no es correcta." }, 401);
    const np = String(body.newPassword || "");
    if (np.length < 6 || np.length > 200) return json({ error: "La nueva contraseña debe tener al menos 6 caracteres." }, 400);
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    await env.LIST.put("user:" + me.k, JSON.stringify({ ...me.user, salt, hash: await hashPw(np, salt, ITER), iter: ITER }));
    return json({ ok: true });
  }
  return json({ error: "Acción desconocida." }, 400);
}
