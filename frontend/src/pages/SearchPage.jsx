import QuestionList from "../components/QuestionList";
import { getServerResult } from "../store/store";
import "../styles/pages/search-page.css";
import RelatedTags from "../components/RelatedTags";
import SearchController from "../components/SearchController";
import DatabaseLink from "../components/DatabaseLink";
import QuestionPagination from "../components/QuestionPagination";
import BackendTiming from "../components/BackendTiming";
import SearchSkeleton from "../components/SearchSkeleton";

function SearchPage() {
  const { searchResult } = getServerResult();
  const aiToggle = !!(searchResult && searchResult.aiToggle);
  const refining = !!(searchResult && searchResult.refining);
  const normal   = searchResult && searchResult.normal;
  const ai       = searchResult && searchResult.ai;
  const viewMode = (searchResult && searchResult.viewMode) || "normal";

  const isAiTab = viewMode === "ai";
  // What goes in the question-list slot:
  //   - AI tab + AI loaded     → AI results
  //   - AI tab + AI not loaded → AI loading view (banner + skeleton)
  //   - Normal tab + FTS done  → FTS results (no AI banner — the AI tab
  //                              with its glowing button is the only place
  //                              that signals AI is still cooking)
  //   - Normal tab + FTS still loading → FTS loading view (skeleton)
  const tabLoading = isAiTab ? !ai : !normal;
  const active = isAiTab ? ai : normal;
  const activeMode = isAiTab ? "ai" : "fts";
  // SearchSkeleton phase:
  //   AI tab + no FTS yet  → "ai-waiting" (sequential pipeline blocks AI on FTS)
  //   AI tab + FTS landed  → "ai-cooking" (vector search now actually firing)
  //   FTS tab              → "fts" (casual spinner)
  const skeletonPhase = isAiTab
    ? (!normal ? "ai-waiting" : "ai-cooking")
    : "fts";

  // Pre-search render: nothing fired yet. Empty <main> until AppHeader
  // dispatches refining/normal/ai (synchronous on URL match).
  const inSearch = refining || !!normal || !!ai;
  if (!inSearch) {
    return <main className="search-page container my-3" />;
  }

  return (
    <main className="search-page container my-3">
      <div className="row">
        <div className="question-container col-lg-8 mb-4">
          {/* Compact header bar absorbs filter chips, sort-by, and the
              Normal/AI mode toggle (with a loading state during refining).
              Renders on every search — including before any results land —
              so the user can switch tabs while AI is cooking. */}
          <SearchController />

          {tabLoading ? (
            <SearchSkeleton aiToggle={aiToggle} phase={skeletonPhase} />
          ) : (
            active && active.data && (
              <>
                <QuestionPagination totalResults={active.data.totalResults} className="pt-1 pb-1" />
                <QuestionList queryResult={active.data} />
                <QuestionPagination totalResults={active.data.totalResults} className={"pt-3 pb-7"} />
              </>
            )
          )}
        </div>
        <div className="search-page-info-container col-lg-4 mb-4">
          <BackendTiming
            result={tabLoading ? null : active}
            mode={activeMode}
            refining={tabLoading}
          />
          <DatabaseLink />
          {!tabLoading && active && active.data && <RelatedTags tags={active.data.relatedTags} />}
        </div>
      </div>
    </main>
  );
}

export default SearchPage;
