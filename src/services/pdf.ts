import puppeteer, { type Browser } from 'puppeteer-core';
import { config } from '../config.js';

/**
 * HTML → PDF via the system Chromium (installed in the Docker image; path from
 * CHROMIUM_PATH). One browser is reused across requests and relaunched if it
 * dies; each render gets its own page. Shared by the management report and the
 * supplier-instruction PDF.
 */
let browserP: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserP) {
    browserP = puppeteer
      .launch({
        executablePath: config.CHROMIUM_PATH,
        headless: true,
        // Container-friendly: no setuid sandbox, /dev/shm is tiny in Docker.
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
      })
      .then((b) => {
        b.on('disconnected', () => {
          browserP = null;
        });
        return b;
      })
      .catch((err) => {
        browserP = null;
        throw err;
      });
  }
  return browserP;
}

// At most this many pages render at once on the shared browser.
const MAX_CONCURRENT = 2;
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// Our templates need nothing but the web font; everything else is blocked so
// injected markup can't reach the network (SSRF to internal services).
const ALLOWED = /^(data:|about:blank|https:\/\/fonts\.(googleapis|gstatic)\.com\/)/;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);

export function htmlToPdf(html: string, opts: { format?: 'A4'; margin?: string } = {}): Promise<Buffer> {
  return slot(() => render(html, opts));
}

async function render(html: string, opts: { format?: 'A4'; margin?: string }): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setJavaScriptEnabled(false); // templates are static HTML
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (ALLOWED.test(r.url())) void r.continue();
      else void r.abort();
    });
    // Wait for the stylesheet + font, but bounded: without internet in the
    // container the page prints with the fallback face instead of failing.
    await page.setContent(html, { waitUntil: 'load', timeout: 10_000 }).catch(async (err: Error) => {
      if (!/timeout/i.test(err.message)) throw err;
    });
    // (string form: evaluated in the page — no DOM types in the Node build)
    await withTimeout(page.evaluate('document.fonts.ready'), 4_000);
    const pdf = await page.pdf({
      timeout: 20_000,
      format: opts.format ?? 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: opts.margin ? { top: opts.margin, right: opts.margin, bottom: opts.margin, left: opts.margin } : undefined,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}
