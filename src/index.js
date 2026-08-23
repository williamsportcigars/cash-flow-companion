export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/state") {
      const user = request.headers.get("Cf-Access-Authenticated-User-Email") || "default";

      if (request.method === "GET") {
        const row = await env.DB.prepare(
          "SELECT state_json FROM cashflow WHERE user_id = ?"
        ).bind(user).first();
        if (!row) {
          return new Response(JSON.stringify(null), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(row.state_json, {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (request.method === "PUT") {
        const body = await request.text();
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }
        if (!parsed || !Array.isArray(parsed.events) || typeof parsed.start !== "number") {
          return new Response("Invalid state", { status: 400 });
        }
        await env.DB.prepare(
          "INSERT INTO cashflow(user_id,state_json,updated_at) VALUES(?,?,datetime('now')) " +
          "ON CONFLICT(user_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at"
        ).bind(user, JSON.stringify(parsed)).run();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Method not allowed", { status: 405 });
    }

    return env.ASSETS.fetch(request);
  },
};
