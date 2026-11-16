/**
 * district-social engine: public surface.
 *
 * Self-contained social post formatter/QA/publisher (one direct vendor API per
 * platform, Claude for text). Only relative imports within this folder, and no
 * framework or database imports, so this folder can be lifted as-is into any
 * consumer (the CLI, or a hosted admin UI).
 *
 * `renderDraft`/`renderQa` (terminal-formatted previews) intentionally stay
 * CLI-side (scripts/social/render.ts) — a hosted UI renders its own views.
 */

// NOTE: `export * from "./types"` was tried here but tsx/esbuild's CJS-interop
// re-export chaining silently drops named exports (e.g. ALL_PLATFORMS) when a
// star-export is itself re-exported through another module at runtime
// (confirmed via a minimal repro; direct imports of ./types are unaffected).
// Explicit named re-exports avoid it and are unambiguous besides.
export {
  ALL_PLATFORMS,
  threadReplies,
  type Platform,
  type MediaAsset,
  type SourcePost,
  type PlatformRender,
  type QASeverity,
  type QAIssue,
  type QAReport,
  type ModelStamp,
  type DraftStatus,
  type Draft,
} from "./types.js";

export {
  SPECS,
  specFor,
  vendorLength,
  specBlock,
  normalizeSubreddit,
  sanitizePlatforms,
  type PlatformSpec,
} from "./specs.js";

export { parseRenderLangs, MAX_RENDER_LANGS, type RenderLangsResult } from "./render-langs.js";

// The brand is data a consumer brings (a BrandPack), bound by createEngine. The
// engine ships none of its own.
export {
  createEngine,
  EMPTY_BRAND_PACK,
  type Engine,
  type EngineOptions,
} from "./engine.js";
export {
  ApprovalRefusedError,
  claudeLlm,
  inMemoryApprovalGate,
  inMemoryCredentialStore,
  inMemoryDraftStore,
  inMemoryLock,
  inMemoryMediaStore,
  manualClock,
  scriptedLlm,
  systemClock,
  type Approval,
  type ApprovalGate,
  type Clock,
  type CredentialStore,
  type DraftStore,
  type EnginePorts,
  type InMemoryApprovalGate,
  type LlmClient,
  type Lock,
  type LockLease,
  type ManualClock,
  type MediaStore,
  type PublishEvidence,
  type ScriptedLlm,
  type StoredMedia,
} from "./ports.js";
export {
  BRIEF_HEADING_MIN_CHARS,
  briefHeadingPhrases,
  NO_BRAND,
  type BrandContext,
  type BrandPack,
  type BrandProfile,
  type GateCopy,
  type QaGate,
} from "./brand-context.js";

export {
  PLATFORM_IDENTIFIERS,
  platformForIdentifier,
  connectIdentifierFor,
} from "./provider-map.js";

export {
  fetchChannelRules,
  rulesBlock,
  effectiveMaxChars,
  type ChannelRules,
  type ChannelRulesMap,
  type ChannelRulesSnapshot,
} from "./channel-rules.js";

export {
  timezone,
  defaults,
  vertexVideoConfig,
  setEngineDeployment,
  type EngineDeployment,
  type VertexVideoConfig,
  type EngineDefaults,
} from "./settings.js";

export {
  genJson,
  setSecretGetter,
  SOCIAL_TEXT_MODEL,
  SOCIAL_TEXT_EFFORT,
  type GenJsonOptions,
  type SecretGetter,
} from "./claude.js";

export {
  VeoError,
  startVideoGeneration,
  pollVideoOperation,
  type VeoGenerationRequest,
  type VeoGeneratedVideo,
  type VeoOperationError,
  type VeoOperationResult,
} from "./veo.js";

export {
  analyzeMedia,
  ensureUploaded,
  readAsBase64,
  hasMediaUploader,
  setMediaUploader,
  type UploadedMedia,
  type MediaUploader,
} from "./media.js";

export {
  fitForTransport,
  hasMediaFitter,
  setMediaFitter,
  type MediaFitRequest,
  type MediaFitter,
} from "./media-fit.js";

