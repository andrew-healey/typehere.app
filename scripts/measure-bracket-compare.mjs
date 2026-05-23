import { chromium } from 'playwright';

const URL = 'http://localhost:5173/';
const CHAR = '\u27E6';
const FONT_URL = 'http://localhost:5173/TypehereMono-Regular.ttf';

const measure = () => {
  const editor = document.querySelector('.ace_editor');
  const style = getComputedStyle(editor);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = style.font;
  const bracket = ctx.measureText('\u27E6').width;
  const X = ctx.measureText('X').width;
  return {
    fontFamily: style.fontFamily,
    font: style.font,
    checks: {
      typehere_space: document.fonts.check("16px 'Typehere Mono'"),
      typehere_bracket: document.fonts.check("16px 'Typehere Mono'", '\u27E6'),
      typehere_X: document.fonts.check("16px 'Typehere Mono'", 'X'),
      jetbrains_bracket: document.fonts.check("16px 'JetBrains Mono'", '\u27E6'),
    },
    measureText: { bracket, X, ratio: bracket / X, diff: Math.abs(bracket - X) },
    isMonospace: Math.abs(bracket - X) < 0.01,
    loadedFamilies: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
  };
};

async function test(page, label, setup) {
  await setup?.(page);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await page.click('.ace_content', { force: true });
  await page.evaluate((ch) => {
    const aceEl = document.querySelector('.ace_editor');
    const ace = window.ace?.edit?.(aceEl) ?? aceEl?.env?.editor;
    ace?.setValue(ch, -1);
    ace?.focus();
  }, CHAR);
  await page.waitForTimeout(300);
  const result = await page.evaluate(measure);
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const nameOnly = await test(page, 'name-only (current CSS)', null);

await test(page, '@font-face (bundled TTF)', async (p) => {
  await p.addInitScript((fontUrl) => {
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = `
        @font-face {
          font-family: 'Typehere Mono Web';
          src: url('${fontUrl}') format('truetype');
          font-weight: normal;
          font-style: normal;
        }
        * { font-family: 'Typehere Mono Web', monospace !important; }
      `;
      document.head.appendChild(s);
    });
  }, FONT_URL);
});

await page.screenshot({ path: 'assets/font-bracket-compare.png' });
await browser.close();

console.log('\n=== SUMMARY ===');
console.log(`name-only monospace: ${nameOnly.isMonospace} (bracket=${nameOnly.measureText.bracket}, X=${nameOnly.measureText.X})`);
