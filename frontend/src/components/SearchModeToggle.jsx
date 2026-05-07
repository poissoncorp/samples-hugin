/* eslint-disable react/prop-types */
import { useDispatch } from "react-redux";
import { getServerResult, setViewMode } from "../store/store";
import "../styles/components/search-mode-toggle.css";

export default function SearchModeToggle() {
  const dispatch = useDispatch();
  const { searchResult } = getServerResult();
  const viewMode = (searchResult && searchResult.viewMode) || "normal";
  const isAi = viewMode === "ai";

  function flip(next) {
    if (next === viewMode) return;
    dispatch(setViewMode(next));
  }

  return (
    <div className={"search-mode-toggle ai-shine" + (isAi ? " is-ai" : "")}>
      <button
        type="button"
        className={"search-mode-toggle-btn" + (!isAi ? " is-active" : "")}
        onClick={() => flip("normal")}
      >
        Normal
      </button>
      <button
        type="button"
        className={"search-mode-toggle-btn ai-glow" + (isAi ? " is-active" : "")}
        onClick={() => flip("ai")}
      >
        AI
      </button>
    </div>
  );
}
