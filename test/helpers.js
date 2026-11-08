const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createApp } = require('../server');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skrepka-test-'));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

// The app on a random port with its own empty data folder
async function startApp(options = {}) {
  const dataDir = options.dataDir || tempDir();
  const server = http.createServer(createApp({ ...options, dataDir }));
  const base = await listen(server);

  async function api(method, url, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers['Content-Type'] ??= 'application/json';
      init.body = typeof body === 'string' || body instanceof FormData ? body : JSON.stringify(body);
      if (body instanceof FormData) delete init.headers['Content-Type'];
    }
    const res = await fetch(base + url, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text, headers: res.headers };
  }

  return {
    base,
    api,
    dataDir,
    async stop() {
      await close(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

// A plain local web server for the link preview tests; counts the requests it gets
async function startSite(handler) {
  const site = { hits: 0 };
  const server = http.createServer((req, res) => {
    site.hits++;
    handler(req, res);
  });
  site.base = await listen(server);
  site.stop = () => close(server);
  return site;
}

const board = (id, elements = [], extra = {}) => ({ id, name: id, elements, connections: [], ...extra });
const boardCard = (boardId) => ({ id: `card-${boardId}`, type: 'board', content: { boardId, name: boardId } });

module.exports = { startApp, startSite, tempDir, board, boardCard };
