import { expect, type Page } from '@playwright/test';

/** Exercise the real recall control and wait for its grid animation before measuring/clicking. */
export async function openSidebar(page: Page): Promise<void> {
  const sidebar = page.locator('.sidebar');
  if (await sidebar.isHidden()) await page.getByTestId('sidebar-expand').click();
  await expect(sidebar).toBeVisible();
  await expect
    .poll(() => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
    .toBe(232);
}
