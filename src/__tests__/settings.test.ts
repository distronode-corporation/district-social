import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { timezone, defaults, vertexVideoConfig, setEngineDeployment, engineDeployment } from "../settings.js";

const ENV_KEYS = [
  "VERTEX_PROJECT_ID",
  "SOCIALMETA_VEO_LOCATION",
  "SOCIALMETA_VEO_MODEL",
  "SOCIALMETA_TIMEZONE",
  "SOCIALMETA_DEFAULT_SUBREDDIT",
  // Must be reset between tests like every other key here, or the
  // "defaults to public" assertion above passes or fails depending on which
  // test ran before it.
  "SOCIALMETA_YOUTUBE_VISIBILITY",
] as const;

describe("settings", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // Veo is the engine's only Vertex surface. The project it bills to is the
  // operator's decision, so the engine has no default for it.
  describe("vertexVideoConfig", () => {
    it("names no project when neither env nor the deployment sets one", () => {
      setEngineDeployment({});
      expect(vertexVideoConfig()).toEqual({
        project: "",
        // A region: Veo has no `global` endpoint.
        location: "us-central1",
        model: "veo-3.1-fast-generate-001",
      });
    });

    it("takes the deployment's project, and env wins over it", () => {
      setEngineDeployment({ vertexProject: "deployed-project" });
      expect(vertexVideoConfig().project).toBe("deployed-project");
      process.env.VERTEX_PROJECT_ID = "env-project";
      expect(vertexVideoConfig().project).toBe("env-project");
    });

    it("keeps a copy, so mutating the argument changes nothing", () => {
      const facts: { vertexProject?: string } = { vertexProject: "a" };
      setEngineDeployment(facts);
      facts.vertexProject = "b";
      expect(engineDeployment()).toEqual({ vertexProject: "a" });
    });

    // Override values differ from the defaults, or this passes with the env ignored.
    it("honors env overrides", () => {
      process.env.VERTEX_PROJECT_ID = "my-project";
      process.env.SOCIALMETA_VEO_LOCATION = "europe-west4";
      process.env.SOCIALMETA_VEO_MODEL = "veo-x";
      expect(vertexVideoConfig()).toEqual({ project: "my-project", location: "europe-west4", model: "veo-x" });
    });
  });

  describe("timezone", () => {
    it("defaults to America/Toronto", () => {
      expect(timezone()).toBe("America/Toronto");
    });

    it("honors SOCIALMETA_TIMEZONE override", () => {
      process.env.SOCIALMETA_TIMEZONE = "America/Vancouver";
      expect(timezone()).toBe("America/Vancouver");
    });
  });

  describe("defaults", () => {
    it("returns the expected default shape", () => {
      const d = defaults();
      expect(d.platforms).toEqual([
        "instagram",
        "facebook",
        "threads",
        "twitter",
        "linkedin",
        "bluesky",
      ]);
      expect(d.youtubeVisibility).toBe("public");
      expect(d.youtubeCategoryId).toBe("28");
      expect(d.subreddit).toBeUndefined();
    });

    it("reads subreddit from SOCIALMETA_DEFAULT_SUBREDDIT", () => {
      process.env.SOCIALMETA_DEFAULT_SUBREDDIT = "SaaS";
      expect(defaults().subreddit).toBe("SaaS");
    });

    /**
     * youtubeVisibility was hardcoded "public", which meant the only way to
     * exercise youtubeTransport.publishNow() was to put a real video live on the
     * brand channel — which is why YouTube's live proof tests the CLIENT and the
     * transport stayed unproven.
     */
    it("reads youtubeVisibility from SOCIALMETA_YOUTUBE_VISIBILITY", () => {
      for (const v of ["private", "unlisted", "public"] as const) {
        process.env.SOCIALMETA_YOUTUBE_VISIBILITY = v;
        expect(defaults().youtubeVisibility).toBe(v);
      }
    });

    it("is case- and whitespace-insensitive", () => {
      process.env.SOCIALMETA_YOUTUBE_VISIBILITY = "  PRIVATE ";
      expect(defaults().youtubeVisibility).toBe("private");
    });

    /**
     * ⚠️ Falls back rather than throwing: this is read on the publish path, and
     * a typo in an env var must never be able to fail a publish.
     */
    it("falls back to public on an unrecognised value instead of throwing", () => {
      process.env.SOCIALMETA_YOUTUBE_VISIBILITY = "prviate";
      expect(() => defaults()).not.toThrow();
      expect(defaults().youtubeVisibility).toBe("public");
    });
  });
});
