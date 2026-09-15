#!/usr/bin/env node
async function main() {
  const originArg = process.argv.find((arg) => arg.startsWith('--origin='));
  const origin = (originArg?.slice('--origin='.length) || 'https://devtrends.site').replace(/\/$/, '');
  const query = process.argv.find((arg) => arg.startsWith('?')) || '?';
  const response = await fetch(`${origin}/api/v1/trends${query}`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`trend API returned ${response.status}: ${await response.text()}`);
  console.log(JSON.stringify(await response.json(), null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
