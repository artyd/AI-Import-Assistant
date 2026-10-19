/** MIME type for inline preview / download, derived from the stored file type. */
export function contentType(type: string, name: string): string {
  switch (type) {
    case 'pdf':
      return 'application/pdf';
    case 'csv':
      return 'text/csv; charset=utf-8';
    case 'md':
      return 'text/markdown; charset=utf-8';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'image': {
      const n = name.toLowerCase();
      if (n.endsWith('.png')) return 'image/png';
      if (n.endsWith('.gif')) return 'image/gif';
      if (n.endsWith('.webp')) return 'image/webp';
      return 'image/jpeg';
    }
    default:
      return 'application/octet-stream';
  }
}

export function imageMediaType(name: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  const n = name.toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}
