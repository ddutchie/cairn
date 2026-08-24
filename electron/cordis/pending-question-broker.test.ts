import { describe, expect, it } from "vitest";
import { clearPendingQuestions, listPendingQuestions, recordPendingQuestion, registerPendingQuestion, resolvePendingQuestionAnswer } from "./pending-question-broker";

describe("session question broker", () => {
  it("routes answers by session id and call id and retains recovery metadata", () => {
    const answers: string[] = [];
    recordPendingQuestion({ sessionId: "chat-a", callId: "call-1", questions: [{ id: "q", prompt: "?" }] });
    const dispose = registerPendingQuestion("chat-a", "call-1", (value) => answers.push(value));
    recordPendingQuestion({ sessionId: "chat-a", callId: "call-1", questions: [{ id: "q", prompt: "updated" }] });

    expect(resolvePendingQuestionAnswer("chat-b", "call-1", "wrong")).toBe(false);
    expect(resolvePendingQuestionAnswer("chat-a", "call-1", "right")).toBe(true);
    expect(answers).toEqual(["right"]);
    expect(listPendingQuestions("chat-a")).toEqual([]);
    dispose();
    clearPendingQuestions("chat-a");
  });
});
