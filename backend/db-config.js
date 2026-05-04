"use strict";

// Central database-name constant for the Hugin backend.
//
// The default is "Hugin" — the canonical name on a fresh Pi appliance.
// Override via environment variable when the on-disk RavenDB database
// uses a different name (for instance after rsync'ing a build artifact
// staged from a dev box where the database is called "Hugin-int1").
//
// Setting `HUGIN_DB_NAME` in the systemd unit (or `.env` consumed by the
// process manager) is the only place the override should live — every
// caller in this codebase reads the constant exported below, so changing
// the env var is sufficient to retarget the entire backend.
const DB_NAME = process.env.HUGIN_DB_NAME || "Hugin";

// Embeddings Generation Task identifier — used at QUERY time when the backend
// asks RavenDB to translate a free-text query into a vector via the EGT.
//
// Why this is overridable:
//  - The Node SDK's `vectorSearch(...).text = q` form does NOT auto-attach a
//    task identifier. The server then auto-derives one from the task NAME via
//    a CamelCase→kebab transform: "QuestionEmbeddings" → "question-embeddings".
//  - On the 2026-04-25-rebuilt Pi, the deployed task identifier is
//    "questionembeddings" (no hyphen) — chosen to match the original index's
//    `loadVector('Title', 'questionembeddings')` argument. The auto-derived
//    "question-embeddings" therefore mismatches the deployed identifier and
//    every `/api/search?mode=ai` request fails with HTTP 500
//    "Couldn't find Embeddings Generation task with 'question-embeddings'
//    identifier".
//  - The fix is to pass the identifier explicitly via
//    `v.byText(q, EMB_TASK_IDENTIFIER)` (or equivalent) so the SDK emits
//    `embedding.text($q, ai.task('<id>'))` with the correct value.
//
// Default is "questionembeddings" to match the deployed Pi state. Override
// via `HUGIN_EMB_TASK_IDENTIFIER` if a future build uses a different one.
const EMB_TASK_IDENTIFIER = process.env.HUGIN_EMB_TASK_IDENTIFIER || "questionembeddings";

module.exports = { DB_NAME, EMB_TASK_IDENTIFIER };
