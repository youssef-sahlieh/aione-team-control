import { test, expect } from "@playwright/test";

// A phone-sized dialog with a field near its bottom. Focusing the field must scroll the dialog's own box, never the page,
// because scrolling the page is what moved the dialog header on some iPhones when the keyboard opened.
test("focusing a field at the bottom of a phone dialog scrolls the dialog, not the page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.goto("/reset.html");
  await page.evaluate(async () => {
    document.body.innerHTML = "<div class=\"pop modal\" style=\"position:fixed\"><header id=\"hd\">Ticket header</header><div id=\"body\" style=\"overflow-y:auto;height:100%\">" + Array.from({ length: 40 }, (_, i) => "<p>Line " + i + "</p>").join("") + "<textarea id=\"note\" rows=\"3\"></textarea></div></div><div style=\"height:2000px\"></div>";
    await import("/assets/app/keyboard.js");
  });
  await page.locator("#note").focus();
  await page.waitForTimeout(450);
  const r = await page.evaluate(() => ({ scrollY: window.scrollY, headerTop: document.getElementById("hd").getBoundingClientRect().top, vvh: getComputedStyle(document.documentElement).getPropertyValue("--vvh") }));
  expect(r.scrollY).toBe(0);
  expect(r.headerTop).toBeGreaterThanOrEqual(0);
  expect(r.vvh.trim()).toMatch(/px$/);
});
