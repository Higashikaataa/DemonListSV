// /api/discord  -> avisa en un canal de Discord cuando se acepta un récord
//
// Usa un webhook de Discord guardado como secreto "DISCORD_WEBHOOK" en Cloudflare
// (Servidor de Discord > Editar canal > Integraciones > Webhooks > Nuevo webhook > Copiar URL).
//
//   POST (header x-admin-password) { text, video }  -> manda el mensaje
//   POST (header x-admin-password) { test:true }     -> manda un mensaje de prueba

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const isAdmin = (request, env) => !!env.ADMIN_PASSWORD && request.headers.get("x-admin-password") === env.ADMIN_PASSWORD;

export async function onRequestPost({ request, env }) {
  if (!isAdmin(request, env)) return json({ error: "Contraseña incorrecta." }, 401);
  const hook = String(env.DISCORD_WEBHOOK || "").trim();
  if (!/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(hook))
    return json({ error: "Falta el secreto DISCORD_WEBHOOK en Cloudflare (o el link no es de un webhook de Discord)." }, 400);
  let b;
  try { b = await request.json(); } catch { return json({ error: "Datos no válidos." }, 400); }

  let content;
  if (b.test) content = "✅ Mensaje de prueba: los récords aceptados en la demonlist van a salir en este canal.";
  else {
    content = String(b.text || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 400);
    if (!content) return json({ error: "Mensaje vacío." }, 400);
    let host = "";
    const video = String(b.video || "").trim().slice(0, 200);
    try { const u = new URL(video); if (u.protocol === "https:" || u.protocol === "http:") host = u.hostname.toLowerCase(); } catch {}
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) content += "\n" + video;
  }
  // allowed_mentions vacío: nadie puede usar @everyone o menciones desde un nombre
  const r = await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
  if (!r.ok) return json({ error: "Discord respondió con error " + r.status + ". Revisa que el webhook siga existiendo." }, 502);
  return json({ ok: true });
}
