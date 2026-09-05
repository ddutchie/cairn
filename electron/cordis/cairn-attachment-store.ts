/**
 * cairn-attachment-store — Cairn's concrete dsh AttachmentStore + the
 * user-message content-block builder for the Cordis engine.
 *
 * dsh-attachment ships only the ABSTRACT AttachmentStore; a deployment must
 * supply the backend. Upstream's backend (@deepseek-ai/dsh-attachment-local)
 * was mounted briefly, but it normalizes every image through sharp — which is
 * a stub in this repo (see electron/sharp-stub; real sharp would need a
 * native-addon fan-out like better-sqlite3) — so EVERY admission failed with
 * "Unsupported or malformed image data" and images were silently dropped from
 * all turns. This backend admits without re-encoding instead:
 *   - content-addressed by a sha256 of the bytes (dedupes identical images),
 *   - dimensions decoded from the raster header (no native deps — parses
 *     PNG/JPEG/WebP/GIF headers directly),
 *   - bytes held in an in-memory Map for the context lifetime. That is enough
 *     for a turn: the durable session log stores the ImageAttachmentRef, and
 *     the adapter reads bytes back within the same request. (A future durable
 *     backend can persist under <userData>/attachments without changing
 *     callers. Cold resume replays text; pi-ai's onReplayDegrade path covers
 *     history images the Map no longer holds.)
 * Limits mirror upstream's defaults (not the older diverged Cairn values).
 */
import type { Context } from "@deepseek-ai/cordis";
import "./ctx-augment";
import AttachmentStore, {
  AttachmentId,
  ImageVariantId,
  AttachmentError,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type ImageMediaType,
  type ImageRequestPolicy,
  type RequestImageAttachment,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from "@deepseek-ai/dsh-attachment";
import * as crypto from "crypto";

/** Limits mirror upstream dsh-attachment-local defaults. */
const DEFAULT_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 20 * 1024 * 1024, // 20 MiB raw per image
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 200 * 1024 * 1024,
  maxImagePixels: 64_000_000, // ~64MP decoded
  maxImageDimension: 8192,
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
};

/** Decoded intrinsic size of a raster image. */
interface Dims { width: number; height: number }

/**
 * Process-wide retention budget for accepted image bytes. Per-message caps
 * bound one turn's intake, but accepted images otherwise live in `blobs`
 * for the process lifetime — distinct images accumulate without bound
 * (20 MiB each). When an insert would exceed the budget, the
 * least-recently-used entries are evicted first (Map insertion order;
 * recency refreshes on save-hit and on read). An evicted id fails closed
 * with ATTACHMENT_NOT_FOUND — the same error as an unknown id, which
 * callers already handle. 512 MiB ≈ 25 max-size images: generous for real
 * sessions, fatal never.
 */
const MAX_BLOBS_BYTES = 512 * 1024 * 1024;
let blobsBudgetBytes = MAX_BLOBS_BYTES;
/** Test seam: shrink the retention budget so eviction is exercisable. */
export function __setBlobsBudgetForTest(bytes: number | undefined): void {
  blobsBudgetBytes = bytes ?? MAX_BLOBS_BYTES;
}

/**
 * Pin every image attachment referenced by freshly built content blocks for
 * the active turn. Returns an unpin-all disposer for the turn's resource
 * stack (finally-disposed, so pins can't leak). Fail-open: unknown block
 * shapes are skipped, never thrown — eviction still fail-closes reads.
 */
export function pinTurnAttachments(
  store: Pick<CairnAttachmentStore, "pin" | "unpin"> | undefined,
  blocks: readonly unknown[],
): () => void {
  if (!store) return () => {};
  const ids: string[] = [];
  for (const b of blocks) {
    const id = (b as { attachment?: { attachmentId?: unknown } } | null | undefined)?.attachment?.attachmentId;
    if (typeof id === "string" && id.length > 0) {
      try {
        store.pin(id);
        ids.push(id);
      } catch { /* pinning is best-effort */ }
    }
  }
  return () => {
    for (const id of ids) {
      try { store.unpin(id); } catch { /* noop */ }
    }
  };
}

