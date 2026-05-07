/* eslint-disable react/prop-types */
import "../styles/components/search-controller.css";
import { useSearchParams } from "react-router-dom";
import { useDispatch } from "react-redux";
import { IoClose } from "react-icons/io5";
import { getServerResult, setViewMode } from "../store/store";

// Compact results-header bar. Replaces the big purple "Tags and Communities"
// card that took a screenful for what's mostly empty space. Layout:
//
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ [chip] [chip]                       Sort: ▾   [Normal | AI 🔄]   │
//   └─────────────────────────────────────────────────────────────────┘
//
// Left side: active filter chips inline. When there are none, the slot just
// stays empty — no placeholder, no "click a tag below" hint (the chips
// below the questions already invite that interaction).
//
// Right side: Sort dropdown + (when AI is in flight or landed) the
// Normal/AI mode toggle. AI button shows a loading state during refining.
function SearchController() {
  const [searchParams, setSearchParams] = useSearchParams();
  const dispatch = useDispatch();
  const { searchResult } = getServerResult();
  const aiToggle = !!(searchResult && searchResult.aiToggle);
  const refining = !!(searchResult && searchResult.refining);
  const ai       = searchResult && searchResult.ai;
  const aiSeen   = !!(searchResult && searchResult.aiSeen);
  const viewMode = (searchResult && searchResult.viewMode) || "normal";

  const tags = searchParams.getAll("tag");
  const communities = searchParams.getAll("community");
  const orderBy = searchParams.get("orderBy") || "CreationDate";
  const showAiSegment = (aiToggle && refining) || ai; // toggle visible whenever AI is in play

  function handleRemoveTag(tag) {
    setSearchParams(p => { p.delete("tag", tag); return p; });
  }
  function handleRemoveCommunity(community) {
    setSearchParams(p => { p.delete("community", community); return p; });
  }
  function handleSortByChange(e) {
    setSearchParams(p => { p.set("orderBy", e.target.value); return p; });
  }
  function setMode(m) {
    if (m === viewMode) return;
    // Switching to AI before results land is allowed — SearchPage renders a
    // skeleton + cooking banner so the user can watch the leg in flight.
    dispatch(setViewMode(m));
  }

  return (
    <div className="search-header">
      <div className="search-header-filters">
        {communities.map((community) => (
          <span key={community} className={"search-header-chip search-header-chip-community bg-faded-" + community}>
            {community}
            <IoClose className="search-header-chip-close" onClick={() => handleRemoveCommunity(community)} />
          </span>
        ))}
        {tags.map((tag) => (
          <span key={tag} className="search-header-chip search-header-chip-tag">
            {tag}
            <IoClose className="search-header-chip-close" onClick={() => handleRemoveTag(tag)} />
          </span>
        ))}
      </div>

      <div className="search-header-controls">
        <label className="search-header-sort">
          <span className="search-header-sort-label">Sort</span>
          <select
            value={orderBy}
            onChange={handleSortByChange}
            className="search-header-sort-select"
          >
            <option value="CreationDate">Newest</option>
            <option value="Score">Score</option>
            <option value="ViewCount">Views</option>
          </select>
        </label>

        {showAiSegment ? (
          <div className="search-header-mode" role="group" aria-label="Result set">
            <button
              type="button"
              className={"search-header-mode-btn" + (viewMode === "normal" ? " is-active" : "")}
              onClick={() => setMode("normal")}
            >
              Full text
            </button>
            <button
              type="button"
              className={
                "search-header-mode-btn" +
                // Glow as soon as AI is in play (refining or just arrived) and
                // the user hasn't acknowledged it yet — clicking AI flips
                // aiSeen and stops the pulse.
                ((refining || ai) && !aiSeen && viewMode !== "ai" ? " ai-glow ai-glow-strong" : "") +
                (viewMode === "ai" ? " is-active" : "") +
                (!ai ? " is-loading" : "")
              }
              onClick={() => setMode("ai")}
              title={!ai ? "Switch to AI tab to watch it cook" : "Show AI results"}
            >
              AI{!ai ? <span className="search-header-mode-spinner" aria-hidden /> : null}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default SearchController;
