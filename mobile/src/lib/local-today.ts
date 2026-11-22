import { buildRhythm } from "@cairn/shared/people/rhythm";
import { buildLocalToday, localDay, localDayBounds, type LocalToday } from "@cairn/shared/today/local";
import { listMeetingsBetween, listOpenDueTasks } from "@/db/queries";
import { loadPeople } from "@/db/people";

/** The phone's Today as of `now`, from synced data only. Cheap and synchronous (SQLite on the JS thread). */
export function loadLocalToday(now: number = Date.now()): LocalToday {
  const { start, end } = localDayBounds(now);
  const tasks = listOpenDueTasks(localDay(now)).map((t) => ({
    id: t.id, title: t.title, dueDate: t.due_date, projectName: t.project_name ?? undefined, priority: t.priority,
  }));
  const meetings = listMeetingsBetween(start, end).map((m) => ({ id: m.id, title: m.title, startsAt: m.starts_at, endsAt: m.ends_at }));
  let peopleDue: LocalToday["peopleDue"] = [];
  try {
    peopleDue = buildRhythm(loadPeople(), new Date(now)).rows
      .filter((r) => r.state === "overdue")
      .map((r) => ({ id: r.person.id, name: r.person.name, daysOver: r.daysOver }));
  } catch {
    // People tables may not be ready; Today still shows tasks and meetings.
  }
  return buildLocalToday({ tasks, meetings, peopleDue }, now);
}
