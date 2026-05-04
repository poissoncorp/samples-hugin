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

// Warmup state — observable via GET /api/ready.
// `ready` flips to true after wakeUp()'s first iteration completes its
// vector.search probe (which loads the embedding model into Ollama and
// primes HNSW pages). Frontend uses this to gate the search UI behind a
// loading screen on the first cold-boot visit.
const warmupState = {
  ready: false,
  startedAt: Date.now(),
  completedAt: null,
  iterationsCompleted: 0,
  // The 30 s boot-time defer (HUGIN_WAKEUP_BOOT_DEFER) + ~10 s for
  // the first wakeUp iteration's queries = 40 s total before
  // /api/ready turns true. Frontend WarmupOverlay countdown uses this.
  // The Ollama model itself is NOT pre-loaded any more (was the OOM-
  // cascade trigger 2026-05-04); first user query pays cold-load.
  etaSeconds: 40,
  lastWarmupCycleMs: null,
  lastError: null,
};

// FTS-first index — opt-in on Hugin-q4 where the original
// QuestionsSearch index is absent. Defined here in code so hugin can
// auto-create it on startup if missing. Targets the "instant first
// batch of results" leg of the two-stage progressive search:
// `/api/search?mode=quick` runs against this index for sub-second
// keyword matches; `mode=ai` continues to use the slower-but-smarter
// Questions/ByVector path.
//
// Build cost on Pi Zero 2 W: ~10-30 min for 1.1 M Questions, runs
// in background after index put. Once built, queries are 100-500 ms
// cold, sub-100 ms warm.
//
// Disable creation entirely with HUGIN_FTS_INDEX_AUTOCREATE=0 if you
// don't want hugin to mutate the DB schema.
const FTS_INDEX_NAME = "Questions/ByTitleFTS";
const FTS_INDEX_DEF = {
  Name: FTS_INDEX_NAME,
  Maps: [
    "from q in docs.Questions select new { Title = q.Title, Tags = q.Tags, Community = q.Community, Score = q.Score, ViewCount = q.ViewCount, CreationDate = q.CreationDate, Owner = q.Owner }"
  ],
  Fields: {
    "Title": { Indexing: "Search", Analyzer: "StandardAnalyzer" },
    "Tags":  { Indexing: "Default" },
    "Community": { Indexing: "Exact" },
  },
  Configuration: {
    "Indexing.IndexEmptyEntries": "false",
  },
  // Lucene engine — Corax doesn't have a stable Search analyzer story
  // on every RavenDB minor; Lucene is the safe default for FTS on
  // older builds. If the live RavenDB is Corax-only this'll need
  // updating to use Corax-native search.
};
let hasFtsTitleIndex = null; // null=unknown, true=present, false=absent
async function ensureFtsTitleIndex() {
  if (process.env.HUGIN_FTS_INDEX_AUTOCREATE === '0') {
    console.log("[hugin] FTS index auto-create disabled by env");
    hasFtsTitleIndex = await _detectIndex(FTS_INDEX_NAME);
    return;
  }
  try {
    const exists = await _detectIndex(FTS_INDEX_NAME);
    if (exists) {
      hasFtsTitleIndex = true;
      console.log(`[hugin] FTS index ${FTS_INDEX_NAME} already present`);
      return;
    }
    // Use the maintenance API to put the index. ravendb JS SDK exposes
    // this via documentStore.maintenance.send(new PutIndexesOperation(...)).
    const { PutIndexesOperation, IndexDefinition } = require("ravendb");
    const def = new IndexDefinition();
    def.name = FTS_INDEX_DEF.Name;
    def.maps = new Set(FTS_INDEX_DEF.Maps);
    def.fields = FTS_INDEX_DEF.Fields;
    def.configuration = FTS_INDEX_DEF.Configuration;
    await documentStore.maintenance.send(new PutIndexesOperation(def));
    hasFtsTitleIndex = true;
    console.log(`[hugin] FTS index ${FTS_INDEX_NAME} created — RavenDB will build it in background`);
  } catch (err) {
    hasFtsTitleIndex = false;
    console.error(`[hugin] FTS index create failed (continuing without):`, err && err.message);
  }
}
// Don't block ready on this — fire-and-forget at startup.
setTimeout(() => { ensureFtsTitleIndex().catch(()=>{}); }, 5000);

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

