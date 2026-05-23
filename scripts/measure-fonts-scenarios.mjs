import { chromium } from 'playwright';

const URL = 'http://localhost:5173/';
const SAMPLE = 'ASCII: abcdefghijklmnopqrstuvwxyz 0123456789\nSymbols: -> Σ ∀ ⟦ ⟧ | Hebrew: אבגד';

const measureScript = () => {
  const editor = document.querySelector('.ace_editor');
  const placeholder = document.querySelector('.ace_placeholder');
  const lines = [...document.querySelectorAll('.ace_line')].map((l) => l.textContent);
  const line = lines.join('') || placeholder?.textContent || 'X→ΣX';
  const style = editor ? getComputedStyle(editor) : null;
  const placeholderStyle = placeholder ? getComputedStyle(placeholder) : null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (style) ctx.font = style.font;
  const charWidths = [...line.replace(/\n/g, '')].map((ch) => ({ ch, w: ctx.measureText(ch).width }));
  return {
    fontFamily: style?.fontFamily ?? null,
    placeholderFontFamily: placeholderStyle?.fontFamily ?? null,
    placeholderFont: placeholderStyle?.font ?? null,
    checks: {
      typehere16: document.fonts.check("16px 'Typehere Mono'"),
      jetbrains16: document.fonts.check("16px 'JetBrains Mono'"),
    },
    loadedWebFonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
    uniqueWidths: [...new Set(charWidths.map((c) => c.w.toFixed(2)))].length,
    widthStats: (() => {
      const ws = charWidths.map((c) => c.w);
      return { min: Math.min(...ws), max: Math.max(...ws), range: Math.max(...ws) - Math.min(...ws), count: ws.length };
    })(),
    sampleCharWidths: charWidths.filter((c) => 'imMW1→Σ∀⟦'.includes(c.ch)).slice(0, 12),
  };
};

const browser = await chromium.launch();

async function runScenario(name, setup) {
  const context = await browser.newContext();
  const page = await context.newPage({ viewport: { width: 1280, height: 800 } });
  await setup(context, page);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  const empty = await page.evaluate(measureScript);
  await page.click('.ace_content', { force: true });
  await page.evaluate((text) => {
    const aceEl = document.querySelector('.ace_editor');
    const ace = window.ace?.edit?.(aceEl) ?? aceEl?.env?.editor;
    if (ace?.setValue) { ace.setValue(text, -1); ace.focus(); }
  }, SAMPLE);
  await page.waitForTimeout(300);
  const filled = await page.evaluate(measureScript);
  const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  await page.screenshot({ path: `assets/font-${slug}.png` });
  console.log(`\n=== ${name} (empty) ===`);
  console.log(JSON.stringify(empty, null, 2));
  console.log(`\n=== ${name} (filled) ===`);
  console.log(JSON.stringify(filled, null, 2));
  await context.close();
}

await runScenario('default-css', async () => {});
await runScenario('no-typehere-in-stack', async (_ctx, page) => {
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = `* { font-family: 'Berkeley Mono', 'JetBrains Mono', monospace !important; }`;
      document.head.appendChild(s);
    });
  });
});
await runScenario('typehere-name-only-blocked-webfonts', async (context) => {
  await context.route('**/*fonts.googleapis.com**', (r) => r.abort());
  await context.route('**/*gstatic.com**', (r) => r.abort());
  await context.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = `* { font-family: 'Typehere Mono', monospace !important; }`;
      document.head.appendChild(s);
    });
  });
});

await browser.close();
