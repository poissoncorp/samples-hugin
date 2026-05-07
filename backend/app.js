const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require('axios');
const ravendb = require("ravendb");
const { performance } = require("perf_hooks");
const { DB_NAME, EMB_TASK_IDENTIFIER } = require("./db-config");

const documentStore = new ravendb.DocumentStore(
  process.env.RAVENDB_URL || "http://127.0.0.1:8080",
  DB_NAME
);
documentStore.initialize();

// Boot/keeper state. /api/boot-status reports the live readiness of each
// stage to the frontend BootScreen. /api/ready is a legacy thin probe.
const bootState = {
  startedAt: Date.now(),
  iterationsCompleted: 0,
  lastUserSearchAt: 0,         // ms epoch — set on every /api/search hit
  lastKeeperRunAt: 0,          // ms epoch — set on every keeper cycle
  lastKeeperError: null,
};

// Index existence flags — null=unknown, true=present, false=absent.
// On the Hugin-q4 minimal-schema DB, QuestionsSearch and QuestionsTags
// don't exist; without these flags the /api/search handler throws inside
// RavenDB's index-not-found path and catches it. On a busy Pi that
// throw+catch costs 1–5 s per request (measured live: 0.97 s at low
// load, 4.80 s at load avg ~7). With the flag we skip the RavenDB call
// entirely on subsequent requests after one detection failure.
let hasTagsIndex = null;
let hasQuestionsSearchIndex = null;
async function _detectIndex(name) {
  try {
    const session = documentStore.openSession();
    await session.query({ indexName: name }).take(1).all();
    return true;
  } catch (err) {
    if (/Could not find index/i.test((err && err.message) || "")) return false;
    return null; // unknown — treat as "try and let the live handler memoize"
  }
}
(async () => {
  hasTagsIndex = await _detectIndex("QuestionsTags");
  hasQuestionsSearchIndex = await _detectIndex("QuestionsSearch");
  console.log(`[hugin] index flags detected: QuestionsTags=${hasTagsIndex} QuestionsSearch=${hasQuestionsSearchIndex}`);
})();

// Hugin-side response cache was intentionally removed (Act XXX rebuild).
// The demo is about RavenDB's own caching — `@embeddings-cache-for-querying`
// (14-day TTL, ~3-5 s warm Corax on Pi) is the cache we want to *show*.
// A hugin LRU short-circuits the entire pipeline and hides RavenDB's work,
// so the timing bar would never reflect what the device is actually doing.
// Every query now goes through the full pipeline; repeats benefit from
// raven's cache and trim accordingly.

// Until the Phase 3 index re-ship lands on the Pi, QuestionsTags aggregates
// by exact pipe-string combo (~100k entries). Cap the take to keep the
// tail latency tolerable; once the new per-token index ships, this can
// safely go back to 10 without paying a cost.
const RELATED_TAGS_LIMIT = parseInt(process.env.HUGIN_RELATED_TAGS_LIMIT || "6", 10);
async function fetchRelatedTags(session, tagsSet) {
  if (hasTagsIndex === false || !tagsSet || tagsSet.size === 0) return [];
  try {
    return await session
      .query({ indexName: 'QuestionsTags' })
      .whereIn("Tag", tagsSet)
      .orderByDescending("Count", "Long")
      .take(RELATED_TAGS_LIMIT)
      .all();
  } catch (err) {
    if (err && /QuestionsTags/i.test(err.message || "")) {
      hasTagsIndex = false;
      return [];
    }
    throw err;
  }
}

// Trim full Question docs to what the search-results UI actually renders.
// Stack-Exchange Question docs carry the full HTML body (often 5–20 KB) plus
// embedded Answers[] and Comments[] arrays (tens of KB each on popular
// questions). The search UI shows a snippet + counts; the detail view loads
// the full doc via /api/question. Trim server-side to cut JSON.stringify CPU
// + browser-side transfer materially on a Pi (16 results × ~10 KB body each
// is 160 KB of JSON to render, ~80 ms on Pi Zero 2 W).
//
// Side-effect: synthesises AnswerCount + CommentCount when those arrays are
// present (the source docs don't carry them as scalars). The frontend
// QuestionPreview reads AnswerCount as a fallback when Answers[] is missing.
function trimQuestion(q) {
  if (!q) return q;
  const out = { ...q };
  if (typeof out.Body === "string" && out.Body.length > 400) {
    const stripped = out.Body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    out.BodySnippet = stripped.length > 400 ? stripped.slice(0, 397) + "..." : stripped;
    delete out.Body;
  }
  if (Array.isArray(out.Answers)) {
    out.AnswerCount = out.Answers.length;
    delete out.Answers;
  }
  if (Array.isArray(out.Comments)) {
    out.CommentCount = out.Comments.length;
    delete out.Comments;
  }
  return out;
}

