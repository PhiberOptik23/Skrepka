const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startApp, startSite, tempDir, board, boardCard } = require('./helpers');

describe('boards', () => {
  let app;
  before(async () => { app = await startApp(); });
  after(() => app.stop());

  test('create, read and save', async () => {
    const created = await app.api('POST', '/api/boards', { name: 'Ideas' });
    assert.equal(created.status, 201);
    const { id } = created.body;

    const saved = await app.api('PUT', `/api/boards/${id}`, {
      ...created.body,
      elements: [{ id: 'n1', type: 'note', content: { html: 'hi' } }]
    });
    assert.equal(saved.status, 200);

    const read = await app.api('GET', `/api/boards/${id}`);
    assert.equal(read.body.name, 'Ideas');
    assert.equal(read.body.elements.length, 1);
  });

  test('the id in the address wins over the one in the body', async () => {
    await app.api('PUT', '/api/boards/real', board('other'));
    assert.equal((await app.api('GET', '/api/boards/real')).body.id, 'real');
    assert.equal((await app.api('GET', '/api/boards/other')).status, 404);
  });

  test('a board needs elements and connections', async () => {
    assert.equal((await app.api('PUT', '/api/boards/x', { name: 'x' })).status, 400);
    assert.equal((await app.api('PUT', '/api/boards/x', { elements: [], connections: 'no' })).status, 400);
  });

  test('broken JSON gets a JSON error', async () => {
    const res = await app.api('PUT', '/api/boards/x', '{"elements": [');
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  test('ids that could leave the boards folder are refused', async () => {
    assert.equal((await app.api('GET', '/api/boards/..%2F..%2Fpackage')).status, 400);
    assert.equal((await app.api('PUT', '/api/boards/..%5Cevil', board('x'))).status, 400);
  });

  test('saving leaves no temporary files behind', async () => {
    for (let i = 0; i < 5; i++) await app.api('PUT', '/api/boards/busy', board('busy'));
    const files = fs.readdirSync(path.join(app.dataDir, 'boards'));
    assert.deepEqual(files.filter(f => !f.endsWith('.json')), []);
  });

  test('unknown API routes answer with JSON 404', async () => {
    const res = await app.api('GET', '/api/nothing-here');
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });
});

test('temp files left by a cut-off write are removed on start', async () => {
  const dataDir = tempDir();
  fs.mkdirSync(path.join(dataDir, 'boards'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'boards', 'a.json.123.abc.tmp'), '{"half');

  const app = await startApp({ dataDir });
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'boards')), []);
  await app.stop();
});

describe('trash', () => {
  let app;
  before(async () => { app = await startApp(); });
  after(() => app.stop());

  test('a board goes to the trash and comes back', async () => {
    await app.api('PUT', '/api/boards/__home__', board('__home__', [boardCard('a')]));
    await app.api('PUT', '/api/boards/a', board('a'));

    assert.equal((await app.api('POST', '/api/boards/a/trash', { card: { name: 'A card' } })).status, 200);
    assert.equal((await app.api('GET', '/api/boards/a')).status, 404);
    const trash = await app.api('GET', '/api/trash');
    assert.equal(trash.body[0].name, 'A card');

    assert.equal((await app.api('POST', '/api/trash/a/restore', { parentId: '__home__' })).status, 200);
    assert.equal((await app.api('GET', '/api/boards/a')).body.parentId, '__home__');
  });

  test('home cannot be trashed', async () => {
    assert.equal((await app.api('POST', '/api/boards/__home__/trash')).status, 400);
  });

  test('purge erases nested boards unless something else still opens them', async () => {
    // home -> parent -> (only, shared); home -> other -> shared
    await app.api('PUT', '/api/boards/__home__', board('__home__', [boardCard('parent'), boardCard('other')]));
    await app.api('PUT', '/api/boards/parent', board('parent', [boardCard('only'), boardCard('shared')]));
    await app.api('PUT', '/api/boards/other', board('other', [boardCard('shared')]));
    await app.api('PUT', '/api/boards/only', board('only'));
    await app.api('PUT', '/api/boards/shared', board('shared'));

    await app.api('POST', '/api/boards/parent/trash');
    assert.equal((await app.api('DELETE', '/api/trash/parent')).status, 200);

    assert.equal((await app.api('GET', '/api/boards/only')).status, 404);
    assert.equal((await app.api('GET', '/api/boards/shared')).status, 200);
  });
});

