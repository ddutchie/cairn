/** Message text for any thrown value (`Error.message`, else `String(value)`). */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
