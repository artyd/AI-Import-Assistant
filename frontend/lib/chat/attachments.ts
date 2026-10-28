/** A file attached to a chat message, as the upload returned it. */
export interface AttachedFile {
  fileId: string;
  name: string;
}

/**
 * The message the agent receives when files were attached to it: the user's
 * text plus the exact files, by id. Like a chat app that sends the attachment
 * with the message — the agent reads these files first instead of guessing which
 * of the shipment's documents "this file" means.
 */
export function withAttachments(text: string, files: AttachedFile[]): string {
  if (files.length === 0) return text;
  const list = files.map((f) => `- «${f.name}» (file_id: ${f.fileId})`).join("\n");
  return `${text}\n\n📎 Прикріплені файли:\n${list}`;
}
