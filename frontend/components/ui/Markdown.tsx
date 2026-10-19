"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Module-level (stable identity) so memoised renders never re-create them.
const REMARK_PLUGINS = [remarkGfm];
const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

// Assistant answers arrive as Markdown (reconciliation diff-tables and
// completeness checklists are Markdown inside the message — v1 of the contract).
// Memoised: re-parsing only happens when the text itself changes, so a
// streaming answer doesn't re-parse every earlier message on each token.
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