// Adaptive in-process keeper. Replaces the prior wakeUp() loop and its
// HUGIN_WAKEUP_BOOT_DEFER. Boot warmup is now driven externally by the
// hugin-warmup.service systemd unit (prod_tools/hugin-warmup), which fires
// the same query set once after boot-status reports ready. The keeper's job
// is steady-state: keep Voron + HNSW pages mapped between user sessions.
//
// Adaptive: skip the cycle if a user search happened within the last
// KEEPER_USER_IDLE_MS. Cache hits are fine — we just want to keep the
// kernel from reclaiming pages.
const KEEPER_INTERVAL_MS = 5 * 60 * 1000;
const KEEPER_USER_IDLE_MS = 15 * 60 * 1000;
const KEEPER_DEMO_PROMPTS = [
  "raspberry pi gpio",
  "kernel panic recovery",
  "docker compose volumes",
  "how do I improve battery life",
];
async function keeperRun() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tolerate = async (label, fn) => {
    for (let i = 0; i < 3; i++) {
      try { await fn(); return; }
      catch (err) {
        const msg = (err && err.message) || String(err);
        // Tolerate missing indexes (minimal-schema DBs).
        if (/Could not find index|DatabaseDoesNotExist|Collection .* does not exist/i.test(msg)) return;
        // Retry on raven-not-ready / connection-refused.
        if (/ECONNREFUSED|ETIMEDOUT|socket hang up|connect EAI|getaddrinfo/i.test(msg)) {
          await sleep(5_000);
          continue;
        }
        // Anything else: log and bail; never crash the loop.
        bootState.lastKeeperError = `[keeper:${label}] ${msg}`;
        return;
      }
    }
  };
  const promptIdx = bootState.iterationsCompleted % KEEPER_DEMO_PROMPTS.length;
  const prompt = KEEPER_DEMO_PROMPTS[promptIdx];
  const cycleStart = Date.now();
  const session = documentStore.openSession();
  let communities = [];
  await tolerate('communities', async () => {
    communities = await session.query({ collection: "Communities" }).all();
  });
  for (const community of communities) {
    await tolerate('QuestionsSearch', async () => {
      await session.query({ indexName: 'QuestionsSearch' })
        .whereEquals("Community", community.id)
        .orderByDescending("CreationDate")
        .take(15).all();
    });
  }
  await tolerate('Questions/ByVector', async () => {
    await session.query({ indexName: 'Questions/ByVector' })
      .vectorSearch(f => f.withField("TitleVector"),
                    v => v.byText(prompt, EMB_TASK_IDENTIFIER))
      .take(10).include("Owner").all();
  });
  bootState.iterationsCompleted += 1;
  bootState.lastKeeperRunAt = Date.now();
  console.log(`[keeper] cycle #${bootState.iterationsCompleted} prompt=${JSON.stringify(prompt)} elapsed=${Date.now() - cycleStart}ms`);
}
async function keeperLoop() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  while (true) {
    await sleep(KEEPER_INTERVAL_MS);
    const idle = Date.now() - bootState.lastUserSearchAt;
    if (bootState.lastUserSearchAt > 0 && idle < KEEPER_USER_IDLE_MS) {
      console.log(`[keeper] skipped (user active, idle=${Math.round(idle/1000)}s)`);
      continue;
    }
    try { await keeperRun(); }
    catch (err) {
      bootState.lastKeeperError = (err && err.message) || String(err);
      console.error("[keeper] cycle failed:", bootState.lastKeeperError);
    }
  }
}
keeperLoop();

// Index definitions ship with the database export — no index creation in app code.
// Canonical definitions live in the POC script (poc-vector-index.js) and in the exported DB.

const app = express();

// Static admin UI is no longer served from the Pi (2026-04-26 architecture
// correction). The dev shim at tools/admin-dev/server.js serves the UI from
// the dev box and reverse-proxies /api/admin/* to the Pi's hugin backend.
// See ARCHITECTURE.md "Why static UI lives on dev, not Pi".
//
// If you need a Pi-served UI for some reason (sealed image without dev box,
// emergency console-on-the-Pi work, …) re-add the express.static + sendFile
// block below and uncomment the admin/* lines in tools/headcrab/manifest.txt
// so the headcrab ships the UI files again.
//
//   const ADMIN_UI_DIR = path.join(__dirname, "admin");
//   app.use("/debug/admin/static", express.static(ADMIN_UI_DIR));
//   app.get("/debug/admin/initialize", (req, res) => { ... });

