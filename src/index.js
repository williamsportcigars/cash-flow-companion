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

const VISION_PASSES = 1; // reads per screenshot (union of the passes)

function extractSystem(today) {
  return `Today is ${today}. ` + EXTRACT_SYSTEM;
}

const EXTRACT_SYSTEM = `You are an OCR system for the M&T Bank mobile app "Account Details" screen. Output ONLY minified JSON, no prose, no markdown fences.

Output shape:
{"asOf":"the newest transaction date","postedBalance":number|null,"availableBalance":number|null,"transactions":[{"date":"exactly as printed, e.g. 09/02/2026","description":"the bold merchant/description line only","amount":number,"direction":"in"|"out","status":"posted"|"pending"}]}

The screen layout, per transaction row:
- LEFT: a description (1-2 lines) with a date like "09/02/2026" underneath it.
- RIGHT: the transaction amount on top (GREEN with no minus = money IN; RED with a leading "-" = money OUT), and BELOW it a smaller grey line "Total Balance: $X". That "Total Balance:" line is the running account balance AFTER that transaction — it is NOT a transaction. NEVER emit a transaction for a "Total Balance" figure.

Rules:
- One JSON object per transaction row. Include every row, in the order shown, from both the "Pending" and "Posted" sections.
- "amount" is the top-right figure only, as a positive number. "$278.07" -> 278.07, "-$1,046.06" -> 1046.06, "-$17.81" -> 17.81 (keep the cents — never drop the decimal point).
- "direction": "out" if the amount is red or has a leading "-", else "in".
- "description": just the main line (e.g. "ACCOUNTANTSWORLD PAYROLL", "HC CIGARS DAYTONA", "MTBMERCHANT DEPOSIT"). Do not include the "Total Balance" text.
- "status": "pending" for rows under the "Pending" header, "posted" for rows under "Posted".
- Balances: the two big numbers at the top. "postedBalance" = the one labelled "Total Balance"; "availableBalance" = the one labelled "Available Balance". A number in parentheses after the account name (e.g. "(2708)") is an account number, not a balance.
- If a value is genuinely unreadable use null. Never invent a row, a date, or a number.`;

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