// Hugin-side response LRU cache. Why server-side rather than HTTP cache
// headers: the conference appliance lives on a Pi without browser-side
// caching agreements, every browser tab is fresh, and an operator
// rehearsing the demo wants the SECOND use of any query to feel
// instant — across tabs, across reloads, across `Esc`+retype.
//
// What lands in here: the entire response object that /api/search would
// otherwise have built (results + users + relatedTags + totalResults).
// A cache hit skips: openSession, vector.search (and its server-side
// @embeddings-cache lookup), HNSW probe, doc load, tags query, users
// load, JSON serialization. Empirically that's ~1 s of work; the LRU
// hit is single-digit ms.
//
// Why no TTL: the Stack-Exchange corpus is static, indexes don't drift,
// there's nothing to invalidate. If a future build mutates docs at
// runtime we'd need cache invalidation; for now, none.
//
// Eviction is insertion-order LRU using Map's iteration order. cacheGet
// re-inserts on hit so MRU items stay at the back; cachePut prunes the
// front when over capacity. 200 entries × ~5–10 KB each ≈ 1–2 MB RAM.
const RESPONSE_CACHE_MAX = 200;
const responseCache = new Map();
const responseCacheStats = { hits: 0, misses: 0, evictions: 0, puts: 0 };
function cacheGet(key) {
  if (!responseCache.has(key)) { responseCacheStats.misses++; return null; }
  const v = responseCache.get(key);
  responseCache.delete(key);
  responseCache.set(key, v);
  responseCacheStats.hits++;
  return v;
}
function cachePut(key, val) {
  if (responseCache.has(key)) responseCache.delete(key);
  responseCache.set(key, val);
  responseCacheStats.puts++;
  if (responseCache.size > RESPONSE_CACHE_MAX) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
    responseCacheStats.evictions++;
  }
}

// Body projection for search results. Stack-Exchange Question docs
// carry the full HTML body (often 5–20 KB). The search UI shows a
// snippet, not the full document — the full body is loaded by
// /api/question on click. Trimming server-side cuts JSON.stringify CPU
// + HTTP transfer noticeably on a Pi (16 results × ~10 KB body each is
// 160 KB of JSON to render, ~80 ms on Pi Zero 2 W).
function trimQuestion(q) {
  if (!q || typeof q.Body !== "string" || q.Body.length <= 400) return q;
  const out = { ...q };
  const stripped = out.Body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  out.BodySnippet = stripped.length > 400 ? stripped.slice(0, 397) + "..." : stripped;
  delete out.Body;
  return out;
}

