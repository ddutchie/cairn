import { describe, it, expect } from "vitest";
import { todayBriefTools, type TodayBriefSession } from "./today-tools";
import { emptyBrief } from "../../shared/today/brief-edit";

function upsertSchema(people: boolean): { properties: Record<string, { description?: string }> } {
  const session: TodayBriefSession = { brief: emptyBrief(new Date(2026, 10, 18, 8)), finished: false };
  const tool = todayBriefTools(session, () => null, people).find((t) => t.name === "today_upsert")!;
  const schema = JSON.parse(JSON.stringify(tool.parameters)) as { properties: { items: { items: { properties: Record<string, { description?: string }> } } } };
  return schema.properties.items.items;
}

describe("today_upsert schema", () => {
  it("offers attendees and seriesId, and asks for the calendar's event id, only when People is on", () => {
    const on = upsertSchema(true);
    expect(on.properties).toHaveProperty("attendees");
    expect(on.properties).toHaveProperty("seriesId");
    expect(on.properties.id.description).toContain("event id");
  });
  it("is the schema it always was when People is off (it is part of the cached prompt prefix)", () => {
    const off = upsertSchema(false);
    expect(off.properties).not.toHaveProperty("attendees");
    expect(off.properties).not.toHaveProperty("seriesId");
    expect(off.properties.id.description).not.toContain("event id");
  });
});
