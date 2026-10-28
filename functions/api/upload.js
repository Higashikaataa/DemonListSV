// POST /api/upload  -> guarda una imagen (solo admin) y devuelve su link
// Las imágenes se guardan en el mismo KV (LIST) con el prefijo "img:".
const MAX = 5 * 1024 * 1024; // 5 MB

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function onRequestPost({ request, env }) {
  if (!env.LIST) return json({ error: "Falta vincular el KV con el nombre LIST." }, 500);
  if (!env.ADMIN_PASSWORD || request.headers.get("x-admin-password") !== env.ADMIN_PASSWORD)
    return json({ error: "Contraseña incorrecta." }, 401);

  const type = (request.headers.get("content-type") || "").split(";")[0].trim();
  if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) return json({ error: "Solo se aceptan imágenes PNG, JPG, WEBP o GIF." }, 415);

  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return json({ error: "La imagen está vacía." }, 400);
  if (buf.byteLength > MAX) return json({ error: "La imagen pesa más de 5 MB." }, 413);

  const id = crypto.randomUUID().replace(/-/g, "");
  await env.LIST.put("img:" + id, buf, { metadata: { type } });
  return json({ url: "/api/img/" + id });
}