// JSON body parser for /api/admin/* routes. Scoped to the admin namespace so
// the runtime API (search/question/communities) keeps its zero-middleware
// shape. Was missing originally — every POST handler in admin-initialize was
// silently reading req.body as undefined and falling back to defaults. That
// didn't matter for healthcheck endpoints (they had sensible fallbacks) but
// breaks the /embeddings/state and /benchmark endpoints where the body
// carries a real parameter (disabled flag / search term).
app.use("/api/admin", express.json({ limit: "2mb" }));

// Admin control plane routes — existence-guarded so runtime-only images
// (no admin tier installed) boot cleanly with zero admin surface. See
// tools/headcrab/README.md for the headcrab architecture.
//
// Order matters: admin-initialize must run first, it registers the
// .disabled middleware that the others gate on.
const ADMIN_MODULES = [
  ["admin-initialize",     "registerInitializeRoutes",     true],  // passes documentStore
  ["admin-health",         "registerHealthRoutes",         false],
  ["admin-services",       "registerServiceRoutes",        false],
  ["admin-ollama",         "registerOllamaRoutes",         false],
  ["admin-network",        "registerNetworkRoutes",        false],
  ["admin-captive",        "registerCaptiveRoutes",        false],
  ["admin-ravendb-config", "registerRavendbConfigRoutes",  false],
];
let adminLoaded = 0;
for (const [mod, fn, needsStore] of ADMIN_MODULES) {
  try {
    const m = require(`./${mod}`);
    if (needsStore) m[fn](app, documentStore);
    else m[fn](app);
    adminLoaded++;
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") throw e;
    // Admin tier not installed for this module — expected on sealed images.
  }
}
console.log(
  `[admin] ${adminLoaded}/${ADMIN_MODULES.length} modules loaded` +
  (adminLoaded === 0 ? " (sealed image — admin disabled)" : "")
);
let currentHandlerFunction = null;
function isRavenUnreachable(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  // ravendb-node SDK wraps connection errors; match the underlying socket signals.
  return /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|socket hang up|connect EAI/i.test(msg)
      || /All servers in topology were not reachable|Could not contact|server is not available/i.test(msg);
}
app.asyncGet = function (path, handler) {
  return this.get(path, async (req, res, next) => {
    try {
      currentHandlerFunction = handler;
      await handler(req, res, next);
    } catch (err) {
      if (isRavenUnreachable(err)) {
        res.status(503).send({ error: "ravendb-unreachable", stage: "ravendb" });
        return;
      }
      res
        .status(err.status || 500)
        .send({ error: err.message });
    }
  });
}

function getRouteCode(req) {
  return `app.${req.method.toLowerCase()}("${req.route.path}", ${currentHandlerFunction})`;
}

const isProdEnv = process.env.NODE_ENV === "production";
if (isProdEnv) {
  app.use(express.static(path.join(path.resolve(), "build", "public")));
} else {
  const corsOptions = {
    origin: [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",") : []),
    ],
    credentials: true,
  };

  app.use(cors(corsOptions));
}

app.asyncGet("/api/question", async (req, res) => {
  const session = documentStore.openSession();
  const loadStart = performance.now();

  const question = await session
    .include("Owner")
    .include("Answers[].Owner")
    .include("Answers[].Comments[].User")
    .load(req.query.id);

  const userIds = question.Answers.map((a) =>
    a.Comments.map((c) => c.User).concat([a.Owner])
  ).concat([question.Owner])
    .concat(question.Comments.map((c) => c.User))
    .flat();
  const users = await session.load(userIds);

  const loadEnd = performance.now();

  res.send({
    data: { question, users },
    code: getRouteCode(req),
    timings: {
      load: loadEnd - loadStart,
    }
  });
});

