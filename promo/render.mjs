// Renders shturman-promo.html frame-by-frame into an MP4 (1920×1080).
//
//   node promo/render.mjs                      → promo/out/shturman-promo.mp4
//   node promo/render.mjs --stills 3,8,12.5    → promo/out/still-<t>.png
//   node promo/render.mjs --fps 30 --audio promo/out/music.wav
//
// Uses the globally installed Playwright (falls back to a local one).
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(join(execSync('npm root -g').toString().trim(), 'playwright'));
}

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const fps = Number(opt('fps', 30));
const outDir = resolve(here, 'out');
mkdirSync(outDir, { recursive: true });
const audio = opt('audio', join(outDir, 'music.wav'));
const out = resolve(opt('out', join(outDir, 'shturman-promo.mp4')));
const stills = opt('stills', null);

const executablePath = undefined; // Playwright finds the pre-installed Chromium via PLAYWRIGHT_BROWSERS_PATH
const browser = await playwright.chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, 'shturman-promo.html')).href);
await page.evaluate(() => document.fonts.ready);
const stage = await page.$('#stage');
const duration = await page.evaluate(() => window.DURATION);

if (stills) {
  for (const t of stills.split(',').map(Number)) {
    await page.evaluate((tt) => window.seek(tt), t);
    const file = join(outDir, `still-${t}.png`);
    await stage.screenshot({ path: file });
    console.log(file);
  }
  await browser.close();
  process.exit(0);
}

const total = Math.round(duration * fps);
const workers = Number(opt('workers', 3));
const framesDir = join(outDir, 'frames');
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });
await page.close();

// Each worker gets its own page and renders an interleaved slice of frames.
const started = Date.now();
let rendered = 0;
await Promise.all(
  Array.from({ length: workers }, async (_, w) => {
    const pg = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await pg.goto(pathToFileURL(join(here, 'shturman-promo.html')).href);
    await pg.evaluate(() => document.fonts.ready);
    for (let f = w; f < total; f += workers) {
      await pg.evaluate((tt) => window.seek(tt), f / fps);
      await pg.screenshot({ path: join(framesDir, `f${String(f).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 95 });
      if (++rendered % (fps * 5) === 0) console.log(`frames ${rendered}/${total} · ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
    await pg.close();
  }),
);
await browser.close();

const ffArgs = ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(fps), '-i', join(framesDir, 'f%05d.jpg')];
if (existsSync(audio)) ffArgs.push('-i', audio, '-c:a', 'aac', '-b:a', '192k', '-shortest');
ffArgs.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-tune', 'animation', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
const ff = spawn('ffmpeg', ffArgs, { stdio: 'inherit' });
await new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));
console.log(`wrote ${out}`);
