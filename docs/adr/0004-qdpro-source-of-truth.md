# qdpro is the source of truth for customs data; the static base is a fallback

Duties, VAT, preferences, restrictions and required documents for an УКТ ЗЕД code come from qdpro through `logist-mcp`. The bundled JSON tables are used only when qdpro is unavailable, and the agent must say so when it falls back. Code *selection* stays advisory: the agent gives several candidates with reasoning and states that a customs specialist confirms the final code.

## Consequences

Consolidated analysis keeps its static numeric calculation but cross-checks every line against qdpro (`/rest/uktzed/flags`). On a divergence the line is marked as needs review, and qdpro wins.
