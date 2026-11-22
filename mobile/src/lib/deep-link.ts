/**
 * Incoming deep links to a project, note or task (`cairn://project/<id>`, as the home-screen
 * widgets send). Those screens are shared by every tab (`app/(tabs)/(projects,calendar,...)/`),
 * so a bare `/project/<id>` would open in whichever tab sorts first (Calendar). Pin them to the
 * Projects tab, the same place a tap in the app opens them from. Anything else passes through.
 */
const DETAIL = /^\/(project|note|card)\/[^/?#]+/;

export function redirectDetailLink(path: string): string {
  // `path` can be a full URL (`cairn://project/abc`, where the host is the first segment) or a path.
  const bare = path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const normalized = bare.startsWith("/") ? bare : `/${bare}`;
  return DETAIL.test(normalized) ? `/(projects)${normalized}` : path;
}