describe('outline and search', () => {
  let app;
  before(async () => {
    app = await startApp();
    await app.api('PUT', '/api/boards/__home__', board('__home__', [boardCard('trip')]));
    await app.api('PUT', '/api/boards/trip', board('trip', [
      { id: 'n1', type: 'note', content: { html: '<b>Ёлка</b> &amp; подарки' } },
      { id: 't1', type: 'todo', content: { title: 'Packing', items: [{ text: 'passport' }] } }
    ]));
    await app.api('PUT', '/api/boards/hidden', board('hidden', [{ id: 'n2', type: 'note', content: { html: 'елка' } }]));
  });
  after(() => app.stop());

  test('the outline holds boards reachable from home, with their parent', async () => {
    const outline = (await app.api('GET', '/api/outline')).body;
    assert.deepEqual(outline.map(b => [b.id, b.parent]), [['__home__', null], ['trip', '__home__']]);
  });

  test('search ignores case and ё, and skips boards nobody can open', async () => {
    const results = (await app.api('GET', `/api/search?q=${encodeURIComponent('ЕЛКА')}`)).body;
    assert.equal(results.length, 1);
    assert.equal(results[0].boardId, 'trip');
    assert.equal(results[0].text, 'Ёлка & подарки');
    assert.deepEqual(results[0].path, ['Home', 'trip']);
  });

  test('todo items are searchable', async () => {
    const results = (await app.api('GET', '/api/search?q=passport')).body;
    assert.equal(results[0].type, 'todo');
  });
});

describe('uploads', () => {
  let app;
  before(async () => { app = await startApp(); });
  after(() => app.stop());

  const upload = (content, type, name) => {
    const form = new FormData();
    form.append('file', new Blob([content], { type }), name);
    return app.api('POST', '/api/upload', form);
  };

  test('an image is stored and served as an image, never as a page', async () => {
    const res = await upload(Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png', 'shot.png');
    assert.equal(res.status, 200);
    assert.equal(res.body.kind, 'image');
    assert.match(res.body.url, /^\/media\/[\w-]+\.png$/);

    const file = await fetch(app.base + res.body.url);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.match(file.headers.get('content-security-policy'), /sandbox/);
    assert.equal(file.headers.get('content-disposition'), null);
  });

  test('a document keeps its extension and its Cyrillic name', async () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const res = await upload('PK...', docx, 'Отчёт за май.docx');
    assert.equal(res.body.kind, 'file');
    assert.equal(res.body.originalName, 'Отчёт за май.docx');
    assert.match(res.body.url, /\.docx$/);

    const text = await upload('hello', 'text/plain', 'notes.txt');
    assert.match(text.body.url, /\.txt$/);
  });

  test('other files are only downloaded, an html one never opens as a page', async () => {
    const res = await upload('<script>alert(1)</script>', 'text/html', 'evil.html');
    assert.equal(res.body.kind, 'file');

    const file = await fetch(app.base + res.body.url);
    assert.equal(file.headers.get('content-disposition'), 'attachment');
    assert.match(file.headers.get('content-security-policy'), /sandbox/);
  });

  test('the extension of a picture comes from its type, not from the file name', async () => {
    const res = await upload('<script>alert(1)</script>', 'image/png', 'evil.html');
    assert.match(res.body.url, /\.png$/);
  });

  test('odd extensions are dropped', async () => {
    const res = await upload('x', 'application/octet-stream', 'name.<script>');
    assert.match(res.body.url, /^\/media\/[\w-]+$/);
  });
});

describe('link preview endpoint', () => {
  let app;
  let site;
  before(async () => {
    app = await startApp();
    site = await startSite((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<title>Internal admin</title>');
    });
  });
  after(async () => { await app.stop(); await site.stop(); });

  test('a broken address is 400 and the server keeps working', async () => {
    assert.equal((await app.api('POST', '/api/link-preview', { url: 'not a url at all' })).status, 400);
    assert.equal((await app.api('POST', '/api/link-preview', {})).status, 400);
    assert.equal((await app.api('GET', '/api/outline')).status, 200);
  });

  test('only http and https', async () => {
    assert.equal((await app.api('POST', '/api/link-preview', { url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await app.api('POST', '/api/link-preview', { url: 'file:///etc/passwd' })).status, 400);
  });

  test('local addresses are never requested', async () => {
    const port = new URL(site.base).port;
    for (const url of [site.base, `http://localhost:${port}/`, `http://[::1]:${port}/`, `http://2130706433:${port}/`]) {
      const res = await app.api('POST', '/api/link-preview', { url });
      assert.equal(res.status, 200);
      assert.notEqual(res.body.title, 'Internal admin');
    }
    assert.equal(site.hits, 0);
  });
});

describe('password', () => {
  let app;
  before(async () => { app = await startApp({ password: 'secret' }); });
  after(() => app.stop());

  const basic = (password) => ({ Authorization: `Basic ${Buffer.from(`me:${password}`).toString('base64')}` });

  test('without the password nothing is served', async () => {
    const res = await app.api('GET', '/');
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), /Basic/);
    assert.equal((await app.api('GET', '/media/anything.png')).status, 401);
  });

  test('the right password lets the request through', async () => {
    assert.equal((await app.api('GET', '/api/outline', undefined, basic('secret'))).status, 200);
  });

  test('after 10 wrong passwords even the right one waits', async () => {
    for (let i = 0; i < 10; i++) {
      assert.equal((await app.api('GET', '/api/outline', undefined, basic('guess'))).status, 401);
    }
    assert.equal((await app.api('GET', '/api/outline', undefined, basic('secret'))).status, 429);
  });
});
