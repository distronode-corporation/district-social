/**
 * Opt-in LIVE proof that the YouTube transport can UPLOAD, read back and
 * DELETE. Skipped unless RUN_YOUTUBE_PUBLISH_PROOF=1, so CI never uploads
 * anything.
 *
 * ⛔ THIS UPLOADS TO A REAL CHANNEL: the channel behind the OAuth credential
 * below. Uploads are the one publish action that cannot be made cheap: a video
 * occupies quota and is visible to the channel owner in Studio even after
 * deletion. The proof uploads a one-second black clip it generates with ffmpeg,
 * reads it back, deletes it, and confirms it is gone. An upload a failed
 * assertion leaves behind is deleted by the sweep in `afterAll`
 * (helpers/proof-artifacts.ts).
 *
 * ⚠️ IT UPLOADS AS `private`, THROUGH youtubeTransport.publishNow(), the real
 * publish path. `youtubeVisibility` reads SOCIALMETA_YOUTUBE_VISIBILITY, so the
 * proof can upload privately AND exercise the transport.
 *
 * ⛔ SOCIALMETA_YOUTUBE_VISIBILITY=private IS MANDATORY, and asserted in its
 * own test BEFORE any upload runs. Without it `defaults()` falls back to
 * "public" and this proof puts a real video on the channel, notifying
 * subscribers.
 *
 * ⚠️ The upload is a REAL resumable session: POST to open it, then one PUT
 * carrying the whole body. A `308 Resume Incomplete` is a hard failure in this
 * client (chunked resume is not implemented), so a flaky link fails the test
 * rather than hanging.
 *
 * Environment (no defaults; export them from your own secret store):
 *   RUN_YOUTUBE_PUBLISH_PROOF=1          the gate
 *   SOCIALMETA_YOUTUBE_VISIBILITY=private
 *   and EITHER
 *   YOUTUBE_ACCESS_TOKEN                 a ready access token with the
 *                                        youtube.upload and youtube scopes
 *   OR all three of
 *   YOUTUBE_CLIENT_ID                    OAuth client of an installed app
 *   YOUTUBE_CLIENT_SECRET
 *   YOUTUBE_REFRESH_TOKEN                minted by an account that manages
 *                                        the channel
 *
 *   npx vitest run src/__tests__/youtube.live.proof.test.ts
 *
 * ⚠️ Two credential traps that are about Google, not this code. Service
 * accounts do not work: the YouTube Data API does not support the
 * service-account flow. And a refresh token issued by an OAuth app whose
 * consent screen is still in Testing expires after 7 days, then fails with an
 * `invalid_grant` that looks like a revoked credential.
 *
 * Requires `ffmpeg` on PATH.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getVideos, setYouTubeTokenResolver } from "../youtube.js";
import { youtubeTransport } from "../youtube-transport.js";
import { defaults } from "../settings.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { MediaAsset, PlatformRender } from "../types.js";
import { useLiveNetwork } from "./helpers/live-network.js";
import { proofArtifacts } from "./helpers/proof-artifacts.js";
import { requireEnv } from "./helpers/proof-env.js";
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const enabled = process.env.RUN_YOUTUBE_PUBLISH_PROOF === "1";

const STAMP = new Date().toISOString();

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * The token resolver the engine needs, built from env only.
 *
 * The engine is deliberately credential-free: youtube.ts holds no secrets and
 * throws unless the embedding app injects a resolver. This is the smallest
 * honest one: a supplied access token as-is, or one refresh-token grant per
 * run, memoised so the upload, the reads and the deletes share it.
 */
function tokenResolver(): () => Promise<string> {
  const direct = process.env.YOUTUBE_ACCESS_TOKEN;
  if (direct) return async () => direct;

  const env = requireEnv(["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]);
  let minted: Promise<string> | null = null;
  return () => {
    minted ??= (async () => {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.YOUTUBE_CLIENT_ID,
          client_secret: env.YOUTUBE_CLIENT_SECRET,
          refresh_token: env.YOUTUBE_REFRESH_TOKEN,
          grant_type: "refresh_token",
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!res.ok || !body.access_token) {
        throw new Error(
          `youtube token refresh failed: ${body.error ?? `HTTP ${res.status}`}` +
            (body.error_description ? ` (${body.error_description})` : ""),
        );
      }
      return body.access_token;
    })();
    return minted;
  };
}

/**
 * A REAL, playable video, generated at test time with ffmpeg rather than
 * committed as a binary fixture.
 *
 * ⛔ DO NOT REPLACE THIS WITH A HAND-BUILT MP4 BYTE ARRAY. A container with no
 * actual stream (ftyp+moov only) is ACCEPTED by the upload API, gets a video
 * id, and `videos.list` confirms the id exists. YouTube then fails the video in
 * processing and removes it, leaving a "Deleted video" entry in the uploads
 * playlist. So an upload proof that stops at "the id exists" can pass against a
 * file that was never going to survive.
 *
 * 256x144, one second, silent, H.264/AAC, ~3.5KB.
 */
function proofVideo(): Uint8Array<ArrayBuffer> {
  const out = path.join(os.tmpdir(), `district-social-yt-proof-${process.pid}.mp4`);
  execFileSync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "color=c=black:s=256x144:d=1",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
    "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-movflags", "+faststart",
    out,
  ], { stdio: "ignore" });
  const bytes = new Uint8Array(readFileSync(out)) as Uint8Array<ArrayBuffer>;
  unlinkSync(out);
  return bytes;
}

