import { chromium } from 'playwright';

const URL = 'http://localhost:5173/';
const CHAR = '\u27E6'; // ⟦

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);

await page.click('.ace_content', { force: true });
await page.evaluate((ch) => {
  const aceEl = document.querySelector('.ace_editor');
  const ace = window.ace?.edit?.(aceEl) ?? aceEl?.env?.editor;
  if (ace?.setValue) {
    ace.setValue(ch, -1);
    ace.focus();
  }
}, CHAR);

await page.waitForTimeout(300);

const results = await page.evaluate((ch) => {
  const editor = document.querySelector('.ace_editor');
  const style = getComputedStyle(editor);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = style.font;
  const wBracket = ctx.measureText(ch).width;
  const wX = ctx.measureText('X').width;
  const cursor = document.querySelector('.ace_cursor');
  const cursorBox = cursor?.getBoundingClientRect();
  const line = document.querySelector('.ace_line');
  const lineBox = line?.getBoundingClientRect();
  return {
    fontFamily: style.fontFamily,
    font: style.font,
    checks: {
      typehere16: document.fonts.check("16px 'Typehere Mono'"),
      jetbrains16: document.fonts.check("16px 'JetBrains Mono'"),
    },
    measureText: { bracket: wBracket, X: wX, ratio: wBracket / wX },
    isMonospace: Math.abs(wBracket - wX) < 0.01,
    lineText: line?.textContent,
    cursor: cursorBox ? { left: cursorBox.left, top: cursorBox.top, width: cursorBox.width, height: cursorBox.height } : null,
    line: lineBox ? { left: lineBox.left, width: lineBox.width } : null,
  };
}, CHAR);

await page.screenshot({ path: 'assets/font-bracket-only.png' });
console.log(JSON.stringify(results, null, 2));
await browser.close();