// Llama 3.2 Vision wants a top-level `image` byte array; newer multimodal
// models (Llama 4, GLM, Qwen) want OpenAI-style content parts with image_url.
async function runVision(env, model, dataUrl, today) {
  const sys = extractSystem(today);
  const ask = "Extract this bank screenshot to JSON now.";
  if (/llama-3\.2/.test(model)) {
    return env.AI.run(model, {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: ask },
      ],
      image: [...dataUrlToBytes(dataUrl)],
      max_tokens: 4096,
      temperature: 0,
    });
  }
  return env.AI.run(model, {
    messages: [
      { role: "system", content: sys },
      {
        role: "user",
        content: [
          { type: "text", text: ask },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: 4096,
    temperature: 0,
  });
}

async function visionWithAgree(env, model, dataUrl, today) {
  try {
    return await runVision(env, model, dataUrl, today);
  } catch (e) {
    if (!isAgreementError(e)) throw e;
    try {
      await env.AI.run(model, { prompt: "agree" }); // one-time Meta license accept
    } catch {
      // fall through to the retry; if it still fails the caller surfaces it
    }
    return runVision(env, model, dataUrl, today);
  }
}

// Read one screenshot VISION_PASSES times and union the transactions — one
// pass frequently drops a row that another pass reads fine.
async function readImage(env, model, dataUrl, today) {
  const runs = await Promise.allSettled(
    Array.from({ length: VISION_PASSES }, () => visionWithAgree(env, model, dataUrl, today))
  );
  const parsed = [];
  let lastErr = null;
  for (const r of runs) {
    if (r.status === "fulfilled") {
      const p = extractJson(pickModelText(r.value));
      if (p && Array.isArray(p.transactions)) parsed.push(p);
    } else {
      lastErr = r.reason;
    }
  }
  if (!parsed.length) throw lastErr || new Error("could not read this screenshot");
  return mergeExtractions(parsed, today); // union of the passes for this one image
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
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

// Accept the many date shapes a bank UI / model produces and return YYYY-MM-DD
// (year may be missing/wrong — repairYear fixes that next).
function cleanDate(v, today) {
  let s = cleanStr(v);
  if (!s) return null;
  s = s.trim();
  let m, y, mo, d;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?/))) {
    mo = +m[1]; d = +m[2]; y = m[3] ? +m[3] : null;
    if (y != null && y < 100) y += 2000;
  } else if ((m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/))) {
    mo = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase() === "sept" ? 4 : 3)]; d = +m[2]; y = m[3] ? +m[3] : null;
  } else return null;
  if (!mo || mo > 12 || !d || d > 31) return null;
  if (y == null) y = today ? Number(today.slice(0, 4)) : new Date().getUTCFullYear();
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Models routinely stamp the wrong YEAR on a row they otherwise read fine (they
// often only see month + day). Snap the year to whichever of last year / this
// year puts the date closest to today without landing in the future.
function repairYear(dateStr, today) {
  const d = cleanDate(dateStr, today);
  if (!d || !today) return d;
  const t = Date.parse(today + "T12:00:00");
  let best = d, bestGap = Infinity;
  const y0 = Number(today.slice(0, 4));
  for (let dy = -1; dy <= 1; dy++) {
    const cand = (y0 + dy) + d.slice(4);
    const ct = Date.parse(cand + "T12:00:00");
    if (Number.isNaN(ct) || ct - t > 86400000) continue;
    const gap = Math.abs(ct - t);
    if (gap < bestGap) { bestGap = gap; best = cand; }
  }
  return best;
}

// Combine per-screenshot results into one transaction list, dropping rows that
// appear on more than one screenshot (overlapping scroll positions).
function mergeExtractions(pages, today) {
  const transactions = [];
  const seen = new Set();
  let asOf = null, postedBalance = null, availableBalance = null;
  for (const p of pages) {
    if (!p || !Array.isArray(p.transactions)) continue;
    const pAsOf = repairYear(p.asOf, today);
    if (pAsOf && (!asOf || pAsOf > asOf)) asOf = pAsOf;
    if (postedBalance == null) postedBalance = cleanNum(p.postedBalance);
    if (availableBalance == null) availableBalance = cleanNum(p.availableBalance);
    for (const t of p.transactions) {
      if (!t) continue;
      const amt = cleanNum(t.amount);
      if (amt == null) continue;
      const desc = String(t.description || "").trim();
      // Guard against the model emitting the "Total Balance: $X" running-balance
      // line (or a bare number) as if it were a transaction.
      if (/total\s*balance|running\s*balance|available\s*balance/i.test(desc)) continue;
      if (!desc || /^[\s$0-9,.\-()]+$/.test(desc)) continue;
      const abs = Math.abs(amt);
      const dir = t.direction === "in" || (t.direction == null && amt > 0) ? "in" : "out";
      const date = repairYear(t.date, today) || "";
      const key = [date, abs.toFixed(2), dir, normDesc(t.description)].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      transactions.push({
        date,
        description: desc,
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
  const today = new Date().toISOString().slice(0, 10);

  const pages = [];
  const warnings = [];
  for (let i = 0; i < images.length; i++) {
    try {
      pages.push(await readImage(env, model, images[i], today));
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 200);
      warnings.push(
        isAgreementError(e)
          ? `Screenshot ${i + 1}: the vision model needs a one-time license acceptance — open ${RECONCILE_MODEL} once in the Cloudflare Workers AI Playground and accept Meta's terms, then retry.`
          : `Screenshot ${i + 1}: couldn't read it (${msg}).`
      );
      pages.push({ error: msg });
    }
  }

  return jsonResponse({ ...mergeExtractions(pages, today), pages, warnings, model, today });
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