app.asyncGet("/api/search", async (req, res) => {
  // Per-phase timing (gated by HUGIN_TIMING=1). Phases:
  //   t0_received      — handler entry
  //   t1_session_open  — openSession returned
  //   t2_query_built   — RQL builder finished
  //   t3_query_returned — .all() resolved (network + RavenDB + Ollama embed + HNSW + doc load)
  //   t4_tail_returned — relatedTags + users loaded (run in PARALLEL via Promise.all)
  // The response body's `timings` field always carries the deltas; the
  // console log (gated) is for journalctl -u hugin parsing.
  const T = process.env.HUGIN_TIMING === '1';
  const t0_received = performance.now();
  bootState.lastUserSearchAt = Date.now();

  const tags = Array.isArray(req.query.tag)
    ? req.query.tags
    : [req.query.tag].filter((x) => x);
  const page = parseInt(req.query.page) || 0;
  const pageSize = parseInt(req.query.pageSize) || 10;

  const session = documentStore.openSession();
  const t1_session_open = performance.now();

  let queryStats = null;
  let results;
  let t2_query_built, t3_query_returned;
  let ollamaEmbedMs = 0;   // populated in mode=ai branch when we embed via direct Ollama call
  let ravenCoraxMs = null, ravenRetrieverMs = null;  // populated from RavenDB timings tree (mode=ai only)

  if (req.query.mode === 'ai') {
    // AI / semantic vector search.
    // Single-vector mode: TitleVector only. Pi Zero 2 W cold latency on
    // BodyVector orElse roughly doubles wallclock because each vector
    // search triggers its own query-time embedding (one per field). The
    // Title vector alone gives strong recall on Q&A corpora where titles
    // are the user-authored summary. Set HUGIN_AI_VECTOR_FIELDS=both to
    // restore the OR'd Title+Body behaviour.
    const dualVectors = process.env.HUGIN_AI_VECTOR_FIELDS === 'both';

    // Query length truncation. The embedding model has a fixed-cost
    // forward pass that scales with token count; for short user queries
    // (typical demo: "raspberry pi gpio" = 4 tokens) this is moot, but
    // a long pasted query like "Why does my Raspberry Pi 3 with USB
    // boot enabled fail to detect SSDs over 2 TB on the secondary..."
    // can be 30+ tokens, doubling embed wallclock. The semantic content
    // of titles is dense in the first ~8 tokens; truncate to first 12
    // words so we match titles, not write essays. Disable via
    // HUGIN_AI_QUERY_TRUNCATE=0.
    let queryText = (req.query.q || "").trim();
    if (process.env.HUGIN_AI_QUERY_TRUNCATE !== '0') {
      const words = queryText.split(/\s+/);
      if (words.length > 12) queryText = words.slice(0, 12).join(' ');
    }

    // Use raven's server-side embed path via the EGT connection string —
    // gets us the @embeddings-cache-for-querying cache (14-day TTL across
    // all queries), so a repeated query string never re-pays Ollama.
    //
    // Tradeoff: we can't surface the Ollama embed time separately in the
    // progress bar (it's lumped into query_exec). Earlier in this session
    // we tried direct hugin→Ollama embed for separable timing — measurable
    // win for the bar, but the Pi started thrashing because the cache loss
    // forced every keeper cycle + every repeat user query to re-embed.
    // Reverted; timing-separation deferred to future work.
    let query = session
      .query({ indexName: 'Questions/ByVector' })
      .vectorSearch(f => f.withField("TitleVector"),
                    v => v.byText(queryText, EMB_TASK_IDENTIFIER));
    if (dualVectors) {
      query = query
        .orElse()
        .vectorSearch(f => f.withField("BodyVector"),
                      v => v.byText(queryText, EMB_TASK_IDENTIFIER));
    }
    // take/skip applied later (see aiTakeMultiplier below for orderBy over-fetch).
    query = query.include("Owner");

    // No selectFields — the prior projection had two issues: (a) AnswerCount
    // isn't stored on the source doc (it's just Answers[].length), so
    // selecting it returned null; (b) projection forced two non-symmetric
    // result shapes between mode=ai and the default FTS path. trimQuestion()
    // (called once over results below) handles size reduction uniformly:
    // strips Body→BodySnippet, Answers[]→AnswerCount, Comments[]→CommentCount.
    // The full doc still crosses raven→hugin loopback (cheap on Pi) but the
    // browser-bound payload is the same as before.
    // NOTE: 2026-05-04 — briefly tried dropping `.include("Owner")` on
    // the suspicion that it was costing ~2 s of "SDK overhead". WRONG.
    // Without the include, the subsequent `session.load(ownerIds)` is a
    // SEPARATE round-trip on a busy Pi — measured cold wallclock went
    // 14 s → 56 s, warm-novel 9 s → 39 s. The include batches owner
    // pre-fetch into the same round-trip; the JS SDK then resolves
    // session.load(ownerIds) from session cache without another network
    // call. Keep the include; the parallel_fanout is still a win for
    // tags fetching.

    if (req.query.community) {
      query = query.andAlso().whereEquals("Community", req.query.community);
    }
    if (tags.length > 0) {
      query = query.andAlso().whereIn("Tags", tags);
    }

    // OrderBy on a vector search means: take a wider top-K by similarity,
    // then re-sort the K rows by the user's chosen field. Pull 3× pageSize
    // (≤ ~30 docs on the default page) so paging through later pages still
    // makes sense. When no orderBy is sent, leave similarity ordering alone.
    const aiOrderBy = req.query.orderBy;
    const aiTakeMultiplier = aiOrderBy ? 3 : 1;
    query = query.take(pageSize * aiTakeMultiplier).skip(page * pageSize);

    t2_query_built = performance.now();
    let queryTimings = null;
    results = await query
      .statistics((stats) => { queryStats = stats; })
      // Enable RavenDB's timings tree. Embed gen is bundled inside Corax
      // (no separate node), but Corax wallclock is a reliable proxy:
      // a cold cache miss runs Ollama → multi-second Corax; a warm cache
      // hit is sub-second. We surface both timings in the response and
      // let the frontend infer "embed generated this time" from the
      // Corax magnitude.
      .timings((t) => { queryTimings = t; })
      .all();
    t3_query_returned = performance.now();
    // Walk the timings tree once. Shape (verified live, JS SDK normalises
    // PascalCase to camelCase):
    //   queryTimings.timings.query.timings.corax.durationInMs       — vector + embed
    //   queryTimings.timings.query.timings.retriever.durationInMs   — doc load
    try {
      const tt = queryTimings && queryTimings.timings;
      const inner = tt && tt.query && tt.query.timings;
      if (inner) {
        if (inner.corax     && typeof inner.corax.durationInMs     === "number") ravenCoraxMs     = inner.corax.durationInMs;
        if (inner.retriever && typeof inner.retriever.durationInMs === "number") ravenRetrieverMs = inner.retriever.durationInMs;
      }
    } catch { /* best-effort */ }

    if (aiOrderBy && results.length > 0) {
      const fld = aiOrderBy === "Score" ? "Score"
                : aiOrderBy === "ViewCount" ? "ViewCount"
                : "CreationDate";
      results = results.slice().sort((a, b) => {
        const av = a && a[fld];
        const bv = b && b[fld];
        if (fld === "CreationDate") return new Date(bv || 0) - new Date(av || 0);
        return (Number(bv) || 0) - (Number(av) || 0);
      }).slice(0, pageSize);
    }

  } else {
    // Full-text search via QuestionsSearch index. On minimal-schema DBs
    // (e.g. Hugin-q4) this index is missing; the catch below falls back
    // to a Questions/ByVector lookup over Community + Tags so the demo
    // path keeps working with reduced FTS fidelity.
    const query = session
      .query({ indexName: 'QuestionsSearch' })
      .take(pageSize)
      .skip(page * pageSize);

    if (tags.length > 0) {
      query.whereIn("Tags", tags);
    }
    if (req.query.community) {
      query.andAlso().whereEquals("Community", req.query.community);
    }
    if (req.query.q) {
      query.andAlso().search("Query", req.query.q);
    }
    if (req.query.orderBy === "Score") {
      query.orderByScore();
    } else {
      query.orderByDescending(req.query.orderBy || "CreationDate");
    }

    t2_query_built = performance.now();
    if (hasQuestionsSearchIndex === false) {
      // Index known-missing — skip the throw+catch entirely and go
      // straight to the Questions/ByVector fallback. Saves 1–5 s of
      // RavenDB-side index-not-found round-trip on every FTS request
      // against a minimal-schema DB.
      const fallback = session.query({ indexName: 'Questions/ByVector' })
        .take(pageSize).skip(page * pageSize);
      if (req.query.community) fallback.whereEquals("Community", req.query.community);
      if (tags.length > 0) fallback.andAlso().whereIn("Tags", tags);
      results = await fallback
        .statistics((stats) => { queryStats = stats; })
        .all();
    } else {
      try {
        results = await query
          .statistics((stats) => { queryStats = stats; })
          .all();
      } catch (err) {
        const msg = (err && err.message) || String(err);
        if (/QuestionsSearch/i.test(msg)) {
          hasQuestionsSearchIndex = false; // memoize so we don't re-fail
          const fallback = session.query({ indexName: 'Questions/ByVector' })
            .take(pageSize).skip(page * pageSize);
          if (req.query.community) fallback.whereEquals("Community", req.query.community);
          if (tags.length > 0) fallback.andAlso().whereIn("Tags", tags);
          results = await fallback
            .statistics((stats) => { queryStats = stats; })
            .all();
        } else {
          throw err;
        }
      }
    }
    t3_query_returned = performance.now();
  }

  // -- Parallel tail: relatedTags + users load --
  // Independent fetches that both depend only on `results`. Run in
  // parallel so the slower of the two (relatedTags on a busy Pi:
  // 0.4–5 s) determines the tail latency, not the sum. Skip the tags
  // query entirely when the index is known-missing — fail-fast saves
  // 1 s on every Hugin-q4 request.
  // ?tail=0 returns ONLY the question docs (no relatedTags, no users).
  // Frontend fires /api/search-tail in parallel after rendering the list
  // and merges relatedTags + users in. The .include("Owner") above was
  // load-bearing for the old single-shot path (it pre-fetched owner docs
  // into the session cache so session.load was free); with the split
  // there's no point including them since we never read them here, but
  // the query already ran by the time we get here so it's a no-op cost.
  // Keeping it to match the historical perf characteristics of the index
  // doc-load path (Lesson XXIX: removing .include made the main query 4×
  // faster on Pi but session.load became a separate cold round-trip);
  // Phase 2 of the split does its own session.load via /api/search-tail
  // so the historical degradation no longer applies — but on the off
  // chance someone calls /api/search without tail=0, we keep the include
  // for backward compatibility.
  const skipTail = req.query.tail === '0';
  const postTags = new Set(results.map((x) => x.Tags).flat());
  const tagsStart = performance.now();
  const ownerIds = results.map((q) => q.Owner).filter(Boolean);
  const [relatedTags, users] = await Promise.all([
    skipTail ? Promise.resolve([]) : fetchRelatedTags(session, postTags),
    skipTail ? Promise.resolve({}) :
      (ownerIds.length > 0 ? session.load(ownerIds) : Promise.resolve({})),
  ]);
  const t4_tail_returned = performance.now();

  // -- Body projection --
  // Stack-Exchange Question docs ship full HTML body (often 5–20 KB).
  // Search UI shows a snippet; full body loads on /api/question click.
  // Trim server-side cuts JSON.stringify CPU + HTTP transfer ~50% on
  // a 16-result page, materially on a 1 GHz Pi.
  const trimmed = results.map(trimQuestion);

  // query_build = pre-await time minus the explicit Ollama embed call.
  // Without this subtraction, mode=ai would account the embed twice (once
  // in query_build, once in ollama_embed).
  const queryBuildMs = (t2_query_built - t1_session_open) - ollamaEmbedMs;

  // Heuristic: if Corax wallclock is large enough, RavenDB's
  // @embeddings-cache-for-querying must have missed and Ollama was called
  // inside the vector.search. Threshold calibrated 2026-05-07 on the live
  // Pi via tools/probe-corax.py (6 queries × 3 runs each):
  //   warm Corax (cache hit) : 3485..7641 ms  (mean 5108, median 4955)
  //   cold Corax (cache miss): 4313..9229 ms  (mean 7739, median 8900)
  // Bands overlap because the Pi is slow even on a "warm" HNSW probe over
  // 1.1 M questions. Threshold 5500 ms biases toward false-negatives at
  // the boundary (we'd rather not show the embed line for a slow-warm
  // query than misclaim it on a fast-cold query). Override with
  // HUGIN_AI_EMBED_THRESHOLD_MS for tuning without redeploy.
  const embedThreshold = parseInt(process.env.HUGIN_AI_EMBED_THRESHOLD_MS || "5500", 10);
  const embedGenerated = (typeof ravenCoraxMs === "number" && ravenCoraxMs >= embedThreshold);

  const timings = {
    query: t3_query_returned - t2_query_built,
    tags: t4_tail_returned - tagsStart,
    phases: {
      session_open:    +(t1_session_open - t0_received).toFixed(1),
      query_build:     +Math.max(0, queryBuildMs).toFixed(1),
      ollama_embed:    +ollamaEmbedMs.toFixed(1),
      query_exec:      +(t3_query_returned - t2_query_built).toFixed(1),
      parallel_fanout: +(t4_tail_returned - t3_query_returned).toFixed(1),
      total:           +(t4_tail_returned - t0_received).toFixed(1),
      // RavenDB timings-tree breakdown (mode=ai only; null in FTS).
      raven_corax:     ravenCoraxMs     != null ? +ravenCoraxMs.toFixed(1)     : null,
      raven_retriever: ravenRetrieverMs != null ? +ravenRetrieverMs.toFixed(1) : null,
    },
    server: queryStats && queryStats.durationInMs ? queryStats.durationInMs : null,
    embedGenerated,
  };
  if (T) {
    console.log(`[search-timing] mode=${req.query.mode || 'fts'} q=${JSON.stringify(req.query.q || '')} ` +
      `session=${timings.phases.session_open} build=${timings.phases.query_build} ` +
      `embed=${timings.phases.ollama_embed} exec=${timings.phases.query_exec} ` +
      `fanout=${timings.phases.parallel_fanout} total=${timings.phases.total} server=${timings.server}`);
  }

  res.send({
    data: {
      results: trimmed,
      users,
      relatedTags,
      totalResults: queryStats.totalResults,
    },
    code: getRouteCode(req),
    timings,
  });
});

