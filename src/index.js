const HISTORY_LIMIT = 20;

function isValidState(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  // Current shape: { activeAccount, accounts:{ income:{start,events}, ... }, scorecard }
  if (parsed.accounts && typeof parsed.accounts === "object") {
    const accts = Object.values(parsed.accounts);
    return accts.length > 0 && accts.every(
      (a) => a && Array.isArray(a.events) && typeof a.start === "number"
    );
  }
  // Legacy single-account shape: { start, events, scorecard }
  return Array.isArray(parsed.events) && typeof parsed.start === "number";
}

// Pull a { start, eventCount } summary out of either state shape, for the
// History list. Multi-account: Income's start, and every account's events.
function summarizeState(state) {
  if (state && state.accounts && typeof state.accounts === "object") {
    const income = state.accounts.income || {};
    const eventCount = Object.values(state.accounts).reduce(
      (n, a) => n + (a && Array.isArray(a.events) ? a.events.length : 0),
      0
    );
    return {
      start: typeof income.start === "number" ? income.start : null,
      eventCount,
    };
  }
  return {
    start: state && typeof state.start === "number" ? state.start : null,
    eventCount: state && Array.isArray(state.events) ? state.events.length : null,
  };
}

// ---- Screenshot reconciliation ------------------------------------------------
// POST /api/reconcile takes 1..MAX_IMAGES base64 screenshots of a bank account
// and returns the transactions + balances it can read out of them, as JSON.
// It does NOT touch the database — the browser does all the matching against
// the calendar and only writes through the normal PUT /api/state (which
// snapshots history) once the user reviews and applies.
//
// Model: Llama 3.2 11B Vision is well documented for image->text on the binding
// and strong at reading dense tables. It needs a one-time Meta license
// acceptance per account (handled lazily below, or by opening the model once in
// the Workers AI Playground). Swap RECONCILE_MODEL for a no-license-gate option
// if needed: "@cf/mistralai/mistral-small-3.1-24b-instruct" or
// "@cf/moondream/moondream3.1-9B-A2B". The client may also override per request
// with a "model" field while we tune.
const RECONCILE_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const MAX_IMAGES = 6;
const MAX_IMAGE_CHARS = 3_500_000; // base64 length, ~2.6MB decoded, after client downscale

const EXTRACT_SYSTEM = `You read a screenshot of a bank account (usually the M&T mobile app) and output ONLY minified JSON. No prose, no markdown code fences.

Output shape:
{"asOf":"YYYY-MM-DD or null","postedBalance":number or null,"availableBalance":number or null,"transactions":[{"date":"YYYY-MM-DD","description":"verbatim row text","amount":number,"direction":"in or out","status":"posted or pending"}]}

Rules:
- Include EVERY transaction row visible, in the order shown. Do not summarize or skip.
- amount is always a positive number. Use "direction":"out" for withdrawals/debits/payments/fees (minus sign, parentheses, or red text) and "direction":"in" for deposits/credits.
- Read digits exactly: "$1,257.00" -> 1257, "$278.07" -> 278.07.
- Balances and amounts are dollar figures with cents and usually a "$". A masked account number like "...4821", "x4821" or "ending 4821" is NOT a balance — ignore it.
- "postedBalance" is the balance labelled Current, Present, Posted, or Ledger; "availableBalance" is the one labelled Available. Either may be absent — use null, do not guess one from the other.
- A row is "status":"pending" if it is under a "Pending" / "Processing" heading OR labelled pending; every other row is "posted". If there is no pending section, all rows are "posted".
- If the year is not shown, assume the most recent year that keeps the date in the past.
- If you cannot read a value, use null. Never invent a transaction or a number.`;

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Llama returns {response}, moondream {answer}, some models {result} or a bare
// string — normalize to the text we then dig JSON out of.
function pickModelText(out) {
  if (out == null) return "";
  if (typeof out === "string") return out;
  return out.response ?? out.answer ?? out.text ?? out.result ?? out.output_text ?? "";
}

