import { chromium } from 'playwright';

const URL = 'http://localhost:5173/';
const SAMPLE = 'ASCII: abcdefghijklmnopqrstuvwxyz 0123456789\nSymbols: -> Σ ∀ ⟦ ⟧ | Hebrew: אבגד';

const measureScript = () => {
  const editor = document.querySelector('.ace_editor');
  const placeholder = document.querySelector('.ace_placeholder');
  const lines = [...document.querySelectorAll('.ace_line')].map((l) => l.textContent);
  const line = lines.join('') || 'X→ΣX';
  const style = editor ? getComputedStyle(editor) : null;
  const placeholderStyle = placeholder ? getComputedStyle(placeholder) : null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (style) ctx.font = style.font;

  const charWidths = [...line].map((ch) => ({ ch, w: ctx.measureText(ch).width }));

  const typehereFonts = [...document.fonts]
    .filter((f) => f.family.includes('Typehere'))
    .map((f) => `${f.family} ${f.status}`);

  const checks = {
    typehere16: document.fonts.check("16px 'Typehere Mono'"),
    jetbrains16: document.fonts.check("16px 'JetBrains Mono'"),
    berkeley16: document.fonts.check("16px 'Berkeley Mono'"),
    monospace16: document.fonts.check('16px monospace'),
  };

  return {
    fontFamily: style?.fontFamily ?? null,
    font: style?.font ?? null,
    placeholderFontFamily: placeholderStyle?.fontFamily ?? null,
    checks,
    typehereFonts,
    loadedWebFonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
    lines,
    lineText: line,
    charWidths,
    uniqueWidths: [...new Set(charWidths.map((c) => c.w.toFixed(2)))].length,
    widthStats: (() => {
      const ws = charWidths.map((c) => c.w);
      const min = Math.min(...ws);
      const max = Math.max(...ws);
      return { min, max, range: max - min, count: ws.length };
    })(),
  };
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(URL, { waitUntil: 'networkidle' });

// Focus editor and inject sample text via Ace API
await page.click('.ace_content', { force: true });
await page.evaluate((text) => {
  const aceEl = document.querySelector('.ace_editor');
  const ace = window.ace?.edit?.(aceEl) ?? aceEl?.env?.editor;
  if (ace?.setValue) {
    ace.setValue(text, -1);
    ace.focus();
  }
}, SAMPLE);

await page.waitForTimeout(500);

const results = await page.evaluate(measureScript);

await page.screenshot({
  path: 'assets/font-measure-playwright.png',
  fullPage: false,
});

// Also screenshot just the editor area
const editorBox = await page.locator('.ace_editor').boundingBox();
if (editorBox) {
  await page.screenshot({
    path: 'assets/font-measure-editor.png',
    clip: editorBox,
  });
}

console.log('=== WITH system Typehere Mono (default CSS) ===');
console.log(JSON.stringify(results, null, 2));

// Simulate missing Typehere Mono: force fallback stack only
await page.addStyleTag({
  content: `* { font-family: 'Berkeley Mono', 'JetBrains Mono', monospace !important; }`,
});
await page.waitForTimeout(800);
const fallbackResults = await page.evaluate(measureScript);
await page.screenshot({ path: 'assets/font-measure-no-typehere.png' });

console.log('\n=== WITHOUT Typehere Mono (forced fallback) ===');
console.log(JSON.stringify(fallbackResults, null, 2));

// Scenario 3: Typehere Mono named in CSS but unavailable, web fonts blocked
const contextBlocked = await browser.newContext();
await contextBlocked.route('**/*fonts.googleapis.com**', (route) => route.abort());
await contextBlocked.route('**/*gstatic.com**', (route) => route.abort());
const pageBlocked = await contextBlocked.newPage({ viewport: { width: 1280, height: 800 } });
await pageBlocked.goto(URL, { waitUntil: 'domcontentloaded' });
await pageBlocked.addStyleTag({
  content: `* { font-family: 'Typehere Mono', monospace !important; }`,
});
await pageBlocked.click('.ace_content', { force: true });
await pageBlocked.evaluate((text) => {
  const aceEl = document.querySelector('.ace_editor');
  const ace = window.ace?.edit?.(aceEl) ?? aceEl?.env?.editor;
  if (ace?.setValue) { ace.setValue(text, -1); ace.focus(); }
}, SAMPLE);
await pageBlocked.waitForTimeout(500);
const blockedResults = await pageBlocked.evaluate(measureScript);
await pageBlocked.screenshot({ path: 'assets/font-measure-blocked-webfonts.png' });
console.log('\n=== Typehere Mono name only, web fonts blocked ===');
console.log(JSON.stringify(blockedResults, null, 2));
await contextBlocked.close();
