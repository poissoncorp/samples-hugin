/* eslint-disable react/prop-types */
import { useDispatch } from "react-redux";
import { getServerResult, setAiToggle } from "../store/store";
import "../styles/components/ai-search-toggle.css";

export default function AiSearchToggle() {
  const dispatch = useDispatch();
  const { searchResult } = getServerResult();
  const checked = !!(searchResult && searchResult.aiToggle);

  return (
    <label
      className={"ai-search-toggle ai-shine ai-glow" + (checked ? " is-on" : "")}
      title={checked
        ? "AI search runs alongside keyword search — toggle Normal/AI on the results to compare."
        : "Turn on to run an AI semantic search alongside keyword search."}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => dispatch(setAiToggle(e.target.checked))}
        aria-label="Also run AI semantic search alongside keyword search"
      />
      <span className="ai-search-toggle-track" aria-hidden>
        <span className="ai-search-toggle-knob" />
      </span>
      <span className="ai-search-toggle-label">+&nbsp;AI&nbsp;search</span>
    </label>
  );
}
