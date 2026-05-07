/* eslint-disable react/prop-types */
import { useEffect, useState, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { getBootStatus, healService } from "../services/data.service";
import "../styles/components/boot-screen.css";

const STAGE_ORDER = [
  { key: "ollama",  label: "Ollama service",   healSvc: "ollama"  },
  { key: "ravendb", label: "RavenDB",          healSvc: "ravendb" },
  { key: "warmup",  label: "Warmup queries",   healSvc: null      },
];

const POLL_OK_MS    = 1000;
const POLL_BACKOFF_MAX_MS = 5000;
// localStorage key for the "I've already seen Hugin boot once" flag. Once
// the BootScreen successfully dismisses, we never show it again in this
// browser unless the user appends ?bootscreen=1 (or wipes localStorage).
// Runtime ravendb outages still surface via RuntimeErrorBanner instead.
const DISMISSED_STORAGE_KEY = "hugin.bootscreen.dismissed.v1";
function readDismissed() {
  try { return window.localStorage.getItem(DISMISSED_STORAGE_KEY) === "1"; }
  catch { return false; }
}
function writeDismissed() {
  try { window.localStorage.setItem(DISMISSED_STORAGE_KEY, "1"); }
  catch { /* private mode / quota */ }
}

export default function BootScreen() {
  const [params] = useSearchParams();
  const forceShow = params.get("bootscreen") === "1";

  const [status, setStatus] = useState(null);   // last /api/boot-status response
  const [reachable, setReachable] = useState(true); // is hugin itself responding
  const [failedPolls, setFailedPolls] = useState(0); // for "still trying" UI
  const [healing, setHealing] = useState({});   // { ravendb: true }
  // Initial dismissed state: true if we've ever boot-dismissed in this
  // browser before (and the user didn't force-show via URL). That makes
  // page reloads silent for users who've already seen Hugin come up once.
  const [dismissed, setDismissed] = useState(() => !forceShow && readDismissed());
  const [fading, setFading] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0); // bump → re-runs effect
  const pollDelay = useRef(POLL_OK_MS);

  // Poll loop. Active only while the BootScreen is visible (not dismissed).
  // Once dismissed in a session it stops polling entirely — RuntimeErrorBanner
  // handles runtime ravendb-unreachable errors via search-leg 503 responses,
  // not via continuous boot-status polling.
  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    let timer = null;
    async function tick() {
      if (cancelled) return;
      try {
        const j = await getBootStatus();
        if (cancelled) return;
        setStatus(j);
        setReachable(true);
        setFailedPolls(0);
        pollDelay.current = POLL_OK_MS;
      } catch {
        if (cancelled) return;
        setReachable(false);
        setFailedPolls(n => n + 1);
        pollDelay.current = Math.min(POLL_BACKOFF_MAX_MS, pollDelay.current * 2);
      }
      timer = setTimeout(tick, pollDelay.current);
    }
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [dismissed, retryNonce]);

  // Auto-dismiss when ready=true (unless ?bootscreen=1). Persists the
  // dismissal so reloads don't replay the boot screen for users who've
  // already seen Hugin come up once.
  useEffect(() => {
    if (!status) return;
    if (!status.ready) return;
    if (forceShow) return;
    if (dismissed) return;
    setFading(true);
    const t = setTimeout(() => {
      setDismissed(true);
      writeDismissed();
    }, 220);
    return () => clearTimeout(t);
  }, [status, forceShow, dismissed]);

  if (dismissed) return null;
  if (!status && reachable) {
    // First render before the first poll — keep it minimal.
    return null;
  }

  async function onHeal(svc) {
    setHealing(h => ({ ...h, [svc]: true }));
    try { await healService(svc); }
    catch { /* swallow — next poll will surface state */ }
    finally { setHealing(h => ({ ...h, [svc]: false })); }
  }

  function onManualRetry() {
    pollDelay.current = POLL_OK_MS;
    setRetryNonce(n => n + 1);
  }

  // First-load with no successful poll yet: don't pretend hugin is in a
  // specific stage — just show a "Connecting" state. Once we get any
  // successful poll, we trust the backend's reported stages.
  const hasFreshStatus = !!status;

  return (
    <div className={"boot-screen" + (fading ? " is-fading" : "")} role="status" aria-live="polite">
      <div className="boot-screen-card">
        <h1 className="boot-screen-title">Hugin is waking up</h1>
        <p className="boot-screen-subtitle">
          A 1&nbsp;GHz Pi is bringing up 1.1&nbsp;million Stack&nbsp;Exchange questions. Give it a beat.
        </p>
        <ul className="boot-screen-stages">
          {STAGE_ORDER.map(({ key, label, healSvc }) => {
            const stage = status && status.stages && status.stages[key];
            const s = stage ? stage.status : "pending";
            const detail = stage ? stage.detail : (hasFreshStatus ? "" : "Connecting…");
            const isFailed = s === "failed";
            const isActive = s === "loading" || s === "starting";
            return (
              <li
                key={key}
                className={
                  "boot-stage" +
                  (isActive ? " ai-shine" : "") +
                  (s === "ready" ? " is-ready" : "") +
                  (isFailed ? " is-failed" : "")
                }
              >
                <span className="boot-stage-icon" aria-hidden>
                  {s === "ready" ? "✓" : s === "failed" ? "!" : "•"}
                </span>
                <span className="boot-stage-label">{label}</span>
                <span className={"boot-stage-status boot-stage-status-" + s}>{s}</span>
                {detail ? <span className="boot-stage-detail">{detail}</span> : null}
                {isFailed && healSvc ? (
                  <button
                    className="boot-stage-heal ai-glow"
                    disabled={!!healing[healSvc]}
                    onClick={() => onHeal(healSvc)}
                  >
                    {healing[healSvc] ? "Healing…" : `Heal ${label}`}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {!reachable && (
          <div className="boot-screen-hint">
            {hasFreshStatus
              ? <>Lost contact with Hugin — retrying…</>
              : <>Hugin is busy or still warming up — retrying ({failedPolls})…</>}
            <button type="button" className="boot-screen-retry" onClick={onManualRetry}>
              Try now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
