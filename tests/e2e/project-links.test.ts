/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Project links on the Overview: add by pasting a URL (kind and ref are detected),
 * edit, and remove. Runs against the dev server with the IPC layer mocked.
 */
import { test, expect, type Page } from "@playwright/test";
import { buildIpcMock } from "../fixtures/ipc-mock";

const STORE_ATTACH = `
  Object.defineProperty(window, '__cairnStore', {
    get() { return window.__cairnStoreRef; },
    set(v) { window.__cairnStoreRef = v; },
    configurable: true,
  });
`;

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await page.addInitScript({ content: buildIpcMock() });
  await page.addInitScript({ content: STORE_ATTACH });
  await page.goto("/");
  await page.waitForSelector("[data-testid='sidebar'], nav, aside", { timeout: 20_000 });
  const skip = page.getByRole("button", { name: "Skip all" });
  await skip.waitFor({ timeout: 5_000 }).then(() => skip.click()).catch(() => {});
  await page.evaluate(() => (window as any).__cairnStore?.getState?.()?.setView?.("overview"));
  await page.getByRole("heading", { name: "Links" }).waitFor({ timeout: 10_000 });
});

test.afterAll(async () => { await page.close(); });

test("shows an empty state, then adds a Confluence space with its key detected", async () => {
  await expect(page.getByText("No links yet")).toBeVisible();

  const input = page.getByLabel("Add a link");
  await input.fill("https://acme.atlassian.net/wiki/spaces/ENG/overview");
  await expect(page.getByText("Confluence, ENG")).toBeVisible(); // live detection hint
  await page.getByRole("button", { name: "Add link" }).click();

  await expect(page.getByText("Confluence space ENG")).toBeVisible();
  await expect(page.getByText("No links yet")).toHaveCount(0);
  await expect(input).toHaveValue("");
});

test("adds a Slack channel, edits its label and note, and persists to the store", async () => {
  await page.getByLabel("Add a link").fill("https://acme.slack.com/archives/C0123ABC");
  await page.getByRole("button", { name: "Add link" }).click();
  await expect(page.getByText("Slack channel C0123ABC")).toBeVisible();

  await page.getByRole("button", { name: "Edit link" }).nth(1).click();
  await page.getByLabel("Label").fill("#proj-alerts");
  await page.getByLabel("What it is for").fill("on-call channel");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText("#proj-alerts")).toBeVisible();
  await expect(page.getByText("on-call channel")).toBeVisible();

  const links = await page.evaluate(() => {
    const s = (window as any).__cairnStore.getState();
    return s.projects.find((p: any) => p.id === s.activeProjectId)?.links;
  });
  expect(links).toHaveLength(2);
  expect(links[1]).toMatchObject({ kind: "slack", ref: "C0123ABC", label: "#proj-alerts", note: "on-call channel" });
});

test("refuses text that is not a web address", async () => {
  await page.getByLabel("Add a link").fill("javascript:alert(1)");
  await page.getByRole("button", { name: "Add link" }).click();
  await expect(page.getByText("Not a web address")).toBeVisible();
  await page.getByLabel("Add a link").fill("");
});

test("removes a link", async () => {
  await page.getByRole("button", { name: "Remove link" }).first().click();
  await expect(page.getByText("Confluence space ENG")).toHaveCount(0);
  await expect(page.getByText("#proj-alerts")).toBeVisible();
});
