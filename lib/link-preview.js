// Title, description and picture of a web page, for link cards.
//
// The server fetches whatever URL it is given, so the fetch is fenced in: only http(s), only
// public addresses (no localhost, home network or cloud metadata at 169.254.169.254), at most
// a few redirects, half a megabyte and five seconds.

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

const TIMEOUT = 5000;
const MAX_BYTES = 512 * 1024; // the meta tags are in <head>, the rest of the page is not needed
const MAX_REDIRECTS = 3;

// Two lists, because a BlockList also matches IPv4 addresses against IPv6 rules, and the
// ::ffff:0:0/96 rule below would then block every IPv4 address there is
const reservedV4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]
]) reservedV4.addSubnet(address, prefix, 'ipv4');

const reservedV6 = new net.BlockList();
for (const [address, prefix] of [
  ['::', 127], // :: and ::1
  ['::ffff:0:0', 96], // IPv4-mapped, would reach any IPv4 address including 127.0.0.1
  ['64:ff9b::', 96], ['2002::', 16], // NAT64 and 6to4 also wrap IPv4 addresses
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
]) reservedV6.addSubnet(address, prefix, 'ipv6');

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !reservedV4.check(address, 'ipv4');
  if (family === 6) return !reservedV6.check(address, 'ipv6');
  return false;
}

// Checked on every connection, redirects included. Checking the name once before the request
// would not be enough: it could resolve to a public address first and to 127.0.0.1 next time.
function publicOnlyLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const allowed = addresses.filter(a => isPublicAddress(a.address));
    if (!allowed.length) return callback(Object.assign(new Error(`${hostname} is not a public address`), { code: 'EBLOCKED' }));
    if (options.all) callback(null, allowed);
    else callback(null, allowed[0].address, allowed[0].family);
  });
}

// "example.com" typed without a scheme is taken as https://example.com
function parseHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let text = value.trim();
  if (!/^[a-z][a-z\d+.-]*:/i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function fetchPage(url, { allowPrivate, signal, redirectsLeft }) {
  return new Promise((resolve, reject) => {
    // Node connects to an IP address directly, without calling lookup, so those are checked here
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && !isPublicAddress(host)) {
      return reject(new Error(`${host} is not a public address`));
    }

    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Skrepka/1.0)', Accept: 'text/html' },
      lookup: allowPrivate ? undefined : publicOnlyLookup,
      signal
    }, (res) => {
      const { statusCode, headers } = res;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        let next = null;
        try { next = parseHttpUrl(new URL(headers.location, url).href); } catch {}
        if (!next) return reject(new Error('Bad redirect'));
        if (!redirectsLeft) return reject(new Error('Too many redirects'));
        return resolve(fetchPage(next, { allowPrivate, signal, redirectsLeft: redirectsLeft - 1 }));
      }
      if (statusCode !== 200 || !/text\/html|application\/xhtml\+xml/i.test(headers['content-type'] || '')) {
        res.resume();
        return reject(new Error(`Not a web page (${statusCode} ${headers['content-type'] || 'no type'})`));
      }

      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= MAX_BYTES) res.destroy(); // enough, the head is in there
      });
      res.on('error', reject);
      // 'close' also comes after destroy(), when 'end' does not
      res.on('close', () => resolve({ url, html: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? match;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
  });
}

const tidy = (text, max) => decodeEntities(text).replace(/\s+/g, ' ').trim().slice(0, max);

// <meta property|name="..." content="..."> in any attribute order and quoting; first one wins
function metaTags(html) {
  const tags = new Map();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
    }
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content != null && !tags.has(key)) tags.set(key, attrs.content);
  }
  return tags;
}

/** Only the fields the page actually has; the caller fills in the rest. */
function parsePreview(html, pageUrl) {
  const meta = metaTags(html);
  const get = (...keys) => keys.map(k => meta.get(k)).find(Boolean);
  const title = get('og:title', 'twitter:title') ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const description = get('og:description', 'twitter:description', 'description');
  const siteName = get('og:site_name');
  const image = get('og:image', 'og:image:url', 'twitter:image');

  const preview = {};
  if (title && tidy(title, 300)) preview.title = tidy(title, 300);
  if (description) preview.description = tidy(description, 1000);
  if (siteName) preview.siteName = tidy(siteName, 100);
  if (image) {
    // often relative, and only a web address may end up as an <img src>
    let src = null;
    try { src = parseHttpUrl(new URL(decodeEntities(image).trim(), pageUrl).href); } catch {}
    if (src) preview.image = src.href;
  }
  return preview;
}

/**
 * Fetches the page at `url` (a URL from parseHttpUrl) and reads its preview.
 * `allowPrivate` lifts the address check; it exists for tests against a local server.
 */
async function linkPreview(url, { allowPrivate = false } = {}) {
  const page = await fetchPage(url, {
    allowPrivate,
    signal: AbortSignal.timeout(TIMEOUT),
    redirectsLeft: MAX_REDIRECTS
  });
  return parsePreview(page.html, page.url);
}

module.exports = { linkPreview, parseHttpUrl, parsePreview, isPublicAddress };
