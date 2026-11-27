// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MediaAsset } from "../types.js";

const mockExecFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

import {
  analyzeMedia,
  ensureUploaded,
  readAsBase64,
  hasMediaUploader,
  setMediaUploader,
  type MediaUploader,
} from "../media.js";

function tmpFile(ext: string, content = "some-bytes"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-hq-engine-media-"));
  const p = path.join(dir, `asset${ext}`);
  fs.writeFileSync(p, content);
  return p;
}

describe("media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no ffprobe available, so probeDimensions() swallows.
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ffprobe not found");
    });
    // Module state is shared across test files in a vitest worker, so a
    // wired uploader left over from another file would silently change which
    // branch ensureUploaded takes here.
    setMediaUploader(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setMediaUploader(null);
  });

  describe("analyzeMedia", () => {
    it.each([
      [".jpg", "image/jpeg", "image"],
      [".jpeg", "image/jpeg", "image"],
      [".png", "image/png", "image"],
      [".webp", "image/webp", "image"],
      [".gif", "image/gif", "gif"],
      [".mp4", "video/mp4", "video"],
      [".mov", "video/quicktime", "video"],
      [".webm", "video/webm", "video"],
      [".m4v", "video/x-m4v", "video"],
      [".pdf", "application/pdf", "document"],
    ] as const)("maps %s to mimeType %s / type %s", (ext, mimeType, type) => {
      const p = tmpFile(ext);
      const asset = analyzeMedia(p);
      expect(asset.mimeType).toBe(mimeType);
      expect(asset.type).toBe(type);
      expect(asset.path).toBe(path.resolve(p));
      expect(asset.size).toBeGreaterThan(0);
    });

    it("is case-insensitive on extension", () => {
      const p = tmpFile(".JPG");
      const asset = analyzeMedia(p);
      expect(asset.mimeType).toBe("image/jpeg");
      expect(asset.type).toBe("image");
    });

    it("throws for an unsupported extension", () => {
      const p = tmpFile(".txt");
      expect(() => analyzeMedia(p)).toThrow(/unsupported media extension "\.txt"/);
    });

    it("throws for a missing file", () => {
      const missing = path.join(os.tmpdir(), "does-not-exist-12345.jpg");
      expect(() => analyzeMedia(missing)).toThrow(/media file not found/);
    });

    it("sets width/height/durationSec when ffprobe succeeds", () => {
      mockExecFileSync.mockReturnValue(
        JSON.stringify({
          streams: [{ width: 1920, height: 1080 }],
          format: { duration: "12.34" },
        }),
      );
      const p = tmpFile(".mp4");
      const asset = analyzeMedia(p);
      expect(asset.width).toBe(1920);
      expect(asset.height).toBe(1080);
      expect(asset.durationSec).toBe(12.3);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "ffprobe",
        expect.arrayContaining(["-v", "error"]),
        expect.objectContaining({ encoding: "utf8" }),
      );
    });

    it("leaves dims undefined when ffprobe throws", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("no ffprobe binary");
      });
      const p = tmpFile(".mp4");
      const asset = analyzeMedia(p);
      expect(asset.width).toBeUndefined();
      expect(asset.height).toBeUndefined();
      expect(asset.durationSec).toBeUndefined();
    });

    it("leaves dims undefined when ffprobe returns no usable stream/format data", () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({ streams: [], format: {} }));
      const p = tmpFile(".mp4");
      const asset = analyzeMedia(p);
      expect(asset.width).toBeUndefined();
      expect(asset.height).toBeUndefined();
      expect(asset.durationSec).toBeUndefined();
    });

    it("treats falsy width/height (0) as undefined", () => {
      mockExecFileSync.mockReturnValue(
        JSON.stringify({ streams: [{ width: 0, height: 0 }], format: { duration: "5" } }),
      );
      const p = tmpFile(".mp4");
      const asset = analyzeMedia(p);
      expect(asset.width).toBeUndefined();
      expect(asset.height).toBeUndefined();
      expect(asset.durationSec).toBe(5);
    });
  });

  describe("readAsBase64", () => {
    it("returns base64 content when under the byte cap", async () => {
      const p = tmpFile(".pdf", "hello world");
      const asset: MediaAsset = {
        path: p,
        type: "document",
        mimeType: "application/pdf",
        size: fs.statSync(p).size,
      };
      const result = await readAsBase64(asset);
      expect(result).toBe(Buffer.from("hello world").toString("base64"));
    });

    it("returns null when the asset size exceeds maxBytes", async () => {
      const p = tmpFile(".pdf", "hello world");
      const asset: MediaAsset = {
        path: p,
        type: "document",
        mimeType: "application/pdf",
        size: fs.statSync(p).size,
      };
      // ⛔ The ceiling is checked against `asset.size` BEFORE the read, so an
      // oversized asset is never loaded into memory. Asserted through a path
      // that does not exist: a read would throw ENOENT, so resolving to null
      // proves the size guard short-circuits rather than merely masking.
      await expect(readAsBase64({ ...asset, path: "/nonexistent/huge.pdf" }, 1)).resolves.toBeNull();
      await expect(readAsBase64(asset, 1)).resolves.toBeNull();
    });

    it("respects a custom maxBytes above the default", async () => {
      const p = tmpFile(".pdf", "hi");
      const asset: MediaAsset = {
        path: p,
        type: "document",
        mimeType: "application/pdf",
        size: fs.statSync(p).size,
      };
      await expect(readAsBase64(asset, 1_000_000)).resolves.toBe(
        Buffer.from("hi").toString("base64"),
      );
    });
  });

  describe("ensureUploaded", () => {
    it("returns the asset unchanged when url is already set (no upload call)", async () => {
      const asset: MediaAsset = {
        path: "/tmp/whatever.jpg",
        type: "image",
        mimeType: "image/jpeg",
        size: 10,
        url: "https://already.example/asset.jpg",
      };
      const result = await ensureUploaded(asset);
      expect(result).toBe(asset);
    });

    it("THROWS when no uploader is wired, rather than sending the bytes to a third party", async () => {
      // ⛔ This used to fall back to the aggregator's own storage, which meant a
      // caller with nothing wired silently published media from someone else's
      // CDN — and when that account was deleted every URL it had issued died,
      // stripping images off posts that were already live. An asset with no
      // home is a publish that must not start.
      expect(hasMediaUploader()).toBe(false);
      const p = tmpFile(".jpg", "img-bytes");
      const asset: MediaAsset = {
        path: p,
        type: "image",
        mimeType: "image/jpeg",
        size: fs.statSync(p).size,
      };
      await expect(ensureUploaded(asset)).rejects.toThrow(/no media uploader is wired/);
      expect(asset.url).toBeUndefined();
    });

    it("uses the injected uploader when one is wired", async () => {
      const uploader: MediaUploader = vi.fn(async () => ({
        url: "https://cdn.example/injected.jpg",
      }));
      setMediaUploader(uploader);
      expect(hasMediaUploader()).toBe(true);

      const p = tmpFile(".jpg", "img-bytes");
      const asset: MediaAsset = {
        path: p,
        type: "image",
        mimeType: "image/jpeg",
        size: fs.statSync(p).size,
      };

      const result = await ensureUploaded(asset);

      expect(uploader).toHaveBeenCalledWith(
        path.basename(p),
        Buffer.from("img-bytes"),
        "image/jpeg",
      );
      expect(result.url).toBe("https://cdn.example/injected.jpg");
      expect(result).toBe(asset);
    });

    it("does not call the injected uploader when asset.url is already set", async () => {
      const uploader: MediaUploader = vi.fn(async () => ({ url: "https://unused.example" }));
      setMediaUploader(uploader);

      const asset: MediaAsset = {
        path: "/tmp/whatever.jpg",
        type: "image",
        mimeType: "image/jpeg",
        size: 10,
        url: "https://already.example/asset.jpg",
      };
      const result = await ensureUploaded(asset);

      expect(result).toBe(asset);
      expect(uploader).not.toHaveBeenCalled();
    });

    it("setMediaUploader(null) clears the wired uploader, and ensureUploaded then refuses", async () => {
      const uploader: MediaUploader = vi.fn(async () => ({ url: "https://cdn.example/x.jpg" }));
      setMediaUploader(uploader);
      expect(hasMediaUploader()).toBe(true);

      setMediaUploader(null);
      expect(hasMediaUploader()).toBe(false);

      const p = tmpFile(".jpg", "img-bytes");
      const asset: MediaAsset = {
        path: p,
        type: "image",
        mimeType: "image/jpeg",
        size: fs.statSync(p).size,
      };
      await expect(ensureUploaded(asset)).rejects.toThrow(/no media uploader is wired/);
      expect(uploader).not.toHaveBeenCalled();
    });
  });

  describe("hasMediaUploader", () => {
    it("is false by default (no uploader wired)", () => {
      expect(hasMediaUploader()).toBe(false);
    });

    it("reflects wiring state as setMediaUploader is toggled", () => {
      const uploader: MediaUploader = async () => ({ url: "https://cdn.example/x.jpg" });
      setMediaUploader(uploader);
      expect(hasMediaUploader()).toBe(true);
      setMediaUploader(null);
      expect(hasMediaUploader()).toBe(false);
    });
  });
});
