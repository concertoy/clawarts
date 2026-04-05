/**
 * Download non-image files from Slack and extract text content.
 * Companion to slack-images.ts — handles everything that isn't an image.
 */

import { errMsg } from "./errors.js";
import { fetchWithTimeout } from "./fetch-timeout.js";
import { fileExtension, IMAGE_EXTENSIONS, type SlackFile } from "./slack-types.js";
import { createLogger } from "./logger.js";

const log = createLogger("slack-files");

const TEXT_EXTENSIONS = new Set([
  // Plain text
  "txt", "md", "csv", "json", "xml", "yaml", "yml", "toml", "ini", "log",
  // Code
  "ts", "js", "py", "rb", "go", "rs", "java", "c", "cpp", "h", "sh", "sql",
  "html", "css", "tsx", "jsx", "swift", "kt", "scala", "r", "m", "lua",
  "php", "pl", "ex", "exs", "hs", "ml", "clj", "erl", "elm", "vue", "svelte",
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_TEXT_CHARS = 50_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export interface FileAttachment {
  name: string;
  content: string;
  truncated: boolean;
}

/**
 * Download non-image file attachments from a Slack message and extract text.
 * Images are skipped (handled by slack-images.ts).
 */
export async function downloadSlackFiles(
  files: SlackFile[] | undefined,
  botToken: string,
): Promise<FileAttachment[]> {
  if (!files || files.length === 0) return [];

  const attachments: FileAttachment[] = [];

  for (const file of files) {
    const ext = fileExtension(file);

    // Skip images — already handled by downloadSlackImages
    if (IMAGE_EXTENSIONS.has(ext)) continue;

    const fileName = file.name ?? `file.${ext}`;

    // Binary files we can't extract text from
    if (!TEXT_EXTENSIONS.has(ext)) {
      const sizeStr = file.size != null ? ` (${Math.round(file.size / 1024)}KB)` : "";
      attachments.push({
        name: fileName,
        content: `[File: ${fileName}${sizeStr} — binary, cannot extract text]`,
        truncated: false,
      });
      continue;
    }

    if (file.size && file.size > MAX_FILE_SIZE) {
      log.info(`Skipping ${fileName}: too large (${Math.round(file.size / 1024)}KB)`);
      attachments.push({
        name: fileName,
        content: `[File: ${fileName} (${Math.round(file.size / 1024)}KB) — too large to process, limit is ${MAX_FILE_SIZE / 1024 / 1024}MB]`,
        truncated: false,
      });
      continue;
    }

    const url = file.url_private_download ?? file.url_private;
    if (!url) continue;

    try {
      const resp = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${botToken}` },
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      });

      if (!resp.ok) {
        log.warn(`Failed to download ${fileName}: ${resp.status}`);
        continue;
      }

      let text = await resp.text();
      let truncated = false;

      if (text.length > MAX_TEXT_CHARS) {
        text = text.slice(0, MAX_TEXT_CHARS);
        truncated = true;
      }

      attachments.push({ name: fileName, content: text, truncated });
      log.debug(`Downloaded ${fileName} (${text.length} chars${truncated ? ", truncated" : ""})`);
    } catch (err) {
      log.warn(`Error downloading ${fileName}:`, errMsg(err));
    }
  }

  return attachments;
}

/** Format file attachments as text to prepend to a user message. */
export function formatFileAttachments(attachments: FileAttachment[]): string {
  if (attachments.length === 0) return "";

  return attachments
    .map((a) => {
      const ext = a.name.split(".").pop() ?? "";
      const truncNote = a.truncated ? ` (truncated to ${MAX_TEXT_CHARS} chars)` : "";
      // Binary stubs already have the bracket format
      if (a.content.startsWith("[File:")) return a.content;
      return `[Attached file: ${a.name}${truncNote}]\n\`\`\`${ext}\n${a.content}\n\`\`\``;
    })
    .join("\n---\n");
}
