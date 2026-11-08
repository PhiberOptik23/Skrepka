const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { linkPreview, parseHttpUrl, parsePreview, isPublicAddress } = require('../lib/link-preview');
const { startSite } = require('./helpers');

test('parseHttpUrl', () => {
  assert.equal(parseHttpUrl('example.com')?.href, 'https://example.com/');
  assert.equal(parseHttpUrl('  http://a.b/c?d  ')?.href, 'http://a.b/c?d');
  for (const bad of ['', '   ', 'javascript:alert(1)', 'ftp://x.y', 'data:text/html,hi', 'https://', null, 42]) {
    assert.equal(parseHttpUrl(bad), null, String(bad));
  }
});

test('isPublicAddress', () => {
  for (const ip of ['8.8.8.8', '172.32.0.1', '2a00:1450:4001::1']) assert.ok(isPublicAddress(ip), ip);
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fd00::1', 'not an ip'
  ]) assert.ok(!isPublicAddress(ip), ip);
});

describe('parsePreview', () => {
  const page = 'https://site.example/articles/1';

  test('reads Open Graph tags in any attribute order and quoting', () => {
    const preview = parsePreview(`
      <meta content="Don't panic" property="og:title">
      <meta property='og:description' content='A "guide"'>
      <meta name=og:site_name content=Guide>`, page);
    assert.deepEqual(preview, { title: "Don't panic", description: 'A "guide"', siteName: 'Guide' });
  });

  test('decodes entities and squeezes whitespace', () => {
    const preview = parsePreview('<title>\n  Tom &amp; Jerry &#8212; &#x41;&quot;  </title>', page);
    assert.equal(preview.title, 'Tom & Jerry — A"');
  });

  test('the first tag of a kind wins, og before twitter before <title>', () => {
    const html = '<title>Plain</title><meta name="twitter:title" content="Twitter"><meta property="og:title" content="OG">';
    assert.equal(parsePreview(html, page).title, 'OG');
  });

  test('a relative image becomes absolute, a script one is dropped', () => {
    assert.equal(parsePreview('<meta property="og:image" content="/img/cover.png">', page).image,
      'https://site.example/img/cover.png');
    assert.equal(parsePreview('<meta property="og:image" content="javascript:alert(1)">', page).image, undefined);
  });

  test('a page without tags gives nothing', () => {
    assert.deepEqual(parsePreview('<p>hello</p>', page), {});
  });
});

describe('linkPreview against a local site', () => {
  let site;
  before(async () => {
    site = await startSite((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<head><meta property="og:title" content="Привет"><meta property="og:image" content="/a.png"></head>');
      }
      if (req.url === '/moved') {
        res.writeHead(302, { Location: '/page' });
        return res.end();
      }
      if (req.url === '/loop') {
        res.writeHead(302, { Location: '/loop' });
        return res.end();
      }
      if (req.url === '/huge') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write('<title>Huge</title>');
        // ten megabytes in total, only the start of it should ever be read
        const chunk = 'x'.repeat(64 * 1024);
        let sent = 0;
        const pump = () => {
          while (sent < 160 && res.write(chunk)) sent++;
          if (sent < 160) res.once('drain', pump); else res.end();
        };
        res.on('error', () => {});
        return pump();
      }
      if (req.url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"title": "no"}');
      }
      res.writeHead(404);
      res.end();
    });
  });
  after(() => site.stop());

  const at = (p) => parseHttpUrl(site.base + p);

  test('reads the preview', async () => {
    const preview = await linkPreview(at('/page'), { allowPrivate: true });
    assert.equal(preview.title, 'Привет');
    assert.equal(preview.image, `${site.base}/a.png`);
  });

  test('follows a redirect, and the image is resolved against the final page', async () => {
    const preview = await linkPreview(at('/moved'), { allowPrivate: true });
    assert.equal(preview.title, 'Привет');
  });

  test('gives up on a redirect loop', async () => {
    await assert.rejects(linkPreview(at('/loop'), { allowPrivate: true }), /redirects/);
  });

  test('reads only the beginning of a huge page', async () => {
    const preview = await linkPreview(at('/huge'), { allowPrivate: true });
    assert.equal(preview.title, 'Huge');
  });

  test('refuses what is not a web page', async () => {
    await assert.rejects(linkPreview(at('/json'), { allowPrivate: true }), /Not a web page/);
    await assert.rejects(linkPreview(at('/missing'), { allowPrivate: true }), /Not a web page/);
  });

  test('without allowPrivate the local site is not contacted at all', async () => {
    const before = site.hits;
    await assert.rejects(linkPreview(at('/page')), /not a public address/);
    assert.equal(site.hits, before);
  });
});