/**
 * Read the intrinsic pixel dimensions from a raster header. Supports the four
 * media types dsh accepts. Throws AttachmentError("IMAGE_TYPE_MISMATCH") when
 * the declared media type does not match the actual bytes.
 */
function decodeDimensions(bytes: Uint8Array, declared: ImageMediaType): Dims {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mismatch = () => new AttachmentError("Declared media type does not match the image bytes.", "IMAGE_TYPE_MISMATCH");

  // PNG: 8-byte signature, then IHDR (width/height big-endian at offset 16/20).
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    if (declared !== "image/png") throw mismatch();
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  // GIF: "GIF87a"/"GIF89a", width/height little-endian at offset 6/8.
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    if (declared !== "image/gif") throw mismatch();
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  // WebP: RIFF....WEBP. VP8 / VP8L / VP8X sub-chunks carry dimensions.
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    if (declared !== "image/webp") throw mismatch();
    const fourcc = b.toString("ascii", 12, 16);
    if (fourcc === "VP8 ") {
      // Lossy: 0x9d012a signature, then 14-bit width/height at offset 26/28.
      const w = b.readUInt16LE(26) & 0x3fff;
      const h = b.readUInt16LE(28) & 0x3fff;
      return { width: w, height: h };
    }
    if (fourcc === "VP8L") {
      // Lossless: 1-byte signature (0x2f) at 20, then 14-bit dims packed at 21.
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === "VP8X") {
      // Extended: 24-bit width-1/height-1 little-endian at offset 24/27.
      const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
      const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
      return { width: w, height: h };
    }
    throw mismatch();
  }
  // JPEG: FFD8, then scan SOF markers for 16-bit height/width.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    if (declared !== "image/jpeg") throw mismatch();
    let off = 2;
    while (off + 9 < b.length) {
      if (b[off] !== 0xff) { off++; continue; }
      const marker = b[off + 1];
      // SOF0..SOF15 (excluding DHT=C4, DNL=C8, DAC=CC) carry frame dimensions.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: b.readUInt16BE(off + 5), width: b.readUInt16BE(off + 7) };
      }
      const segLen = b.readUInt16BE(off + 2);
      off += 2 + segLen;
    }
    throw mismatch();
  }
  throw mismatch();
}

/**
 * In-process concrete AttachmentStore. Mounted on the shared Cordis context so
 * the pi-ai adapter (resolveAttachments: () => ctx.get("attachments")) can read
 * image bytes back when converting ImageBlocks to the wire request.
 */
