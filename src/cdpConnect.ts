import { chromium, selectors, Browser } from 'playwright-core';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function getChromeExecutablePath(): string | undefined {
  if (process.platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
  } else if (process.platform === 'darwin') {
    const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(macPath)) return macPath;
  } else {
    const linuxPaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ];
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

export async function launchChrome(endpoint: string = 'http://localhost:9222'): Promise<boolean> {
  const chromePath = getChromeExecutablePath();
  if (!chromePath) {
    return false;
  }

  const portMatch = endpoint.match(/:(\d+)/);
  const port = portMatch ? portMatch[1] : '9222';
  const userDataDir = path.join(os.tmpdir(), 'chrome-pw-debug');

  const child = child_process.spawn(
    chromePath,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`],
    {
      detached: true,
      stdio: 'ignore',
    }
  );
  child.unref();

  // Poll until CDP is available (up to 5 seconds)
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const browser = await chromium.connectOverCDP(endpoint);
      await browser.close();
      return true;
    } catch (e) {}
  }

  return false;
}

async function getActivePage(context: any): Promise<any> {
  const pages = context.pages();
  if (pages.length === 0) {
    return await context.newPage();
  }
  if (pages.length === 1) {
    return pages[0];
  }

  // Filter non-internal pages first (excluding about:blank, chrome://, etc.)
  const realPages = pages.filter((page: any) => {
    const url = page.url();
    return (
      url &&
      !url.startsWith('about:') &&
      !url.startsWith('chrome:') &&
      !url.startsWith('devtools:') &&
      !url.startsWith('edge:')
    );
  });

  const pool = realPages.length > 0 ? realPages : pages;

  // 1. Check for tab that is focused and visible in Chrome
  for (const page of pool) {
    try {
      const isFocused = await page.evaluate(
        () => document.visibilityState === 'visible' && document.hasFocus()
      );
      if (isFocused) return page;
    } catch (e) {}
  }

  // 2. Check for tab that is visible
  for (const page of pool) {
    try {
      const isVisible = await page.evaluate(() => document.visibilityState === 'visible');
      if (isVisible) return page;
    } catch (e) {}
  }

  // 3. Fallback to the last page in pool
  return pool[pool.length - 1];
}

export function applyPlaywrightConfig(targetFilePath?: string): void {
  if (!targetFilePath) return;
  try {
    let currentDir = path.dirname(targetFilePath);
    let configPath: string | undefined;

    while (currentDir && currentDir !== path.dirname(currentDir)) {
      const candidateTs = path.join(currentDir, 'playwright.config.ts');
      const candidateJs = path.join(currentDir, 'playwright.config.js');
      if (fs.existsSync(candidateTs)) { configPath = candidateTs; break; }
      if (fs.existsSync(candidateJs)) { configPath = candidateJs; break; }
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }

    if (!configPath) return;

    const content = fs.readFileSync(configPath, 'utf-8');
    const testIdMatch = content.match(/testIdAttribute\s*:\s*["']([^"']+)["']/);
    if (testIdMatch && testIdMatch[1]) {
      selectors.setTestIdAttribute(testIdMatch[1]);
    }
  } catch (e) {
    console.error('[PW-DEBUG] Error setting testIdAttribute from config:', e);
  }
}

export async function getFixtureBindings(
  required: string[],
  endpoint: string = 'http://localhost:9222',
  targetFilePath?: string
): Promise<Record<string, any>> {
  applyPlaywrightConfig(targetFilePath);

  let browser: Browser;

  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (err: any) {
    // Attempt auto-launching Chrome if initial connection failed
    const launched = await launchChrome(endpoint);
    if (launched) {
      try {
        browser = await chromium.connectOverCDP(endpoint);
      } catch (retryErr: any) {
        throw new Error(
          `Auto-launched Chrome, but could not connect to CDP on ${endpoint}.\n` +
          `Original error: ${retryErr?.message || retryErr}`
        );
      }
    } else {
      throw new Error(
        `Could not connect to Chrome on ${endpoint}.\n` +
        `Failed to auto-launch Chrome. Please ensure Chrome is installed or start it manually with:\n` +
        `  chrome.exe --remote-debugging-port=9222\n\n` +
        `Original error: ${err?.message || err}`
      );
    }
  }

  const contexts = browser.contexts();
  let context = contexts.length > 0 ? contexts[0] : null;

  if (!context) {
    context = await browser.newContext();
  }

  const bindings: Record<string, any> = {};

  const effectiveRequired = required && required.length > 0 ? required : ['page'];

  for (const fixture of effectiveRequired) {
    switch (fixture) {
      case 'browser':
        bindings.browser = browser;
        break;

      case 'context':
        bindings.context = context;
        break;

      case 'page': {
        bindings.page = await getActivePage(context);
        break;
      }

      case 'request':
        bindings.request = context.request;
        break;

      default:
        throw new Error(`Unsupported fixture requested: '${fixture}'`);
    }
  }

  return bindings;
}
