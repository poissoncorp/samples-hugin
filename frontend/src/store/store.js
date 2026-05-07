import { configureStore } from "@reduxjs/toolkit";
import { createSlice } from "@reduxjs/toolkit";
import { useSelector } from "react-redux";

const emptySearch = {
  normal:   null,
  ai:       null,
  viewMode: "normal",
  aiToggle: true,
  refining: false,
  query:    "",
  // Sticky flag: flips true the first time the user lands on viewMode === "ai"
  // for the current query. Drives the AI button's "results just arrived!" glow
  // — once the user has acknowledged the AI results, the glow stops nagging.
  aiSeen:   false,
};

const slice = createSlice({
  name: "page-state",
  initialState: {
    searchResult: { ...emptySearch },
    questionResult: {},
    communitiesResult: {},
    runtimeError: { kind: null, healingState: "idle" },
  },
  reducers: {
    // Legacy compat: callers (e.g. QuestionPage flow) that still set the old
    // shape get their data normalized into the new searchResult.normal slot.
    setSearchResult: (state, action) => {
      const p = action.payload || {};
      // If payload looks like the new dual shape, accept verbatim.
      if (p && (Object.prototype.hasOwnProperty.call(p, "normal") || Object.prototype.hasOwnProperty.call(p, "ai"))) {
        state.searchResult = { ...emptySearch, ...p };
      } else {
        state.searchResult = { ...emptySearch, normal: p, viewMode: "normal" };
      }
    },
    clearSearch: (state, action) => {
      // Pagination + filter changes re-fire the search through the same
      // clearSearch path as a brand-new query. Distinguish by query text:
      // same q text = "still the same conceptual search" (paging, sort,
      // tag tweak) → preserve the active tab (viewMode) and the "AI seen"
      // flag so the user doesn't bounce back to FTS or get the AI button
      // glow re-fired on every page click. Different q = fresh search →
      // reset both, so the next results land on FTS by default and the
      // glow can re-announce a new AI arrival.
      const newQuery = action.payload || "";
      const sameQuery = state.searchResult.query === newQuery;
      state.searchResult = {
        ...emptySearch,
        query: newQuery,
        aiToggle: state.searchResult.aiToggle,
        viewMode: sameQuery ? state.searchResult.viewMode : "normal",
        aiSeen:   sameQuery ? state.searchResult.aiSeen   : false,
      };
    },
    setNormalResult: (state, action) => {
      state.searchResult.normal = action.payload;
      // Default to showing normal results as soon as they land.
      if (state.searchResult.viewMode !== "ai") state.searchResult.viewMode = "normal";
      // FTS-only flow (aiToggle off): no AI leg follows, so this is the
      // terminal landing — clear refining so the loading skeleton clears.
      if (!state.searchResult.aiToggle) {
        state.searchResult.refining = false;
      }
    },
    setAiResult: (state, action) => {
      state.searchResult.ai = action.payload;
      state.searchResult.refining = false;
    },
    // Phase-2 tail merges, split: authors fires first, tags follows.
    // Each merger writes its own slice + its own timing into
    // leg.timings.tail.{authors,tags}. The BackendTiming aside renders
    // each as its own row so the demo shows the two distinct hops.
    mergeNormalAuthors: (state, action) => {
      const leg = state.searchResult.normal;
      if (!leg || !leg.data) return;
      const p = action.payload || {};
      if (p.users) leg.data.users = p.users;
      if (p._timing) {
        leg.timings = { ...leg.timings, tail: { ...(leg.timings?.tail || {}), authors: p._timing } };
      }
    },
    mergeNormalTags: (state, action) => {
      const leg = state.searchResult.normal;
      if (!leg || !leg.data) return;
      const p = action.payload || {};
      leg.data.relatedTags = p.relatedTags || [];
      if (p._timing) {
        leg.timings = { ...leg.timings, tail: { ...(leg.timings?.tail || {}), tags: p._timing } };
      }
    },
    mergeAiAuthors: (state, action) => {
      const leg = state.searchResult.ai;
      if (!leg || !leg.data) return;
      const p = action.payload || {};
      if (p.users) leg.data.users = p.users;
      if (p._timing) {
        leg.timings = { ...leg.timings, tail: { ...(leg.timings?.tail || {}), authors: p._timing } };
      }
    },
    mergeAiTags: (state, action) => {
      const leg = state.searchResult.ai;
      if (!leg || !leg.data) return;
      const p = action.payload || {};
      leg.data.relatedTags = p.relatedTags || [];
      if (p._timing) {
        leg.timings = { ...leg.timings, tail: { ...(leg.timings?.tail || {}), tags: p._timing } };
      }
    },
    setViewMode: (state, action) => {
      const next = action.payload === "ai" ? "ai" : "normal";
      state.searchResult.viewMode = next;
      if (next === "ai") state.searchResult.aiSeen = true;
    },
    setAiToggle: (state, action) => {
      state.searchResult.aiToggle = !!action.payload;
    },
    setRefining: (state, action) => {
      state.searchResult.refining = !!action.payload;
    },
    setQuestionResult: (state, action) => {
      state.questionResult = action.payload;
    },
    setCommunitiesResult: (state, action) => {
      state.communitiesResult = action.payload;
    },
    setRuntimeError: (state, action) => {
      const p = action.payload || {};
      state.runtimeError = {
        kind: p.kind || null,
        healingState: p.healingState || "idle",
      };
    },
    clearRuntimeError: (state) => {
      state.runtimeError = { kind: null, healingState: "idle" };
    },
    setHealingState: (state, action) => {
      state.runtimeError.healingState = action.payload;
    },
  },
});

const store = configureStore({
  reducer: {
    response: slice.reducer,
  },
});

function getServerResult() {
  return useSelector((state) => state.response);
}

const {
  setSearchResult,
  clearSearch,
  setNormalResult,
  setAiResult,
  mergeNormalAuthors,
  mergeNormalTags,
  mergeAiAuthors,
  mergeAiTags,
  setViewMode,
  setAiToggle,
  setRefining,
  setQuestionResult,
  setCommunitiesResult,
  setRuntimeError,
  clearRuntimeError,
  setHealingState,
} = slice.actions;

export {
  store,
  getServerResult,
  setSearchResult,
  clearSearch,
  setNormalResult,
  setAiResult,
  mergeNormalAuthors,
  mergeNormalTags,
  mergeAiAuthors,
  mergeAiTags,
  setViewMode,
  setAiToggle,
  setRefining,
  setQuestionResult,
  setCommunitiesResult,
  setRuntimeError,
  clearRuntimeError,
  setHealingState,
};