// Cached communities list. Tries the canonical Communities collection
// first; falls back to a hardcoded set of known Stack Exchange community
// names if that collection is absent (e.g. Hugin-q4 ships only Questions
// + @embeddings/*). The hardcoded set matches CLAUDE.md's documented
// communities and is stable across builds.
const KNOWN_COMMUNITIES = ["raspberrypi", "unix", "serverfault", "superuser"];
let _communitiesCache = null;
async function getCommunities(session) {
  if (_communitiesCache) return _communitiesCache;
  const direct = await session.query({ collection: "Communities" }).all().catch(() => []);
  if (direct && direct.length > 0) {
    _communitiesCache = direct;
    return _communitiesCache;
  }
  _communitiesCache = KNOWN_COMMUNITIES.map((id) => ({
    id, name: id,
    "@metadata": { "@id": id, "@collection": "Communities" }
  }));
  return _communitiesCache;
}

// Tail split: previously /api/search-tail ran relatedTags + users in
// parallel and returned both together. The frontend now fires these
// SEQUENTIALLY so the demo can narrate the difference: authors are a
// session.load batch (sub-100 ms), related tags is an index aggregation
// query (slower). User-perceived UX wins too: author skeletons fill in
// fast, then the sidebar tags trickle in.
function _parseArr(raw) {
  if (typeof raw === "string" && raw.length > 0) {
    try { return JSON.parse(raw); } catch { return raw.split(","); }
  }
  return Array.isArray(raw) ? raw : [];
}

