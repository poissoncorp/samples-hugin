/* eslint-disable react/prop-types */
import { useEffect, useState } from "react";
import "../styles/components/search-skeleton.css";

// Cycling faces drive the AI-cooking head. The other two phases use a
// single static glyph (a casual spinner for FTS, a calm flower face for
// "AI is waiting for FTS to finish"). The point is to match the energy of
// what's actually happening: keyword search is quick and undramatic;
// waiting on FTS is calm; vector cooking on a 1 GHz Pi is the dramatic bit.
// Tired-eye ASCII faces — "I'm working hard, this is heavy". Cycling them
// while the title stays static ("AI Cooking…") puts the energy on effort,
// not persona-switching.
// More expressive than `>_<` / `-_-` — these actually read as "this is
// heavy work" instead of mild discomfort.
const TIRED_FACES = [
  ";_;",
  "◑﹏◐",
  "(◎﹏◎)",
  "(⊙_◎)",
  "ᕦ(ò_óˇ)ᕤ",
  "＼（〇_ｏ）／",
  "○|￣|_",
  "(╯‵□′)╯︵┻━┻",
];

const COOKING_TITLE = "AI Cooking…";
const COOKING_SUBTITLES = [
  "Calculating your query's embedding vector",
  "Ollama is grinding the embedding model on a 1 GHz core",
  "Each word becomes a 384-dim vector of floats",
  "Pi is sweating but the embedding model fits in RAM",
];
const COOKING_CYCLE_MS = 3600;

const ROW_COUNT = 5;

// Phase values:
//   "fts"        — FTS tab, FTS leg loading. Casual spinner + "Searching…".
//   "ai-waiting" — AI tab, FTS leg still in flight. AI literally cannot
//                  start until FTS resolves (sequential pipeline), so we
//                  show one static (✿◠‿◠) — calm, not cycling.
//   "ai-cooking" — AI tab, FTS done, AI leg now firing. Roulette of titles
//                  + subtitles + cycling faces — the demo's dramatic moment.
export default function SearchSkeleton({ aiToggle, phase = "fts" }) {
  const [faceIdx, setFaceIdx] = useState(0);
  // Start the subtitle roulette on a random pick so consecutive AI
  // searches don't always lead with the same line.
  const [cookIdx, setCookIdx] = useState(() =>
    Math.floor(Math.random() * COOKING_SUBTITLES.length)
  );
  useEffect(() => {
    if (phase !== "ai-cooking") return;
    const t = setInterval(() => setFaceIdx(i => (i + 1) % TIRED_FACES.length), 600);
    return () => clearInterval(t);
  }, [phase]);
  useEffect(() => {
    if (phase !== "ai-cooking") return;
    const t = setInterval(() => setCookIdx(i => i + 1), COOKING_CYCLE_MS);
    return () => clearInterval(t);
  }, [phase]);

  let head;
  if (phase === "ai-cooking") {
    // Title stays still ("AI Cooking…") so the eye lands on it; the face
    // and subtitle cycle to convey "this is taking effort".
    head = (
      <>
        <div className="search-skeleton-title">
          <span className="search-skeleton-face" aria-hidden>{TIRED_FACES[faceIdx]}</span>
          {COOKING_TITLE}
        </div>
        <div className="search-skeleton-subtitle">
          {COOKING_SUBTITLES[cookIdx % COOKING_SUBTITLES.length]}
        </div>
      </>
    );
  } else if (phase === "ai-waiting") {
    head = (
      <>
        <div className="search-skeleton-title">
          <span className="search-skeleton-face-calm" aria-hidden>{"(✿◠‿◠)"}</span>
          Waiting to start…
        </div>
        <div className="search-skeleton-subtitle">
          waiting for FTS query to finish
        </div>
      </>
    );
  } else {
    // FTS tab loading — keyword search is fast, a casual spinner is honest.
    head = (
      <div className="search-skeleton-title search-skeleton-title-fts">
        <span className="search-skeleton-spinner" aria-hidden />
        Searching…
      </div>
    );
  }

  return (
    <div className="search-skeleton" role="status" aria-live="polite">
      <div className="search-skeleton-head">{head}</div>

      <ul className="search-skeleton-list">
        {Array.from({ length: ROW_COUNT }).map((_, i) => (
          <li className="search-skeleton-row" key={i} style={{ animationDelay: `${i * 80}ms` }}>
            <div className="search-skeleton-stats">
              <span className="search-skeleton-shimmer" />
              <span className="search-skeleton-shimmer" />
              <span className="search-skeleton-shimmer" />
            </div>
            <div className="search-skeleton-body">
              <div className="search-skeleton-shimmer search-skeleton-line search-skeleton-line-title" />
              <div className="search-skeleton-shimmer search-skeleton-line" />
              <div className="search-skeleton-shimmer search-skeleton-line search-skeleton-line-short" />
              <div className="search-skeleton-tags">
                <span className="search-skeleton-shimmer" />
                <span className="search-skeleton-shimmer" />
                <span className="search-skeleton-shimmer" />
              </div>
            </div>
            <div className="search-skeleton-img search-skeleton-shimmer" />
          </li>
        ))}
      </ul>
    </div>
  );
}
