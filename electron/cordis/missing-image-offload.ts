/**
 * missing-image-offload — recover a session whose history references an image
 * the attachment store can no longer read.
 *
 * The session log stores only an ImageAttachmentRef per image; the bytes live
 * in the attachment store. The pi-ai adapter reads EVERY non-offloaded history
 * image on each request and fails the whole request when one is missing, so a
 * single lost image made every later turn end with "attachment … not found"
 * (images were memory-only before the store gained its disk copy, so any chat
 * with an image broke after a restart).
 *
 * On that failure this listener records an `image/offload` event for exactly
 * the unreadable occurrences and retries. That event (projection registered by
 * dsh-compaction-image-offload, which must be mounted) is durable: the adapter
 * renders those blocks as placeholder text on every later request, so the
 * session stays resumable. Images that are still readable are left alone.
 */
import type { Context } from "@deepseek-ai/cordis";

const MISSING_ATTACHMENT_RE = /attachment \S+ not found/;

type ImageBlock = { type: "image"; offloaded?: boolean; attachment?: { attachmentId?: unknown } };
type SessionLike = {
  surface: { nodes: Iterable<number> };
  eventAt(seq: number): { type: string };
  deriveEventMessage(event: { type: string }): { content: ReadonlyArray<{ type: string }> };
  append(type: string, data: unknown): unknown;
};
type Target = { seq: number; imageIndexes: number[] };

/**
 * Find every non-offloaded image occurrence on the session surface whose bytes
 * `isReadable` rejects. Image indexes count ALL image blocks in a message
 * (offloaded ones included), matching the image/offload projection.
 */
export function findMissingImageTargets(session: SessionLike, isReadable: (id: string) => boolean): Target[] {
  const targets: Target[] = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event.type !== "user/message" && event.type !== "tool/result") continue;
    const imageIndexes: number[] = [];
    let imageIndex = 0;
    for (const block of session.deriveEventMessage(event).content) {
      if (block.type !== "image") continue;
      const image = block as ImageBlock;
      if (image.offloaded !== true && !isReadable(String(image.attachment?.attachmentId ?? ""))) imageIndexes.push(imageIndex);
      imageIndex += 1;
    }
    if (imageIndexes.length > 0) targets.push({ seq, imageIndexes });
  }
  return targets;
}

export const name = "cairn-missing-image-offload";
export const inject = ["agents", "sessions"];

export function apply(ctx: Context): void {
  const on = (ctx as unknown as {
    on(event: string, listener: (payload: { agent: { session: SessionLike }; failure: { message?: string } }, next: () => Promise<unknown>) => unknown): void;
  }).on.bind(ctx);
  on("agent/request-error", ({ agent, failure }, next) => {
    if (!MISSING_ATTACHMENT_RE.test(failure?.message ?? "")) return next();
    const store = ctx.get("attachments") as { has?: (id: string) => boolean } | undefined;
    if (typeof store?.has !== "function") return next();
    const targets = findMissingImageTargets(agent.session, (id) => store.has!(id));
    // Nothing on the surface to offload → not ours to fix; let the turn fail.
    if (targets.length === 0) return next();
    console.warn(`[attachments] offloading ${targets.reduce((n, t) => n + t.imageIndexes.length, 0)} missing history image(s) and retrying`);
    agent.session.append("image/offload", { targets });
    return Promise.resolve({ kind: "retry" });
  });
}
