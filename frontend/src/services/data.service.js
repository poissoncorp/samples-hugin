import Axios from "axios";
import { httpService } from "./http.service";

const BASE_URL =
  process.env.NODE_ENV === "production"
    ? "/api/"
    : "http://localhost:3030/api/";

const rawAxios = Axios.create({ withCredentials: true });

export async function getCommunities() {
  try {
    return await httpService.get("communities");
  } catch (err) {
    alert(err.response.data.error);
    throw err;
  }
}

export async function queryQuestions(args) {
  try {
    return await httpService.get("search", args);
  } catch (err) {
    alert(err.response.data.error);
    throw err;
  }
}

export async function getQuestion(id) {
  try {
    return await httpService.get("question", { id });
  } catch (err) {
    alert(err.response.data.error);
    throw err;
  }
}

// Sequential progressive search — FTS first, then (optionally) AI.
//
// Returns `{ abort }`; calling abort cancels whichever leg is in flight.
// onNormal({data, timings, code})  is called when /api/search resolves.
// onAi(...)                        is called when /api/search?mode=ai resolves
//                                  — only if aiToggle === true and FTS succeeded.
// onError({ stage, message })      is called on 503 raven-unreachable
//                                  (single dispatch per progressive run; we
//                                  don't double-fire if both legs would 503).
export function queryQuestionsProgressive(args, callbacks = {}) {
  const { onNormal, onAi, onError } = callbacks;
  const aiToggle = !!args.aiToggle;
  const controller = new AbortController();
  // Backend doesn't accept aiToggle; strip it before serialization.
  const searchArgs = { ...args };
  delete searchArgs.aiToggle;
  let raisedRavenError = false;
  function maybeRaiseRaven(err) {
    if (raisedRavenError) return true;
    if (err && err.response && err.response.status === 503 && err.response.data && err.response.data.stage === "ravendb") {
      raisedRavenError = true;
      try { onError && onError({ stage: "ravendb", message: err.response.data.error }); } catch { /* ignore */ }
      return true;
    }
    return false;
  }
  // Measure the request wall on the client. Backend's `total` is pure
  // server time — subtracting that from client wall gives actual wire +
  // nginx + parse overhead, which is the only honest value for the
  // "Network" bar segment. Annotate it onto the response before dispatch.
  function annotateNetwork(resp, clientWallMs) {
    try {
      const phases = resp && resp.timings && resp.timings.phases;
      if (!phases) return;
      const serverTotal = typeof phases.total === "number" ? phases.total : 0;
      // Floor at 0 (client clocks can drift negative on a same-host loopback).
      phases.network = Math.max(0, +(clientWallMs - serverTotal).toFixed(1));
      // Bump phases.total to client wall so the bar adds up cleanly.
      phases.total = +Math.max(serverTotal, clientWallMs).toFixed(1);
    } catch { /* best-effort */ }
  }
  // Phase-2 split: authors first (fast — session.load batch), THEN tags
  // (slower — QuestionsTags index aggregation). Sequential so the demo
  // shows two distinct moments: author skeletons fill in, then sidebar
  // chips appear. Each call annotates its own client-measured timing
  // (network + server) for the BackendTiming aside.
  function makeTiming(wallMs, serverMs) {
    return {
      totalMs:   +wallMs.toFixed(1),
      serverMs:  +serverMs.toFixed(1),
      networkMs: +Math.max(0, wallMs - serverMs).toFixed(1),
    };
  }
  function fireAuthors(ids, onAuthors) {
    if (!ids || ids.length === 0) {
      onAuthors({ users: {}, _timing: makeTiming(0, 0) });
      return Promise.resolve();
    }
    const t0 = performance.now();
    return rawAxios.get(`${BASE_URL}search-authors`, {
      params: { ids: JSON.stringify(ids) },
      signal: controller.signal,
    }).then(r => {
      const wallMs = performance.now() - t0;
      const users = (r && r.data && r.data.data && r.data.data.users) || {};
      const serverMs = (r && r.data && r.data.timings && typeof r.data.timings.query === "number") ? r.data.timings.query : 0;
      onAuthors({ users, _timing: makeTiming(wallMs, serverMs) });
    }).catch(() => { /* tail is decoration; failure is silent */ });
  }
  function fireTags(tagsList, onTags) {
    if (!tagsList || tagsList.length === 0) {
      onTags({ relatedTags: [], _timing: makeTiming(0, 0) });
      return Promise.resolve();
    }
    const t0 = performance.now();
    return rawAxios.get(`${BASE_URL}search-tags`, {
      params: { tags: JSON.stringify(tagsList) },
      signal: controller.signal,
    }).then(r => {
      const wallMs = performance.now() - t0;
      const relatedTags = (r && r.data && r.data.data && r.data.data.relatedTags) || [];
      const serverMs = (r && r.data && r.data.timings && typeof r.data.timings.query === "number") ? r.data.timings.query : 0;
      onTags({ relatedTags, _timing: makeTiming(wallMs, serverMs) });
    }).catch(() => { /* tail is decoration; failure is silent */ });
  }
  function fireTailFor(resultsArray, onAuthors, onTags) {
    const arr = resultsArray || [];
    const ids  = Array.from(new Set(arr.map(r => r && r.Owner).filter(Boolean)));
    const tags = Array.from(new Set(arr.flatMap(r => r && r.Tags ? r.Tags : [])));
    fireAuthors(ids, onAuthors).then(() => {
      // Sequential: tags only fires after authors resolves (or errors out).
      // Aborted requests skip naturally — controller.signal stops the next call too.
      if (controller.signal.aborted) return;
      return fireTags(tags, onTags);
    });
  }
  (async () => {
    let normalRes;
    const t0n = performance.now();
    try {
      const r = await rawAxios.get(`${BASE_URL}search`, {
        params: { ...searchArgs, tail: 0 },
        signal: controller.signal,
      });
      normalRes = r.data;
      annotateNetwork(normalRes, performance.now() - t0n);
      if (onNormal) onNormal(normalRes);
      // Phase-2 split: authors first, then tags. Sequential so the demo
      // can narrate the difference between session.load and an index query.
      if (callbacks.onNormalAuthors || callbacks.onNormalTags) {
        fireTailFor(
          normalRes && normalRes.data && normalRes.data.results,
          callbacks.onNormalAuthors || (() => {}),
          callbacks.onNormalTags    || (() => {}),
        );
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      if (maybeRaiseRaven(err)) return;
      // Other errors bubble up to onError as a generic stage signal.
      try { onError && onError({ stage: "unknown", message: (err && err.message) || String(err) }); } catch { /* ignore */ }
      return;
    }
    if (!aiToggle) return;
    const t0a = performance.now();
    try {
      const r2 = await rawAxios.get(`${BASE_URL}search`, {
        params: { ...searchArgs, mode: "ai", tail: 0 },
        signal: controller.signal,
      });
      annotateNetwork(r2.data, performance.now() - t0a);
      if (onAi) onAi(r2.data);
      if (callbacks.onAiAuthors || callbacks.onAiTags) {
        fireTailFor(
          r2.data && r2.data.data && r2.data.data.results,
          callbacks.onAiAuthors || (() => {}),
          callbacks.onAiTags    || (() => {}),
        );
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      if (maybeRaiseRaven(err)) return;
      try { onError && onError({ stage: "ai", message: (err && err.message) || String(err) }); } catch { /* ignore */ }
    }
  })();
  return { abort: () => controller.abort() };
}

// Cheap GET — used by BootScreen + RuntimeErrorBanner polling. Generous
// timeout because the probes themselves call Ollama/RavenDB and on a
// loaded Pi those can stall briefly behind the keeper cycle.
export async function getBootStatus() {
  const r = await rawAxios.get(`${BASE_URL}boot-status`, { timeout: 15000 });
  return r.data;
}

// Heal endpoints. Returns { status, message? } or rejects on transport error.
export async function healService(name) {
  if (name !== "ollama" && name !== "ravendb") throw new Error("unknown service: " + name);
  const r = await rawAxios.post(`${BASE_URL}heal/${name}`, {}, { timeout: 35000, validateStatus: () => true });
  return { httpStatus: r.status, ...(r.data || {}) };
}
