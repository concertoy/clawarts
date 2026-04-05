/**
 * Shared types for Slack file handling (used by slack-images.ts and slack-files.ts).
 */

export interface SlackFile {
  url_private?: string;
  url_private_download?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  name?: string;
}

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** Extract the lowercase file extension from a Slack file object. */
export function fileExtension(file: SlackFile): string {
  return (file.filetype ?? file.name?.split(".").pop() ?? "").toLowerCase();
}
