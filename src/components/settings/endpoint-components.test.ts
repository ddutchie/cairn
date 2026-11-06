import { describe, expect, it } from "vitest";
import { isLocalBaseUrl } from "./endpoint-components";

describe("isLocalBaseUrl", () => {
  it.each(["http://localhost:11434/v1", "http://127.0.0.1:8000/v1", "http://0.0.0.0:8000", "http://[::1]:8000/v1"])(
    "treats %s as local",
    (url) => expect(isLocalBaseUrl(url)).toBe(true),
  );

  it("leaves a cloud endpoint out", () => {
    expect(isLocalBaseUrl("https://api.openai.com/v1")).toBe(false);
  });
});
