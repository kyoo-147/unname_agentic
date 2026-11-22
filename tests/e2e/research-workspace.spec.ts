import { test, expect } from '@playwright/test';

test('research desk keeps local papers, exact evidence, notes and citation inspection through reload', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('mirror.locale', 'en');
    if (!sessionStorage.getItem('research-workspace-test-started')) {
      localStorage.removeItem('mirror.research-workspace.v1');
      sessionStorage.setItem('research-workspace-test-started', '1');
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Research desk/ }).click();
  await expect(page.getByRole('heading', { name: 'Research desk' })).toBeVisible();

  await page.getByLabel('Title').first().fill('Offline evidence study');
  await page.getByLabel('Authors').fill('A. Researcher');
  await page.getByLabel('Year').first().fill('2026');
  await page.getByRole('button', { name: 'Add paper locally' }).click();
  await expect(page.getByText('Offline evidence study')).toHaveCount(3);

  await page.getByLabel('Block id').fill('p1-r1');
  await page.getByLabel('Page').first().fill('1');
  await page.locator('input[name=section]').fill('Results');
  await page.locator('textarea[name=text][required]').fill('The method uses a local dataset and reports accuracy.');
  await page.getByRole('button', { name: 'Attach exact block' }).click();
  await expect(page.getByText('Attached exact evidence p1-r1 on page 1.')).toBeVisible();

  await page.getByRole('tab', { name: /Compare/ }).click();
  await expect(page.getByText('SUPPORTED').first()).toBeVisible();
  await expect(page.getByText('The method uses a local dataset and reports accuracy.').first()).toBeVisible();

  await page.getByRole('tab', { name: /Notes/ }).click();
  await page.locator('form[data-add-note] input[name=page]').fill('1');
  await page.locator('form[data-add-note] input[name=blockId]').fill('p1-r1');
  await page.getByLabel('Exact quote').fill('The method uses a local dataset and reports accuracy.');
  await page.getByLabel('Note text').fill('Verify this result before writing the review.');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText('ANCHORED', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: /Citations/ }).click();
  await page.getByLabel('Answer text').fill('The paper reports a result [p1:r1].');
  await page.getByRole('button', { name: 'Inspect citations' }).click();
  await expect(page.getByText('p1:r1')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /Research desk/ }).click();
  await expect(page.getByText('Offline evidence study')).toHaveCount(2);
  await page.getByRole('tab', { name: /Notes/ }).click();
  await expect(page.getByText('Verify this result before writing the review.')).toBeVisible();
});
