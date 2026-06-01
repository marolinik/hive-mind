import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Visual + behavioral spec for the 6 wiki-web routes against the deterministic
 * fixture (5 entities, 4 relations, 6 ZephyrFixture frames, 6 wiki pages).
 * Each test asserts real seeded content AND saves a screenshot to
 * e2e/screenshots/ for review. Pairs with the browserless http-verify backbone.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name), fullPage: true });

test('home shows real health + wiki list', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('data_quality_score: 90')).toBeVisible();
  await expect(page.getByText('total_frames: 6')).toBeVisible();
  await expect(page.getByRole('link', { name: 'hive-mind' })).toBeVisible();
  await shot(page, '01-home.png');
});

test('search returns 6 seeded frames', async ({ page }) => {
  await page.goto('/search?q=ZephyrFixture');
  await expect(page.getByRole('heading', { name: /Frames/ })).toContainText('6');
  await expect(page.getByText(/ZephyrFixture:/).first()).toBeVisible();
  await shot(page, '02-search.png');
});

test('entity/1 resolves with relations (regression: was 404)', async ({ page }) => {
  const resp = await page.goto('/entity/1');
  expect(resp?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Hive Mind' })).toBeVisible();
  await expect(page.getByText('type: project')).toBeVisible();
  await expect(page.getByText('works_on')).toBeVisible();
  await shot(page, '03-entity.png');
});

test('entity/999999 returns 404', async ({ page }) => {
  const resp = await page.goto('/entity/999999');
  expect(resp?.status()).toBe(404);
});

test('frame/1 shows content', async ({ page }) => {
  await page.goto('/frame/1');
  await expect(page.getByText(/local-first AI memory system built on SQLite/)).toBeVisible();
  await shot(page, '04-frame.png');
});

test('graph renders nodes from the knowledge graph', async ({ page }) => {
  await page.goto('/graph');
  await expect(page.getByRole('heading', { name: 'Knowledge graph' })).toBeVisible();
  // vis-network draws into a <canvas>; wait for it to mount + stabilize.
  await expect(page.locator('#graph canvas')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await shot(page, '05-graph.png');
});

test('wiki/hive-mind shows article + source frames', async ({ page }) => {
  await page.goto('/wiki/hive-mind');
  await expect(page.getByRole('heading', { name: 'Hive Mind' })).toBeVisible();
  await expect(page.getByText(/source frames/i).first()).toBeVisible();
  await shot(page, '06-wiki.png');
});
