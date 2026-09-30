import { test as base, expect } from 'playwright/test';
import { chromium } from './contained-playwright.cjs';
import guard from './network-guard.cjs';

// Preserve the runner's context/page fixtures; replace only its browser launcher.
export const test = base.extend({
  browser: [async ({ browserName, launchOptions, headless }, use) => {
    guard.assertActive();
    if (browserName !== 'chromium') {
      guard.poison('browser-engine-override-denied');
      throw new Error('Only contained Chromium is supported');
    }
    const browser = await chromium.launch({ ...launchOptions, headless });
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: 'worker' }]
});
export { expect };
