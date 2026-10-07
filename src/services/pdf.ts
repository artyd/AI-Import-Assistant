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

/**
 * Render a public page in headless Chromium and return its visible text — the
 * fallback for carrier tracking pages that are client-side apps (the plain HTML
 * fetch returns an empty shell). Only https URLs on the caller's allow-list ever
 * reach here (see services/hub/scrape.ts); images/fonts/media are blocked to
 * keep it light.
 */
export function renderPageText(url: string, timeoutMs = 25_000): Promise<string> {
  return slot(async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      );
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const t = req.resourceType();
        if (t === 'image' || t === 'font' || t === 'media') void req.abort();
        else void req.continue();
      });
      await withTimeout(
        page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs }).catch(() => undefined),
        timeoutMs + 2_000,
      );
      const text = await withTimeout(
        page.evaluate('document.body ? document.body.innerText : ""') as Promise<string>,
        5_000,
      );
      return (text ?? '').slice(0, 60_000);
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}
