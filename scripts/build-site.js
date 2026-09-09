const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, '知识', '大家都在做什么', 'raw');
const webDir = path.join(root, 'web');
const outputDir = path.join(root, 'dist');
const reportsDir = path.join(outputDir, 'data', 'reports');
const markdownDir = path.join(outputDir, 'data', 'markdown');
const finalDir = path.join(root, '知识', '大家都在做什么', 'final');

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(reportsDir, { recursive: true });
fs.mkdirSync(markdownDir, { recursive: true });

for (const name of ['index.html', 'styles.css', 'app.js']) {
  fs.copyFileSync(path.join(webDir, name), path.join(outputDir, name));
}

const dates = fs.readdirSync(sourceDir)
  .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
  .map((name) => name.slice(0, -5))
  .sort()
  .reverse();

for (const date of dates) {
  fs.copyFileSync(path.join(sourceDir, `${date}.json`), path.join(reportsDir, `${date}.json`));
  const enhancedMarkdown = path.join(finalDir, `${date}.md`);
  const rawMarkdown = path.join(sourceDir, `${date}.md`);
  const markdownSource = fs.existsSync(enhancedMarkdown) ? enhancedMarkdown : rawMarkdown;
  if (fs.existsSync(markdownSource)) {
    fs.copyFileSync(markdownSource, path.join(markdownDir, `${date}.md`));
  }
}

const latest = dates[0] || null;
fs.writeFileSync(
  path.join(outputDir, 'data', 'index.json'),
  `${JSON.stringify({ latest, dates, generatedAt: new Date().toISOString() }, null, 2)}\n`,
);

console.log(`Built ${dates.length} reports${latest ? `; latest is ${latest}` : ''}.`);