export class CairnAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = DEFAULT_LIMITS;
  private readonly blobs = new Map<string, { data: Uint8Array; ref: ImageAttachmentRef }>();
  /** Live sum of blobs values' byteLengths — avoids re-walking the map. */
  private blobsBytes = 0;
  /**
   * Ids pinned by active turns. Eviction skips these: without pinning, one
   * session's heavy intake could evict another session's in-flight image
   * between its save and read (same shared store, concurrent turns). Pins
   * are turn-scoped — runners register the unpin-all disposer on their
   * turn resources, which dispose in a finally, so pins can't leak. If
   * everything is pinned, the budget goes soft rather than hanging the save.
   */
  private readonly pinned = new Set<string>();

  /** Refresh LRU recency for a retained entry (Map insertion order = age). */
  private touch(id: string, entry: { data: Uint8Array; ref: ImageAttachmentRef }): void {
    this.blobs.delete(id);
    this.blobs.set(id, entry);
  }

  /** Evict least-recently-used entries until `bytes` more fit the budget. */
  private evictFor(bytes: number): void {
    if (this.blobsBytes + bytes <= blobsBudgetBytes) return;
    for (const id of [...this.blobs.keys()]) {
      if (this.blobsBytes + bytes <= blobsBudgetBytes) break;
      if (this.pinned.has(id)) continue;
      const entry = this.blobs.get(id);
      this.blobs.delete(id);
      this.blobsBytes -= entry?.data.byteLength ?? 0;
    }
  }

  /** Pin one retained id against eviction (turn-scoped; must be unpinned). */
  pin(id: string): void {
    if (this.blobs.has(id)) this.pinned.add(id);
  }

  /** Release one pin; no-op when absent. */
  unpin(id: string): void {
    this.pinned.delete(id);
  }

  constructor(ctx: Context) {
    super(ctx);
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    this.assertAndMeasure(input);
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const { dims } = this.assertAndMeasure(input);
    const id = crypto.createHash("sha256").update(input.data).digest("hex");
    const existing = this.blobs.get(id);
    if (existing) {
      this.touch(id, existing);
      return existing.ref;
    }
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(id),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: dims.width,
      height: dims.height,
      ...(input.name === undefined ? {} : { name: input.name }),
    };
    this.evictFor(input.data.byteLength);
    this.blobs.set(id, { data: input.data, ref });
    this.blobsBytes += input.data.byteLength;
    return ref;
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const hit = this.blobs.get(String(ref.attachmentId));
    if (!hit) throw new AttachmentError(`attachment ${String(ref.attachmentId)} not found`, "ATTACHMENT_NOT_FOUND");
    this.touch(String(ref.attachmentId), hit);
    return { ref: hit.ref, data: hit.data };
  }

  /**
   * Derive the model-request version of a stored image. The pi-ai adapter calls
   * this (not readImage) to get the bytes it base64-encodes into the wire
   * request. We do NOT re-encode/resize (no native image pipeline — sharp is
   * stubbed): the stored, already-validated bytes ARE the request version. The
   * policy's pixel/byte caps are honoured at admission time (assertAndMeasure)
   * rather than by a lossy downscale here; a stored image that passed our
   * limits is emitted as-is. variantId is a deterministic key over
   * (attachmentId, policy) so the adapter's per-request cache is stable.
   */
  async readImageRequest(
    ref: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const hit = this.blobs.get(String(ref.attachmentId));
    if (!hit) throw new AttachmentError(`attachment ${String(ref.attachmentId)} not found`, "ATTACHMENT_NOT_FOUND");
    this.touch(String(ref.attachmentId), hit);
    const variantId = ImageVariantId(
      crypto
        .createHash("sha256")
        .update(String(ref.attachmentId))
        .update(`|${policy.maxPixels}|${policy.maxBytes}`)
        .digest("hex"),
    );
    // PNG/WebP/GIF may carry alpha; JPEG never does. We don't inspect the alpha
    // channel per-pixel (no decoder), so declare alpha by container capability.
    const hasAlpha = hit.ref.mediaType !== "image/jpeg";
    return {
      variantId,
      attachment: hit.ref,
      data: hit.data,
      mediaType: hit.ref.mediaType,
      bytes: hit.data.byteLength,
      width: hit.ref.width,
      height: hit.ref.height,
      depth: "uchar",
      space: "srgb",
      hasAlpha,
    };
  }

  /** Shared validation + dimension decode for validate/save. */
  private assertAndMeasure(input: SaveImageAttachment): { dims: Dims } {
    if (!this.imageLimits.mediaTypes.includes(input.mediaType)) {
      throw new AttachmentError(`unsupported media type ${input.mediaType}`, "IMAGE_TYPE_MISMATCH");
    }
    if (input.data.byteLength > this.imageLimits.maxImageBytes) {
      throw new AttachmentError("image exceeds the per-image byte limit", "IMAGE_TOO_LARGE");
    }
    const dims = decodeDimensions(input.data, input.mediaType);
    if (dims.width > this.imageLimits.maxImageDimension || dims.height > this.imageLimits.maxImageDimension) {
      throw new AttachmentError("image dimension exceeds the limit", "IMAGE_DIMENSION_TOO_LARGE");
    }
    if (dims.width * dims.height > this.imageLimits.maxImagePixels) {
      throw new AttachmentError("image exceeds the pixel limit", "IMAGE_TOO_MANY_PIXELS");
    }
    return { dims };
  }
}

export default CairnAttachmentStore;

/** Attachment on an outgoing message (Cairn's ChatRequest.images shape). */
export interface MessageAttachment {
  kind?: "image" | "pdf";
  /** base64 data URL, e.g. data:image/png;base64,… */
  dataUrl: string;
  name?: string;
}

