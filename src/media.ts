import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { MediaAsset } from "./types.js";

/**
 * Where an asset's bytes get a public URL, injected rather than imported.
 *
 * Same shape as media-fit.ts's `MediaFitter` and for the same reason: this
 * folder is deliberately portable engine code (relative imports only; see
 * index.ts's header), so it cannot reach the
 * app's media store uploader directly. The app wires an implementation the
 * same way it wires the media fitter and every credential resolver.
 */
export interface UploadedMedia {
  url: string;
}

export type MediaUploader = (
  filename: string,
  bytes: Buffer,
  mimeType: string,
) => Promise<UploadedMedia>;

let _uploader: MediaUploader | null = null;

export function setMediaUploader(fn: MediaUploader | null): void {
  _uploader = fn;
}

/** Whether an app-side uploader is wired. Without one, ensureUploaded throws. */
export function hasMediaUploader(): boolean {
  return _uploader !== null;
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".pdf": "application/pdf",
};

export function analyzeMedia(filePath: string): MediaAsset {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`media file not found: ${abs}`);
  const ext = path.extname(abs).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) {
    throw new Error(
      `unsupported media extension "${ext}" (supported: ${Object.keys(MIME_BY_EXT).join(", ")})`,
    );
  }
  const size = fs.statSync(abs).size;
  const type: MediaAsset["type"] =
    mimeType === "image/gif"
      ? "gif"
      : mimeType.startsWith("image/")
        ? "image"
        : mimeType.startsWith("video/")
          ? "video"
          : "document";
  const asset: MediaAsset = { path: abs, type, mimeType, size };
  Object.assign(asset, probeDimensions(abs));
  return asset;
}

/** Uses ffprobe when available; silently skips otherwise. */
function probeDimensions(abs: string): Partial<MediaAsset> {
  try {
    const out = execFileSync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height:format=duration",
        "-of", "json",
        abs,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const parsed = JSON.parse(out);
    const stream = parsed.streams?.[0] ?? {};
    const duration = parseFloat(parsed.format?.duration ?? "");
    return {
      width: stream.width || undefined,
      height: stream.height || undefined,
      durationSec: Number.isFinite(duration) ? Math.round(duration * 10) / 10 : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Give the asset a public URL through the wired uploader. No-op if it already
 * has one. Sets asset.url.
 *
 * ⛔ THROWS when no uploader is wired, and that is the point. Falling back to
 * an aggregator's own storage would silently publish media from a third
 * party's CDN, and when that account is deleted every URL it ever issued dies
 * with it, taking the images off posts that are already live. There is no
 * safe default here: an asset with no home is a publish that must not start.
 *
 * A caller with no uploader (such as a CLI with no media store client) can
 * compose and QA drafts but cannot publish one carrying local media. That is a
 * real limitation, stated rather than papered over.
 *
 * ⚠️ The read is `fs.promises.readFile`, NOT `readFileSync`. This runs on the
 * publish path inside a server process, where a synchronous read of a video
 * blocks the whole event loop for every other request on that process for as
 * long as the read takes. The asynchronous read is also what lets the caller
 * upload several independent assets at once instead of one after another.
 */
export async function ensureUploaded(asset: MediaAsset): Promise<MediaAsset> {
  if (asset.url) return asset;
  if (!_uploader) {
    throw new Error(
      `no media uploader is wired, so ${path.basename(asset.path)} has no public URL to publish from ` +
        `(call setMediaUploader — see media.ts)`,
    );
  }
  const data = await fsp.readFile(asset.path);
  const { url } = await _uploader(path.basename(asset.path), data, asset.mimeType);
  asset.url = url;
  return asset;
}

/**
 * The asset's bytes as base64, or null when it is over the ceiling.
 *
 * ⛔ THE CEILING IS CHECKED AGAINST `asset.size` BEFORE ANY READ, and that
 * ordering is the behaviour, not an optimisation: an oversized asset is never
 * loaded into memory at all. Async for the same reason as `ensureUploaded` —
 * the previous `readFileSync` stalled the event loop for up to 15 MB.
 */
export async function readAsBase64(
  asset: MediaAsset,
  maxBytes = 15_000_000,
): Promise<string | null> {
  if (asset.size > maxBytes) return null;
  return (await fsp.readFile(asset.path)).toString("base64");
}
