# Social Platform Formatting Reference — 2026
Researched 2026-07-19 for an automated post-formatting tool (B2B SaaS).
Tags: **[verified]** = confirmed via web search/fetch this session (often multiple sources cross-checked).
**[training]** = prior knowledge, not independently re-verified this session — treat as lower confidence.

**Reconciled 2026-08-03** against the nine direct vendor transports there were then, in `src/`
(`bluesky.ts`, `linkedin.ts`, `pinterest.ts`, `http/meta-graph.ts` + `facebook-transport.ts` /
`instagram-transport.ts` / `threads-transport.ts`, `x.ts`, `reddit.ts`, `youtube.ts`, and each
transport's own `channelRules()`); TikTok, the tenth (`tiktok.ts` + `tiktok-transport.ts`), came
later and has its own section (10) below. Those transports are replacing Postiz as the publishing path one
platform at a time. Their docblocks name, per fact, exactly what was checked against the
vendor's own documentation and what was merely assumed — a strictly better source than parts
of this file's original research pass, which in several places turned out to have been
reading Postiz's own channel schema (`GET /integration-settings/:id`) rather than the vendor.
Three more tags below capture that distinction:
- **[Postiz artifact]** = this number came from Postiz's channel schema or provider source,
  not from the platform vendor. Postiz is being decommissioned as the publishing aggregator,
  so a value tagged this way is not a vendor fact and should not be trusted as one going
  forward, even where it happens to be the number currently enforced in code.
- **[vendor-verified in code, DATE]** = confirmed directly against the platform vendor's own
  documentation by a direct transport (exact source in that transport's docblock). This
  supersedes a pre-existing **[verified]** tag where the two disagree.
- **[assumed in code]** = the direct transport that now handles this platform explicitly could
  not confirm the figure against an official vendor page, and says so in its own docblock.
  Best-available guess, not a proven vendor limit — do not silently read this as [verified].

---

## 1. INSTAGRAM (Business Account)

### Hard limits
- Caption max: **2,200 characters** [verified] — also **[vendor-verified in code]**,
  `instagram-transport.ts`'s `channelRules()`: "verified against the `/{ig-user-id}/media`
  reference's `caption` param (\"Maximum 2200 characters\")." Same number, now independently
  confirmed from the API reference itself rather than general web research.
- Hashtags: **HARD CAP CHANGED** — as of **Dec 18, 2025** Meta announced a rolling reduction from the old 30-tag ceiling to **5 hashtags max per post/Reel** (caption + comments combined) [verified — corroborated by Social Media Today citing Instagram's own statement, plus multiple independent trade sources]. Treat 30 as **obsolete** for 2026; build validators around **5**, not 30. Rollout was gradual/account-by-account starting Dec 2025, so some accounts may still see the old 30 cap during transition — but design for 5 as the target state. [training: pre-Dec-2025 sources still say 30 — do not trust those without a date check]
- Image file size via the Content Publishing API: **8 MB maximum**, JPEG only, 4:5 to 1.91:1, width 320 to 1440 px [vendor-verified 2026-09-17, `/{ig-user-id}/media` reference]. The ~30 MB figure that stood here until then was the app's help-centre number and is not what the API enforces.
- Video via the API (Reels): **300 MB maximum, 15 minutes maximum, 3 seconds minimum**, MOV/MP4 [vendor-verified 2026-09-17, same reference]. The app's 4 GB / Story 250 MB figures do not apply to API publishing.
- API rate limits: 100 API-published posts per 24 h per account (a carousel counts as one), 400 containers per rolling 24 h [vendor-verified 2026-09-17, content-publishing guide]
- Video length: Reels up to **20 minutes**, but Reels **>3 min are throttled to non-followers/new audiences** — keep discovery-intent Reels short [verified]. Stories: 60 sec/clip [verified]
- Links: **not clickable in caption body** — only one clickable link via bio/link-in-bio or Story link sticker; Reels/feed captions render URLs as plain text [training, consistent with long-standing IG behavior — not contradicted by any 2026 source found]
- Image format: **JPEG only** **[vendor-verified in code, 2026-08-02]** — Meta's own image
  requirements doc, quoted in `instagram-transport.ts`: "JPEG is the only image format
  supported. Extended JPEG formats such as MPO and JPS are not supported." A PNG (including
  this pipeline's own `next/og` cards, when they already fit the byte ceiling unconverted) is
  rejected; animated GIFs are refused for the same reason. Threads, by contrast, accepts both
  JPEG and PNG — see the Threads section.
- Carousel: up to **10** images/videos per post, and Meta's own wording allows a **mix of the
  two** **[vendor-verified in code]** — `instagram-transport.ts`'s `MAX_CAROUSEL_ITEMS`
  docblock quotes Meta's Content Publishing guide verbatim: "Carousels are limited to 10
  images, videos, or a mix of the two." ⚠️ Open question, not resolved here: this repo's own
  `SPECS.instagram.mixedMediaAllowed` is `false` in `specs.ts` — i.e. the pipeline currently
  refuses to mix carousel media types even though Meta's own text says it can. That may be a
  deliberate simplification or a stale restriction; nothing in the code says which, so treat
  the 10-item cap as vendor fact but the "images-or-videos, not mixed" behaviour as this
  engine's own current choice, not a platform limit.

### Image/video specs
- Feed: Square 1080×1080 (1:1), Portrait 1080×1350 (4:5), new **3:4** 1080×1440 (vertical grid optimization), Landscape 1080×566 (1.91:1) [verified]
- Reels/Stories: 1080×1920, 9:16 [verified]
- Recommend MP4, H.264, AAC audio, 30fps for Reels [verified]
- IG re-encodes everything to max 1080px width — always upload at native 1080 to avoid soft/compressed output [verified]

### Optimal formatting
- Caption visible before "…more" truncation: **~125 characters** [training, widely cross-referenced number, not contradicted by any source pulled this session — treat as directionally solid but not independently re-verified to the character]
- Ideal caption length: front-load the hook in first ~125 chars; full caption can run longer for storytelling but B2B posts should stay tight (2–4 short paragraphs, ~400–900 chars) [training + synthesis]
- Hashtags: with the new 5-cap, use **all 5, highly specific/niche** (not generic #business #marketing) — quality over quantity is now Meta's own stated rationale [verified]. Mosseri: hashtags aid **search/discoverability, not distribution/reach** [verified]
- Placement: caption vs first comment makes **no distribution difference**; caption placement is now favored because IG captions are **indexable by search** [verified]
- Emoji: light-moderate use as visual line breaks/bullets is standard; avoid emoji walls
- Line breaks: use blank lines between short thought-chunks (IG renders \n\n as paragraph breaks); this is essential since dense text blocks kill the "…more" hook
- CTA: end with one clear action ("Link in bio," "Save this," "Comment X below") — Reels performs better with verbal/on-screen CTA than caption-only

### Pitfalls
- Exceeding 5 hashtags likely triggers **algorithmic suppression**, not necessarily a hard block — exact enforcement mechanism (block vs silent throttle) not officially detailed [verified partial — mechanism unconfirmed]
- Engagement bait ("like if you agree," vote-baiting, tag-a-friend spam) is **actively demoted** by Meta's classifier across IG+FB, in place since 2017 and still enforced [verified]
- Heavy/generic hashtag stacking reads as spam/inauthentic and can suppress reach even under the cap [verified]
- Only one real clickable link (bio) — do not put bare URLs in caption expecting clicks

### B2B SaaS specifics
- Best formats: short Reels (demo clips, "day in the life," feature highlight <60–90s), carousel posts (educational/how-to, 5–8 slides), founder-voice static posts. Avoid pure text-dump posts; IG is visual-first even for B2B.

---

## 2. FACEBOOK PAGE

### Hard limits
- Post text max: **63,206 characters** [verified]
- No hashtag hard cap (unlike IG); no official recommended max found — treat as low-priority for FB
- Image max file size on the Page `/photos` edge our transport uses: **10 MB** ("Files can not exceed 10MB"; .jpeg, .bmp, .png, .gif, .tiff) [vendor-verified 2026-09-17, page/photos reference]. The ~30 MB figure that stood here until then was help-centre prose.
- Video max file size: **4 GB** [verified via help-centre prose; the video publishing guide states format only, so this is not API-verified]
- Video length: Feed ~**240 min** ceiling documented; **Reels effectively uncapped** since Meta's June 2025 change (90 sec still commonly cited as the practical/algorithmic sweet spot); Stories 60 sec/organic segment [verified]
- Links: **clickable in-body** (unlike IG) — but see Pitfalls below for the new 2026 restriction [verified]

### Image/video specs
- Square 1080×1080, 4:5 Feed 1080×1350, vertical Stories/Reels 1080×1920 [verified]
- Video aspect: 9:16 vertical is now the de facto default since most FB video surfaces as Reels; Feed supports 16:9 through 9:16 [verified]

### Optimal formatting
- Visible before truncation: **~477 characters on desktop, ~125 on mobile** before "See more" [verified]
- Optimal length: **posts under ~80 characters get the highest engagement** (up to 66% more than longer posts) per 2026 data — much shorter than IG/LinkedIn optimal [verified]
- Tone: more casual/community than LinkedIn, less visual-first than IG; text+image or native video outperforms link posts
- Emoji: light use acceptable, less bullet-heavy than IG
- CTA: native engagement asks (question prompts, polls) outperform "click here" asks

### Pitfalls — MOST IMPORTANT 2026 CHANGE
- **"Two-link rule" (2026):** Meta is testing/rolling out a restriction where non-Meta-Verified Pages/profiles are limited to **~2 organic posts containing external links per month**; beyond that, posts aren't hard-blocked but get **effectively zero organic reach** [verified — Social Media Examiner]. **Links in the comments section remain unlimited/unrestricted** — this is the workaround [verified]
- Meta Verified subscription ($14.99–$500+/mo depending on tier) lifts the link restriction and boosts link-post reach [verified]
- Link posts have had suppressed reach for ~a decade regardless of the new rule — outbound URLs are treated as a negative distribution signal generally [verified]
- Engagement bait demotion applies identically to FB (same Meta classifier as IG) [verified]

### B2B SaaS specifics
- Best format for a dev-tool/business-tool company: **native video or image + link-in-first-comment**, NOT link-in-post-body, to avoid both the link penalty and the 2-link/month cap. Save the 2 allotted body-link posts/month for high-value CTAs (major launch, gated content).

---

## 3. X / TWITTER

### Hard limits
- **Free accounts: 280 characters** per post [verified, current as of 2026]
- **X Premium / Premium+ subscribers: up to 25,000 characters** ("long-form posts"); applies to posts, replies, and quote posts alike [verified, multiple independent sources agree, consistent with the known Feb 2023 launch / late-2023 expansion history — ⚠️ `x-transport.ts`'s `channelRules()` did NOT independently recheck this figure during its 2026-08-02 vendor pass: it explicitly notes the Premium ceiling "comes from specs.ts's pre-existing comment, not a page this transport's migration re-checked," while the free-tier 280 and the weighted-counting algorithm below WERE freshly verified against docs.x.com. Not a Postiz artifact, but not re-proven either — carried at its original confidence]
- Timeline display truncates **everyone's** post preview at ~280 chars with a "Show more" expand, even for Premium long-form posts [verified]
- URLs auto-shorten and always count as **23 characters** regardless of true length [verified]
- Video in POSTS: default accounts **20 minutes / 8 GB**, Premium **125 minutes / 16 GB** [vendor-verified 2026-09-17, docs.x.com/changelog, Sep 1 2026 entry]. The **140 sec / 512 MB** figure that stood here until then is the DIRECT-MESSAGE video limit, which the same entry keeps unchanged.
- Pricing on pay-per-use since Apr 16 2026: `POST /2/tweets` $0.015 per post, and **a post containing a URL is $0.20** [vendor-verified 2026-09-17, docs.x.com/changelog]. Follow, like and quote endpoints were removed from self-serve tiers the same day (nothing here used them).
- Feb 23 2026: programmatic REPLIES on self-serve tiers are "only permitted when the original Post's author has summoned the replier". Whether a reply to one's OWN post is exempt is not stated, so the direct transport's self-thread path (`x-transport.ts` replies to its own root) is untested against it. Probe before trusting a direct X thread.
- Images: **5 MB** per image (single or multi-image post), 5 MB header, 2 MB profile pic [verified]
- Video aspect ratios supported: 16:9 (1920×1080), 1:1 (1080×1080), 9:16 (1080×1920) [verified]
- Links: clickable in-body, auto-carded — but see link-penalty pitfall below

### Optimal formatting
- Practical optimal length for reach: short, punchy, well under 280 for the primary hook even on Premium accounts — long-form (25k) is for essay/thread-replacement content, not standard posting
- Hashtags: X best practice is **minimal (0–2)**, inline not stacked at end; X's culture treats heavy hashtag use as spammy/dated, unlike IG
- Tone: terser, more opinionated/conversational than LinkedIn; threads (numbered reply chains) still a strong format for technical B2B content
- Emoji: sparse, used for tone/emphasis not decoration

### Pitfalls — CRITICAL for 2026
- **Link penalty is severe and reportedly worsening.** X's own open-sourced ranking code shows a documented **30–50% reach penalty** for posts containing external links; independent Q1 2026 testing found **up to 94% visibility reduction** for link posts vs. text-only equivalents [verified — note: the 94% figure comes from independent/unofficial testing, not X's own disclosure, so treat as directional not exact]
- X officially claimed it **removed** the link penalty in Oct 2025; real-world data contradicts this — suppression now appears to run through indirect mechanisms (delayed redirects, in-app browsing friction, engagement-based demotion) rather than one visible flag [verified — treat "official removal" claim as PR, not operative reality]
- Non-Premium accounts see **near-total suppression** of link posts since March 2026; Premium accounts fare somewhat better but still take a meaningful hit [verified]
- Standard workaround: **post the link as the first reply**, not in the main post body [verified — still effective per 2026 sources]
- Jan 2026: X replaced its legacy ranking system with a **Grok-powered transformer model** that evaluates full post/video content and predicts engagement — this is a major, recent algorithm shift worth flagging to any team tuning X content strategy [verified]

### B2B SaaS specifics
- Best format: text-only posts or threads for technical announcements/opinions; put the product link in the first reply, never the main post, to preserve reach.

---

## 4. LINKEDIN (Company Page)

### Hard limits
- Post text max: **3,000 characters** (same limit for personal and Company Page posts) [verified]
- Hashtags: no hard cap found; best-practice range only (see below)
- Native video: **10 minutes max from mobile app / Company Page; up to 15 minutes from desktop** [verified]
- Document/PDF carousel: fails above **100 MB file size, if password-protected, or over 300 pages** [verified]
- Links: clickable in-body, auto-carded — but see reach-penalty pitfall

### Image/video specs
- Image: 1200×627 (1.91:1) renders cleanly across desktop+mobile without cropping; 1080×1080 (1:1) or 1080×1350 (4:5) also fully supported and use more mobile screen real estate [verified]
- Carousel/Document posts: 1080×1080 (1:1) sweet spot, or 1080×1350 (4:5) vertical for more mobile dominance [verified]

### Optimal formatting
- "…see more" truncation: **~140 characters on mobile, ~210 on desktop** (range ~120–210 depending on line breaks/media) [verified]
- **Two consecutive newlines (a paragraph break) ends the visible snippet early** — keep the hook as one unbroken paragraph if you want more of it visible before truncation [verified — notable, actionable formatting rule]
- Hashtags: **3–5 relevant tags**, placed at the end; end-placed hashtags do **not** count against/shrink the visible "see more" window on mobile [verified]
- Tone: professional but personable; first-person founder/practitioner voice outperforms corporate-brand voice in 2026 LinkedIn's "Depth and Authority" ranking shift [verified]
- Format that performs best: **Document/PDF carousel posts — 6.60% engagement rate, highest of any LinkedIn format** in 2026 data [verified]; long-form native video also rewarded
- Comments carry **~15x the algorithmic weight of likes** — CTAs should invite discussion/questions, not just reactions [verified]
- **Dwell time is now the primary ranking signal**: posts with 0–3s dwell get ~1.2% engagement vs. 15.6% for 61+s dwell (13x difference) — favors longer, substantive posts that hold attention over quick-hit one-liners [verified]

### Pitfalls
- External links in the post body: **~60% reach reduction** vs. an identical link-free post [verified]
- The old "put the link in the first comment" workaround is **also now penalized as of early 2026** — LinkedIn appears to detect and demote this pattern too [verified — significant, this closes a loophole marketers have relied on for years]
- Best practice: post the substance natively (no link at all) and mention "link in comments" as a soft pointer, or accept the reach tradeoff for high-value CTAs only
- Weak/misaligned Company Page profile (no About copy, generic headline) suppresses distribution of posts from that page independent of content quality [verified]

### B2B SaaS specifics
- Best formats for a dev-tool/business-tool company: **document carousels** (how-it-works, ROI breakdowns, feature explainers), native video demos, and founder/practitioner text posts with a strong single-paragraph hook. Avoid link-out posts except for major announcements.

---

## 5. YOUTUBE

### Hard limits
- Title: **100 characters max** [verified] — also **[vendor-verified in code]**, `youtube.ts`'s
  `YouTubeVideoMetadata.title` docblock: "Max 100 characters — PROVEN,
  developers.google.com/youtube/v3/docs/videos (`snippet.title`)"; search results/suggested
  tiles/end-screens truncate around **~70 chars**; Shorts shelf/feed truncates around **~40
  chars** [verified]
- Description: **5,000 BYTES max, NOT characters** — **CORRECTED 2026-08-03.** This file
  previously said "5,000 characters," which is wrong about the unit. `youtube.ts`'s
  `YouTubeVideoMetadata.description` docblock is explicit: "Max 5000 BYTES, not characters —
  PROVEN," same `developers.google.com/youtube/v3/docs/videos` (`snippet.description`) page.
  `youtube-transport.ts`'s own `channelRules()` flags the same gap: its declared gate uses
  UTF-16 code units as "the closest available approximation" because the shared
  `TransportChannelRules` type has no byte-counting mode, which "UNDERCOUNTS the real vendor
  budget" for non-ASCII text — the transport's actual publish-time truncation
  (`truncateUtf8Bytes`) enforces the real byte limit regardless. **~157 characters** visible
  above the fold before "Show more" on the watch page [verified, unaffected by the byte/char
  distinction — that figure is about on-screen truncation, not the hard cap]
- Hashtags: **15 max per video** — **all hashtags are ignored if you exceed 15** [verified;
  not independently rechecked by the new transport, which only verifies the separate `tags`
  metadata field below]
- Tags (separate from hashtags/metadata field): **500 characters total** combined across all
  tags [verified] — also **[vendor-verified in code]**, `youtube.ts`: "Combined max 500
  characters across the whole array, counting the separating commas and (for any tag
  containing a space) a pair of quotation marks — PROVEN, same page (`snippet.tags`)."
- Long-form video: up to **12 hours or 256 GB** (verified channels), whichever comes first
  [verified] — the **256 GB** ceiling is also **[vendor-verified in code]**,
  `youtube-transport.ts`'s `channelRules()`: "274,877,906,944 bytes (256 GiB) — PROVEN, the
  YouTube v3 discovery document's `videos.insert` `mediaUpload.maxSize`." ⚠️ The direct
  YouTube transport's own default gate is more conservative than "12 hours for a verified
  channel": `channelRules()` declares `maxVideoSec: 900` (15 minutes) unconditionally, because
  it "is a static, synchronous declaration with no account context" and cannot know the account's
  channel verification status — it deliberately picks the conservative (unverified-account)
  bound over the permissive one. Treat 12h/256GB as the platform ceiling for a verified
  channel, but 900s as what the code itself currently enforces.
- Shorts: **must be ≤3 minutes** (raised from 60s, effective for uploads after Oct 15 2024) and vertical/square framing to auto-classify as a Short [verified]
- Links: clickable in description (not in title); one link can be pinned/pinned-comment; Shorts descriptions behave the same as long-form

### Image/video specs
- Recommended: **1920×1080, 16:9** for long-form; **1080×1920, 9:16** for Shorts [verified]
- MP4, H.264 video codec, AAC-LC audio codec recommended [verified]

### Optimal formatting
- Hashtags: **2–3 highly relevant**, placed in the **description** (not title) — the **first 3 hashtags in the description auto-display as clickable chips above the Shorts title**, so front-loading them there gets visibility without spending title characters [verified]
- Title: put the strongest keyword/hook in the first ~40–70 characters since that's what's actually visible in most surfaces
- Description: put the critical hook/CTA in the first ~157 characters (above the fold); use the remainder for SEO/keywords/timestamps/links

### Pitfalls
- Exceeding 15 hashtags **nukes all of them** (not just the excess) — validators must hard-block at 15 [verified]
- Dec 2025 algorithm overhaul reportedly **cut long-form video's home-feed slot allocation by up to 80%** in favor of Shorts-first discovery — a channel relying solely on long-form should expect materially reduced organic reach vs. pre-2026 [verified — significant strategic fact]

### B2B SaaS specifics
- 2026 data: Shorts reach **53% of B2B buyers before they request a demo**; B2B content commands the **highest CPM of any vertical ($1–5)** [verified]. Recommended content ladder: **Shorts for awareness** (3–5/week, feature clips, quick tips) → **mid-form for consideration** (3–8 min, use-case walkthroughs) → **long-form for decision** (10–20 min, deep demo/webinar, 1–2/month). Repurpose one long-form video into 5–10 Shorts rather than producing each format from scratch.

---

## 6. REDDIT

**Route:** direct, through `reddit-transport.ts` on the operator's own Reddit app (a
refresh token with the submit scope). Self
post whenever there is copy (an attached card is dropped with a warning, since an image post
has no body); image post only with no copy and `SOCIALMETA_REDDIT_MEDIA_UPLOAD=1`; link post
only with neither; a copy-less video post is refused (video submit is not built). A
flair-required subreddit's rejection (`SUBMIT_VALIDATION_FLAIR_REQUIRED`) and a `RATELIMIT`
come back as errors naming the fix; a 429's `x-ratelimit-reset` is the retry delay.

### Hard limits
- Title: **300 characters max** (site-wide, applies to text/link/image/video/poll posts) [verified]; individual subreddits may impose **stricter** title/body/flair/karma/account-age rules on top of this — always subreddit-rule-check, not just site-wide [verified]
- Image: **20 MB max** file size (JPEG/PNG/GIF/WebP); recommend keeping under 5 MB for load speed [verified]
- Gallery: up to **20 images**; mixed aspect ratios in one gallery cause Reddit to crop subsequent images to match the first slide — **keep aspect ratio consistent across a gallery** [verified]
- Video: native upload up to **15 minutes**, **1 GB max**, min 2 seconds [verified]
- ⚠️ Unresolved provenance tension on the three figures above: this file's original research
  tagged them [verified] via general web research (no Postiz mention). But
  `reddit-transport.ts`'s `channelRules()` comment describes these exact same numbers
  (`maxImages: 20`, `maxImageBytes: 20MB`, `maxVideoBytes: 1024MB`, `maxVideoSec: 900`) as
  "specs.ts's existing, **Postiz-schema-verified figures**" — without pointing at a specific
  vendor page the way it does for Reddit's other proven facts. `specs.ts` itself carries no
  comment attributing these particular numbers to Postiz (only `maxChars` has that comment).
  Left as [verified] here because no vendor contradiction was found, but flagging the
  discrepancy rather than picking a side — the transport's own docblock and this file's
  original tagging disagree about where these came from, and Reddit's media upload is
  undocumented in its public API reference regardless (`reddit-transport.ts`'s
  `warnMediaNotUploaded`), so no code path in this migration actually re-checked them.
- Text post body: the **10,000** figure previously stated here is a **[Postiz artifact]**, not
  a Reddit fact — it came from Postiz's own channel schema (`GET /integration-settings/:id` →
  `maxLength: 10000`), which is being decommissioned as the publishing path. `reddit.ts`'s
  `submitPost` docblock, checked directly against reddit.com/dev/api's `POST /api/submit`
  reference (fetched 2026-08-02/03), found the `text` field documented only as "raw markdown
  text" with **no length figure anywhere on the page**. The new direct Reddit transport
  (`reddit-transport.ts`'s `channelRules()`) uses `maxLength: 40_000` as "the best available
  guard" going forward, but says plainly that number is itself **[assumed in code]** —
  inherited from `specs.ts`'s pre-existing (also uncited) comment, not confirmed against any
  official page found. Treat **40,000** as an unverified placeholder, not a proven ceiling,
  until someone finds (or tests into) a real number.
- Links: **link posts are a distinct post type** from self/text posts — see "text vs link" guidance below

### Image/video specs
- Recommended image: **1080×1350 (4:5 portrait)** for max mobile feed presence; landscape 1200×900 (4:3) or 1920×1080 (16:9); square 1080×1080 also fine [verified]
- Recommended video: 1920×1080 (16:9) traditionally best-supported; 1080×1920 (9:16 vertical) gaining traction under Reddit's mobile-first redesign [verified]. Native 4K uploads get compressed down to 1080p regardless [verified]

### Optimal formatting
- Title: site allows 300 chars but **60–80 characters performs better** for engagement [verified]
- **Text post vs. link post choice**: a text (self) post lets you control the framing/discussion and is generally preferred for community engagement and for self-promotion contexts (you can disclose affiliation, add context, invite discussion in the body) — a bare link post reads as more promotional/lower-effort and is more likely to trip spam filters or mod removal in stricter subreddits [training + synthesis from self-promotion guidance found this session — not a single authoritative source, moderate confidence]
- Tone: **zero corporate voice** — Reddit culture punishes marketing-speak hard; write as a practitioner/founder, not a brand account

### Pitfalls
- **90/10 rule** (commonly mislabeled "10:1"): roughly **90% of your activity should be genuine participation** (comments, upvotes, helpful answers) and **≤10% self-promotional**; more concretely, **for every 1 promotional post you should have ~9 non-promotional contributions** [verified]
- Never sockpuppet, always disclose affiliation when posting about your own product, never cross-post identical promo content across subreddits [verified]
- Subreddit-specific rules can be far stricter than the site-wide 90/10 norm — e.g. **r/programming bans essentially all promotion**; **DevOps/infra communities (r/devops, r/sysadmin) have the highest buyer intent but the strictest anti-promo culture** and punish anything that reads as vendor marketing [verified]
- A post that's compliant with Reddit's site-wide rules can still be auto-removed or manually pulled for violating a specific subreddit's stricter local rules (karma minimums, account age, flair requirements) [verified]

### B2B SaaS specifics
- Best-fit subreddits for a dev/business tool: **r/SaaS** and **r/indiehackers** (self-promotion tolerated if framed as progress updates/lessons/metrics, not pure ads), **r/sysadmin / r/devops / r/webdev** for product-adjacent categories (high buyer intent, but promote via **incidental mentions inside a technical post** — an incident writeup, comparison, or "how we built X" — never a direct pitch) [verified]. **r/startups / r/Entrepreneur**: self-promo restricted to designated weekly feedback threads only [verified].

---

## 7. BLUESKY

### Hard limits
- Post text max: **300 characters**, measured in **Unicode grapheme clusters** (not raw UTF-8 bytes/code points) — a multi-codepoint emoji like a family emoji (👨‍👩‍👧‍👦) counts as **1 grapheme** [verified]
- **URL character counting — verified directly against Bluesky's own GitHub discussion (maintainer response), this is the most load-bearing fact for a formatting tool:**
  - At the **protocol level**, URLs get **NO automatic shortening** — "all characters in the text itself are treated equally," so a full raw URL consumes its full character length against the 300 cap [verified — primary source: bluesky-social/atproto GitHub discussion #3517, maintainer reply]
  - The **official Bluesky app** implements a **client-side-only** convenience: it can display/store a **truncated visible URL text** (commonly cited as landing around 22–23 visible chars) while attaching the full URL as a clickable "facet" annotation — but this is **app behavior, not a protocol guarantee**
  - **If posting via the raw API** (which an automated tool would do), a long URL placed directly in post text **counts at full length** unless your tool itself implements the facet-truncation trick (truncate the display string, attach full URL as a separate facet annotation pointing at those bytes)
  - Do **not** trust generic SEO blog claims of "URLs always count as 22/23 characters" as a platform-wide guarantee — that only holds if the *posting client* implements facet truncation, which is not automatic
- Images: up to **4 per post**, **1 MB per image** (some sources say a 2MB ceiling but 1MB is the safer/stricter figure cited) [verified — minor source disagreement on exact MB, treat 1MB as the conservative target], max ~1000px, JPEG/PNG/GIF/WebP; alt text up to 1,000 characters per image [verified]
- Video: **1 per post**; the app allows **100 MB / 3 minutes** (bluesky-social/social-app PR #7916, merged 2025-03-06) and the `app.bsky.embed.video` lexicon permits blobs up to **300,000,000 bytes** with no duration field [vendor-verified 2026-09-17, lexicon on GitHub main]. The **50 MB / 60 s** that stood here until then was the 2024 launch limit. Images and video **cannot be combined** in the same post [verified]. The record's `tags` array takes at most 8 entries; `app.bsky.embed.gallery` is now in the embed union [lexicon, 2026-09-17].
- Link cards: Bluesky generates an **embed/card preview** for the first URL in a post (does not remove the URL text unless the client truncates it per above)

### Optimal formatting
- Because there's no algorithmic URL discount at the protocol level, a **formatting tool should proactively shorten/trim display text and use facet annotations** to avoid silently eating the character budget with long tracking-parameter URLs
- Tone: skews more like early-Twitter — conversational, text-forward, less corporate-polished; B2B/SaaS brand accounts should lean toward plain-spoken updates over polished marketing copy
- Hashtags: minimal use, functions similarly to X — used for topic/community discovery (e.g. #buildinpublic, #saas) rather than reach mechanics; no evidence of an algorithmic hashtag boost
- Chronological-leaning feed (Bluesky's default "Following" feed is reverse-chronological, unlike algorithmic feeds elsewhere) means **posting time/frequency matters more directly** than on algorithm-first platforms — no need to "beat" a ranking model, just show up when your audience is online [training — consistent with Bluesky's known default-feed architecture, not independently re-verified this session]

### Pitfalls
- Silently blowing the 300-char budget by embedding a long UTM-tagged URL without facet truncation — a real risk for an automated tool that naively concatenates copy + tracking link
- Small, still-growing B2B audience on Bluesky relative to X/LinkedIn — treat as a supplementary channel, not primary, for B2B SaaS distribution [training/synthesis, not a hard platform fact]

### B2B SaaS specifics
- Best format: short text updates, changelog/release notes, technical community engagement (Bluesky's early-adopter base skews developer/tech-worker) — good for product-update and build-in-public content, secondary to LinkedIn/X for demand gen.

---

## 8. THREADS

### Hard limits
- Text cap **500 chars** **[vendor-verified in code, 2026-08-02]** — `threads-transport.ts`'s
  `channelRules()` checked this directly against developers.facebook.com/docs/threads/posts,
  quoted verbatim: "Text posts are limited to 500 characters." ⚠️ Re-read 2026-09-17: the same
  page now also says "Emojis are counted as the number of UTF-8 bytes", so an emoji costs 4 toward
  the 500 while `vendorLength` (utf16) charges 2; a byte count mode would over-charge every
  accented French letter, so the engine keeps utf16 and this stays a written caveat. Same read:
  "The number of links is restricted to 5 or less", a hard `THREADS_API__LINK_LIMIT_EXCEEDED`
  since 2025-12-22 (changelog), now `SPECS.threads.maxLinks` + QA `too-many-links`; 1 GB / 300 s
  video is vendor-stated on that page; 250 published posts per 24 h. Originally this file's number
  came from Postiz's own channel schema (`GET /integration-settings/:id` → `maxLength: 500`)
  and its provider source — that [Postiz artifact] happened to be correct, and is now
  independently confirmed against Meta itself rather than merely inherited from the
  aggregator.
- Carousel up to **20 items**, and unlike Instagram/Facebook a Threads carousel **may mix
  images and video** **[vendor-verified in code, 2026-08-02]** — `threads-transport.ts`'s
  `channelRules()` cites Meta's own Threads API changelog (Sept 19 2024): "Carousel posts are
  now allowed up to 20 images, videos, or a mix of the two." This was previously a
  [training]-tagged guess read off Postiz's untyped `createCarouselContent` passthrough; it is
  now an independently confirmed vendor fact. Note the direct Threads transport itself still
  only ever builds image carousels (video containers were never implemented), so the vendor
  allows more than this engine currently sends.
- Image **8MB max** **[vendor-verified in code, 2026-08-02]** —
  developers.facebook.com/docs/threads/posts, quoted verbatim in `threads-transport.ts`'s
  `channelRules()`: "8 MB maximum." Accepted formats are **JPEG and PNG**
  **[vendor-verified in code, 2026-08-02]** — same page: "JPEG and PNG image types are the
  officially supported formats for image posts." This is wider than Instagram, which is
  JPEG-only (see the Instagram section) — both were checked against Meta on the same day.
- Video up to ~5 min **[assumed in code]** — no transport has checked this against Meta.
  Video is out of scope for the direct Threads transport (it refuses video and never builds a
  VIDEO container — `threads-transport.ts`'s `assertNoVideo`), so this duration is a
  carried-over guess with no vendor citation anywhere in the code, not a confirmed limit.

### Threading
- Replies chain natively. Originally **[verified]** only in Postiz's source (`post()`
  publishes `value[0]` and the worker chains `value[1..]` through `comment()` using
  `reply_to_id`) — now also **[vendor-verified in code, 2026-08-02]** directly against
  Meta: `threads.ts`'s `replyToId` field cites
  developers.facebook.com/docs/threads/retrieve-and-manage-replies/create-replies with a
  worked example (`-F "reply_to_id=<THREADS_ID>"`). This is the identical contract X and
  Bluesky use (`const [firstPost] = postDetails` in all three), so our existing thread-item
  and first-comment plumbing works unmodified.

### Optimal formatting
- One topic tag per post — Threads surfaces a single tag, so extra hashtags are dead
  weight **[training]**. Prefer zero.
- Links are clickable and unfurl a card **[training]**. No documented reach penalty found;
  deliberately NOT encoded as a `linkPenalty` rather than assert one we cannot show.
- Register is text-first and conversational, much closer to Bluesky than to Instagram
  despite the shared account graph. Build-in-public notes and short technical opinions fit;
  polished brand copy does not.

### Pitfalls
- Same Meta engagement-bait classifier as Instagram and Facebook — "tag a friend" style
  copy gets demoted.
- The audience overlaps Instagram heavily. Cross-posting identical IG copy wastes the
  channel; the formatter renders it separately for that reason.

---

## 9. PINTEREST

### Hard limits
- Description: **800** chars — **CORRECTED 2026-08-03.** The **500** figure this file
  previously stated is a **[Postiz artifact]**: it came from Postiz's own channel schema
  (`GET /integration-settings/:id`), which is narrower than what Pinterest's real API accepts.
  **800** is **[vendor-verified in code, 2026-08-02]** — `pinterest.ts`'s module docblock
  states the description cap was checked directly "against Pinterest's own published OpenAPI
  description (`github.com/pinterest/api-description`, `v5/openapi.yaml`) and the generated
  Python client's model docs," and `CreatePinInput.description`'s own comment is explicit:
  "Vendor cap is 800 chars (openapi.yaml `PinCreate.description`), not the 500 some docs
  quote." `pinterest-transport.ts`'s `channelRules()` and `specs.ts`
  (`SPECS.pinterest.maxChars`) both enforce **800**.
- Title: **100** chars **[vendor-verified in code, 2026-08-02]** — same OpenAPI verification
  pass as the description cap above (`pinterest.ts`'s module docblock names "the 800/100 char
  caps" together). Previously tagged [verified live] from Postiz's schema only; the number is
  unchanged, but it is now independently confirmed against Pinterest's own API contract rather
  than Postiz's.
- Media: **at least one asset is MANDATORY** **[Postiz artifact — read from the channel's live
  integration schema, not independently re-checked against Pinterest's OpenAPI spec by this
  repo's own code]**. A pin with no image or video cannot be created. `pinterest.ts`'s
  `createPin()` also enforces this client-side, but its own docblock frames the vendor
  rejection as inferred ("the vendor would reject anyway"), not a cited OpenAPI `required`
  field the way the description/title/images caps above are.
- Images: **maximum 5** per pin **[vendor-verified in code, 2026-08-02]** —
  `pinterest-transport.ts`'s `channelRules()` calls this "Real vendor cap on images per pin"
  and cites `PinMediaSourceImagesBase64`'s OpenAPI constraint (`minItems: 2, maxItems: 5` for
  the carousel path, one `image_base64` pin as the other legal shape). Same number as before,
  same OpenAPI source as the description/title fixes above.
- Accepted image formats: **JPEG and PNG only** — no WebP, no GIF **[vendor-verified in code,
  2026-08-02]**. `pinterest.ts`'s `PinterestImageContentType` type is drawn directly from the
  OpenAPI `ContentType` enum on `image_base64`; a different mime type must be converted or the
  publish fails loudly rather than being silently re-encoded. This was not previously stated
  in this file.
- Video: exactly ONE video per pin, and it needs a **second attachment as the cover
  image** **[Postiz artifact]**. The vendor states it as: "if posting a video, you must have
  two attachment, one for video, one for the cover picture". Not independently re-checked
  against Pinterest's OpenAPI spec — the direct Pinterest transport does not implement video
  pins at all yet (`pinterest-transport.ts` refuses any video in `publishNow`), so nothing in
  this repo's code has verified this specific claim against the vendor directly.
- `settings.board` is **REQUIRED** and the schema description says "board must be an id"
  **[Postiz artifact]**. Board IDs are listed via the channel's `boards` tool. `pinterest.ts`'s
  `createPin()` enforces this client-side too, but as an inferred caller-bug guard, not a cited
  OpenAPI `required` field.
- Optional settings: `title`, `link` (`format: url`), `dominant_color` **[Postiz artifact,
  not independently re-checked against the OpenAPI spec]**.

### Image/video specs
- 20MB per image, 2GB per video, ~15 min max duration **[training]** — these come from
  Pinterest's published API limits and are NOT vendor-verified like the numbers above.
  They exist in `specs.ts` as guards, not as contract. Correct them if a real publish
  ever disagrees.
- Tall **2:3 (1000x1500)** is the native aspect ratio **[training]**; square works,
  landscape crops badly in feed.

### Optimal formatting
- Pinterest is a **search engine**, not a social feed. Plain keyword-rich copy describing
  what the image shows and what the reader gets beats conversational voice.
- The feed shows the **image and title**, not the description. The hook belongs in the
  title; the description (800 chars per the vendor, see Hard limits above) is secondary
  context and keywords.
- Pins have a long tail (months, not hours), so evergreen explainers outperform
  time-bound announcements.

### Pitfalls
- **Hashtags are deprecated** **[training]**: not clickable, no ranking weight. The spec
  sets `idealHashtags: [0, 0]` and `hashtagPlacement: "none"` so QA warns and the
  mechanical fixer strips them.
- **URLs in the description are dead text.** The clickable destination is the separate
  `settings.link` field, filled from the draft's source link. A URL in the copy is pure
  waste, which is why `linksClickable: false` plus a Pinterest-specific `linkAdvice`
  (the generic "link in bio" remedy is Instagram's, and wrong here).
- `mixedMediaAllowed` is deliberately **true** on this spec even though only one mixed
  shape is legal. A video pin is legitimately video + image, which the generic
  mixed-media check would reject; the real rule (1-5 images, OR one video with exactly one
  cover) is enforced by `pinterestMediaShape()` in `qa.ts` instead.
- **Board list shape [verified live 2026-07-25]**, once a board existed:
  `{"output":[{"name":"Acme","id":"100000000000000001"}]}`. The id is a
  **numeric-looking string**, and it is NOT the cuid-style id Postiz used for
  integrations: do not confuse the two.
  `pinterestBoards()` also keeps a `{value,label}` fallback for Postiz's dropdown
  convention, and deliberately THROWS on an unreadable list rather than returning `[]`,
  because `[]` hard-refuses a publish with "this account has no boards" and that must
  never be said about an account that has some.

### B2B SaaS specifics
- Typically the lowest-priority channel for a B2B SaaS audience (LinkedIn > Reddit > YouTube
  > X >> IG/FB/Pinterest). Value here is long-tail search on explainer/infographic content,
  not engagement.
- Every pin needs media, so a pipeline that creates drafts with no media should keep
  Pinterest out of its target list until a media source is wired in.

---

## 10. TIKTOK

Added after the 2026-08-03 reconciliation. Every figure here is the one `specs.ts`
(`SPECS.tiktok`) and `tiktok-transport.ts`'s `channelRules()` both declare, which
`specs-transport-drift.test.ts` holds equal. The vendor quotes are from TikTok API for Business's
"Publish a public video post" doc, as `tiktok-transport.ts`'s limits docblock cites it; the
**[vendor-verified in code]** tags below carry no date because that check did not record one.

### Hard limits
- Caption: **2,200** characters, counted in UTF-16 code units ("Length limit: 2,200 characters
  (UTF-16 encoding)") **[vendor-verified in code]**. Zernio's own documented caption cap
  (`zernio-aggregator.ts` RULES, from its OpenAPI `TikTokPlatformData`) matches while it holds
  the route.
- Media: **one video, and only a video** is MANDATORY. No video, no post; no images, no mixed
  media.
- Video size: **1 GB** ("The maximum video size is 1 GB"), declared as 10^9 bytes, the smaller
  reading **[vendor-verified in code]**.
- Video duration: **600 s** ("the maximum video duration is 600 seconds", same doc), the most
  any account gets. The real cap is per account (`max_video_post_duration_sec` from
  `/business/video/settings/`) and can be shorter **[vendor-verified in code]**.
- Enforced only by TikTok, not expressible in `channelRules()`: at least 3 seconds, 360 px on
  each side, 23 to 60 fps, and .mp4/.mov/.webm.
- No title, no first comment, no threads.

### Publishing behaviour
- ⛔ **A publish is a task, not a post.** `/business/video/publish/` answers a `share_id`, and
  TikTok downloads, checks and publishes the video afterwards, which can take up to an hour.
  The transport never throws on that uncertainty after the create succeeds; postFacts and the
  reconcile give the verdict.
- ⛔ **Public only.** The endpoint takes no privacy level, so a leg is live to everyone the
  moment it completes. There is no private-first option as YouTube has.
- ⚠️ **No delete.** The API has no endpoint to delete a video post, so `deletePost` refuses
  with the one instruction that works: delete it in the TikTok app.

### Optimal formatting
- The caption overlays the video and folds after roughly two lines on a phone **[training]**
  (`truncationPoint: 100`), so the first line is the hook and must work alone.
- **3-5 hashtags at the end**; they are clickable and feed TikTok search.
- Links in captions are **not clickable**: point to the link in the profile instead.
- Every post is labelled as promoting the operator's own business (TikTok's Brand organic
  disclosure), so the copy must not pretend to be anything else.

---

## ENGAGEMENT MECHANICS (researched 2026-07-25)

This file was formatting-first; these are the behavioural findings that drive the
deterministic playbook layer (`src/playbook.ts`). Anything here that
changes a placement decision is encoded in code, not left to the formatter prompt.

### LinkedIn: there is NO free link placement **[verified 2026-07-25]**
- Body links still cost ~60% reach.
- **The first-comment workaround is penalized JUST AS HEAVILY.** The 2026 algorithm
  reads the comments section immediately and treats an author dropping a link as
  the first comment as "bridge behaviour", applying the same hit as a body link.
- Consequence for the code: moving a LinkedIn link to the first comment is
  **strictly dominated**. It pays the identical penalty, adds a detection signal,
  and buries the link where fewer readers look. `applyMechanicalFixes` used to do
  exactly this; it no longer does, gated by the new
  `PlatformSpec.firstCommentLinkPenalized` flag, and `LINKEDIN_LINK_POLICY`
  defaults to `"body"` (keep the link visible, accept the cost, let QA report it).
- Ranking has shifted to depth/authority: dwell time beats click count, and a post
  held for ~30s outperforms one with 50 quick likes.

### X: the link-in-reply mechanic is confirmed, and Premium changes the shape **[verified 2026-07-25]**
- The open-sourced ranking code confirms a **30-50% external-link penalty**, and
  since March 2025 link posts from FREE accounts have had effectively zero median
  engagement. Posting the link as a reply is the documented workaround, which is
  what the twitter playbook does unconditionally.
- **280 free / 25,000 Premium**. The timeline still shows
  only the first **280** characters behind a "Show more", so a long post's hook must
  land inside that. `truncationPoint: 280` is now set for exactly this, and the trim
  reads `effectiveMaxChars` so the live channel cap (not the hardcoded 280) governs.
- Premium accounts see materially more reach per post, so long-form roots are worth
  using where the content earns it.
- URLs count as a flat 23 characters to X, however long, and emoji and CJK count 2
  (`xWeightedLength` in `src/length.ts`). An older `max(weighted, raw)` count, which
  charged a UTM-stamped link in full, is gone.

### Follow-up delay (per-item timing): STILL UNVERIFIED
- A follow-up item (a thread reply, a first comment) could in principle wait N minutes
  after its root. No platform's timing for this has been proven here.
- It is also unobservable on failure: a root that publishes while its delayed follow-up
  silently never lands can look like success.
- Therefore `PLAYBOOK_TUNING` (`src/playbook.ts`) ships every delay at **0** (immediate
  chaining, which is the verified behaviour and already satisfies "a comment after the
  post"), and a test pins it there. To change that, prove the follow-up timing with a live
  publish, verify it by hand, and record the result HERE before touching the tuning table.

### Still not researched
Per-platform best posting times (cadence slot hours remain deliberately plain
rather than dressed up as data), first-N-minutes engagement effects, whether "every
post carries media" is measurably better per platform, and Pinterest's current
fresh-pin/duplicate-image policy (relevant because generated cards are
content-addressed by sha256, so a true re-run of the same post reuses one asset).

---

## SUMMARY TABLE (quick-reference)

| Platform | Text hard cap | Hashtag hard cap | Optimal hashtags | Truncation point | Link-in-body penalty 2026 |
|---|---|---|---|---|---|
| Instagram | 2,200 | **5** (new Dec 2025, was 30) | 5, niche | ~125 chars | N/A (not clickable anyway) |
| Facebook | 63,206 | none | low, optional | ~477 desktop/~125 mobile | Yes — 2 link-posts/mo cap (non-Verified) + long-standing reach penalty; comments unlimited |
| Threads | **500** (vendor-verified 2026-08-02 against Meta directly; was Postiz schema before) | none formal (1 topic tag surfaces) | 0–1 | ~140 chars | No documented penalty; links unfurl |
| X/Twitter | 280 free / 25,000 Premium | none formal | 0–2 | 280 (even for Premium, in-timeline) | Severe — 30–50% confirmed in the open-sourced ranking code, ~zero median engagement for free-account link posts; post link as first reply |
| LinkedIn | 3,000 | none formal | 3–5, end-placed | ~140 mobile/~210 desktop | Yes — ~60% reach loss, and the first-comment workaround is penalized **just as heavily** (bridge-behaviour detection), so no placement avoids it |
| YouTube | Title 100 (chars) / Desc 5,000 **bytes, not chars** | 15 (hard, else all stripped) | 2–3 in description | Title ~70/~40(Shorts); Desc ~157 | N/A (description links normal/expected) |
| Reddit | Title 300 / body ~40,000 (unverified placeholder — old "10,000, verified" was a Postiz artifact) | none formal | rarely used | n/a | Link posts more promotional-flagged than text posts; subreddit-dependent |
| Bluesky | 300 (graphemes) | none formal | minimal | n/a (no "more" truncation) | No official penalty found, but raw URLs eat full char budget unless facet-truncated |
| Pinterest | Title 100 / desc **800** (both vendor-verified 2026-08-02 against Pinterest's OpenAPI spec; old "500, verified live" was a Postiz artifact) | none formal (deprecated) | **0** | n/a (feed shows image + title) | N/A — description links are dead text; the destination is a separate `link` setting |
| TikTok | Caption 2,200 (UTF-16); one video only, 1 GB, 600 s | none formal | 3-5, end-placed | ~100 chars (folds after ~2 lines) | N/A: caption links are not clickable; point to the profile link |

---

## KEY 2026 CHANGES TO BAKE INTO THE TOOL (highest priority)
1. **Instagram hashtag cap dropped from 30 to 5** (Dec 18, 2025 rollout) — validator must reject >5, not >30.
2. **Facebook 2-link-posts/month cap** for non-Meta-Verified Pages — tool should default to link-in-comment, not link-in-body.
3. **LinkedIn link-in-first-comment workaround is no longer safe** (penalized since early 2026) — no reliable link-reach workaround remains except accepting the ~60% hit or Company Page article/newsletter format.
4. **X link penalty intensified** (up to ~94% in independent tests despite X's own "we removed it" claim) — first-reply link placement remains the workaround.
5. **YouTube long-form home-feed allocation cut ~80%** in favor of Shorts — shift B2B content mix toward Shorts-led funnels.
6. **Bluesky has no protocol-level URL shortening** — any tool posting via API must implement its own facet-truncation or budget for full URL length.
