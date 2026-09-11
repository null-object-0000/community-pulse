const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');
const { downloadImage, localizeReport, pruneManifest, itemUrls, readManifest } = require('../scripts/image-store.js');
const local = '/images/' + 'a'.repeat(64) + '.png';
const local2 = '/images/' + 'b'.repeat(64) + '.png';
const remote = 'https://example.org/logo.png';
const vibe = 'https://akxlagkpqhwjrwrq.public.blob.vercel-storage.com/products/x/y.png';
const site = 'https://kiri.test/apple-touch-icon.png';

// Most cases pin the bundled mode. `IMAGE_BASE` wins over `site.config.json`, so an empty value
// forces the bundled default even after the committed config switches production to the CDN.
function bundledMode(body) {
  const saved = process.env.IMAGE_BASE;
  process.env.IMAGE_BASE = '';
  try { return body(); } finally { if (saved !== undefined) process.env.IMAGE_BASE = saved; else delete process.env.IMAGE_BASE; }
}

test('site.config.json supplies the mirror origin and IMAGE_BASE overrides it', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'site.config.json'), 'utf8'));
  const expected = String(config.imageBase || '').trim().replace(/\/+$/, '');
  const saved = process.env.IMAGE_BASE;
  delete process.env.IMAGE_BASE;
  try {
    const report = { results: [{ items: [{ logo: remote }] }] };
    localizeReport(report, { [remote]: local });
    assert.equal(report.results[0].items[0].logo, expected ? expected + local : local);
  } finally {
    if (saved !== undefined) process.env.IMAGE_BASE = saved;
  }
  // An explicit empty IMAGE_BASE always forces the bundled mode, whatever the config says.
  bundledMode(() => {
    const report = { results: [{ items: [{ logo: remote }] }] };
    localizeReport(report, { [remote]: local });
    assert.equal(report.results[0].items[0].logo, local);
  });
});

test('managed image policy blocks external requests and unsafe paths', () => {
  assert.equal(D.localImage(remote, { [remote]: local }), local);
  assert.equal(D.localImage(local), local);
  for (const value of [remote, '//example.org/x', '/images/../x', 'data:image/png;base64,x', local + '?redirect=x']) {
    assert.equal(D.localImage(value), '');
    assert.ok(!D.renderItem({ title: 'Example', siteLogo: value }, 'en').includes('<img'));
  }
  assert.ok(D.renderItem({ title: 'Example', siteLogo: local }, 'en').includes(`src="${local}"`));
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
    assert.ok(!D.renderItem({ title: 'Example', siteLogo: value }, 'en').includes('<img'));
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
  // The website-logo fallback is a product mark too, so it is mirrored like the platform ones.
  assert.deepEqual(itemUrls({ siteLogo: site, image: shot }), [site]);
  // Unsafe values are dropped from both the mark list and the screenshot list.
  assert.deepEqual(itemUrls({ logo: 'javascript:alert(1)', image: shot, images: ['data:image/png;base64,x'] }, { screenshots: true }), [shot]);
});

test('Product Hunt marks are hotlinked instead of mirrored', () => {
  const phMark = 'https://ph-files.imgix.net/a/thumb.png';
  const phShot = 'https://ph-files.imgix.net/a/shot.png';
  // PH marks are launch images (up to 9 MB) shown as a 48px avatar, and the host is already a
  // trusted hotlink origin, so they never enter the mirror set.
  assert.deepEqual(itemUrls({ logo: phMark, icon: '', image: phShot }), []);
  assert.deepEqual(itemUrls({ logo: vibe }), [vibe]);
  // Hostname matching is case-insensitive, and a lookalike host is a normal mark.
  assert.deepEqual(itemUrls({ logo: 'https://PH-FILES.IMGIX.NET/a/thumb.png' }), []);
  assert.deepEqual(itemUrls({ logo: 'https://ph-files.imgix.net.evil.test/a.png' }), ['https://ph-files.imgix.net.evil.test/a.png']);
  // An explicit retention window still mirrors the whole report, PH included.
  assert.deepEqual([...new Set(itemUrls({ logo: phMark, images: [phShot] }, { screenshots: true }))], [phMark, phShot]);
});

