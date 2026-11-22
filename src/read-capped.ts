/**
 * The one capped reader for untrusted HTTP response bodies: it refuses a body
 * over `maxBytes` rather than truncating it, and it stops reading at the first
 * chunk that crosses the cap, so what is ever held in memory is bounded by the
 * cap plus at most one arriving network chunk, never the whole body.
 *
 * ⛔ THE BYTE CAP IS A SECURITY PROPERTY OF EVERY READER THAT GOES THROUGH
 * HERE. The three readers this module replaced (in the application it was
 * extracted from) each sit behind
 * an SSRF guard (`preparePinnedHttpsFetch`, address pinning), but the guard
 * says nothing about SIZE: an allowed host can still stream an endless body
 * into memory. Two checks make that impossible:
 *   - a Content-Length header already over the cap refuses BEFORE a byte is
 *     read (the stream is cancelled so its socket is released);
 *   - a missing or lying Content-Length is caught WHILE STREAMING, chunk by
 *     chunk, and the reader is cancelled at the first chunk that crosses the
 *     cap.
 * A reader that "capped" by reading the whole body and slicing afterwards would
 * buffer exactly the unbounded bytes this exists to refuse; the cap only holds
 * if it is enforced on the stream.
 *
 * The result is a value, not a throw, so each caller maps the refusal to its
 * own typed answer (`too_large`, a Refusal, an error) without matching error
 * classes across modules. Only a genuine transport fault mid-read (a reset,
 * the deadline firing) still throws, and each caller already maps that.
 *
 * Dependency-free on purpose: node and web streams only.
 * It lives in the engine, which imports nothing outside its own
 * folder; the app may re-export it so every app caller keeps its import: one
 * implementation, not two copies.
 */

/** A capped body read: the bytes, or the cap's refusal. */
export type CappedBodyRead =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: "too_large" };

/** A cancel that fails has nothing left to tell us: the read is already refused. */
const ignore = (): undefined => undefined;

/**
 * Read `res`'s body up to `maxBytes`, or refuse the whole read when the body
 * is larger. Never truncates: a caller asking for at most N bytes gets either
 * at most N bytes or a refusal, because a silently shortened page or document
 * would be parsed as if it were complete.
 */
export async function readCappedBody(res: Response, maxBytes: number): Promise<CappedBodyRead> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(ignore);
    return { ok: false, reason: "too_large" };
  }
  // A 204 is `ok` and has no body at all; it reads as an empty body.
  if (!res.body) return { ok: true, bytes: new Uint8Array(0) };
  // A fetch Response body is a stream of bytes (Fetch standard); Node types it as
  // ReadableStream<any>.
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    // A missing or lying Content-Length is caught here, while streaming.
    if (total > maxBytes) {
      await reader.cancel().catch(ignore);
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, bytes: out };
}
