/**
 * Pure template instantiation — shared by desktop + mobile.
 *
 * A template is a note whose body contains `{{variable}}` placeholders.
 * Instantiating substitutes a fixed set of auto-resolved variables (date/time
 * derivatives + a user-supplied title). Unknown placeholders are left intact
 * so nothing is silently dropped. No DB/native deps — unit-testable.
 */

export interface TemplateVars {
  /** User-supplied title for the new note. */
  title?: string;
  /** Injectable "now" for deterministic tests; defaults to new Date(). */
  now?: Date;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Monday-based start of the ISO week containing `d`, as YYYY-MM-DD. */
function weekOf(d: Date): string {
  const copy = new Date(d);
  const dow = (copy.getDay() + 6) % 7; // 0 = Monday
  copy.setDate(copy.getDate() - dow);
  return `${copy.getFullYear()}-${pad(copy.getMonth() + 1)}-${pad(copy.getDate())}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Build the auto-resolved variable map for a given instant. Exported so the
 * UI can preview which variables a template will fill.
 */
export function buildTemplateVars(vars: TemplateVars = {}): Record<string, string> {
  const now = vars.now ?? new Date();
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return {
    title: vars.title ?? "",
    date,
    time,
    datetime: `${date} ${time}`,
    year: String(now.getFullYear()),
    month: MONTHS[now.getMonth()],
    weekOf: weekOf(now),
  };
}

/** All placeholder names the built-in variable set will resolve. */
export const TEMPLATE_VARIABLES = ["title", "date", "time", "datetime", "year", "month", "weekOf"] as const;

/**
 * Substitute `{{var}}` placeholders in a template body. Whitespace inside the
 * braces is tolerated (`{{ date }}`). Unknown variables are left untouched.
 */
export function instantiateTemplate(body: string, vars: TemplateVars = {}): string {
  const map = buildTemplateVars(vars);
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(map, name) ? map[name] : whole);
}

/**
 * Derive a default note title from a template when the user doesn't supply one:
 * the template's name with date-ish variables filled, e.g.
 * "Weekly Review — {{weekOf}}" → "Weekly Review — 2026-07-13".
 */
export function defaultTitleFromTemplate(templateTitle: string, vars: TemplateVars = {}): string {
  return instantiateTemplate(templateTitle, vars).trim() || templateTitle;
}