export {
  BlueskyError,
  setBlueskyCredentialsResolver,
  setBlueskySessionStore,
  buildRichText,
  normalizeBlueskyIdentifier,
  searchPosts as blueskySearchPosts,
  type BlueskyCredentials,
  type BlueskyCredentialsResolver,
  type BlueskyProfile,
  type StrongRef,
} from "./bluesky.js";

export { blueskyTransport } from "./bluesky-transport.js";

export {
  LinkedInError,
  LINKEDIN_VERSION,
  setLinkedInTokenResolver,
  setLinkedInOrganizationId,
  setLinkedInWriteGuard,
  logLinkedInCall,
  getComments as linkedInGetComments,
  getFollowerCount as linkedInGetFollowerCount,
  getFollowerGains as linkedInGetFollowerGains,
  getShareStatisticsWindow as linkedInGetShareStatisticsWindow,
  linkedInCommentPermalink,
  linkedInStatsWindow,
  listOrganizationPosts as linkedInListOrganizationPosts,
  parseLinkedInCommentPermalink,
  replyToComment as linkedInReplyToComment,
  getOrganizationUrn as linkedInOrganizationUrn,
  LINKEDIN_WINDOW_SUMMABLE_FIELDS,
  type LinkedInComment,
  type LinkedInPagePost,
  type LinkedInStatsWindow,
  type LinkedInWriteKind,
  type LinkedInTokenResolver,
  type LinkedInBatchGetResult,
  type LinkedInImageUpload,
  withLinkedInCallLog,
  type LinkedInCallRecord,
  setLinkedInCallSink,
  withLinkedInCallContext,
  type LinkedInLedgerRecord,
  type LinkedInLedgerSink,
} from "./linkedin.js";

export { linkedinTransport } from "./linkedin-transport.js";

export {
  PinterestError,
  isPinterestNotFound,
  setPinterestTokenResolver,
  createPin,
  getPin,
  deletePin,
  type PinterestTokenResolver,
  type PinterestImageContentType,
  type PinterestImageSource,
  type PinterestPin,
  type PinterestAccount,
} from "./pinterest.js";

export { pinterestTransport } from "./pinterest-transport.js";

export {
  XError,
  isXNotFound,
  setXTokenResolver,
  type XTokenResolver,
  type XReplySettings,
  type XTweet,
  type XProblem,
  type XTweetsBatchResult,
  type XImageMimeType,
  type XProfile,
} from "./x.js";

export { xTransport } from "./x-transport.js";

export {
  RedditError,
  RedditApiError,
  isRedditNotFound,
  setRedditTokenResolver,
  redditUserAgent,
  type RedditTokenResolver,
  type RedditPostKind,
  type RedditPost,
  type RedditApiErrorEntry,
  type RedditSubredditAbout,
  type RedditPostRequirements,
  type RedditFlairTemplate,
  type RedditProfile,
} from "./reddit.js";

export { redditTransport } from "./reddit-transport.js";

/**
 * Zernio, exported NARROWLY on purpose.
 *
 * ⛔ The raw client (`ZernioError`, `listAccounts`, `getPost`, …) is NOT
 * re-exported, and `index.test.ts` asserts that those names stay absent. That
 * assertion was written when this vendor was removed, to stop app code calling a
 * flat engine-wide `engine.listAccounts()` again — and it still holds now the
 * vendor is back, because the surface that crosses this boundary is the
 * `Aggregator` and its wiring, not a second per-platform API. Anything needing
 * the raw client imports `./zernio` directly, from inside the engine.
 */
export {
  setZernioTokenResolver,
  type ZernioTokenResolver,
} from "./zernio.js";

export { zernioAggregator, ZERNIO_ID, resetZernioAccounts } from "./zernio-aggregator.js";

export {
  YouTubeError,
  isYouTubeNotFound,
  setYouTubeTokenResolver,
  type YouTubeTokenResolver,
  type YouTubePrivacyStatus,
  type YouTubeVideoMetadata,
  type YouTubeUploadInput,
  type YouTubeVideo,
  type YouTubeChannel,
} from "./youtube.js";

export { youtubeTransport } from "./youtube-transport.js";

export {
  TikTokError,
  setTikTokCredentialsResolver,
  type TikTokCredentials,
  type TikTokCredentialsResolver,
} from "./tiktok.js";

