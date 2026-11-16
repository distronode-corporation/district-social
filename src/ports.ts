/**
 * The engine's ports: the interfaces an application implements to give the
 * engine storage, credentials, media, a model, time, mutual exclusion and
 * approvals, plus an in-memory implementation of each.
 *
 * The engine defines the shapes and never the backing: a deployment backs
 * `DraftStore` with its database, `CredentialStore` with whatever encrypts its
 * secrets at rest, `MediaStore` with an object store, `Lock` with a shared
 * lease, and so on. The in-memory implementations are complete and tested, so
 * a single process (a test, a CLI, a demo) runs with no infrastructure at all;
 * none of them survives a restart or is shared between processes.
 *
 * Nothing here is a module-level singleton. Every in-memory factory returns a
 * fresh instance, and `createEngine` (engine.ts) holds the ports it is given
 * per engine, so two engines in one process never share state.
 *
 * ## The approval model
 *
 * Publishing is shaped as: a draft, then its renders, then a hash of exactly
 * those renders (`rendersHash`, computed by the application over everything a
 * publish would send), then a single-use approval a HUMAN grants for that hash,
 * then the publish that consumes it, then evidence of what went out. The engine
 * only ever CONSUMES an approval (`ApprovalGate.consume`); it has no call that
 * grants one, so there is no path by which an agent approves its own post. A
 * grant comes from the application's human surface, which is the only caller of
 * the in-memory gate's `grant`.
 *
 * Engine rules apply: relative imports only, no `@/`, no prisma, no next.
 */

import { genJson, type GenJsonOptions } from "./claude.js";
import type { Draft } from "./types.js";
import { trimTrailing } from "./trim.js";

// ── Clock ────────────────────────────────────────────────────────────────────

export interface Clock {
  now(): Date;
}

/** The wall clock. */
export const systemClock: Clock = Object.freeze({ now: () => new Date() });

/** A clock that moves only when told to. */
export interface ManualClock extends Clock {
  advance(ms: number): void;
  set(at: Date): void;
}

export function manualClock(start: Date = new Date(0)): ManualClock {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
    set: (at: Date) => {
      t = at.getTime();
    },
  };
}

// ── LlmClient ────────────────────────────────────────────────────────────────

/**
 * A model that answers a prompt with JSON of a given schema. The engine's
 * default is Claude (claude.ts `genJson`); a deployment can hand createEngine
 * any other client with the same contract: the reply always has the schema's
 * shape, and a refusal or a truncated reply throws.
 */
export interface LlmClient {
  generateJson<T>(prompt: string, opts: GenJsonOptions): Promise<T>;
}

/**
 * Claude, through claude.ts. Calls `genJson` per request (never captured), so
 * the client it builds follows its own credential rules.
 */
export const claudeLlm: LlmClient = Object.freeze({
  generateJson: <T>(prompt: string, opts: GenJsonOptions) => genJson<T>(prompt, opts),
});

/** An LlmClient that answers from a script, for tests and dry runs. Records every prompt. */
export interface ScriptedLlm extends LlmClient {
  readonly prompts: string[];
}

export function scriptedLlm(answer: (prompt: string, opts: GenJsonOptions) => unknown): ScriptedLlm {
  const prompts: string[] = [];
  return {
    prompts,
    async generateJson<T>(prompt: string, opts: GenJsonOptions): Promise<T> {
      prompts.push(prompt);
      return answer(prompt, opts) as T;
    },
  };
}

// ── Lock ─────────────────────────────────────────────────────────────────────

/** A held lease. `release` is idempotent and releases only this holder's lease. */
export interface LockLease {
  readonly key: string;
  release(): Promise<void>;
}

/**
 * Mutual exclusion by key with a lease: at most one holder per key until it
 * releases or the lease expires, so a crashed holder cannot wedge a key.
 * `acquire` answers null, never waits, when the key is held.
 */
export interface Lock {
  acquire(key: string, ttlMs: number): Promise<LockLease | null>;
}

