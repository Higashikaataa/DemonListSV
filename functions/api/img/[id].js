// GET /api/img/<id>  -> devuelve una imagen subida
export async function onRequestGet({ params, env }) {
  const id = String(params.id || "");
  if (!env.LIST || !/^[a-f0-9]{32}$/.test(id)) return new Response("No encontrada", { status: 404 });
  const { value, metadata } = await env.LIST.getWithMetadata("img:" + id, { type: "arrayBuffer" });
  if (!value) return new Response("No encontrada", { status: 404 });
  return new Response(value, {
    headers: {
      "content-type": (metadata && metadata.type) || "image/jpeg",
      "cache-control": "public, max-age=31536000, immutable"
    }
  });
}
