// CdpControl — drives one session's target over CDP. Collapses to a single
// canonical page so every reconnecting command drives the same target, and never
// calls bringToFront / activateTarget, so acting on a headless target never moves
// anything on screen. Mirrors the proven ~/.claude/browse connect-act-detach cycle.
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { ActionResult, BrowserCommand } from '../domain/types.js';

const ACTION_TIMEOUT_MS = 15_000;
const SHOT_SETTLE_MS = 200;

/** Drives a single already-running target over CDP. */
export interface BrowserControl {
  perform(cdpEndpoint: string, command: BrowserCommand): Promise<ActionResult>;
}

function isStray(pageUrl: string): boolean {
  return pageUrl.startsWith('chrome:') || pageUrl === 'about:blank' || pageUrl === '';
}

async function canonicalPage(context: BrowserContext): Promise<Page> {
  let pages = context.pages();
  if (pages.length === 0) {
    await context.newPage();
    pages = context.pages();
  }
  const chosen = pages.find((candidate) => !isStray(candidate.url())) ?? pages[0];
  for (const other of pages) {
    if (other !== chosen) await other.close().catch(() => { /* best effort */ });
  }
  return chosen;
}

async function safeTitle(page: Page): Promise<string> {
  try {
    return await page.title();
  } catch {
    return '';
  }
}

async function mutate(page: Page, command: BrowserCommand): Promise<void> {
  switch (command.kind) {
    case 'goto': await page.goto(command.href ?? 'about:blank', { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS }); return;
    case 'click': await page.click(command.selector ?? '', { timeout: ACTION_TIMEOUT_MS }); return;
    case 'type': await page.fill(command.selector ?? '', command.text ?? '', { timeout: ACTION_TIMEOUT_MS }); return;
    case 'press': await page.keyboard.press(command.text ?? 'Enter'); return;
    default: return;
  }
}

async function applyCommand(page: Page, command: BrowserCommand): Promise<ActionResult> {
  if (command.kind === 'text') {
    const text = await page.evaluate(() => document.body.innerText);
    return { success: true, pageUrl: page.url(), title: await safeTitle(page), text };
  }
  if (command.kind === 'eval') {
    const value = await page.evaluate(command.script ?? '');
    return { success: true, pageUrl: page.url(), title: await safeTitle(page), text: JSON.stringify(value) };
  }
  if (command.kind === 'shot') {
    await page.waitForTimeout(SHOT_SETTLE_MS);
    await page.screenshot({ path: command.shotPath });
    return { success: true, pageUrl: page.url(), title: await safeTitle(page), shotPath: command.shotPath };
  }
  await mutate(page, command);
  return { success: true, pageUrl: page.url(), title: await safeTitle(page) };
}

export class CdpControl implements BrowserControl {
  async perform(cdpEndpoint: string, command: BrowserCommand): Promise<ActionResult> {
    // noDefaults avoids Playwright's setDownloadBehavior call, which recent
    // Chrome rejects on a persistent debug context.
    const browser = await chromium.connectOverCDP(cdpEndpoint, { noDefaults: true });
    try {
      const page = await canonicalPage(browser.contexts()[0]);
      return await applyCommand(page, command);
    } catch (caught) {
      return { success: false, pageUrl: '', error: caught instanceof Error ? caught.message : String(caught) };
    } finally {
      // Detaches the CDP client only; the Chrome process stays alive for reuse.
      await browser.close();
    }
  }
}