export {
  tiktokTransport,
  TikTokPublishFailedError,
  TIKTOK_PUBLISH_SCOPE,
  setTikTokProfileUrl,
} from "./tiktok-transport.js";

export {
  META_GRAPH_VERSION,
  MetaGraphError,
  appsecretProof,
  metaCredentials,
  setMetaCredentialsResolver,
  type MetaCredentials,
  type MetaCredentialsResolver,
} from "./meta-graph.js";

export { facebookTransport } from "./facebook-transport.js";

export { instagramTransport } from "./instagram-transport.js";

export {
  THREADS_API_VERSION,
  ThreadsError,
  isThreadsNotFound,
  setThreadsCredentialsResolver,
  threadsCredentials,
  type ThreadsCredentials,
  type ThreadsCredentialsResolver,
  type ThreadsMediaType,
  type ThreadsContainerRef,
  type ThreadsContainerStatusCode,
  type ThreadsContainerStatus,
  type ThreadsProfile,
} from "./threads.js";

export { threadsTransport } from "./threads-transport.js";

export {
  AI_CARD_PATH_PREFIX,
  PREFERRED_RATIO,
  isGeneratedCardSet,
  normalizeCardMediaIndices,
  pickMediaForPlatform,
  unpublishableVideoIndices,
} from "./media-pick.js";

export {
  formatPost,
  skippedForMedia,
  generateAltText,
  generateAltTextsFromFiles,
  draftSummaryForPrompt,
} from "./format.js";

export {
  deterministicChecks,
  channelRuleChecks,
  complianceChecks,
  llmReview,
  runQa,
  qaScore,
  issueWeight,
  isTextFixable,
  isMechanicallyFixable,
  MECHANICAL_FIX_CODES,
  mediaFixKind,
} from "./qa.js";

export {
  applyMechanicalFixes,
  outstandingIssues,
  reviseRenders,
  stripEmDashes,
  type MechanicalFixResult,
} from "./revise.js";

export {
  applyPlaybooks,
  PLAYBOOK_TUNING,
  LINKEDIN_LINK_POLICY,
  type PlaybookResult,
} from "./playbook.js";

export {
  tidy,
  countHashtags,
  trimHashtags,
  hasUrl,
  moveLinkToThread,
  moveLinkToFirstComment,
  dropBodyLink,
} from "./link-placement.js";

export {
  connectedAccounts,
  // Re-exported so the app-side connect callback can bust the 60s memo the
  // moment a consent lands. Without it the first minute after connecting
  // refuses drafts and blames the connection.
  invalidateConnectedAccounts,
  publishDraft,
  assertPublishable,
  publishDestination,
  assertPinterestBoard,
  PublishPreflightError,
  PublishNotSentError,
  type ConnectedMap,
  type PublishOptions,
  type PublishResult,
} from "./publish.js";

export {
  parseProviderPostIds,
  encodeProviderPostIds,
  joinProviderPostIds,
  directEntry,
  directStateEntry,
  legacyEntry,
  isDirectEntry,
  legacyIds,
  isFullyDirect,
  isTerminalEntry,
  registerTransport,
  directTransportFor,
  registeredTransportFor,
  registeredPlatforms,
  resetTransports,
  setTransportOverridesResolver,
  aggregatorEntry,
  aggregatorStateEntry,
  stateEntryLike,
  liveEntryLike,
  registerAggregator,
  registeredAggregatorFor,
  aggregatorById,
  registeredAggregators,
  aggregatorsForPlatform,
  resolveRoute,
  routeTransportFor,
  transportForEntry,
  parseTransportMode,
  noRouteMessage,
  TRANSPORT_MODES,
  type Aggregator,
  type PlatformRoute,
  type NoRouteReason,
  type ResolvedMode,
  type RoutedTransport,
  type RoutedPublish,
  type ProviderPostEntry,
  type RoutableEntry,
  type DirectPendingState,
  type DirectTransport,
  type DirectConnectStatus,
  type DirectPublishInput,
  type DirectPublishResult,
  type PublishDestination,
  type DirectQueuedReply,
  type DirectPostFacts,
  type TransportChannelRules,
  type CountMode,
  type TransportMode,
  type TransportOverrides,
  type TransportOverridesResolver,
} from "./transport.js";
