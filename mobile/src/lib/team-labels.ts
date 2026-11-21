import type { TeamKind } from "@cairn/shared/types/people";

export const KIND_LABEL: Record<TeamKind, string> = { team: "Team", guild: "Guild", project: "Project", committee: "Committee" };

/** "1 person" / "3 people". */
export const peopleCount = (n: number): string => `${n} ${n === 1 ? "person" : "people"}`;