// Pull the first well-formed JSON object out of a model reply that may be
// wrapped in ```json fences or have stray words around it.
function extractJson(text) {
  if (!text) return null;
  let t = String(text).replace(/```(?:json)?/gi, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  for (let cut = end; cut > start; cut = t.lastIndexOf("}", cut - 1)) {
    try {
      return JSON.parse(t.slice(start, cut + 1));
    } catch {
      // keep walking back to the previous closing brace
    }
  }
  return null;
}

function isAgreementError(e) {
  return /\b5016\b|not agreed|agree to|license|acceptable use/i.test(
    String((e && (e.message || e.toString())) || "") + " " + JSON.stringify(e || "")
  );
}

function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// The Llama 3.2 Vision binding has accepted `image` as an array of bytes
// historically and a base64 / data-URI string more recently. Try the byte
// array first, fall back to the raw string, so this keeps working across
// runtime versions.
async function runVision(env, model, dataUrl) {
  const base = {
    messages: [
      { role: "system", content: EXTRACT_SYSTEM },
      { role: "user", content: "Extract this bank screenshot to JSON now." },
    ],
    max_tokens: 2048,
    temperature: 0,
  };
  try {
    return await env.AI.run(model, { ...base, image: [...dataUrlToBytes(dataUrl)] });
  } catch (e) {
    if (isAgreementError(e)) throw e;
    return env.AI.run(model, { ...base, image: dataUrl });
  }
}

async function visionWithAgree(env, model, dataUrl) {
  try {
    return await runVision(env, model, dataUrl);
  } catch (e) {
    if (!isAgreementError(e)) throw e;
    try {
      await env.AI.run(model, { prompt: "agree" }); // one-time Meta license accept
    } catch {
      // fall through to the retry; if it still fails the caller surfaces it
    }
    return runVision(env, model, dataUrl);
  }
}

function normDesc(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 48);
}

// Models sometimes emit the string "null"/"none"/"" or a formatted number
// like "$3,086.89" — coerce those to a real number or null.
function cleanNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = parseFloat(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function cleanStr(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && !/^(null|none|n\/a|undefined)$/i.test(s) ? s : null;
}
function cleanDate(v) {
  const s = cleanStr(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Combine per-screenshot results into one transaction list, dropping rows that
// appear on more than one screenshot (overlapping scroll positions).
function mergeExtractions(pages) {
  const transactions = [];
  const seen = new Set();
  let asOf = null, postedBalance = null, availableBalance = null;
  for (const p of pages) {
    if (!p || !Array.isArray(p.transactions)) continue;
    const pAsOf = cleanDate(p.asOf);
    if (pAsOf && (!asOf || pAsOf > asOf)) asOf = pAsOf;
    if (postedBalance == null) postedBalance = cleanNum(p.postedBalance);
    if (availableBalance == null) availableBalance = cleanNum(p.availableBalance);
    for (const t of p.transactions) {
      if (!t) continue;
      const amt = cleanNum(t.amount);
      if (amt == null) continue;
      const abs = Math.abs(amt);
      const dir = t.direction === "in" || (t.direction == null && amt > 0) ? "in" : "out";
      const key = [cleanDate(t.date) || "", abs.toFixed(2), dir, normDesc(t.description)].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      transactions.push({
        date: cleanDate(t.date) || "",
        description: String(t.description || "").trim(),
        amount: abs,
        direction: dir,
        status: t.status === "pending" ? "pending" : "posted",
      });
    }
  }
  transactions.sort((a, b) => a.date.localeCompare(b.date));
  return { asOf, postedBalance, availableBalance, transactions };
}

async function handleReconcile(request, env) {
  if (!env.AI) {
    return jsonResponse(
      { error: "The vision model isn't enabled on this deployment yet (missing AI binding)." },
      503
    );
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length) return jsonResponse({ error: "No screenshots provided" }, 400);
  if (images.length > MAX_IMAGES) {
    return jsonResponse({ error: `Too many screenshots at once (max ${MAX_IMAGES})` }, 400);
  }
  for (const im of images) {
    if (typeof im !== "string" || !/^data:image\/(png|jpe?g|webp);base64,/.test(im)) {
      return jsonResponse({ error: "Each screenshot must be an image data URL" }, 400);
    }
    if (im.length > MAX_IMAGE_CHARS) {
      return jsonResponse({ error: "A screenshot is too large — upload fewer or smaller images" }, 413);
    }
  }
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : RECONCILE_MODEL;

  const pages = [];
  const warnings = [];
  for (let i = 0; i < images.length; i++) {
    try {
      const parsed = extractJson(pickModelText(await visionWithAgree(env, model, images[i])));
      if (parsed && Array.isArray(parsed.transactions)) {
        pages.push(parsed);
      } else {
        warnings.push(`Screenshot ${i + 1}: couldn't read a transaction list from it.`);
        pages.push({ error: "unparseable" });
      }
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 200);
      warnings.push(
        isAgreementError(e)
          ? `Screenshot ${i + 1}: the vision model needs a one-time license acceptance — open @cf/meta/llama-3.2-11b-vision-instruct once in the Cloudflare Workers AI Playground and accept Meta's terms, then retry.`
          : `Screenshot ${i + 1}: ${msg}`
      );
      pages.push({ error: msg });
    }
  }

  return jsonResponse({ ...mergeExtractions(pages), pages, warnings, model });
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
    ({ start, eventCount } = summarizeState(JSON.parse(existing.state_json)));
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

    if (url.pathname === "/api/reconcile" && request.method === "POST") {
      return handleReconcile(request, env);
    }

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
