import { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import ReactDOM from 'react-dom';
import { httpService } from '../services/http.service';

// Module-level connectivity cache. The HomePage mounts ~10 ExternalLinks at
// once; every instance previously fired its own /api/is-online probe AND
// retried every 2.5s on failure, producing a steady-state probe storm. Now:
// one in-flight probe is shared across all instances, the result is cached
// for CACHE_MS, and retries on failure are exponential and capped.
const CACHE_MS = 60_000;
let cachedStatus = null;     // 'online' | 'offline' | null
let cachedAt    = 0;
let inflight    = null;      // Promise<'online'|'offline'> | null
let nextRetryAt = 0;
let backoffMs   = 2500;      // grows on consecutive failures, capped at 30 s

const subscribers = new Set(); // notified on every status update

function notify(status) {
  for (const fn of subscribers) {
    try { fn(status); } catch { /* swallow */ }
  }
}

async function probeOnline() {
  const now = Date.now();
  if (cachedStatus && now - cachedAt < CACHE_MS) return cachedStatus;
  if (inflight) return inflight;
  if (cachedStatus === "offline" && now < nextRetryAt) return cachedStatus;

  inflight = (async () => {
    let next;
    try {
      const r = await httpService.get("is-online");
      next = r && r.online ? "online" : "offline";
    } catch {
      next = "offline";
    }
    cachedStatus = next;
    cachedAt = Date.now();
    if (next === "offline") {
      nextRetryAt = cachedAt + backoffMs;
      backoffMs = Math.min(30_000, backoffMs * 2);
    } else {
      backoffMs = 2500;
      nextRetryAt = 0;
    }
    inflight = null;
    notify(next);
    return next;
  })();
  return inflight;
}

export function ExternalLink({ href, children, className }) {
  const [showPopup, setShowPopup] = useState(false);
  const [onlineStatus, setOnlineStatus] = useState(cachedStatus || "loading");

  useEffect(() => {
    let cancelled = false;
    const onUpdate = (status) => { if (!cancelled) setOnlineStatus(status); };
    subscribers.add(onUpdate);
    probeOnline().then((s) => { if (!cancelled) setOnlineStatus(s); });
    return () => { cancelled = true; subscribers.delete(onUpdate); };
  }, []);

  const openPopup = (e) => {
    if (onlineStatus !== "online") {
      e.preventDefault();
      setShowPopup(true);
    }
    else {
      setShowPopup(false);
    }
  };

  const closePopup = () => {
    setShowPopup(false);
  };

  const openExternalLink = () => {
    closePopup();
  };

  const portalContainer = document.createElement('div');

  useEffect(() => {
    document.body.appendChild(portalContainer);

    return () => {
      document.body.removeChild(portalContainer);
    };
  }, [portalContainer]);

  const popupPortal = showPopup
    ? ReactDOM.createPortal(
      <div className="external-link-popup">
        <div className='card bg-faded-interactive external-link-card'>
          <div className='card-body text-center text-light'>
            <h3>Opening an external link</h3>
            <img src={"./img/switch-wifi.svg"} className='img-fluid my-3' />
            <p className='lead'>By default Hugin's WiFi is not connected to the Internet. Disconnect from Hugin's WiFi and connect to the normal network and click <strong className='text-emphasis'>Open external website</strong>. </p>
            <div className='hstack gap-3 justify-content-center flex-wrap-1 mt-4'>
              <button onClick={closePopup} className='btn btn-secondary btn-lg'>Cancel</button>
              <a href={href} className='btn btn-interactive btn-lg' target="_blank" onClick={openExternalLink}>Open external website</a>
            </div>
          </div>
        </div>
      </div>,
      portalContainer
    )
    : null;

  return (
    <>
      <a href={href} className={className} onClick={openPopup} target="_blank">
        {children}
      </a>
      {popupPortal}
    </>
  );
}

ExternalLink.propTypes = {
  href: PropTypes.string.isRequired,
  children: PropTypes.node.isRequired,
};
