/**
 * Env-driven settings for the Social HQ engine. Everything here is read
 * lazily (at call time, never at module load) so the engine has no import-time
 * dependency on process.env or the filesystem — safe to import from anywhere,
 * including Next.js server bundles that may not have secrets wired at boot.
 *
 * Deployment facts the engine must not guess (the GCP project Veo bills to,
 * the Reddit User-Agent that names the operator's app and account) come from
 * env first, then from `setEngineDeployment`, which the application calls when
 * it wires the engine. Neither has a default: an unconfigured engine fails at
 * the call that needs the value, with a message naming it.
 */

/**
 * Vertex config for Veo (video generation).
 *
 * Text generation is NOT here: every text call runs on Claude through the
 * direct Anthropic API (claude.ts), so this is the only Vertex surface the
 * engine has. Image generation is the application's, outside the engine.
 *
 * Veo has NO `global` endpoint and is served only from regional hosts
 * (`us-central1`, ...), which is why the location is pinned to a region below.
 */
/** What the application supplies where env does not. */
export interface EngineDeployment {
  /** The GCP project Veo requests bill to; VERTEX_PROJECT_ID wins over it. */
  vertexProject?: string;
  /** The Reddit User-Agent; SOCIALMETA_REDDIT_USER_AGENT wins over it. */
  redditUserAgent?: string;
}

let deployment: EngineDeployment = {};

/** Replaces the application's deployment facts (idempotent; a copy is kept). */
export function setEngineDeployment(next: EngineDeployment): void {
  deployment = { ...next };
}

/** The deployment facts last set, for the readers in this engine. */
export function engineDeployment(): Readonly<EngineDeployment> {
  return deployment;
}

export interface VertexVideoConfig {
  /** "" when neither VERTEX_PROJECT_ID nor the deployment names one; veo.ts refuses to call then. */
  project: string;
  location: string;
  model: string;
}

export function vertexVideoConfig(): VertexVideoConfig {
  return {
    project: process.env.VERTEX_PROJECT_ID || deployment.vertexProject || "",
    // PINNED to us-central1: Veo has no `global` endpoint. Still
    // override-able (tests, or a future region migration), but a location
    // that does not serve the target Veo model 404s every call with
    // "Publisher model ... not found", which reads as a total outage rather
    // than as a config error.
    location: process.env.SOCIALMETA_VEO_LOCATION || "us-central1",
    model: process.env.SOCIALMETA_VEO_MODEL || "veo-3.1-fast-generate-001",
  };
}

export function timezone(): string {
  return process.env.SOCIALMETA_TIMEZONE || "America/Toronto";
}

export interface EngineDefaults {
  platforms: string[];
  subreddit?: string;
  /**
   * Pinterest board ID (not name) to pin to when a draft does not name one.
   * Pinterest cannot publish without a board, so this is to Pinterest what
   * `subreddit` is to Reddit.
   */
  pinterestBoard?: string;
  youtubeVisibility: "public" | "unlisted" | "private";
  youtubeCategoryId: string;
}

const YOUTUBE_VISIBILITIES = ["public", "unlisted", "private"] as const;

/**
 * `SOCIALMETA_YOUTUBE_VISIBILITY`, falling back to "public".
 *
 * ⚠️ PARSE AND FALL BACK, NEVER THROW. This is read on the publish path, and a
 * typo in an env var must not be able to fail a publish — the same reasoning
 * that makes `sanitize()` in transport-wiring.ts swallow a malformed overrides
 * row rather than crash.
 *
 * Why it is configurable at all: it was hardcoded "public", which meant the
 * only way to exercise `youtubeTransport.publishNow()` was to put a real video
 * live on the brand channel. That is why YouTube's live proof tests the CLIENT
 * instead of the transport, leaving the transport itself unproven. With this,
 * the proof can upload privately and still exercise the real publish path.
 *
 * ⛔ THE RISK RUNS BOTH WAYS. A stray `SOCIALMETA_YOUTUBE_VISIBILITY=private`
 * in a deployed environment would silently make every real upload private —
 * published, billed against quota, and invisible. That is a strictly safer
 * failure than the previous one (a test making a real upload public), but it is
 * silent, so it belongs in the deploy checklist rather than only here.
 */
function youtubeVisibility(): EngineDefaults["youtubeVisibility"] {
  const raw = process.env.SOCIALMETA_YOUTUBE_VISIBILITY?.trim().toLowerCase();
  const match = YOUTUBE_VISIBILITIES.find((v) => v === raw);
  if (raw && !match) {
    console.warn(
      `[socialhq] SOCIALMETA_YOUTUBE_VISIBILITY="${raw}" is not one of ` +
        `${YOUTUBE_VISIBILITIES.join("|")}; falling back to "public"`,
    );
  }
  return match ?? "public";
}

export function defaults(): EngineDefaults {
  return {
    platforms: ["instagram", "facebook", "threads", "twitter", "linkedin", "bluesky"],
    subreddit: process.env.SOCIALMETA_DEFAULT_SUBREDDIT || undefined,
    pinterestBoard: process.env.SOCIALMETA_DEFAULT_PINTEREST_BOARD || undefined,
    youtubeVisibility: youtubeVisibility(),
    youtubeCategoryId: "28",
  };
}
