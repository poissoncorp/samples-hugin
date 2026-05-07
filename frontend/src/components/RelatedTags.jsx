/* eslint-disable react/prop-types */
import "../styles/components/related-tags.css";
import { useAddToQueryParams } from "../hooks/useAddToQueryParams";
import { splitTags } from "./TagList";

// QuestionsTags' indexed Tag field is the same pipe-delimited string the
// source docs carry (e.g. "|microsoft-excel|worksheet-function|"). One row
// per pipe-string aggregates all questions that share that exact tag combo,
// so the Count is meaningful per row but each individual tag-token is more
// useful as a clickable filter.

function RelatedTags({ tags }) {
  const { addToQueryParams } = useAddToQueryParams();

  function handleTagClick(tag) {
    addToQueryParams({
      key: "tag",
      value: tag,
    });
  }

  function handleCommunityClick(community) {
    addToQueryParams({
      key: "community",
      value: community,
    });
  }

  return (
    <div className="card related-tags">
      <div className="card-body">
      <h3>Related tags:</h3>
      <ul className="related-tags-list">
        {tags.map((t) => {
          const tokens = splitTags(t.Tag);
          return (
            <li className="related-tag" key={t.Tag}>
              <div className="related-tag-title">
                <div className="related-tag-tokens">
                  {tokens.map((tok) => (
                    <button
                      key={tok}
                      className="tag btn btn-secondary btn-sm"
                      onClick={() => handleTagClick(tok)}
                    >
                      {tok}
                    </button>
                  ))}
                </div>
                <span className="related-tag-count">{t.Count.toLocaleString()}</span>
              </div>
              <ul className="related-tag-communities">
                {Object.entries(t.Communities || {}).map(([key, value]) => (
                  <li
                    key={key}
                    className={"related-tag-community tag-" + key + " bg-faded-" + key}
                    onClick={() => handleCommunityClick(key)}
                  >
                    <img src={`/img/${key}.svg`} />
                    <span>{value.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      </div>
    </div>
  );
}

export default RelatedTags;
