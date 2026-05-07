/* eslint-disable react/prop-types */
import { useNavigate } from "react-router-dom";
import "../styles/components/question-preview.css";
import { formatDateToRelativeTime, getUserLink, getUserName } from "../services/util.service";
import TagList from "./TagList";
import { ExternalLink } from "./ExternalLink";

function QuestionPreview({ question, users }) {
  const navigate = useNavigate();
  // The backend's trimQuestion() drops Body and adds BodySnippet on rows > 400
  // chars; the mode=ai projection omits Body entirely. Render whichever is
  // present, fall back to empty.
  const rawBody = question.Body || question.BodySnippet || "";
  const text = rawBody
    ? rawBody.replace(/<[^>]+>/g, "").slice(0, 200) + (rawBody.length > 200 ? "..." : "")
    : "";
  const answerCount = Array.isArray(question.Answers)
    ? question.Answers.length
    : (question.AnswerCount ?? 0);
  const favoriteCount = question.FavoriteCount ?? 0;

  function handlePreviewclick() {
    navigate(`/question?id=${question.id}`);
  }

  return (
    <div className="card">
      <article className="card-body question-preview" onClick={handlePreviewclick}>
        <div className="question-preview-stats">
          <div className="question-preview-stats-item">
            <span>{favoriteCount}</span>
            <span>votes</span>
          </div>
          <div className="question-preview-stats-item">
            <span>{answerCount}</span>
            <span>answers</span>
          </div>
          <div className="question-preview-stats-item">
            <span>{question.ViewCount}</span>
            <span>views</span>
          </div>
        </div>
        <h3 className="question-preview-title m-0">{question.Title}</h3>
        <p className="question-preview-text">{text}</p>
        <div className="question-preview-img">
          <img
            src={`/img/${question.Community}.svg`}
            alt="logo"
          />
        </div>


        <footer className="question-preview-footer">
          <TagList tags={question.Tags} />
          <div className="question-preview-details">
            <span className="question-preview-owner">
              {question.Owner && users && users[question.Owner] ? (
                <ExternalLink href={getUserLink(question.Owner)}>
                  {" "}{getUserName(question.Owner, users)}
                </ExternalLink>
              ) : (
                /* Author info lazy-loads from /api/search-tail. Skeleton
                   placeholder until the tail merges users into redux. */
                <span className="question-preview-owner-skeleton" aria-label="loading author" />
              )}
            </span>
            {favoriteCount > 0 && (
              <span
                title="Favorite count"
                className="question-preview-favorite-count"
              >
                {favoriteCount}
              </span>
            )}

            <span className="question-preview-creation-date">
              asked {formatDateToRelativeTime(question.CreationDate)}
            </span>
          </div>
        </footer>
      </article>
    </div>
  );
}

export default QuestionPreview;
