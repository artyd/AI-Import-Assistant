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

export async function htmlToPdf(html: string, opts: { format?: 'A4'; margin?: string } = {}): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 20_000 });
    // Web fonts (Hanken Grotesk) must be in before printing, else a fallback face is baked in.
    // (string form: this runs in the page — no DOM types in the Node build)
    await page.evaluate('document.fonts.ready');
    const pdf = await page.pdf({
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
