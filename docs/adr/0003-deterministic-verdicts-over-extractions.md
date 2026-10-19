# Verdicts are deterministic functions over extractions

Completeness, discrepancies, risks and parties are computed in code from `document_extractions`. The model does not reason them out. A confirmed (🔴) flag needs two source citations, and anything uncertain is a suspected (🟡) flag. In the 2026-09-10 MVP review, the user's three complaints (bad sorting, no context, "doesn't see problems") turned out to be one root cause: trust in extraction. So the fix went into extraction and pure functions, not into prompting.

## Consequences

Grounding rule 2 in the system prompt makes the agent call these tools instead of answering on its own. The golden eval (`npm run eval:golden`) guards extraction quality.