/**
 * Serve the generated bytes over an ephemeral localhost server.
 *
 * publishNow takes a render whose video has a FETCHABLE URL: it calls
 * fetchMediaBytes("youtube", video.url) through the shared media fetch
 * (media-fetch.ts). This bridges that to a video built at test time without
 * an external dependency: no asset has to be hosted anywhere, and the proof
 * stays self-contained.
 *
 * ⚠️ 127.0.0.1, so this does NOT exercise a real media host (TLS, redirects, a
 * CDN in front). That is fine for what is being proven here (the bytes
 * arriving at YouTube are the same either way), but it means this leg says
 * nothing about fetching media from a real origin.
 */
async function serveBytes(bytes: Uint8Array): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(bytes.byteLength) });
    res.end(Buffer.from(bytes));
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/proof.mp4`,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

describe.runIf(enabled)("youtube transport live proof", () => {
  // Deletes an upload a failed assertion left on the real channel. An orphaned
  // upload here is worse than a stray post elsewhere: it also holds ~1,600
  // units of the default 10,000/day quota.
  const artifacts = proofArtifacts("youtube", youtubeTransport);

  // Real network for the whole file (Google's APIs and the local media server
  // below), with the sweep run BEFORE fetch is handed back to the suite's
  // interceptor (see helpers/live-network.ts). The token resolver is
  // module-scoped state and survives to the sweep.
  useLiveNetwork(() => artifacts.sweep());

  let resolver: () => Promise<string>;
  beforeAll(() => {
    resolver = tokenResolver();
  });

  beforeEach(() => {
    setYouTubeTokenResolver(resolver);
  });

  /**
   * ⛔ THE GUARD, and deliberately its own test so it runs BEFORE the upload
   * and fails as itself.
   *
   * publishNow reads privacyStatus from defaults(), which falls back to
   * "public" when SOCIALMETA_YOUTUBE_VISIBILITY is unset or misspelled, and it
   * falls back SILENTLY, by design, because a typo must never fail a real
   * publish. That safety property is exactly what makes it dangerous here: get
   * it wrong and this proof puts a real video on the channel, notifies
   * subscribers, and only then deletes it.
   */
  it("is configured to upload PRIVATELY", () => {
    expect(
      defaults().youtubeVisibility,
      "set SOCIALMETA_YOUTUBE_VISIBILITY=private: without it this uploads PUBLICLY to the real channel",
    ).toBe("private");
  });

  it("publishes through the transport, reads it back, deletes it, and confirms it is gone", async () => {
    // Re-checked here as well as in its own row: vitest does not bail after a
    // failed `it`, and this one uploads.
    expect(defaults().youtubeVisibility).toBe("private");

    const media = await serveBytes(proofVideo());
    try {
      const title = `district-social upload proof ${STAMP}`;
      const video: MediaAsset = {
        path: "/proof/clip.mp4",
        type: "video",
        mimeType: "video/mp4",
        size: 0,
        url: media.url,
      };
      const render: PlatformRender = {
        platform: "youtube",
        title,
        content:
          "Automated upload proof. Private, deleted immediately after this test reads it back. " +
          "If you are seeing this in Studio, the delete step failed and it should be removed.",
      } as PlatformRender;

      // The real path: title/description/tag truncation, defaults() for
      // category and privacy, the shared media fetch, insertVideo, postUrl.
      const created = await youtubeTransport.publishNow({
        render,
        media: [video],
        draftId: "proof",
        destination: { title },
      });

      expect(created.ref).toBeTruthy();
      artifacts.track(created.ref, created.url ?? `https://youtu.be/${created.ref}`);
      expect(created.url).toContain(created.ref);

      // Read it back from Google, not from the publish response object: the whole
      // point is that the vendor agrees the thing exists.
      const found = await getVideos([created.ref]);
      expect(found.map((v) => v.id)).toContain(created.ref);

      await youtubeTransport.deletePost(created.ref);
      artifacts.untrack(created.ref);

      const afterDelete = await getVideos([created.ref]);
      expect(afterDelete.map((v) => v.id)).not.toContain(created.ref);

      // Idempotent re-delete: "already gone is success" is a contract every
      // transport carries, and it is only ever proven live.
      await expect(youtubeTransport.deletePost(created.ref)).resolves.toBeUndefined();

      console.log(`[proof] youtube: deleted ${created.ref}, confirmed gone`);
    } finally {
      await media.close();
    }
  }, 120_000);
});
