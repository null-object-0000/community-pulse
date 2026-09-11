const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');
const { downloadImage, localizeReport } = require('../scripts/image-store.js');
const local = '/images/' + 'a'.repeat(64) + '.png';
const remote = 'https://example.org/logo.png';

test('managed image policy blocks external requests, unsafe paths and legacy favorite hotlinks', () => {
  assert.equal(D.localImage(remote, { [remote]: local }), local);
  assert.equal(D.localImage(local), local);
  for (const value of [remote, '//example.org/x', '/images/../x', 'data:image/png;base64,x', local + '?redirect=x']) {
    assert.equal(D.localImage(value), '');
    assert.ok(!D.renderItem({ title: 'Example', image: value }, 'en').includes('<img'));
  }
  assert.ok(D.renderItem({ title: 'Example', image: local }, 'en').includes(`src="${local}"`));
});

test('report images are localized across all fields and failures get a placeholder', () => {
  const report = { results: [{ items: [{ image: remote, logo: 'https://example.org/missing', icon: local }] }] };
  localizeReport(report, { [remote]: local, 'https://example.org/missing': null });
  assert.deepEqual(report.results[0].items[0], { image: local, logo: '', icon: local });
  assert.throws(() => localizeReport({ results: [{ items: [{ image: remote }] }] }, {}), /images:sync/);
});

test('download rejects error pages, oversized responses and HTTP failures', async () => {
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const result = await downloadImage(remote, async () => new Response(png));
  assert.equal(result.extension, 'png');
  assert.deepEqual(result.bytes, png);
  const svg = await downloadImage(remote, async () => new Response('\n<svg xmlns="http://www.w3.org/2000/svg"></svg>', { headers: { 'content-type': 'image/jpeg' } }));
  assert.equal(svg.extension, 'svg');
  await assert.rejects(downloadImage(remote, async () => new Response('<!DOCTYPE svg><svg></svg>')), /invalid image/);
  await assert.rejects(downloadImage(remote, async () => new Response('<html>error</html>')), /invalid image/);
  await assert.rejects(downloadImage(remote, async () => new Response('missing', { status: 404 })), /HTTP 404/);
  await assert.rejects(downloadImage(remote, async () => new Response(png, { headers: { 'content-length': 11 * 1024 * 1024 } })), /exceeds/);
  await assert.rejects(downloadImage(remote, async () => new Response(Buffer.alloc(10 * 1024 * 1024 + 1))), /exceeds/);
});

test('built reports only expose managed images backed by deployed files', () => {
  const directory = path.resolve(__dirname, '../dist');
  let count = 0;
  for (const file of fs.readdirSync(path.join(directory, 'data/reports'))) {
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'data/reports', file), 'utf8'));
    for (const item of D.reportItems(report)) for (const field of ['image', 'logo', 'icon']) {
      if (!item[field]) continue;
      assert.equal(D.localImage(item[field]), item[field]);
      assert.ok(fs.existsSync(path.join(directory, item[field])));
      count++;
    }
  }
  assert.ok(count > 0);
  assert.match(fs.readFileSync(path.join(directory, '_headers'), 'utf8'), /Content-Security-Policy: sandbox; default-src 'none'/);
});
