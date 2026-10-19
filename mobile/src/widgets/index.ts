import { PixelRatio, Platform } from "react-native";
import { formatDate, getDueDateStatus } from "@cairn/shared/format/date";
import { getActiveSourceName } from "@/db";
import { getProjectOverview, getWorkspaceProgress, listDueTasks, listProjects } from "@/db/queries";
import { summarizeProject } from "@/components/overview/project-summary";
import { applyAccentToTheme, darkTheme, getAccentId, lightTheme, type Theme } from "@/theme";
import type { ProgressWidgetProps, WidgetCard, WidgetColors } from "./progress-widget";

const WORKSPACE_KEY = "workspace";

/** The subset of theme tokens the widget runtime needs. */
function colors(t: Theme): WidgetColors {
  return {
    surface: t.surface,
    accent: t.accent,
    textPrimary: t.textPrimary,
    textTertiary: t.textTertiary,
    warning: t.warning,
    danger: t.danger,
  };
}

/** Local `YYYY-MM-DD` for a timestamp (what SQLite's `date(?)` and the due-date helpers expect). */
function localDay(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Start of the local day after `now` — when the date-dependent counts roll over. */
function nextMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** The "needs attention" counts shared by the workspace and project cards, as of `now`. */
function attention(openDueDates: (string | null | undefined)[], now: number): { overdue: number; dueToday: number } {
  let overdue = 0;
  let dueToday = 0;
  for (const d of openDueDates) {
    const s = getDueDateStatus(d, now);
    if (s === "overdue") overdue += 1;
    else if (s === "today") dueToday += 1;
  }
  return { overdue, dueToday };
}

/** The whole-workspace card as of `now`. */
function workspaceCard(now: number): WidgetCard {
  const p = getWorkspaceProgress();
  const { overdue, dueToday } = attention(p.openDueDates, now);
  return {
    title: getActiveSourceName() ?? "Cairn",
    completion: p.completionRate,
    doneCards: p.doneCards,
    totalCards: p.totalCards,
    openCards: p.openCards,
    overdue,
    dueToday,
    footerLeft: `${p.projectCount} ${p.projectCount === 1 ? "project" : "projects"} · ${p.totalNotes} ${p.totalNotes === 1 ? "note" : "notes"}`,
    footerRight: p.totalCards === 0 ? "No tasks yet" : overdue + dueToday > 0 ? `${overdue} overdue · ${dueToday} today` : "All caught up",
    tasks: listDueTasks(8, localDay(now)).map((t) => ({ id: t.id, title: t.title, overdue: getDueDateStatus(t.due_date, now) === "overdue" })),
    url: "cairn://projects",
  };
}

/** One project's card as of `now`, or null when the project no longer exists. */
function projectCard(projectId: string, now: number): WidgetCard | null {
  const data = getProjectOverview(projectId);
  if (!data.project) return null;
  const { metrics } = summarizeProject(data);
  const dated = metrics.openCards.filter((c) => c.dueDate);
  const { overdue, dueToday } = attention(dated.map((c) => c.dueDate), now);
  const due = dated
    .filter((c) => getDueDateStatus(c.dueDate, now) !== "upcoming")
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
    .slice(0, 8);
  const { project } = data;
  return {
    title: project.name,
    completion: metrics.completionRate,
    doneCards: metrics.doneCards.length,
    totalCards: metrics.allCards.length,
    openCards: metrics.openCards.length,
    overdue,
    dueToday,
    footerLeft: project.created_at ? `Started ${formatDate(project.created_at)}` : "",
    footerRight: project.due_date ? `Target ${formatDate(project.due_date)}` : "No target date",
    tasks: due.map((c) => ({ id: c.id, title: c.title, overdue: getDueDateStatus(c.dueDate, now) === "overdue" })),
    url: `cairn://project/${projectId}`,
  };
}

/**
 * Push the active workspace's progress to the home-screen widgets: one card for
 * the whole workspace plus one per project (the Project widget's picker chooses
 * which to show), and the picker's option list. The date-dependent counts
 * (due today / overdue) are pre-computed for today and the next two days and
 * scheduled as a timeline, so the widgets roll over at midnight even if the app
 * stays closed. iOS only for now; never throws (a widget miss must not break
 * the app).
 */
export function refreshWidgets(): void {
  if (Platform.OS !== "ios") return;
  try {
    // Imported lazily: expo-widgets has no native module in Expo Go / on Android.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { workspaceWidget, projectWidget } = require("./progress-widget") as typeof import("./progress-widget");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { captureWidget } = require("./capture-widget") as typeof import("./capture-widget");
    const projects = listProjects();
    const accent = getAccentId();
    const light = applyAccentToTheme(lightTheme, accent, true);
    const dark = applyAccentToTheme(darkTheme, accent, false);
    // Follow the OS text size (widgets don't inherit it), capped so the small size still fits.
    const fontScale = Math.min(1.3, Math.max(1, PixelRatio.getFontScale()));

    const now = Date.now();
    const entries: { date: Date; props: ProgressWidgetProps }[] = [];
    for (let i = 0; i < 3; i++) {
      const at = i === 0 ? now : nextMidnight(entries.length ? entries[entries.length - 1].date.getTime() : now);
      const cards: Record<string, WidgetCard> = { [WORKSPACE_KEY]: workspaceCard(at) };
      for (const p of projects) {
        const card = projectCard(p.id, at);
        if (card) cards[p.id] = card;
      }
      entries.push({ date: new Date(at), props: { cards, fontScale, light: colors(light), dark: colors(dark) } });
    }
    workspaceWidget.updateTimeline(entries);
    projectWidget.updateTimeline(entries);
    projectWidget.setConfigurationParameterEnum("project", [
      { name: "All projects", value: WORKSPACE_KEY },
      ...projects.map((p) => ({ name: p.name, value: p.id })),
    ]);
    captureWidget.updateSnapshot({
      fontScale,
      light: { accent: light.accent, accentFg: light.accentFg },
      dark: { accent: dark.accent, accentFg: dark.accentFg },
    });
  } catch (e) {
    console.warn("[widgets] refresh failed:", e);
  }
}
