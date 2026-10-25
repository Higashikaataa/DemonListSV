// GET  /api/list  -> devuelve la lista (pública)
// PUT  /api/list  -> guarda la lista (requiere la contraseña de admin)
//
// Requiere en Cloudflare Pages:
//   - Un KV namespace vinculado con el nombre LIST
//   - Una variable secreta ADMIN_PASSWORD

const DEFAULT = {
  title: "Mi Demonlist",
  tagline: "Datos de ejemplo: entra al modo editor para cambiarlos",
  about: "Ranking de Extreme Demons ordenados por dificultad. Estos niveles y récords son de ejemplo.",
  discordUrl: "",
  submitUrl: "",
  mainSize: 75,
  extSize: 150,
  demons: [
    { id: "ex1", name: "Tidal Wave", publisher: "OniLink", creator: "OniLink", verifier: "Zoink", levelId: "", req: 55, video: "", thumb: "", notes: "",
      records: [{ player: "Jugador Ejemplo", progress: 100, video: "" }, { player: "Otro Jugador", progress: 62, video: "" }] },
    { id: "ex2", name: "Slaughterhouse", publisher: "icedcave", creator: "icedcave", verifier: "Doggie", levelId: "", req: 60, video: "", thumb: "", notes: "",
      records: [{ player: "Otro Jugador", progress: 100, video: "" }] },
    { id: "ex3", name: "Sonic Wave", publisher: "Cyclic", creator: "Cyclic", verifier: "Sunix", levelId: "", req: 60, video: "", thumb: "", notes: "", records: [] },
    { id: "ex4", name: "Bloodbath", publisher: "Riot", creator: "Riot", verifier: "Riot", levelId: "", req: 70, video: "", thumb: "", notes: "",
      records: [{ player: "Jugador Ejemplo", progress: 100, video: "" }] }
  ]
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });

export async function onRequestGet({ env }) {
  if (!env.LIST) return json({ error: "Falta vincular el KV con el nombre LIST." }, 500);
  const data = await env.LIST.get("main");
  if (!data) return json(DEFAULT);
  return new Response(data, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

export async function onRequestPut({ request, env }) {
  if (!env.LIST) return json({ error: "Falta vincular el KV con el nombre LIST." }, 500);
  if (!env.ADMIN_PASSWORD) return json({ error: "Falta configurar la variable ADMIN_PASSWORD." }, 500);
  if (request.headers.get("x-admin-password") !== env.ADMIN_PASSWORD)
    return json({ error: "Contraseña incorrecta." }, 401);

  const body = await request.text();
  if (body.length > 20 * 1024 * 1024) return json({ error: "La lista es demasiado grande." }, 413);
  let data;
  try { data = JSON.parse(body); } catch { return json({ error: "JSON no válido." }, 400); }
  if (!data || !Array.isArray(data.demons)) return json({ error: "Falta la lista de demons." }, 400);

  await env.LIST.put("main", JSON.stringify(data));
  return json({ ok: true });
}
