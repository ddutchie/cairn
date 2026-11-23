import { describe, it, expect } from "vitest";
import { formatAnswers, parseQuestions } from "./questions";

describe("parseQuestions", () => {
  it("keeps well-formed questions and fills in missing ids and labels", () => {
    const r = parseQuestions([
      { id: "who", label: "Audience", prompt: "Who is this for?" },
      { prompt: "When is it due?" },
      { id: "who", label: "Again", prompt: "Same id" },
    ]);
    expect("questions" in r && r.questions).toEqual([
      { id: "who", label: "Audience", prompt: "Who is this for?" },
      { id: "q2", label: "When is it due?", prompt: "" },
      { id: "who_3", label: "Again", prompt: "Same id" },
    ]);
  });

  it("rejects an empty or unusable list", () => {
    expect(parseQuestions([])).toHaveProperty("error");
    expect(parseQuestions("nope")).toHaveProperty("error");
    expect(parseQuestions([{ id: "x" }])).toHaveProperty("error");
  });
});

describe("formatAnswers", () => {
  it("writes one bold-label line per question and marks blanks", () => {
    const qs = [{ id: "a", label: "Audience", prompt: "" }, { id: "b", label: "Deadline", prompt: "" }];
    expect(formatAnswers(qs, { a: " Designers " })).toBe("**Audience:** Designers\n**Deadline:** (no answer)");
  });

  it("treats inherited properties as unanswered", () => {
    const qs = [{ id: "constructor", label: "Name", prompt: "" }, { id: "b", label: "B", prompt: "" }];
    expect(formatAnswers(qs, { b: "yes" })).toBe("**Name:** (no answer)\n**B:** yes");
  });
});
