import { useEffect, useState } from "react";

const POLL_INTERVAL_MS = 1500;

// Full-page overlay that polls /api/ready and dismisses when the
// backend reports its first wakeUp() iteration has finished. Mounted
// once at app load — once dismissed it does not reappear (so route
// changes inside the warm session don't keep flashing the overlay).
//
// If /api/ready is missing (pre-intervention image, dev box without
// hugin proxy, etc) the overlay treats that as "ready" and dismisses
// immediately. The overlay should never be the reason the user can't
// see the app; it's a friendly hint, not a gate.
//
// "Continue without waiting" is intentional. The user is in charge —
// some queries don't need warm Ollama (FTS, /how page) and a stuck
// warmup shouldn't trap them on a loading screen.
export default function WarmupOverlay() {
  const [state, setState] = useState({ checked: false, ready: false, eta: null });

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function poll() {
      try {
        const resp = await fetch("/api/ready", { cache: "no-store" });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const j = await resp.json();
        if (cancelled) return;
        setState({ checked: true, ready: !!j.ready, eta: j.etaSeconds });
        if (!j.ready) timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        if (cancelled) return;
        setState({ checked: true, ready: true, eta: 0 });
      }
    }
    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  if (!state.checked || state.ready) return null;

  const eta = state.eta != null ? Math.max(0, Math.round(state.eta)) : null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20, 24, 31, 0.92)",
        zIndex: 9000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#e8eaed",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 420,
          padding: "32px 28px",
          textAlign: "center",
          background: "#1f2530",
          borderRadius: 12,
          boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
        }}
      >
        <div
          aria-hidden
          style={{
            width: 44, height: 44,
            margin: "0 auto 18px",
            border: "3px solid #3a4252",
            borderTopColor: "#7aa3ff",
            borderRadius: "50%",
            animation: "warmup-spin 1s linear infinite",
          }}
        />
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
          Initializing the knowledge base…
        </h2>
        <p style={{ margin: "10px 0 0", fontSize: 14, opacity: 0.78 }}>
          {eta != null && eta > 0
            ? `About ${eta} second${eta === 1 ? "" : "s"} remaining.`
            : "Almost ready."}
        </p>
        <p style={{ margin: "20px 0 0", fontSize: 12, opacity: 0.55 }}>
          One-time warm-up so vector search responds quickly. Subsequent
          searches will be much faster.
        </p>
        <button
          onClick={() => setState((s) => ({ ...s, ready: true }))}
          style={{
            marginTop: 22,
            padding: "8px 16px",
            background: "transparent",
            color: "#9bb1d8",
            border: "1px solid #3a4252",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          Continue without waiting
        </button>
      </div>
      <style>{`@keyframes warmup-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