/** A dsh content block (text or image). Kept loose to avoid a hard type import. */
type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; attachment: ImageAttachmentRef };

const DATA_URL_RE = /^data:([^;,]+)(;base64)?,(.*)$/s;

/** Parse a data URL into its media type + decoded bytes (base64 or percent). */
function parseDataUrl(dataUrl: string): { mediaType: string; bytes: Uint8Array } | null {
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return null;
  const mediaType = m[1] || "application/octet-stream";
  const isBase64 = !!m[2];
  const raw = m[3] ?? "";
  try {
    const buf = isBase64 ? Buffer.from(raw, "base64") : Buffer.from(decodeURIComponent(raw), "utf8");
    return { mediaType, bytes: new Uint8Array(buf) };
  } catch {
    return null;
  }
}

/**
 * Build the dsh user-message content blocks for a text prompt + optional
 * attachments. Images are admitted through the mounted attachment store and
 * emitted as ImageBlocks; PDFs degrade to a text notice (dsh's ContentBlock
 * union has no document block). Falls back to text-only when no store is
 * mounted or an attachment can't be processed — nothing is thrown, so a bad
 * attachment never fails the whole turn.
 *
 * @returns content blocks in message order (text first, then attachments).
 */
export async function buildCordisUserContent(
  ctx: Context,
  text: string,
  attachments: readonly MessageAttachment[] | undefined,
): Promise<UserContentBlock[]> {
  const blocks: UserContentBlock[] = [{ type: "text", text }];
  if (!attachments || attachments.length === 0) return blocks;

  const store = ctx.get("attachments") as AttachmentStore | undefined;

  // Enforce the per-MESSAGE aggregate caps up front. saveImage() (called per
  // image below) only checks the PER-IMAGE limit; the batch caps
  // (maxImagesPerMessage, maxMessageImageBytes) live in validateImageBatch,
  // which the single-image path never runs. Without this, a message with many
  // just-under-limit images is fully admitted and each decoded/normalized
  // through sharp — an unbounded-work / OOM vector. We do it inline (rather
  // than store.saveImages) to preserve graceful per-attachment degradation and
  // PDF interleaving; the aggregate is a hard cap that drops the overflow.
  let admittedImages = 0;
  let admittedBytes = 0;
  const maxImages = store?.imageLimits.maxImagesPerMessage ?? Infinity;
  const maxBytes = store?.imageLimits.maxMessageImageBytes ?? Infinity;

  for (const att of attachments) {
    const parsed = parseDataUrl(att.dataUrl);
    if (!parsed) continue;
    const isPdf = att.kind === "pdf" || parsed.mediaType === "application/pdf";

    if (isPdf) {
      // dsh's ContentBlock union has no document block, and PDF text extraction
      // would pull pdfjs into the Electron main bundle. For v1 we degrade
      // gracefully: tell the model a PDF was attached (so it can ask the user to
      // paste the relevant text) rather than silently dropping it. Full PDF
      // passthrough is tracked as a follow-up.
      blocks.push({
        type: "text",
        text: `\n\n[A PDF${att.name ? ` "${att.name}"` : ""} was attached, but PDF attachments are not yet supported on this engine. Ask the user to paste the relevant text if you need its contents.]`,
      });
      continue;
    }

    // Image: admit through the store → ImageBlock.
    if (!store) continue;
    const mediaType = parsed.mediaType as ImageMediaType;
    if (!store.imageLimits.mediaTypes.includes(mediaType)) continue;
    // Aggregate caps: stop admitting once either the count or total-byte budget
    // for this message is reached (drop the overflow rather than OOM).
    if (admittedImages >= maxImages) continue;
    if (admittedBytes + parsed.bytes.byteLength > maxBytes) continue;
    try {
      const ref = await store.saveImage({ data: parsed.bytes, mediaType, ...(att.name ? { name: att.name } : {}) });
      blocks.push({ type: "image", attachment: ref });
      admittedImages += 1;
      admittedBytes += parsed.bytes.byteLength;
    } catch { /* omit an image the store rejects (too large / bad bytes) */ }
  }
  return blocks;
}