test('report images are localized across all fields and failures get a placeholder', () => bundledMode(() => {
  const report = { results: [{ items: [{ image: remote, logo: 'https://example.org/missing', icon: local, siteLogo: remote }] }] };
  localizeReport(report, { [remote]: local, 'https://example.org/missing': null });
  assert.deepEqual(report.results[0].items[0], { image: local, logo: '', icon: local, siteLogo: local });
  // A website logo is never hotlinked from its origin, so it must be mirrored before it can render.
  assert.throws(() => localizeReport({ results: [{ items: [{ siteLogo: site }] }] }, {}), /images:sync/);
  assert.throws(() => localizeReport({ results: [{ items: [{ image: remote }] }] }, {}), /images:sync/);
  // A pruned mirror is not an error as long as the origin is trusted.
  const archived = { results: [{ items: [{ logo: vibe, images: [vibe] }] }] };
  localizeReport(archived, {});
  assert.deepEqual(archived.results[0].items[0], { logo: vibe, images: [vibe] });
}));

test('screenshot galleries localize every entry and refuse unsynced URLs', () => bundledMode(() => {
  const missing = 'https://example.org/gone.png';
  const report = { results: [{ items: [{ images: [remote, missing, local] }] }] };
  localizeReport(report, { [remote]: local, [missing]: null });
  assert.deepEqual(report.results[0].items[0].images, [local, local]);
  assert.throws(() => localizeReport({ results: [{ items: [{ images: [remote] }] }] }, {}), /images:sync/);
}));

