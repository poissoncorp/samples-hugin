import { useCallback, useEffect, useRef, useState } from "react";
import "../styles/components/app-header.css";
import { useLocation, useSearchParams, useNavigate } from "react-router-dom";
import { queryQuestionsProgressive } from "../services/data.service";
import { useDispatch } from "react-redux";
import {
  getServerResult,
  clearSearch,
  setNormalResult,
  setAiResult,
  mergeNormalAuthors,
  mergeNormalTags,
  mergeAiAuthors,
  mergeAiTags,
  setRefining,
  setRuntimeError,
} from "../store/store";
import AiSearchToggle from "./AiSearchToggle";

function AppHeader() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { searchResult } = getServerResult();
  const aiToggle = !!(searchResult && searchResult.aiToggle);
  const aiToggleRef = useRef(aiToggle);
  aiToggleRef.current = aiToggle;
  const inflight = useRef(null);

  const [searchTerm, setSearchTerm] = useState(searchParams.get("q") || "");

  const onSearch = useCallback(
    (args) => {
      // Cancel any in-flight progressive search before starting a new one.
      if (inflight.current && inflight.current.abort) {
        try { inflight.current.abort(); } catch { /* ignore */ }
      }
      dispatch(clearSearch(args.q || ""));
      // refining = "a search is in flight" (regardless of AI). Drives the
      // SearchPage skeleton + AI button glow. Cleared by setAiResult when
      // AI lands, or by setNormalResult when the search is FTS-only.
      dispatch(setRefining(true));
      inflight.current = queryQuestionsProgressive(args, {
        onNormal:        (res)  => dispatch(setNormalResult(res)),
        onAi:            (res)  => dispatch(setAiResult(res)),
        onNormalAuthors: (p)    => dispatch(mergeNormalAuthors(p)),
        onNormalTags:    (p)    => dispatch(mergeNormalTags(p)),
        onAiAuthors:     (p)    => dispatch(mergeAiAuthors(p)),
        onAiTags:        (p)    => dispatch(mergeAiTags(p)),
        onError:  ({ stage }) => {
          if (stage === "ravendb") dispatch(setRuntimeError({ kind: "ravendb-unreachable" }));
          dispatch(setRefining(false));
        },
      });
    },
    [dispatch]
  );

  function onSearchClick() {
    const community = searchParams.get("community");
    const tag = searchParams.get("tag");
    let url = "/search";
    if (searchTerm)  url += `?q=${searchTerm}`;
    if (community)   url += `&community=${community}`;
    if (tag)         url += `&tag=${tag}`;
    // navigate() is a no-op when URL is unchanged (same q/community/tag),
    // so the useEffect that fires onSearch wouldn't re-trigger and the
    // user couldn't re-run the same query (e.g. to compare a cold vs warm
    // RavenDB cache hit). Fire the search directly here too — the
    // queryQuestionsProgressive helper handles aborting any in-flight leg
    // before starting a new one, so duplicate dispatches are safe.
    navigate(url);
    if (searchTerm || community || tag) {
      // New search resets to page 0 (backend 0-indexed) regardless of any
      // stale page= param still in searchParams.
      onSearch({
        community,
        q: searchTerm,
        tag,
        page: 0,
        orderBy: searchParams.get("orderBy") || "CreationDate",
        aiToggle: aiToggleRef.current,
      });
    }
  }

  function inputChangeHandler(e) {
    setSearchTerm(e.target.value);
  }

  function handleTitleClick() {
    navigate("/home");
  }

  function searchKeyUp(e) {
    if (e.key === "Enter") onSearchClick();
  }

  useEffect(() => {
    // useSearchParams() returns a new URLSearchParams object on every render,
    // so depending on it would re-fire this effect on every redux dispatch
    // (clearSearch, setRefining, etc.) — abort+retry storm + visible
    // duplicate /api/search hits on the wire. Re-parse from the stable
    // location.search string instead.
    const params = new URLSearchParams(location.search);
    const community = params.get("community");
    const tag = params.get("tag");
    const q = params.get("q");
    // QuestionPagination writes 1-indexed page numbers to the URL (page=1
    // is the first page, page=2 is the second). The backend's /api/search
    // is 0-indexed (skip = page * pageSize). Convert at the boundary —
    // forgetting to do so was the bug that made "Next" return zero rows.
    const pageRaw = params.get("page");
    const page = pageRaw ? Math.max(0, parseInt(pageRaw, 10) - 1) : 0;
    const orderBy = params.get("orderBy") || "CreationDate";
    setSearchTerm(q || "");
    if (!q && !community && !tag) return;
    onSearch({ community, q, tag, page, orderBy, aiToggle: aiToggleRef.current });
  }, [location.search, onSearch]);

  return (
    <header className="hero">
      <img src="/img/hero.jpg" className="hero-img" alt="raven-logo" onClick={handleTitleClick} />
      <div className="hero-container">
        <div className="hero-content">
          <h1 className="hero-title" onClick={handleTitleClick}>
            <img
              src="/img/ravendb-logo.svg"
              className="hero-logo"
              alt="RavenDB"
            />
            Hugin
          </h1>
          <h2>Offline knowledge base</h2>
          <div className="search-input-container">
            <input
              type="text"
              className="search-input"
              placeholder="Search database"
              value={searchTerm}
              onChange={inputChangeHandler}
              onKeyUp={searchKeyUp}
            />
            <button
              className="search-btn"
              type="button"
              onClick={onSearchClick}
            >
              Search
            </button>
            <AiSearchToggle />
          </div>
        </div>
      </div>
    </header>
  );
}

export default AppHeader;