export function inMemoryLock(clock: Clock = systemClock): Lock {
  const held = new Map<string, { token: symbol; until: number }>();
  return {
    async acquire(key: string, ttlMs: number) {
      if (!(ttlMs > 0)) throw new RangeError("a lock lease needs a positive ttlMs");
      const now = clock.now().getTime();
      const current = held.get(key);
      if (current && current.until > now) return null;
      const token = Symbol(key);
      held.set(key, { token, until: now + ttlMs });
      return {
        key,
        async release() {
          // A lease that expired and was taken by someone else is theirs now.
          if (held.get(key)?.token === token) held.delete(key);
        },
      };
    },
  };
}

// ── DraftStore ───────────────────────────────────────────────────────────────

export interface DraftStore {
  get(id: string): Promise<Draft | null>;
  /** Insert or replace by `draft.id`. */
  put(draft: Draft): Promise<void>;
  /** Every draft, newest `updatedAt` first. */
  list(): Promise<Draft[]>;
  delete(id: string): Promise<boolean>;
}

/** Stores structured copies, so a caller mutating its draft never edits the store. */
export function inMemoryDraftStore(): DraftStore {
  const rows = new Map<string, Draft>();
  return {
    async get(id) {
      const row = rows.get(id);
      return row ? structuredClone(row) : null;
    },
    async put(draft) {
      rows.set(draft.id, structuredClone(draft));
    },
    async list() {
      return [...rows.values()].map((d) => structuredClone(d)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async delete(id) {
      return rows.delete(id);
    },
  };
}

// ── CredentialStore ──────────────────────────────────────────────────────────

/**
 * Platform credentials (tokens, refresh tokens, app secrets) by name. How a
 * value is protected at rest is the implementation's business: the engine only
 * reads and writes plaintext through this interface and never logs a value.
 */
export interface CredentialStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export function inMemoryCredentialStore(initial: Readonly<Record<string, string>> = {}): CredentialStore {
  const values = new Map(Object.entries(initial));
  return {
    async get(name) {
      return values.get(name) ?? null;
    },
    async set(name, value) {
      if (!value) throw new Error(`refusing to store an empty credential for ${name}`);
      values.set(name, value);
    },
    async delete(name) {
      values.delete(name);
    },
  };
}

// ── MediaStore ───────────────────────────────────────────────────────────────

export interface StoredMedia {
  key: string;
  contentType: string;
  bytes: number;
  /** Where a platform fetches it from; vendors that pull media need a public URL. */
  url: string;
}

/** Media bytes by key, behind whatever object store the deployment uses. */
export interface MediaStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<StoredMedia>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

/**
 * Keys are URL path segments under `baseUrl`; a key with `..` or a leading `/`
 * is refused. Each segment is percent-encoded in the URL, so a key carrying a
 * space, `#` or `?` still names its own object rather than a fragment or query.
 */
export function inMemoryMediaStore(baseUrl = "memory://media"): MediaStore {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const checkKey = (key: string) => {
    if (!key || key.startsWith("/") || key.split("/").includes("..")) throw new Error(`invalid media key "${key}"`);
  };
  return {
    async put(key, body, contentType) {
      checkKey(key);
      objects.set(key, { body: body.slice(), contentType });
      const path = key.split("/").map(encodeURIComponent).join("/");
      return { key, contentType, bytes: body.byteLength, url: `${trimTrailing(baseUrl, "/")}/${path}` };
    },
    async get(key) {
      const obj = objects.get(key);
      return obj ? { body: obj.body.slice(), contentType: obj.contentType } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

// ── ApprovalGate ─────────────────────────────────────────────────────────────

export interface Approval {
  id: string;
  draftId: string;
  /** The hash of the renders the approver saw. A publish of anything else is refused. */
  rendersHash: string;
  /** The human who granted it, as the application identifies them. */
  approvedBy: string;
  approvedAt: string;
  mode: "now" | "at";
  scheduledFor?: string;
}

/** What a publish sent, recorded against the approval it consumed. */
export interface PublishEvidence {
  approvalId: string;
  draftId: string;
  rendersHash: string;
  at: string;
  legs: Array<{ platform: string; ref?: string; url?: string; error?: string }>;
}

export class ApprovalRefusedError extends Error {
  constructor(
    readonly reason: "unknown" | "used" | "wrong-draft" | "renders-changed",
    message: string,
  ) {
    super(message);
    this.name = "ApprovalRefusedError";
  }
}

/**
 * The engine's side of the approval model. `consume` succeeds once per
 * approval, and only for the draft and rendersHash it was granted for; every
 * other call throws ApprovalRefusedError. `recordEvidence` keeps what a
 * consumed approval published. There is deliberately no grant here.
 */
export interface ApprovalGate {
  consume(approvalId: string, subject: { draftId: string; rendersHash: string }): Promise<Approval>;
  recordEvidence(evidence: PublishEvidence): Promise<void>;
  evidence(approvalId: string): Promise<PublishEvidence[]>;
}

/** The in-memory gate, plus the grant a human surface (never the engine) calls. */
export interface InMemoryApprovalGate extends ApprovalGate {
  grant(approval: Omit<Approval, "approvedAt"> & { approvedAt?: string }): Approval;
}

export function inMemoryApprovalGate(clock: Clock = systemClock): InMemoryApprovalGate {
  const approvals = new Map<string, Approval>();
  const used = new Set<string>();
  const log = new Map<string, PublishEvidence[]>();
  return {
    grant(input) {
      if (!input.approvedBy) throw new Error("an approval names the human who granted it");
      if (approvals.has(input.id)) throw new Error(`approval ${input.id} already exists`);
      const approval: Approval = { ...input, approvedAt: input.approvedAt ?? clock.now().toISOString() };
      approvals.set(approval.id, approval);
      return { ...approval };
    },
    async consume(approvalId, subject) {
      const approval = approvals.get(approvalId);
      if (!approval) throw new ApprovalRefusedError("unknown", `no approval ${approvalId}`);
      if (used.has(approvalId)) throw new ApprovalRefusedError("used", `approval ${approvalId} was already used`);
      if (approval.draftId !== subject.draftId) {
        throw new ApprovalRefusedError("wrong-draft", `approval ${approvalId} is for another draft`);
      }
      if (approval.rendersHash !== subject.rendersHash) {
        throw new ApprovalRefusedError("renders-changed", `the renders changed after approval ${approvalId}`);
      }
      used.add(approvalId);
      return { ...approval };
    },
    async recordEvidence(evidence) {
      if (!used.has(evidence.approvalId)) {
        throw new ApprovalRefusedError("unknown", `no consumed approval ${evidence.approvalId} to record against`);
      }
      // The same subject checks consume makes: evidence names the draft and
      // renders it published, and they must be the ones this approval covered.
      // Non-null: `used` only ever holds ids consume found in `approvals`.
      const approval = approvals.get(evidence.approvalId)!;
      if (approval.draftId !== evidence.draftId) {
        throw new ApprovalRefusedError("wrong-draft", `approval ${evidence.approvalId} is for another draft`);
      }
      if (approval.rendersHash !== evidence.rendersHash) {
        throw new ApprovalRefusedError("renders-changed", `evidence for approval ${evidence.approvalId} names other renders`);
      }
      const rows = log.get(evidence.approvalId) ?? [];
      rows.push(structuredClone(evidence));
      log.set(evidence.approvalId, rows);
    },
    async evidence(approvalId) {
      return structuredClone(log.get(approvalId) ?? []);
    },
  };
}

// ── The set createEngine takes ───────────────────────────────────────────────

/** Every port an engine can hold. `clock` and `llm` have defaults; the stores do not. */
export interface EnginePorts {
  clock: Clock;
  llm: LlmClient;
  lock?: Lock;
  drafts?: DraftStore;
  credentials?: CredentialStore;
  media?: MediaStore;
  approvals?: ApprovalGate;
}
