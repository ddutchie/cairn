import { describe, it, expect } from "vitest";
import { cleanTitle, isVagueMessage, titleRequest, titleUserPrompt, TITLE_MAX } from "./title";

describe("cleanTitle", () => {
  it("keeps the first line and strips labels, markdown, quotes and trailing punctuation", () => {
    expect(cleanTitle('Title: "Plan the garden beds."\nSure!')).toBe("Plan the garden beds");
    expect(cleanTitle("**Title:** Fix sync conflicts")).toBe("Fix sync conflicts");
    expect(cleanTitle("# “Quarterly planning”")).toBe("Quarterly planning");
    expect(cleanTitle("\n\n  Rename the project folder  \n")).toBe("Rename the project folder");
  });

  it("drops a leaked thinking block", () => {
    expect(cleanTitle("<think>they want a title</think>\nBoard cleanup")).toBe("Board cleanup");
  });

  it("caps long titles and rejects empty ones", () => {
    const long = cleanTitle("word ".repeat(40))!;
    expect(long.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(cleanTitle('  ""  ')).toBeUndefined();
    expect(cleanTitle("...")).toBeUndefined();
  });
});

describe("titleRequest", () => {
  it("asks once after the first reply, with the reply", () => {
    const prompt = titleRequest({ humanMessages: ["Help me plan the garden beds for spring"], firstReply: "Sure, here is a plan", autoTitles: 0 })!;
    expect(prompt).toContain("plan the garden beds");
    expect(prompt).toContain("<reply>");
    expect(titleRequest({ humanMessages: ["Help me plan the garden beds", "and the shed"], autoTitles: 1 })).toBeUndefined();
  });

  it("asks again after the second message when the first was vague", () => {
    expect(isVagueMessage("hi")).toBe(true);
    const again = titleRequest({ humanMessages: ["hi", "can you tidy my board for the garden project"], autoTitles: 1 })!;
    expect(again).toContain("tidy my board");
    expect(titleRequest({ humanMessages: ["hi", "x", "y"], autoTitles: 1 })).toBeUndefined();
  });

  it("never asks once a person has named the thread, or with nothing typed", () => {
    expect(titleRequest({ humanMessages: ["Help me plan the garden beds"], autoTitles: 0, userTitle: "Garden" })).toBeUndefined();
    expect(titleRequest({ humanMessages: [], autoTitles: 0 })).toBeUndefined();
  });

  it("trims long messages in the prompt", () => {
    expect(titleUserPrompt("a".repeat(5000)).length).toBeLessThan(1400);
  });
});
