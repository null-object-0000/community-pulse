const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');
const { downloadImage, localizeReport, pruneManifest, itemUrls } = require('../scripts/image-store.js');
const local = '/images/' + 'a'.repeat(64) + '.png';
const local2 = '/images/' + 'b'.repeat(64) + '.png';
const remote = 'https://example.org/logo.png';
const vibe = 'https://akxlagkpqhwjrwrq.public.blob.vercel-storage.com/products/x/y.png';

test('managed image policy blocks external requests, unsafe paths and legacy favorite hotlinks', () => {
  assert.equal(D.localImage(remote, { [remote]: local }), local);
  assert.equal(D.localImage(local), local);
  for (const value of [remote, '//example.org/x', '/images/../x', 'data:image/png;base64,x', local + '?redirect=x']) {
    assert.equal(D.localImage(value), '');
    assert.ok(!D.renderItem({ title: 'Example', image: value }, 'en').includes('<img'));
  }
  assert.ok(D.renderItem({ title: 'Example', image: local }, 'en').includes(`src="${local}"`));
});

test('only trusted source CDNs may render an image that was not mirrored', () => {
  // Retention mirrors the newest report and lets the archive reference the origin again.
  assert.equal(D.hotlinkable(vibe), vibe);
  assert.equal(D.localImage(vibe), vibe);
  assert.equal(D.hotlinkable('https://ph-files.imgix.net/a/b.png'), 'https://ph-files.imgix.net/a/b.png');
  // A mirror always wins over the origin, and unknown hosts stay blocked.
  assert.equal(D.localImage(vibe, { [vibe]: local }), local);
  for (const value of ['https://akxlagkpqhwjrwrq.public.blob.vercel-storage.com.evil.test/a.png', 'https://evil.test/a.png', 'https://ph-files.imgix.net.evil.test/a.png']) {
    assert.equal(D.hotlinkable(value), '');
    assert.ok(!D.renderItem({ title: 'Example', image: value }, 'en').includes('<img'));
  }
});

test('retention rebuilds the manifest around the newest report and orphans the rest', () => {
  const manifest = { [vibe]: local, [remote]: local2, 'https://akxlagkpqhwjrwrq.public.blob.vercel-storage.com/products/x/old.png': local2 };
  const { kept, keptFiles, removed } = pruneManifest(manifest, new Set([vibe, remote]));
  assert.deepEqual(kept, { [vibe]: local, [remote]: local2 });
  assert.deepEqual([...keptFiles].sort(), ['a'.repeat(64) + '.png', 'b'.repeat(64) + '.png']);
  assert.deepEqual(removed, ['https://akxlagkpqhwjrwrq.public.blob.vercel-storage.com/products/x/old.png']);
});

test('only product marks are mirrored; screenshots stay on the source CDN', () => {
  const shot = 'https://akxlagkpqhwjrwrq.public.blob.vercel-storage.com/products/x/one.png';
  const shot2 = 'https://ph-files.imgix.net/a/two.png';
  const item = { logo: vibe, icon: '', image: shot, images: [shot, shot2] };
  assert.deepEqual(itemUrls(item), [vibe]);
  assert.deepEqual([...new Set(itemUrls(item, { screenshots: true }))], [vibe, shot, shot2]);
  // Unsafe values are dropped from both the mark list and the screenshot list.
  assert.deepEqual(itemUrls({ logo: 'javascript:alert(1)', image: shot, images: ['data:image/png;base64,x'] }, { screenshots: true }), [shot]);
});

test('report images are localized across all fields and failures get a placeholder', () => {
  const report = { results: [{ items: [{ image: remote, logo: 'https://example.org/missing', icon: local }] }] };
  localizeReport(report, { [remote]: local, 'https://example.org/missing': null });
  assert.deepEqual(report.results[0].items[0], { image: local, logo: '', icon: local });
  assert.throws(() => localizeReport({ results: [{ items: [{ image: remote }] }] }, {}), /images:sync/);
  // A pruned mirror is not an error as long as the origin is trusted.
  const archived = { results: [{ items: [{ logo: vibe, images: [vibe] }] }] };
  localizeReport(archived, {});
  assert.deepEqual(archived.results[0].items[0], { logo: vibe, images: [vibe] });
});

test('screenshot galleries localize every entry and refuse unsynced URLs', () => {
  const missing = 'https://example.org/gone.png';
  const report = { results: [{ items: [{ images: [remote, missing, local] }] }] };
  localizeReport(report, { [remote]: local, [missing]: null });
  assert.deepEqual(report.results[0].items[0].images, [local, local]);
  assert.throws(() => localizeReport({ results: [{ items: [{ images: [remote] }] }] }, {}), /images:sync/);
});

test('the product logo wins the avatar and screenshots render as a managed gallery', () => {
  const html = D.renderItem({ title: 'Example', logo: local, image: local2, images: [local2, remote, local] }, 'en');
  assert.ok(html.includes(`<img src="${local}" class="is-logo"`));
  assert.ok(html.includes('class="item-gallery"'), 'gallery strip');
  assert.ok(html.includes(`data-gallery="[&quot;${local2}&quot;,&quot;${local}&quot;]"`), 'unsafe screenshot dropped');
  assert.ok(!html.includes(remote));
  assert.ok(html.includes('gallery-thumb'));
  // A single screenshot needs no "+n" overflow tile; four do.
  assert.ok(!D.renderItem({ title: 'One', images: [local] }, 'en').includes('gallery-more'));
  assert.ok(D.renderItem({ title: 'Four', images: [local, local2, local, local2] }, 'en').includes('gallery-more'));
  // Sources without screenshots keep the plain avatar and gain no gallery.
  assert.ok(!D.renderItem({ title: 'Plain', image: local2 }, 'en').includes('item-gallery'));
});

test('screenshots show in the grid view only, never in the dense list', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8');
  assert.match(css, /\.item-gallery \{[^}]*display: none/);
  const visible = css.match(/^[^\n]*\.card-view \.item-gallery[^\n]*$/m)?.[0] || '';
  assert.match(visible, /\.card-view \.item-gallery/);
  assert.match(visible, /\.panel \.item-gallery/);
  assert.match(visible, /display: flex/);
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

test('built reports expose either a deployed managed file or a trusted origin', () => {
  const directory = path.resolve(__dirname, '../dist');
  let managed = 0;
  let hotlinked = 0;
  for (const file of fs.readdirSync(path.join(directory, 'data/reports'))) {
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'data/reports', file), 'utf8'));
    for (const item of D.reportItems(report)) {
      const values = [...['image', 'logo', 'icon'].map(field => item[field]), ...(Array.isArray(item.images) ? item.images : [])];
      for (const value of values) {
        if (!value) continue;
        assert.equal(D.localImage(value), value, `${file}: ${value}`);
        if (value.startsWith('/images/')) {
          assert.ok(fs.existsSync(path.join(directory, value)), `${file}: ${value}`);
          managed++;
        } else {
          assert.ok(D.hotlinkable(value), `${file}: ${value}`);
          hotlinked++;
        }
      }
    }
  }
  // Retention mirrors the newest report; the archive is expected to hotlink instead.
  assert.ok(managed > 0);
  assert.ok(hotlinked > 0);
  assert.match(fs.readFileSync(path.join(directory, '_headers'), 'utf8'), /Content-Security-Policy: sandbox; default-src 'none'/);
});
