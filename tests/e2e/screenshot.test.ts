import { test, expect } from "@playwright/test";
import { buildIpcMock } from "../fixtures/ipc-mock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(buildIpcMock());
  await page.goto("http://localhost:3000");
  await page.waitForTimeout(2000); // Give it time
});

test("screenshot the chat input", async ({ page, context }) => {
  // Start video recording programmatically is tough in test runner, but playwright captures it if configured
  // We can just take screenshots here to verify.
  await page.waitForTimeout(1000);

  // Find central chat input
  const input = page.getByPlaceholder("What would you like to do today?");
  await input.fill('create a task called "buy milk"');
  await page.waitForTimeout(1000);

  // Submit
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);

  // The stream is loading now...
  await page.evaluate(() => {
    const store = window.useCairnStore?.getState();
    if (store) {
       const threads = store.chatThreads;
       const tid = threads[0]?.id || "t-1";
       // Let's add another message from the assistant containing the UI components
       store.addMessage(tid, "assistant", "I've created the task for you.", [
         { type: "task", id: "123", title: "buy milk", snippet: "Remember to get 2%" },
         { type: "note", id: "456", title: "shopping list" }
       ]);
    }
  });

  await page.waitForTimeout(1000);
  // Take screenshot of the result in the chat panel
  await page.screenshot({ path: "/home/jules/verification/screenshots/chat-panel-2.png" });
});
