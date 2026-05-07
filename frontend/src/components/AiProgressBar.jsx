/* eslint-disable react/prop-types */
import "../styles/components/ai-progress-bar.css";

// Segments rendered in the bar, left-to-right. parallel_fanout was dropped
// — under tail=0 it's a no-op promise, the real author/tag work runs in the
// "Lazy-loaded after" rows. RavenDB's label/tooltip is set dynamically per
// mode (AI vs FTS) since AI search runs through Ollama too.
const SEGMENT_DEFS = [
  { key: "network",         label: "Network",  tooltip: "Browser ↔ Pi wire time." },
  // `app` is a frontend-side composite of the backend's session_open +
  // query_build phases — both are tiny pre-RavenDB hugin work, the
  // distinction only matters for backend diagnostics.
  { key: "app",             label: "App",      tooltip: "Hugin runtime — opening the DB session + building the query." },
  { key: "query_exec"       /* label + tooltip set dynamically below */ },
];

function fmt(ms) {
  if (ms == null) return "?";
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

export default function AiProgressBar({ refining, result, mode = "ai" }) {
  // In-flight: simple indeterminate bar.
  if (refining && !result) {
    return (
      <div className="ai-progress-bar ai-progress-bar-loading">
        <div className="ai-progress-bar-track">
          <div className="ai-progress-bar-indeterminate" />
        </div>
        <div className="ai-progress-bar-label">Working…</div>
      </div>
    );
  }

  if (!result || !result.timings) return null;

  const t = result.timings;
  const phases = t.phases || {};
  const total = phases.total || t.query || 0;
  if (!total) return null;

  // Network is honest only when the client measured it (data.service
  // annotates phases.network after the fetch returns). When that's
  // missing (legacy responses, cache hits), skip the segment rather
  // than show the rounding-noise value derived from server-side phases.
  const network = (typeof phases.network === "number") ? phases.network : 0;

  const values = {
    network,
    // session_open + query_build collapsed — both are tiny pre-RavenDB
    // hugin work, the per-phase split only matters for backend diagnostics.
    app:             (phases.session_open || 0) + (phases.query_build || 0),
    query_exec:      phases.query_exec      || 0,
  };

  // The "RavenDB" segment is a misnomer for AI search — under the hood it's
  // RavenDB + Ollama (the embedding model is invoked via the EGT path, even
  // when the @embeddings-cache hits). For FTS it's pure RavenDB Lucene.
  const isAi = mode === "ai";
  const ravenLabel = isAi ? "RavenDB + Ollama" : "RavenDB";
  const baseTip = isAi
    ? `RavenDB found the closest matches across 1.1 M questions in ${fmt(values.query_exec)}`
    : `RavenDB searched 1.1 M questions in ${fmt(values.query_exec)}`;
  // When RavenDB's @embeddings-cache-for-querying missed, the timing also
  // covers a fresh Ollama embedding call on this same Pi. Backend signals
  // that via `embedGenerated` (heuristic: Corax wallclock > threshold).
  const embedNote = (isAi && t.embedGenerated)
    ? " — this run also included generating a fresh embedding via Ollama on the same Pi to query with"
    : "";
  const ravenTip = baseTip + embedNote + ".";

  return (
    <div className={`ai-progress-bar ai-progress-bar-settled ai-progress-bar-mode-${mode}`}>
      <div className="ai-progress-bar-track">
        {SEGMENT_DEFS.map(({ key, label, tooltip }) => {
          const ms = values[key] || 0;
          if (ms <= 0) return null;
          const pct = (ms / total) * 100;
          const segLabel = key === "query_exec" ? ravenLabel : label;
          const tip = key === "query_exec" ? ravenTip : `${segLabel}: ${fmt(ms)} — ${tooltip}`;
          // The shine effect requires overflow:hidden to clip the sweep
          // gradient; that conflicts with the ::after tooltip which needs
          // overflow:visible on the segment to pop. Resolution: wrap the
          // shine in an inner element so the segment itself stays clean.
          const shine = key === "query_exec";
          return (
            <div
              key={key}
              className={`ai-progress-bar-segment ai-progress-bar-segment-${key}`}
              style={{ width: pct + "%" }}
              data-tooltip={tip}
            >
              {shine ? (
                <span className="ai-progress-bar-segment-shine ai-shine" aria-hidden />
              ) : null}
              <span className="ai-progress-bar-segment-label">{segLabel}</span>
            </div>
          );
        })}
      </div>
      {/* The "+ Post info" secondary line previously lived here. Moved
          to BackendTiming so the new card layout owns the labeled
          "Lazy-loaded after" section and the bar stays focused on the
          main-query phase breakdown. */}
    </div>
  );
}
