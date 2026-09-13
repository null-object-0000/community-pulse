const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('design tokens load before component styles and are emitted by the build', () => {
  const template = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  const tokens = fs.readFileSync(path.join(root, 'web', 'token.css'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'web', 'styles.css'), 'utf8');

  assert.ok(template.indexOf('/token.css') < template.indexOf('/styles.css'));
  assert.match(tokens, /:root\s*\{/);
  assert.match(tokens, /:root\[data-theme="dark"\]\s*\{/);
  for (const group of ['Typography', 'Spacing', 'Shape', 'Layout', 'Motion', 'Light theme', 'Elevation']) {
    assert.ok(tokens.includes(`/* ${group} */`), `missing ${group} token group`);
  }
  assert.doesNotMatch(styles, /:root\s*\{[^}]*--color-canvas/);

  const build = fs.readFileSync(path.join(root, 'scripts', 'build-site.js'), 'utf8');
  assert.match(build, /staticFiles = \['token\.css', 'styles\.css'/);
});

test('every custom property consumed by component CSS is declared in the token or component layer', () => {
  const css = ['token.css', 'styles.css'].map(name => fs.readFileSync(path.join(root, 'web', name), 'utf8')).join('\n');
  const declarations = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
  const usages = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map(match => match[1]));
  assert.deepEqual([...usages].filter(name => !declarations.has(name)), []);
});

test('nothing paints text white on top of the accent fill (the dark theme accent is near-white)', () => {
  // `--color-accent` is a light colour in dark mode (#edede7 by default, and the blue/forest/violet
  // accents are pastels too), so white text on it is invisible. `--color-on-accent` exists for exactly
  // this pairing and is what .button.primary has always used.
  const css = fs.readFileSync(path.join(root, 'web', 'styles.css'), 'utf8');
  // `.chip.is-active` keeps white on the solid accent and instead swaps to a soft fill in dark mode,
  // so the white-on-light pairing never occurs. That override is asserted below, which is what makes
  // the exception safe rather than merely tolerated.
  const exempt = new Set(['.chip.is-active']);
  const offenders = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = rule[1].trim().split('\n').pop().trim();
    const body = rule[2];
    if (!/background:\s*var\(--accent\)/.test(body)) continue;
    if (exempt.has(selector)) continue;
    const color = body.match(/(?:^|;)\s*color:\s*([^;]+)/);
    if (!color) continue;
    const value = color[1].trim();
    if (value !== 'var(--color-on-accent)') offenders.push(`${selector} → color: ${value}`);
  }
  assert.deepEqual(offenders, [], `use var(--color-on-accent) on the accent fill: ${offenders.join(' | ')}`);
  // The exemption above is only valid while dark mode really does replace the fill.
  assert.match(css, /:root\[data-theme="dark"\] \.chip\.is-active \{ background: var\(--accent-soft\)/,
    'the chip exemption requires its dark-mode soft fill');
});
