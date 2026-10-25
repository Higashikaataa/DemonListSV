// POST /api/login  -> comprueba la contraseña de admin
export async function onRequestPost({ request, env }) {
  const ok = !!env.ADMIN_PASSWORD && request.headers.get("x-admin-password") === env.ADMIN_PASSWORD;
  return new Response(JSON.stringify({ ok }), {
    status: ok ? 200 : 401,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
