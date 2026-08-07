"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Assistant answers arrive as Markdown (reconciliation diff-tables and
// completeness checklists are Markdown inside the message — v1 of the contract).
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
