/* eslint-disable react/prop-types */
import { useEffect, useRef } from "react";
import { useDispatch } from "react-redux";
import { getServerResult, clearRuntimeError, setHealingState } from "../store/store";
import { getBootStatus, healService } from "../services/data.service";
import "../styles/components/runtime-error.css";

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS  = 60_000;

export default function RuntimeErrorBanner() {
  const dispatch = useDispatch();
  const { runtimeError } = getServerResult();
  const pollAbort = useRef(null);

  // Cleanup any in-flight poll if the user navigates / kind clears.
  // Declared before the early return so React's hook ordering stays stable.
  useEffect(() => {
    return () => { if (pollAbort.current) pollAbort.current(); };
  }, []);

  // If kind clears (or never set), don't render.
  if (!runtimeError || !runtimeError.kind) return null;

  async function onHeal() {
    dispatch(setHealingState("healing"));
    let r;
    try {
      r = await healService("ravendb");
    } catch (err) {
      dispatch(setHealingState("failed"));
      return;
    }
    if (r.httpStatus === 200 && r.status === "already-up") {
      dispatch(clearRuntimeError());
      return;
    }
    if ((r.httpStatus === 202 || r.httpStatus === 200) && r.status === "starting") {
      dispatch(setHealingState("polling"));
      const stop = startPoll(() => {
        dispatch(clearRuntimeError());
      }, () => {
        dispatch(setHealingState("failed"));
      });
      pollAbort.current = stop;
      return;
    }
    dispatch(setHealingState("failed"));
  }

  // Returns a function that stops polling.
  function startPoll(onReady, onTimeout) {
    let cancelled = false;
    const startedAt = Date.now();
    let timer = null;
    async function tick() {
      if (cancelled) return;
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) { onTimeout(); return; }
      try {
        const j = await getBootStatus();
        const r = j && j.stages && j.stages.ravendb;
        if (r && r.status === "ready") { onReady(); return; }
      } catch { /* keep polling */ }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }

  const state = runtimeError.healingState || "idle";
  const isFailed = state === "failed";
  const isPolling = state === "polling";
  const isHealing = state === "healing";

  let text = "RavenDB unreachable";
  if (isHealing) text = "Sending heal command…";
  else if (isPolling) text = "RavenDB started, please wait";
  else if (isFailed) text = "Unexpected error — please restart the RPi";

  return (
    <div className={"runtime-error-banner" + (isFailed ? " is-failed" : "")} role="alert">
      <span className="runtime-error-text">{text}</span>
      {!isFailed && !isPolling && !isHealing ? (
        <button className="runtime-error-heal ai-glow" onClick={onHeal}>Heal</button>
      ) : null}
      {isPolling ? <span className="runtime-error-spinner" aria-hidden /> : null}
    </div>
  );
}
