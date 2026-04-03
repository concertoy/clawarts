/**
 * Download images from Slack file attachments and convert to base64.
 * Ported from claude-code's inboundAttachments pattern.
 */

import type { ImageContent } from "../provider.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const DOWNLOAD_TIMEOUT_MS = 30_000;

interface SlackFile {
  url_private?: string;
  url_private_download?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  name?: string;
}

/**
 * Extract downloadable image files from a Slack message event.
 * Returns base64-encoded image content blocks for the Claude API.
 */
export async function downloadSlackImages(
  files: SlackFile[] | undefined,
  botToken: string,
): Promise<ImageContent[]> {
  if (!files || files.length === 0) return [];

  const images: ImageContent[] = [];

  for (const file of files) {
    const ext = (file.filetype ?? file.name?.split(".").pop() ?? "").toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    if (file.size && file.size > MAX_IMAGE_SIZE) {
      console.log(`[slack-images] Skipping ${file.name}: too large (${Math.round((file.size) / 1024)}KB)`);
      continue;
    }

    const url = file.url_private_download ?? file.url_private;
    if (!url) continue;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${botToken}` },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        console.warn(`[slack-images] Failed to download ${file.name}: ${resp.status}`);
        continue;
      }

      const buffer = await resp.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");

      const mediaType = mimeToMediaType(file.mimetype ?? `image/${ext}`);
      if (!mediaType) continue;

      images.push({ type: "image", mediaType, base64 });
      console.log(`[slack-images] Downloaded ${file.name} (${Math.round(buffer.byteLength / 1024)}KB)`);
    } catch (err) {
      console.warn(`[slack-images] Error downloading ${file.name}:`, err);
    }
  }

  return images;
}

function mimeToMediaType(mime: string): ImageContent["mediaType"] | null {
  if (mime.includes("png")) return "image/png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "image/jpeg";
  if (mime.includes("gif")) return "image/gif";
  if (mime.includes("webp")) return "image/webp";
  return null;
}