async function wakeUp() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tryWarm = async (label, fn) => {
    try { await fn(); }
    catch (err) {
      const msg = (err && err.message) || String(err);
      // Tolerate missing indexes/collections on minimal-schema DBs
      // (e.g. Hugin-q4 ships only Questions + Questions/ByVector).
      if (/Could not find index|DatabaseDoesNotExist|Collection .* does not exist/i.test(msg)) return;
      throw err;
    }
  };
  // Boot-time defer: on a fresh Pi reboot, RavenDB itself is busy
  // loading indexes + voron files in the first 30-60 seconds. Hitting
  // it with our wakeUp queries during that window competes for memory
  // and CPU, contributing to the OOM-thrash spiral observed live
  // 2026-05-04. A 30 s sleep before the first iteration lets RavenDB
  // settle into steady state before we touch it. Disable via
  // HUGIN_WAKEUP_BOOT_DEFER=0 for testing.
  if (process.env.HUGIN_WAKEUP_BOOT_DEFER !== '0') {
    await sleep(30 * 1000);
  }
  while (true) {
    const cycleStart = Date.now();
    try {
      const session = documentStore.openSession();
      let communities = [];
      await tryWarm('communities', async () => {
        communities = await session.query({ collection: "Communities" }).all();
      });
      for (const community of communities) {
        await tryWarm('QuestionsSearch', async () => {
          await session.query({ indexName: 'QuestionsSearch' })
            .whereEquals("Community", community.id)
            .orderByDescending("CreationDate")
            .take(15)
            .all();
        });
      }
      // STEP 1 (was: force Ollama model load via direct embed call —
      // REVERTED 2026-05-04 morning). On a cold-booted Pi Zero 2 W
      // with 416 MB RAM, allocating 90 MB for Ollama's Q4 model
      // anon memory at the same moment RavenDB is loading its
      // working set is enough to push the kernel into a swap-thrash
      // death spiral that takes the Pi unreachable for 30+ minutes
      // (observed live 2026-05-04 06:17 UTC and again at 08:17 UTC).
      //
      // Tradeoff: the user's first novel query now pays the +5 s
      // cold-load tail. That's acceptable because:
      //   1. The frontend WarmupOverlay covers the first 30 s anyway
      //   2. Boot-time OOM-killing sshd is a much worse failure mode
      //   3. Lazy load means Ollama's 90 MB doesn't compete with
      //      RavenDB's index startup
      //
      // The "byText('linux')" probe below still runs but it's a
      // @embeddings-cache hit (linux has been embedded thousands of
      // times) so it returns instantly without calling Ollama. The
      // model loads on demand when the first novel-string query
      // comes in.
      // STEP 2: Prime HNSW pages + doc-load pages via the EGT path.
      // byText("linux") IS a cache hit so this is sub-second on its own.
      // We still want it because it forces RavenDB to mmap the index +
      // doc voron pages we'd touch on a real /api/search?mode=ai call.
      // take(10) primes more HNSW + doc pages than take(1); Owner include
      // warms the user-load fan-out hugin runs after vector search.
      await tryWarm('Questions/ByVector', async () => {
        await session.query({ indexName: 'Questions/ByVector' })
          .vectorSearch(f => f.withField("TitleVector"),
                        v => v.byText("linux", EMB_TASK_IDENTIFIER))
          .take(10).include("Owner").all();
      });
      await tryWarm('QuestionsTags', async () => {
        await session.query({ indexName: 'QuestionsTags' })
          .whereIn("Tag", ["linux"]).take(1).all();
      });
      warmupState.iterationsCompleted += 1;
      warmupState.lastWarmupCycleMs = Date.now() - cycleStart;
      if (!warmupState.ready) {
        warmupState.ready = true;
        warmupState.completedAt = Date.now();
        console.log(`[wakeUp] first iteration complete in ${warmupState.lastWarmupCycleMs}ms — /api/ready now true`);
      }
      await sleep(5 * 60 * 1000);
    }
    catch (err) {
      console.error("Failed to wake up", err);
      warmupState.lastError = (err && err.message) || String(err);
      await sleep(15_000);
    }
  }
}

