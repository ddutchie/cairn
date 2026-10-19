import { Platform } from "react-native";
import { formatDate, getDueDateStatus } from "@cairn/shared/format/date";
import { getActiveSourceName } from "@/db";
import { getProjectOverview, getWorkspaceProgress, listDueTasks, listProjects } from "@/db/queries";
import { summarizeProject } from "@/components/overview/project-summary";
import { applyAccentToTheme, darkTheme, getAccentId, lightTheme, type Theme } from "@/theme";
import type { ProgressWidgetProps, WidgetCard, WidgetColors } from "./progress-widget";

const WORKSPACE_KEY = "workspace";

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

/** The "needs attention" counts + footer shared by the workspace and project cards. */
function attention(openDueDates: (string | null | undefined)[]): { overdue: number; dueToday: number } {
  let overdue = 0;
  let dueToday = 0;
  for (const d of openDueDates) {
    const s = getDueDateStatus(d);
    if (s === "overdue") overdue += 1;
    else if (s === "today") dueToday += 1;
  }
  return { overdue, dueToday };
}

function workspaceCard(): WidgetCard {
  const p = getWorkspaceProgress();
  const { overdue, dueToday } = attention(p.openDueDates);
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
    tasks: listDueTasks(8).map((t) => ({ id: t.id, title: t.title, overdue: getDueDateStatus(t.due_date) === "overdue" })),
    url: "cairn://projects",
  };
}

function projectCard(projectId: string): WidgetCard | null {
  const data = getProjectOverview(projectId);
  if (!data.project) return null;
  const { metrics } = summarizeProject(data);
  const dated = metrics.openCards.filter((c) => c.dueDate);
  const { overdue, dueToday } = attention(dated.map((c) => c.dueDate));
  const due = dated
    .filter((c) => getDueDateStatus(c.dueDate) !== "upcoming")
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
    tasks: due.map((c) => ({ id: c.id, title: c.title, overdue: getDueDateStatus(c.dueDate) === "overdue" })),
    url: `cairn://project/${projectId}`,
  };
}

/**
 * Push the active workspace's progress to the home-screen widgets: one card for
 * the whole workspace plus one per project (the Project widget's picker chooses
 * which to show), and the picker's option list. iOS only for now; never throws
 * (a widget miss must not break the app).
 */
export function refreshWidgets(): void {
  if (Platform.OS !== "ios") return;
  try {
    // Imported lazily: expo-widgets has no native module in Expo Go / on Android.
    const { workspaceWidget, projectWidget } = require("./progress-widget") as typeof import("./progress-widget");
    const { captureWidget } = require("./capture-widget") as typeof import("./capture-widget");
    const cards: Record<string, WidgetCard> = { [WORKSPACE_KEY]: workspaceCard() };
    const projects = listProjects();
    for (const p of projects) {
      const card = projectCard(p.id);
      if (card) cards[p.id] = card;
    }
    const accent = getAccentId();
    const props: ProgressWidgetProps = {
      cards,
      light: colors(applyAccentToTheme(lightTheme, accent, true)),
      dark: colors(applyAccentToTheme(darkTheme, accent, false)),
    };
    const lightTheme_ = applyAccentToTheme(lightTheme, accent, true);
    const darkTheme_ = applyAccentToTheme(darkTheme, accent, false);
    captureWidget.updateSnapshot({
      light: { accent: lightTheme_.accent, accentFg: lightTheme_.accentFg },
      dark: { accent: darkTheme_.accent, accentFg: darkTheme_.accentFg },
    });
    workspaceWidget.updateSnapshot(props);
    projectWidget.updateSnapshot(props);
    projectWidget.setConfigurationParameterEnum("project", [
      { name: "All projects", value: WORKSPACE_KEY },
      ...projects.map((p) => ({ name: p.name, value: p.id })),
    ]);
  } catch (e) {
    console.warn("[widgets] refresh failed:", e);
  }
}
