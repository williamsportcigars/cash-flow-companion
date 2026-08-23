const HISTORY_LIMIT = 20;

function isValidState(parsed) {
  return !!parsed && Array.isArray(parsed.events) && typeof parsed.start === "number";
}

// Snapshot whatever is currently saved for this user into cashflow_history
// before it gets overwritten, then prune down to the most recent
// HISTORY_LIMIT snapshots. No-op if there's nothing saved yet.
async function snapshotCurrent(env, user) {
  const existing = await env.DB.prepare(
    "SELECT state_json, updated_at FROM cashflow WHERE user_id = ?"
  ).bind(user).first();
  if (!existing) return;

  let start = null;
  let eventCount = null;
  try {
    const old = JSON.parse(existing.state_json);
    start = typeof old.start === "number" ? old.start : null;
    eventCount = Array.isArray(old.events) ? old.events.length : null;
  } catch {
    // Corrupt snapshot content shouldn't block the write; store it with no summary.
  }

  await env.DB.prepare(
    "INSERT INTO cashflow_history(user_id,state_json,start,event_count,saved_at) VALUES(?,?,?,?,?)"
  ).bind(user, existing.state_json, start, eventCount, existing.updated_at).run();

  await env.DB.prepare(
    "DELETE FROM cashflow_history WHERE user_id = ? AND id NOT IN " +
    "(SELECT id FROM cashflow_history WHERE user_id = ? ORDER BY id DESC LIMIT ?)"
  ).bind(user, user, HISTORY_LIMIT).run();
}

async function writeState(env, user, stateJson) {
  await env.DB.prepare(
    "INSERT INTO cashflow(user_id,state_json,updated_at) VALUES(?,?,datetime('now')) " +
    "ON CONFLICT(user_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at"
  ).bind(user, stateJson).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const user = request.headers.get("Cf-Access-Authenticated-User-Email") || "default";

    if (url.pathname === "/api/state") {
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
        if (!isValidState(parsed)) {
          return new Response("Invalid state", { status: 400 });
        }
        await snapshotCurrent(env, user);
        await writeState(env, user, JSON.stringify(parsed));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/state/history" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, saved_at, start, event_count FROM cashflow_history " +
        "WHERE user_id = ? ORDER BY id DESC LIMIT ?"
      ).bind(user, HISTORY_LIMIT).all();
      return new Response(JSON.stringify(results), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const historyItemMatch = url.pathname.match(/^\/api\/state\/history\/(\d+)$/);
    if (historyItemMatch && request.method === "GET") {
      const id = Number(historyItemMatch[1]);
      const row = await env.DB.prepare(
        "SELECT state_json, saved_at FROM cashflow_history WHERE user_id = ? AND id = ?"
      ).bind(user, id).first();
      if (!row) return new Response("Not found", { status: 404 });
      return new Response(row.state_json, {
        headers: { "Content-Type": "application/json" },
      });
    }

    const restoreMatch = url.pathname.match(/^\/api\/state\/restore\/(\d+)$/);
    if (restoreMatch && request.method === "POST") {
      const id = Number(restoreMatch[1]);
      const snap = await env.DB.prepare(
        "SELECT state_json FROM cashflow_history WHERE user_id = ? AND id = ?"
      ).bind(user, id).first();
      if (!snap) return new Response("Not found", { status: 404 });

      // Snapshot the current state first, so restoring is itself undoable.
      await snapshotCurrent(env, user);
      await writeState(env, user, snap.state_json);

      return new Response(snap.state_json, {
        headers: { "Content-Type": "application/json" },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