test('the product logo wins the avatar and screenshots render as a managed gallery', () => {
  const html = D.renderItem({ title: 'Example', logo: local, image: local2, images: [local2, remote, local] }, 'en');
  assert.ok(html.includes(`<img src="${local}" class="is-logo"`));
  // The avatar chain is logo -> icon -> website logo -> initials; a screenshot never fills it.
  assert.ok(D.renderItem({ title: 'Icon', icon: local2, siteLogo: local }, 'en').includes(`<img src="${local2}" class="is-logo"`));
  assert.ok(D.renderItem({ title: 'Website', siteLogo: local2, image: local }, 'en').includes(`<img src="${local2}" class="is-logo"`));
  assert.ok(!D.renderItem({ title: 'Shot only', image: local }, 'en').includes('<img'));
  assert.ok(html.includes('class="item-gallery"'), 'gallery strip');
  assert.ok(html.includes(`data-gallery="[&quot;${local2}&quot;,&quot;${local}&quot;]"`), 'unsafe screenshot dropped');
  assert.ok(!html.includes(remote));
  assert.ok(html.includes('gallery-thumb'));
  // A single screenshot needs no "+n" overflow tile; four do.
  assert.ok(!D.renderItem({ title: 'One', images: [local] }, 'en').includes('gallery-more'));
  assert.ok(D.renderItem({ title: 'Four', images: [local, local2, local, local2] }, 'en').includes('gallery-more'));
  // Sources without screenshots keep the plain avatar and gain no gallery.
  assert.ok(!D.renderItem({ title: 'Plain', image: local2 }, 'en').includes('item-gallery'));
  assert.ok(D.renderItem({ title: 'Plain', image: local2 }, 'en').includes('Pl'));
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

test('the uploader maps every mirrored mark to a content-addressed CDN key', () => {
  const { uploadEntries } = require('../scripts/image-upload.js');
  const entries = uploadEntries(readManifest());
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.match(entry.key, /^images\/[a-f0-9]{64}\.(png|jpg|gif|webp|avif|ico|svg)$/);
    assert.ok(entry.type.startsWith('image/'), entry.type);
    assert.ok(fs.existsSync(entry.file), entry.file);
  }
  // One upload per file: the key is the content hash, so duplicates collapse.
  assert.equal(new Set(entries.map(entry => entry.key)).size, entries.length);
  assert.throws(() => uploadEntries({ x: '/images/' + 'a'.repeat(64) + '.bmp' }), /Unsupported image extension/);
  assert.throws(() => uploadEntries({ x: '/images/' + 'b'.repeat(64) + '.png' }), /Missing mirror file/);
});

test('built reports expose either a deployed managed file or a trusted origin', () => {
  const directory = path.resolve(__dirname, '../dist');
  let managed = 0;
  let hotlinked = 0;
  for (const file of fs.readdirSync(path.join(directory, 'data/reports'))) {
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'data/reports', file), 'utf8'));
    for (const item of D.reportItems(report)) {
      const values = [...['image', 'logo', 'icon', 'siteLogo'].map(field => item[field]), ...(Array.isArray(item.images) ? item.images : [])];
      for (const value of values) {
        if (!value) continue;
        assert.equal(D.localImage(value), value, `${file}: ${value}`);
        if (value.startsWith('/images/')) {
          assert.ok(fs.existsSync(path.join(directory, value)), `${file}: ${value}`);
          managed++;
        } else if (D.managedImage(value)) {
          // IMAGE_BASE build: the same content-addressed path is served by the image CDN, so the
          // bundle must not carry the bytes and no local file may be referenced.
          assert.ok(!fs.existsSync(path.join(directory, new URL(value).pathname)), `${file}: ${value}`);
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
  const headers = path.join(directory, '_headers');
  if (fs.existsSync(headers)) {
    assert.match(fs.readFileSync(headers, 'utf8'), /Content-Security-Policy: sandbox; default-src 'none'/);
  } else {
    // An external IMAGE_BASE means this site serves no image bytes, so the rule would be dead config.
    assert.ok(!fs.existsSync(path.join(directory, 'images')), 'no image bundle in CDN mode');
  }
});

test('mirrors may also be served from the configured image CDN origin', () => {
  const mirrored = 'https://img.devtrends.site' + local;
  assert.equal(D.managedImage(mirrored), mirrored);
  assert.equal(D.localImage(mirrored), mirrored);
  assert.ok(D.renderItem({ title: 'Example', siteLogo: mirrored }, 'en').includes(`src="${mirrored}"`));
  // The same path shape on any other host is not a managed mirror.
  for (const value of [
    'https://evil.test' + local,
    mirrored + '?v=2',
    mirrored + '#frag',
    'https://img.devtrends.site/other/' + 'a'.repeat(64) + '.png',
    'https://img.devtrends.site.evil.test' + local,
  ]) {
    assert.equal(D.managedImage(value), '', value);
    assert.equal(D.localImage(value), '', value);
    assert.ok(!D.renderItem({ title: 'Example', siteLogo: value }, 'en').includes('<img'));
  }
});

test('IMAGE_BASE rewrites localized mirrors onto the CDN origin', () => {
  const report = { results: [{ items: [{ logo: remote, icon: local, siteLogo: remote, images: [remote] }] }] };
  process.env.IMAGE_BASE = 'https://img.devtrends.site/';
  try {
    localizeReport(report, { [remote]: local });
    const mirrored = 'https://img.devtrends.site' + local;
    assert.deepEqual(report.results[0].items[0], { logo: mirrored, icon: mirrored, siteLogo: mirrored, images: [mirrored] });
    // The rewritten value must survive the very same validation the browser applies.
    assert.equal(D.localImage(mirrored), mirrored);
    assert.equal(D.localImage(mirrored, { [remote]: local }), mirrored);
  } finally {
    delete process.env.IMAGE_BASE;
  }
  // Without IMAGE_BASE nothing changes: mirrors stay inside the bundle.
  bundledMode(() => {
    const bundled = { results: [{ items: [{ logo: remote }] }] };
    localizeReport(bundled, { [remote]: local });
    assert.deepEqual(bundled.results[0].items[0], { logo: local });
  });
});
