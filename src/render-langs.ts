import type { Platform } from "./types.js";

/**
 * A render's `langs`: the one validator every editor shares.
 *
 * The Bluesky transport sends `PlatformRender.langs` on the root post and on
 * every inline reply, but until this module existed no editor could write it:
 * the hosted PUT whitelisted it away and the CLI's `set` had no option for it.
 * Both now call `parseRenderLangs`, so the CLI and Social HQ cannot disagree on
 * what a valid tag is, and neither can store a value the publisher would choke
 * on.
 *
 * Validated at EDIT time, not at publish time, for the reason the rest of the
 * draft route validates early: the PDS checks `langs` against the lexicon's
 * `format: language`, so a malformed tag is a vendor refusal in the middle of a
 * publish, after other legs may already be live. `bluesky.ts` also slices the
 * list to 3 without a word, which would drop a tag the operator asked for; the
 * limit is enforced here instead, where it can be said out loud.
 */

/**
 * The platforms whose transport sends `langs`. Bluesky alone: every other
 * transport ignores the field, so accepting it elsewhere would store a value
 * that looks meaningful and does nothing. Refusing it is also what catches the
 * likelier mistake, `set <id> x --langs fr` typed for the Bluesky render.
 */
const LANGS_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(["bluesky"]);

/** The `app.bsky.feed.post` lexicon's `maxLength` for `langs`. */
export const MAX_RENDER_LANGS = 3;

/**
 * A primary language subtag with an optional region or script subtag: `en`,
 * `fr-CA`, `zh-Hant`. Deliberately narrower than full BCP-47 (no variants, no
 * numeric regions such as `es-419`): the campaign needs `en` and `fr`, and a
 * narrow rule that refuses loudly beats a wide one that lets the PDS refuse
 * mid-publish.
 */
const LANG_TAG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

const SHAPE_ERROR = `must be 1 to ${MAX_RENDER_LANGS} language tags such as "en" or "fr-CA"`;

export type RenderLangsResult =
  | { ok: true; langs: string[] | undefined }
  | { ok: false; error: string };

/**
 * Lowercase the PRIMARY subtag only. `FR-CA` becomes `fr-CA`, not `fr-ca`: the
 * region subtag's conventional case is upper, and what is stored is what is
 * shown back to the operator and sent to the vendor.
 */
function normalizeTag(tag: string): string {
  const trimmed = tag.trim();
  const dash = trimmed.indexOf("-");
  return dash === -1
    ? trimmed.toLowerCase()
    : trimmed.slice(0, dash).toLowerCase() + trimmed.slice(dash);
}

/**
 * Validate one render's `langs` value as it arrived from an editor.
 *
 * `raw` is `unknown` because both callers hand over untrusted input: a JSON
 * request body, or a CLI option split on commas.
 *
 * Returns `langs: undefined` for `null` and for an empty list, which is how
 * every editor CLEARS the field; the caller assigns it and the key disappears
 * when the render is serialised. A caller that means "not supplied" must not
 * call this at all, since `undefined` is not a value either editor sends.
 *
 * The `error` is a predicate with no subject ("must be ..."), so each caller
 * prefixes the name its operator actually typed: `renderPatch.langs` in the
 * route, `--langs` in the CLI.
 */
export function parseRenderLangs(platform: Platform, raw: unknown): RenderLangsResult {
  // Checked before the value, so clearing is refused off Bluesky too. There is
  // nothing to clear there (no transport reads it), and the refusal is the
  // signal that the edit was aimed at the wrong render.
  if (!LANGS_PLATFORMS.has(platform)) {
    return {
      ok: false,
      error: `is only accepted on the bluesky render (${platform} does not send language tags)`,
    };
  }
  if (raw === null) return { ok: true, langs: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: SHAPE_ERROR };
  if (raw.length === 0) return { ok: true, langs: undefined };
  if (raw.length > MAX_RENDER_LANGS) {
    return { ok: false, error: `${SHAPE_ERROR}, got ${raw.length}` };
  }

  const langs: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return { ok: false, error: SHAPE_ERROR };
    const tag = normalizeTag(item);
    if (!LANG_TAG_RE.test(tag)) {
      return { ok: false, error: `${SHAPE_ERROR}, got ${JSON.stringify(item)}` };
    }
    langs.push(tag);
  }
  return { ok: true, langs };
}
