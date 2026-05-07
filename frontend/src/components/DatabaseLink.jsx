/* eslint-disable react/prop-types */
import "../styles/components/database-link.css";

function DatabaseLink() {
  const useNamedHosts = window.location.hostname === "start.ravendb";
  const dbHost = useNamedHosts
    ? "http://database.ravendb"
    : "http://" + window.location.hostname + ":8080";
  return (
    <article className="card database-link">
      <a href={dbHost} target="_blank" rel="noreferrer" className="database-link-anchor">
        <div className="database-link-body">
          <header className="database-link-header">
            <h3 className="database-link-title">Inspect the database</h3>
            <span className="database-link-cta">Open Studio →</span>
          </header>
          <p className="database-link-subtitle">
            All 1.1 M questions and the indexes powering this search — in your browser.
          </p>
          <div className="database-link-shot">
            <img src="/img/studio.png" alt="RavenDB Studio interface" />
          </div>
        </div>
      </a>
    </article>
  );
}

export default DatabaseLink;