// We call this on startup to ensure that the db is awake and running
// this is important since IO costs are high (on SD card), so on startup
// we'll pay the cost of waking up the db, and then we'll be able to run
// far faster. The issue is typically on first boot, where everything is cold
_ = wakeUp();

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
app.asyncGet = function (path, handler) {
  return this.get(path, async (req, res, next) => {
    try {
      currentHandlerFunction = handler;
      await handler(req, res, next);
    } catch (err) {
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

  const tags = Array.isArray(req.query.tag)
    ? req.query.tags
    : [req.query.tag].filter((x) => x);
  const page = parseInt(req.query.page) || 0;
  const pageSize = parseInt(req.query.pageSize) || 10;

  // -- Hugin-side response cache --
  // Same-string repeats land in single-digit ms instead of the ~1 s
  // RavenDB-cache-hit path. Key includes everything that affects the
  // result. Misses fall through to the full pipeline below.
  const cacheKey = [
    req.query.mode || "fts",
    (req.query.q || "").trim(),
    req.query.community || "",
    page, pageSize,
    [...tags].sort().join("|"),
    req.query.orderBy || "",
  ].join("\x00");
  const cached = cacheGet(cacheKey);
  if (cached) {
    const dt = performance.now() - t0_received;
    if (T) console.log(`[search-timing] CACHE_HIT q=${JSON.stringify(req.query.q || '')} dt=${dt.toFixed(2)}ms`);
    return res.send({ ...cached, timings: { ...cached.timings, cacheHit: true, lookupMs: +dt.toFixed(2) } });
  }

  const session = documentStore.openSession();
  const t1_session_open = performance.now();

  let queryStats = null;
  let results;
  let t2_query_built, t3_query_returned;

  if (req.query.mode === 'quick') {
    // Two-stage progressive search — STAGE 1.
    // Returns top-N matches by TITLE keyword (Lucene FTS) without any
    // Ollama call. ~100-500 ms cold, sub-100 ms warm. Frontend pairs
    // this with a parallel mode=ai request so the user sees results
    // instantly while the semantic-quality results land later.
    //
    // Falls back to mode=ai behaviour if the FTS index is absent
    // (Hugin-q4 ships without it; ensureFtsTitleIndex() at startup
    // creates it but background-build takes ~10-30 min). Until built,
    // requests against a stale index return [].
    let queryText = (req.query.q || "").trim();
    if (!queryText) {
      results = [];
      queryStats = { totalResults: 0, durationInMs: 0 };
      t2_query_built = performance.now();
      t3_query_returned = performance.now();
    } else if (hasFtsTitleIndex === false) {
      // No FTS index — fall back to vector search (slower but always
      // works). Operator who wants the speed-up should ensure the
      // FTS index is built (`/api/admin/initialize/state` would surface
      // this in a future iteration).
      let query = session
        .query({ indexName: 'Questions/ByVector' })
        .vectorSearch(f => f.withField("TitleVector"),
                      v => v.byText(queryText, EMB_TASK_IDENTIFIER))
        .take(pageSize).skip(page * pageSize).include("Owner");
      if (req.query.community) query = query.andAlso().whereEquals("Community", req.query.community);
      t2_query_built = performance.now();
      results = await query.statistics(s => { queryStats = s; }).all();
      t3_query_returned = performance.now();
    } else {
      let query = session
        .query({ indexName: FTS_INDEX_NAME })
        .search("Title", queryText)
        .take(pageSize).skip(page * pageSize).include("Owner");
      if (req.query.community) query = query.andAlso().whereEquals("Community", req.query.community);
      t2_query_built = performance.now();
      try {
        results = await query.statistics(s => { queryStats = s; }).all();
      } catch (err) {
        // Index might be stale or still-building. Return empty rather
        // than throw — the user's parallel mode=ai will catch up.
        results = [];
        queryStats = { totalResults: 0, durationInMs: 0 };
      }
      t3_query_returned = performance.now();
    }
  } else if (req.query.mode === 'ai') {
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
    query = query
      .take(pageSize)
      .skip(page * pageSize)
      .include("Owner");

    // Server-side projection: cuts the RavenDB→hugin loopback payload by
    // dropping the embedded Answers[] / Comments[] arrays (which can be
    // tens of KB per Question on Stack-Exchange data). Search-result UI
    // doesn't need those — full body + answers + comments are loaded
    // by /api/question on click. Env-gated so we can disable if a
    // projected field interaction surprises us.
    //
    // What stays: Title, Tags, Body (still trimmed in JS post-fetch via
    //   trimQuestion), Owner (FK for users fanout), Score, ViewCount,
    //   CreationDate, Community, AnswerCount.
    // What drops: Answers, Comments, LastActivityDate, LastEditDate,
    //   AcceptedAnswerId (server fills nulls for unselected fields).
    if (process.env.HUGIN_AI_PROJECT !== '0') {
      query = query.selectFields([
        "Title", "Tags", "Body", "Owner", "Score", "ViewCount",
        "CreationDate", "Community", "AnswerCount",
      ]);
    }
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

    t2_query_built = performance.now();
    results = await query
      .statistics((stats) => { queryStats = stats; })
      .all();
    t3_query_returned = performance.now();

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
  const postTags = new Set(results.map((x) => x.Tags).flat());
  const tagsStart = performance.now();
  const ownerIds = results.map((q) => q.Owner).filter(Boolean);
  const [relatedTags, users] = await Promise.all([
    (hasTagsIndex === false || postTags.size === 0)
      ? Promise.resolve([])
      : session
          .query({ indexName: 'QuestionsTags' })
          .whereIn("Tag", postTags)
          .orderByDescending("Count", "Long")
          .take(10)
          .all()
          .catch((err) => {
            if (err && /QuestionsTags/i.test(err.message || "")) {
              hasTagsIndex = false; // memoize
              return [];
            }
            throw err;
          }),
    ownerIds.length > 0 ? session.load(ownerIds) : Promise.resolve({}),
  ]);
  const t4_tail_returned = performance.now();

  // -- Body projection --
  // Stack-Exchange Question docs ship full HTML body (often 5–20 KB).
  // Search UI shows a snippet; full body loads on /api/question click.
  // Trim server-side cuts JSON.stringify CPU + HTTP transfer ~50% on
  // a 16-result page, materially on a 1 GHz Pi.
  const trimmed = results.map(trimQuestion);

  const timings = {
    query: t3_query_returned - t2_query_built,
    tags: t4_tail_returned - tagsStart,
    phases: {
      session_open:    +(t1_session_open - t0_received).toFixed(1),
      query_build:     +(t2_query_built - t1_session_open).toFixed(1),
      query_exec:      +(t3_query_returned - t2_query_built).toFixed(1),
      parallel_fanout: +(t4_tail_returned - t3_query_returned).toFixed(1),
      total:           +(t4_tail_returned - t0_received).toFixed(1),
    },
    server: queryStats && queryStats.durationInMs ? queryStats.durationInMs : null,
    cacheHit: false,
  };
  if (T) {
    console.log(`[search-timing] CACHE_MISS mode=${req.query.mode || 'fts'} q=${JSON.stringify(req.query.q || '')} ` +
      `session=${timings.phases.session_open} build=${timings.phases.query_build} ` +
      `exec=${timings.phases.query_exec} fanout=${timings.phases.parallel_fanout} ` +
      `total=${timings.phases.total} server=${timings.server}`);
  }

  const responseBody = {
    data: {
      results: trimmed,
      users,
      relatedTags,
      totalResults: queryStats.totalResults,
    },
    code: getRouteCode(req),
    timings,
  };
  cachePut(cacheKey, responseBody);
  res.send(responseBody);
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

// Warmup readiness probe — used by the frontend to render a loading
// screen on initial cold-boot visit, hiding the ~13 s Ollama cold-load
// behind a "Initializing the knowledge base…" message instead of a
// 14-second search-spinner that looks like a stuck UI.
//
// Frontend should poll on landing (1 s interval) until ready=true.
// Server keeps responding 200 even when ready=false — this is purely a
// hint for UX, not a gate. /api/search?mode=ai works either way; it's
// just much slower before warmup completes.
app.asyncGet("/api/ready", async (req, res) => {
  const now = Date.now();
  const elapsedSeconds = (now - warmupState.startedAt) / 1000;
  const etaSeconds = warmupState.ready ? 0 :
    Math.max(0, +(warmupState.etaSeconds - elapsedSeconds).toFixed(1));
  res.send({
    ready: warmupState.ready,
    elapsedSeconds: +elapsedSeconds.toFixed(1),
    etaSeconds,
    iterationsCompleted: warmupState.iterationsCompleted,
    lastWarmupCycleMs: warmupState.lastWarmupCycleMs,
    lastError: warmupState.lastError,
  });
});


module.exports = app;
