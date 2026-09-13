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
