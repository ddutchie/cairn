import { redirectDetailLink } from "@/lib/deep-link";

/** Runs on every incoming URL (widgets, quick actions, links) before the router matches it. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return redirectDetailLink(path);
}
