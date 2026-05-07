/* eslint-disable react/prop-types */
import { useState } from "react";
import "../styles/components/backend-timing.css";
import CodeModal from "./CodeModal";
import AiProgressBar from "./AiProgressBar";

// Accepts EITHER:
//   <BackendTiming timings={...} code={...} />            (legacy / HomePage)
//   <BackendTiming result={{timings,code}} mode="ai" />   (search results)
//   <BackendTiming result={null} mode="ai" refining />    (AI in-flight)
//
// Layout (search page):
//   ┌──────────────────────────────────────┐
//   │ How long this took           [AI]    │
//   │                                      │
//   │   23.0 s                             │
//   │   on a 1 GHz Pi Zero 2 W · 416 MB    │
//   │                                      │
//   │   ─── progress bar ───               │
//   │                                      │
//   │   Lazy-loaded after                  │
//   │   ▰▰▰▰▱▱  4.3 s  Related-tag chips   │
//   │                                      │
//   │   See the backend code               │
//   └──────────────────────────────────────┘
//
// HomePage degenerate case (no phases, no bar) keeps the same shell with
// just the headline number.
function fmt(ms) {
  if (ms == null) return "—";
  if (ms < 100)  return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function BackendTiming({ timings, code, result, mode = "ai", refining = false }) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const t = result ? result.timings : timings;
  const c = result ? result.code : code;
  const phases = (t && t.phases) || null;
  const total = phases?.total ?? t?.query ?? null;
  const tail = t?.tail;
  const isSearchCard = !!result || refining;
  const showInflight = refining && !result;

  // Headline number is RavenDB's own work (query_exec). The full total
  // covers wire + Hugin + Ollama embed + RavenDB + fanout — not what we
  // want to put on a billboard. Fall back through phases.total → t.query
  // for cache hits / legacy / HomePage where query_exec isn't broken out.
  const ravenMs = phases?.query_exec ?? null;
  const headlineMs = isSearchCard
    ? (ravenMs ?? phases?.total ?? t?.query ?? null)
    : (phases?.total ?? t?.query ?? null);
  // The backend's heuristic flags AI runs where Corax wallclock crossed
  // the embed-cache-miss threshold — meaning the displayed RavenDB number
  // also paid for a fresh Ollama embedding on the same Pi. Asterisk it.
  const showEmbedNote = isSearchCard && mode === "ai" && !!t?.embedGenerated && ravenMs != null;

  return (
    <article className="card backend-timing">
      <div className="card-body backend-timing-body">
        <header className="backend-timing-header">
          <h3 className="backend-timing-title">How long this took</h3>
          {isSearchCard && mode === "ai" && (
            <span className={"backend-timing-badge backend-timing-badge-" + (showInflight ? "loading" : "settled")}>
              {showInflight ? "AI cooking…" : "AI"}
            </span>
          )}
          {isSearchCard && mode === "fts" && (
            <span className="backend-timing-badge backend-timing-badge-fts">Full text</span>
          )}
        </header>

        {/* Headline: dominant RavenDB-only number + hardware brag. For the
            HomePage's legacy single-number case we still show this (falls
            back to total there since there's no query_exec phase). */}
        {headlineMs != null && (
          <div className="backend-timing-headline">
            <span className="backend-timing-total">
              {fmt(headlineMs)}
              {showEmbedNote && (
                <span className="backend-timing-embed-asterisk" aria-label="includes Ollama embedding generation">*</span>
              )}
            </span>
            {isSearchCard && (
              <span className="backend-timing-hardware">
                on a 1 GHz Pi Zero 2 W · 416 MB RAM
              </span>
            )}
          </div>
        )}
        {showEmbedNote && (
          <p className="backend-timing-embed-footnote">
            <span className="backend-timing-embed-footnote-mark">*</span>
            includes generating a fresh embedding via Ollama on the same Pi
          </p>
        )}

        {/* Main timing bar — only on the search card; HomePage doesn't
            have phases. */}
        {isSearchCard && (
          <div className="backend-timing-bar">
            <AiProgressBar refining={showInflight} result={result} mode={mode} />
          </div>
        )}

        {/* "Lazy-loaded after" — phase-2 work that the frontend fires after
            the question list is on screen. Authors first (session.load by
            ID — fast), tags after (QuestionsTags index aggregation —
            slower). Each row is its own measured hop. */}
        {tail && (tail.authors?.totalMs > 0 || tail.tags?.totalMs > 0) && (
          <section className="backend-timing-aside">
            <h4 className="backend-timing-aside-title">Lazy-loaded after</h4>
            {tail.authors?.totalMs > 0 && (
              <div
                className="backend-timing-aside-row"
                data-tooltip={`session.load by ID — batched author docs.\n${fmt(tail.authors.totalMs)} total · ${fmt(tail.authors.networkMs)} on the wire · ${fmt(tail.authors.serverMs)} on RavenDB`}
              >
                <span className="backend-timing-aside-bar">
                  <span
                    className="backend-timing-aside-fill"
                    style={{ width: total ? Math.min(100, (tail.authors.totalMs / total) * 100) + "%" : "0%" }}
                  />
                </span>
                <span className="backend-timing-aside-ms">{fmt(tail.authors.totalMs)}</span>
                <span className="backend-timing-aside-label">Authors</span>
              </div>
            )}
            {tail.tags?.totalMs > 0 && (
              <div
                className="backend-timing-aside-row"
                data-tooltip={`QuestionsTags index aggregation.\n${fmt(tail.tags.totalMs)} total · ${fmt(tail.tags.networkMs)} on the wire · ${fmt(tail.tags.serverMs)} on RavenDB`}
              >
                <span className="backend-timing-aside-bar">
                  <span
                    className="backend-timing-aside-fill"
                    style={{ width: total ? Math.min(100, (tail.tags.totalMs / total) * 100) + "%" : "0%" }}
                  />
                </span>
                <span className="backend-timing-aside-ms">{fmt(tail.tags.totalMs)}</span>
                <span className="backend-timing-aside-label">Related-tag chips</span>
              </div>
            )}
          </section>
        )}

        <button
          type="button"
          className="backend-timing-code-btn"
          onClick={() => setIsModalOpen(o => !o)}
        >
          <span className="backend-timing-code-icon" aria-hidden>{`</>`}</span>
          <span>See the backend code</span>
        </button>
        {isModalOpen && <CodeModal code={c} onClose={() => setIsModalOpen(false)} />}
      </div>
    </article>
  );
}

export default BackendTiming;