app.asyncGet("/api/search-authors", async (req, res) => {
  const t0 = performance.now();
  const ids = _parseArr(req.query.ids).filter(s => typeof s === "string" && s.length > 0);
  const session = documentStore.openSession();
  const users = ids.length > 0 ? await session.load(ids) : {};
  const dt = performance.now() - t0;
  res.send({
    data: { users },
    code: getRouteCode(req),
    timings: { query: +dt.toFixed(1) },
  });
});

app.asyncGet("/api/search-tags", async (req, res) => {
  const t0 = performance.now();
  const tagSet = new Set(_parseArr(req.query.tags).filter(t => typeof t === "string" && t.length > 0));
  const session = documentStore.openSession();
  const relatedTags = await fetchRelatedTags(session, tagSet);
  const dt = performance.now() - t0;
  res.send({
    data: { relatedTags },
    code: getRouteCode(req),
    timings: { query: +dt.toFixed(1) },
  });
});

app.asyncGet("/api/communities", async (req, res) => {
  const session = documentStore.openSession();
  var queryStart = performance.now();
  const results = await getCommunities(session);
  var queryEnd = performance.now();

  res.send({
    data: results,
    code: getRouteCode(req),
    timings: {
      query: queryEnd - queryStart,
    },
  });
});



app.asyncGet("/api/is-online", async (req, res) => {

  const r = await axios.request('https://google.com/generate_204');
  const online = r.status === 204;
  res.status(online ? 200 : 500).send({ online: online });
});

