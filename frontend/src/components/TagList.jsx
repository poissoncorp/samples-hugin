/* eslint-disable react/prop-types */
import "../styles/components/tag-list.css";
import { useAddToQueryParams } from "../hooks/useAddToQueryParams";

// Tags in HuginAI are stored Stack-Exchange-XML-style: a single pipe-delimited
// string like "|mouse|redhat-enterprise-linux|touchpad|". Normalise to a flat
// array of tag names regardless of input shape.
export function splitTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) {
    // Each element might still be a pipe-string if the value came from
    // QuestionsTags (where the indexed Tag field is itself a pipe-string).
    return tags.flatMap((t) => splitTags(t));
  }
  return String(tags)
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

function TagList({ tags }) {
  const { addToQueryParams } = useAddToQueryParams();
  const flat = splitTags(tags);

  return (
    <div className="tag-list">
      {flat.map((tag) => (
        <button
          key={tag}
          className="tag btn btn-secondary btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            addToQueryParams({
              key: "tag",
              value: tag,
            });
          }}
        >
          <span>{tag}</span>
        </button>
      ))}
    </div>
  );
}

export default TagList;
