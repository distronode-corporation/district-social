import { describe, it, expect } from "vitest";
import { PLATFORM_IDENTIFIERS, connectIdentifierFor, platformForIdentifier } from "../provider-map.js";
import { ALL_PLATFORMS } from "../types.js";

describe("connectIdentifierFor", () => {
  it("connects the PREFERRED identifier: the LinkedIn company page and the Instagram business account", () => {
    expect(connectIdentifierFor("linkedin")).toBe("linkedin-page");
    expect(connectIdentifierFor("instagram")).toBe("instagram");
    expect(connectIdentifierFor("twitter")).toBe("x");
    expect(connectIdentifierFor("tiktok")).toBe("tiktok");
  });

  it("answers an identifier that maps back to the same platform, for every platform", () => {
    for (const platform of ALL_PLATFORMS) {
      const id = connectIdentifierFor(platform);
      expect(id).toBe(PLATFORM_IDENTIFIERS[platform][0]);
      expect(platformForIdentifier(id)).toBe(platform);
    }
  });
});