// Legacy thin readiness probe. New frontend uses /api/boot-status; this
// stays for any external health-check tooling.
app.asyncGet("/api/ready", async (req, res) => {
  res.send({ ready: bootState.iterationsCompleted > 0 || bootState.lastUserSearchAt > 0 });
});

// Per-stage probe with ~1 s caching so /api/boot-status is cheap to poll
// at 1 Hz from the BootScreen.
const PROBE_CACHE_MS = 1000;
const probeCache = { ollama: null, ravendb: null };
async function probeOllama() {
  const now = Date.now();
  if (probeCache.ollama && now - probeCache.ollama.at < PROBE_CACHE_MS) return probeCache.ollama.val;
  const out = { status: "starting", detail: "" };
  try {
    const tags = await axios.get("http://127.0.0.1:11434/api/tags", { timeout: 3000 });
    if (tags.status === 200) {
      try {
        const ps = await axios.get("http://127.0.0.1:11434/api/ps", { timeout: 3000 });
        const want = process.env.EMB_MODEL || "snowflake-arctic-embed:s";
        const resident = (ps.data && Array.isArray(ps.data.models) && ps.data.models.some(m => m && m.name === want));
        if (resident) { out.status = "ready"; out.detail = `model ${want} resident`; }
        else { out.status = "loading"; out.detail = `model ${want} resident=false`; }
      } catch {
        out.status = "loading"; out.detail = "ollama up, /api/ps unavailable";
      }
    } else {
      out.status = "starting"; out.detail = `/api/tags returned ${tags.status}`;
    }
  } catch (err) {
    const msg = (err && err.code) || (err && err.message) || String(err);
    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/i.test(msg)) {
      out.status = "failed"; out.detail = `ollama unreachable (${msg})`;
    } else {
      out.status = "starting"; out.detail = msg;
    }
  }
  probeCache.ollama = { at: now, val: out };
  return out;
}
async function probeRavendb() {
  const now = Date.now();
  if (probeCache.ravendb && now - probeCache.ravendb.at < PROBE_CACHE_MS) return probeCache.ravendb.val;
  const out = { status: "starting", detail: "" };
  const ravenUrl = process.env.RAVENDB_URL || "http://127.0.0.1:8080";
  try {
    const ver = await axios.get(`${ravenUrl}/build/version`, { timeout: 3000 });
    if (ver.status === 200) {
      try {
        const stats = await axios.get(`${ravenUrl}/databases/${encodeURIComponent(DB_NAME)}/stats`, { timeout: 5000 });
        const indexes = (stats.data && Array.isArray(stats.data.Indexes)) ? stats.data.Indexes : [];
        const allFresh = indexes.length > 0 && indexes.every(i => i && i.IsStale === false);
        if (allFresh) { out.status = "ready"; out.detail = `${indexes.length} indexes fresh`; }
        else { out.status = "loading"; out.detail = `indexes stale (${indexes.filter(i => i && i.IsStale).length}/${indexes.length})`; }
      } catch (err) {
        out.status = "loading"; out.detail = `raven up, stats unavailable: ${(err && err.message) || err}`;
      }
    } else {
      out.status = "starting"; out.detail = `/build/version returned ${ver.status}`;
    }
  } catch (err) {
    const msg = (err && err.code) || (err && err.message) || String(err);
    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/i.test(msg)) {
      out.status = "failed"; out.detail = `ravendb unreachable (${msg})`;
    } else {
      out.status = "starting"; out.detail = msg;
    }
  }
  probeCache.ravendb = { at: now, val: out };
  return out;
}
const fs = require("fs");
function probeWarmup() {
  try {
    if (fs.existsSync("/run/hugin/warmup.done")) return { status: "ready", detail: "" };
  } catch { /* ignore */ }
  return { status: "pending", detail: "waiting on hugin-warmup.service" };
}

