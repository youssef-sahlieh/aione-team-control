import { test, expect } from "@playwright/test";

// The @mention picker in comments and internal notes. Runs the real component in a served page and types like a person.
const PEOPLE = [
  { name: "Carmel Yacoub", email: "carmel@aione.biz" },
  { name: "Bashar Khalil", email: "bashar@aione.biz" },
  { name: "Ada Lovelace", email: "ada@aione.biz" }
];

async function mount(page, { delay = 0 } = {}) {
  await page.goto("/reset.html");
  await page.evaluate(async ({ people, delay }) => {
    document.body.innerHTML = "<textarea id=\"note\" rows=\"4\"></textarea>";
    const { createCommentMentions } = await import("/assets/components/comment-mentions.js");
    window.searches = [];
    const textarea = document.getElementById("note");
    window.picker = createCommentMentions({
      textarea,
      enabled: () => true,
      local: () => true,
      people: async () => { window.searches.push("people"); return people; },
      search: async () => []
    });
    window.delay = delay;
  }, { people: PEOPLE, delay });
}

const box = page => page.locator("#comment-mention-picker");

test("selecting a user closes the picker, and typing on does not search again", async ({ page }) => {
  await mount(page);
  const note = page.locator("#note");
  await note.click();
  await page.keyboard.type("@Car");
  await expect(box(page)).toBeVisible();
  await page.getByRole("option", { name: "Carmel Yacoub" }).click();
  await expect(box(page)).toBeHidden();
  await expect(note).toHaveValue("@Carmel Yacoub ");
  const before = await page.evaluate(() => window.searches.length);
  await page.keyboard.type("is this done? can we");
  await expect(box(page)).toBeHidden();
  await expect(page.getByText("No matching people")).toHaveCount(0);
  expect(await page.evaluate(() => window.searches.length)).toBe(before);
  expect(await page.evaluate(() => window.picker.mentioned())).toEqual(["carmel@aione.biz"]);
  expect(await page.evaluate(() => window.picker.text())).toBe("@Carmel Yacoub is this done? can we");
});

test("a second @mention opens the picker again, and both people are kept", async ({ page }) => {
  await mount(page);
  const note = page.locator("#note");
  await note.click();
  await page.keyboard.type("@Carmel");
  await page.getByRole("option", { name: "Carmel Yacoub" }).click();
  await expect(box(page)).toBeHidden();
  await page.keyboard.type("can you check this with @Bas");
  await page.getByRole("option", { name: "Bashar Khalil" }).click();
  await expect(box(page)).toBeHidden();
  await page.keyboard.type("?");
  await expect(note).toHaveValue("@Carmel Yacoub can you check this with @Bashar Khalil ?");
  expect(await page.evaluate(() => window.picker.mentioned())).toEqual(["carmel@aione.biz", "bashar@aione.biz"]);
});

test("the keyboard completes a mention with Enter and Escape closes the picker", async ({ page }) => {
  await mount(page);
  const note = page.locator("#note");
  await note.click();
  await page.keyboard.type("@Ada");
  await expect(box(page)).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(box(page)).toBeHidden();
  await expect(note).toHaveValue("@Ada Lovelace ");
  await page.keyboard.type("@Ca");
  await expect(box(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(box(page)).toBeHidden();
});

test("moving the cursor into a finished mention does not reopen the picker", async ({ page }) => {
  await mount(page);
  const note = page.locator("#note");
  await note.click();
  await page.keyboard.type("@Carmel");
  // Wait for the search result before choosing it: Enter only picks a result that is on screen.
  await expect(page.getByRole("option", { name: "Carmel Yacoub" })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("ok");
  await expect(box(page)).toBeHidden();
  await note.click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await expect(box(page)).toBeHidden();
});

test("deleting part of a chosen name removes it from the mentions and searches again", async ({ page }) => {
  await mount(page);
  const note = page.locator("#note");
  await note.click();
  await page.keyboard.type("@Carmel Yacoub");
  await expect(page.getByRole("option", { name: "Carmel Yacoub" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(note).toHaveValue("@Carmel Yacoub ");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  expect(await page.evaluate(() => window.picker.mentioned())).toEqual([]);
  await page.keyboard.type("Yacoub");
  await expect(box(page)).toBeVisible();
});
