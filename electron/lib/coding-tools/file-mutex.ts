/**
 * Per-file write serialisation queue.
 *
 * Concurrent edits to the same file path are queued and executed one at a
 * time so partial-write races are impossible. Separate files run in parallel.
 *
 * Ported from pi packages/coding-agent/src/core/tools/file-mutation-queue.ts
 */

const queues = new Map<string, Promise<void>>();

export function withFileMutex<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(filePath) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  queues.set(filePath, next);

  return prev.then(() => fn()).finally(() => {
    resolve();
    // Clean up if this is still the tail of the queue
    if (queues.get(filePath) === next) queues.delete(filePath);
  });
}