app.asyncGet("/api/boot-status", async (req, res) => {
  const [ollama, ravendb] = await Promise.all([probeOllama(), probeRavendb()]);
  const warmup = probeWarmup();
  const hugin = { status: "ready", since: bootState.startedAt };
  const ready = ollama.status === "ready" && ravendb.status === "ready" && warmup.status === "ready";
  res.send({ ready, stages: { hugin, ollama, ravendb, warmup } });
});

// Heal endpoints — smart restarts that don't bounce a working service.
// Probe first; restart only if unreachable; surface a terminal "please
// restart the RPi" on systemctl failure.
const { exec } = require("child_process");
const inflightHeal = { ollama: false, ravendb: false };
async function isReachable(svc) {
  try {
    if (svc === "ollama") {
      const r = await axios.get("http://127.0.0.1:11434/api/tags", { timeout: 2000 });
      return r.status === 200;
    } else {
      const url = process.env.RAVENDB_URL || "http://127.0.0.1:8080";
      const r = await axios.get(`${url}/build/version`, { timeout: 2000 });
      return r.status === 200;
    }
  } catch { return false; }
}
function systemctlRestart(svc) {
  return new Promise((resolve) => {
    exec(`sudo /bin/systemctl restart ${svc}`, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, code: err.code, stderr: String(stderr || err.message) });
      else resolve({ ok: true });
    });
  });
}
async function healHandler(svc, req, res) {
  if (svc !== "ollama" && svc !== "ravendb") return res.status(400).send({ status: "error", message: "unknown service" });
  if (inflightHeal[svc]) return res.status(202).send({ status: "starting", message: `${svc} restart already in flight` });
  if (await isReachable(svc)) return res.status(200).send({ status: "already-up" });
  inflightHeal[svc] = true;
  // Invalidate probe cache so /api/boot-status reflects the restart promptly.
  probeCache[svc] = null;
  try {
    const r = await systemctlRestart(svc);
    if (r.ok) return res.status(202).send({ status: "starting", message: `${svc} started, please wait` });
    return res.status(500).send({ status: "error", message: "Unexpected error — please restart the RPi", detail: r.stderr });
  } finally {
    inflightHeal[svc] = false;
  }
}
app.use("/api/heal", express.json());
app.post("/api/heal/ollama",  (req, res) => healHandler("ollama",  req, res));
app.post("/api/heal/ravendb", (req, res) => healHandler("ravendb", req, res));


module.exports = app;
