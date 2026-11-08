const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { linkPreview, parseHttpUrl } = require('./lib/link-preview');

const HOME_ID = '__home__';

// Pictures are shown on the board, so their extension comes from this table and not from the
// uploaded name. Any other file is only ever downloaded (see /media below): an uploaded .html
// opened from our own origin could otherwise run scripts with full access to the boards.
const IMAGE_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg'
};
const IMAGE_EXTENSIONS = new Set(Object.values(IMAGE_TYPES));

// multer reads file names as latin1, so "Отчёт.docx" would arrive garbled
const uploadedName = (file) => Buffer.from(file.originalname, 'latin1').toString('utf8');

// Other files keep their own extension, as long as it is plain letters and digits
function safeExtension(name) {
  const ext = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

// Board ids become file names, so they must never be able to point outside the boards folder
const validId = (id) => typeof id === 'string' && /^[\w-]+$/.test(id);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Written next to the target and renamed over it: a crash in the middle leaves the previous
// version of the board, never half of a JSON file
function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const jsonFiles = (dir) => fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f));

// Ids of the boards that a board's cards open
const childIds = (board) => (board.elements || [])
  .filter(el => el.type === 'board' && validId(el.content?.boardId))
  .map(el => el.content.boardId);

// HTTP Basic auth with one password (any username). Wrong passwords are counted per address,
// and after 10 within 15 minutes that address gets 429 until the window is over
function basicAuth(password) {
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
  const expected = sha256(password);
  const WINDOW = 15 * 60 * 1000;
  const LIMIT = 10;
  const failures = new Map(); // ip -> { count, since }

  return (req, res, next) => {
    const now = Date.now();
    for (const [ip, entry] of failures) if (now - entry.since > WINDOW) failures.delete(ip);
    if (failures.get(req.ip)?.count >= LIMIT) {
      return res.status(429).send('Too many wrong passwords, try again later');
    }

    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic') {
      const credentials = Buffer.from(encoded || '', 'base64').toString();
      const given = credentials.slice(credentials.indexOf(':') + 1);
      if (crypto.timingSafeEqual(sha256(given), expected)) return next();
      // the browser's first request has no password at all, only a wrong one counts
      const entry = failures.get(req.ip) || { count: 0, since: now };
      entry.count++;
      failures.set(req.ip, entry);
    }
    res.set('WWW-Authenticate', 'Basic realm="Skrepka", charset="UTF-8"');
    res.status(401).send('Authentication required');
  };
}

/**
 * @param {object} options
 * @param {string} [options.dataDir] boards, uploads and trash; ./data by default
 * @param {string} [options.password] if set, every request needs it
 * @param {string} [options.trustProxy] Express "trust proxy" value, so the password limit sees
 *   real client addresses behind a reverse proxy; only proxies on this machine by default
 */
function createApp({ dataDir, password, trustProxy = 'loopback' } = {}) {
  const DATA_DIR = path.resolve(dataDir || path.join(__dirname, 'data'));
  const BOARDS_DIR = path.join(DATA_DIR, 'boards');
  const MEDIA_DIR = path.join(DATA_DIR, 'media');
  const TRASH_DIR = path.join(DATA_DIR, 'trash');

  for (const dir of [BOARDS_DIR, MEDIA_DIR, TRASH_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
    // left over from a write that was cut off
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.tmp')) fs.rmSync(path.join(dir, f), { force: true });
  }

  const boardPath = (id) => path.join(BOARDS_DIR, `${id}.json`);
  const trashPath = (id) => path.join(TRASH_DIR, `${id}.json`);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    });
    next();
  });
  if (password) app.use(basicAuth(password));

  app.use(express.json({ limit: '50mb' }));
  app.use(express.static(path.join(__dirname, 'public')));
  // An uploaded file is never treated as a page, even an svg opened on its own,
  // and anything but a picture is downloaded instead of opened
  app.use('/media', express.static(MEDIA_DIR, {
    setHeaders: (res, filePath) => {
      res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) res.set('Content-Disposition', 'attachment');
    }
  }));

  const upload = multer({
    storage: multer.diskStorage({
      destination: MEDIA_DIR,
      filename: (req, file, cb) => cb(null, uuidv4() + (IMAGE_TYPES[file.mimetype] || safeExtension(uploadedName(file))))
    }),
    limits: { fileSize: 100 * 1024 * 1024 }
  });

  // Every board that can be reached from Home by opening board cards, breadth-first.
  // Map of id -> { board, parent, card }, where card is the content of the board card that leads
  // to it. Boards outside the map have no card anywhere, so nobody can open them.
  function reachableBoards() {
    const found = new Map();
    const queue = [{ id: HOME_ID, parent: null, card: null }];
    while (queue.length) {
      const { id, parent, card } = queue.shift();
      if (found.has(id) || !fs.existsSync(boardPath(id))) continue;
      let board;
      try { board = readJson(boardPath(id)); } catch { continue; }
      found.set(id, { board, parent, card });
      for (const el of board.elements || []) {
        if (el.type === 'board' && validId(el.content?.boardId)) {
          queue.push({ id: el.content.boardId, parent: id, card: el.content });
        }
      }
    }
    return found;
  }

  // --- Boards ---

  app.param('id', (req, res, next, id) => {
    if (!validId(id)) return res.status(400).json({ error: 'Invalid board id' });
    next();
  });

  app.get('/api/boards/:id', (req, res) => {
    if (!fs.existsSync(boardPath(req.params.id))) return res.status(404).json({ error: 'Board not found' });
    try {
      res.json(readJson(boardPath(req.params.id)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/boards', (req, res) => {
    try {
      const now = new Date().toISOString();
      const board = {
        id: uuidv4(),
        name: req.body.name || 'Untitled Board',
        icon: req.body.icon || '📋',
        backgroundColor: req.body.backgroundColor || '#f4f5f5',
        viewport: { x: 0, y: 0, zoom: 1 },
        elements: [],
        connections: [],
        createdAt: now,
        updatedAt: now,
        parentId: req.body.parentId || null
      };
      writeJson(boardPath(board.id), board);
      res.status(201).json(board);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The client always sends the whole board
  app.put('/api/boards/:id', (req, res) => {
    const body = req.body;
    if (!body || !Array.isArray(body.elements) || !Array.isArray(body.connections)) {
      return res.status(400).json({ error: 'A board needs elements and connections' });
    }
    try {
      const board = { ...body, id: req.params.id, updatedAt: new Date().toISOString() };
      writeJson(boardPath(req.params.id), board);
      res.json(board);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Boards reachable from Home and the board each one is opened from (breadcrumbs, quick jump)
  app.get('/api/outline', (req, res) => {
    try {
      res.json([...reachableBoards()].map(([id, { board, parent, card }]) => (
        { id, name: board.name, icon: board.icon, customIcon: card?.customIcon || null, parent, updatedAt: board.updatedAt }
      )));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Trash ---
  // Deleting a board card moves the board here instead of erasing it. Boards nested inside
  // stay in place: they are only reachable through the trashed board and come back with it.

  app.post('/api/boards/:id/trash', (req, res) => {
    const { id } = req.params;
    if (id === HOME_ID) return res.status(400).json({ error: 'The home board cannot be deleted' });
    if (!fs.existsSync(boardPath(id))) return res.status(404).json({ error: 'Board not found' });
    try {
      const board = readJson(boardPath(id));
      // `card` is how the board looked on the canvas (name, icon), so it can be put back the same
      writeJson(trashPath(id), { deletedAt: new Date().toISOString(), card: req.body?.card || null, board });
      fs.unlinkSync(boardPath(id));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Most recently deleted first
  app.get('/api/trash', (req, res) => {
    try {
      const items = jsonFiles(TRASH_DIR).map(file => {
        const { deletedAt, card, board } = readJson(file);
        return {
          id: board.id,
          name: card?.name || board.name,
          icon: card?.icon || board.icon,
          customIcon: card?.customIcon || null,
          cards: (board.elements || []).length,
          deletedAt
        };
      });
      items.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bring a board back from the trash; the client then adds a card for it to the board in parentId
  app.post('/api/trash/:id/restore', (req, res) => {
    const { id } = req.params;
    if (!fs.existsSync(trashPath(id))) return res.status(404).json({ error: 'Not in the trash' });
    try {
      const { card, board } = readJson(trashPath(id));
      if (validId(req.body?.parentId)) board.parentId = req.body.parentId;
      // If the board file reappeared in the meantime (a save from another tab), that newer copy wins
      if (!fs.existsSync(boardPath(id))) writeJson(boardPath(id), board);
      fs.unlinkSync(trashPath(id));
      res.json({ id, name: card?.name || board.name, icon: card?.icon || board.icon, customIcon: card?.customIcon || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Does any board, live or trashed, still have a card that opens this one?
  function isReferenced(id) {
    const boards = [
      ...jsonFiles(BOARDS_DIR).map(readJson),
      ...jsonFiles(TRASH_DIR).map(file => readJson(file).board)
    ];
    return boards.some(board => board.id !== id && childIds(board).includes(id));
  }

  // Erase a trashed board for good, together with the nested boards nothing else points to.
  // Uploaded media is left alone: the same file can be used by other cards.
  function purge(id) {
    const { board } = readJson(trashPath(id));
    fs.unlinkSync(trashPath(id));
    const pending = childIds(board);
    while (pending.length) {
      const child = pending.pop();
      if (child === HOME_ID || !fs.existsSync(boardPath(child)) || isReferenced(child)) continue;
      const nested = readJson(boardPath(child));
      fs.unlinkSync(boardPath(child));
      pending.push(...childIds(nested));
    }
  }

  app.delete('/api/trash/:id', (req, res) => {
    if (!fs.existsSync(trashPath(req.params.id))) return res.status(404).json({ error: 'Not in the trash' });
    try {
      purge(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/trash', (req, res) => {
    try {
      for (const file of jsonFiles(TRASH_DIR)) purge(path.basename(file, '.json'));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Search ---

  // Case-insensitive, and "ё" matches "е"
  const fold = (text) => String(text ?? '').toLowerCase().replace(/ё/g, 'е');

  const stripHtml = (html) => String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();

  // The pieces of text a card can be found by
  function elementTexts(el) {
    const c = el.content || {};
    switch (el.type) {
      case 'note': return [stripHtml(c.html)];
      case 'image': return [c.caption, c.alt];
      case 'todo': return [c.title, ...(c.items || []).map(item => item.text)];
      case 'link': return [c.title, c.description, c.url, c.siteName];
      case 'column': return [c.title];
      case 'color': return [c.color];
      case 'file': return [c.name];
      default: return [];
    }
  }

  // A stretch of the text around the match, short enough for one result row
  function excerpt(text, at, length) {
    const start = Math.max(0, at - 32);
    const end = Math.min(text.length, at + length + 64);
    return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
  }

  // Board names and card text across every board reachable from Home
  app.get('/api/search', (req, res) => {
    const query = fold(req.query.q).trim();
    if (!query) return res.json([]);
    try {
      const boards = reachableBoards();
      const nameOf = (id) => id === HOME_ID ? 'Home' : boards.get(id).board.name;
      const trailTo = (id) => {
        const trail = [];
        for (let cur = boards.get(id).parent; cur && trail.length < 50; cur = boards.get(cur).parent) trail.unshift(nameOf(cur));
        return trail;
      };

      const results = [];
      for (const [id, { board }] of boards) {
        if (id !== HOME_ID && fold(board.name).includes(query)) {
          results.push({ type: 'board', boardId: id, text: board.name, path: trailTo(id) });
        }
      }
      for (const [id, { board }] of boards) {
        const where = [...trailTo(id), nameOf(id)];
        const hit = (type, elementId, text) => {
          const at = fold(text).indexOf(query);
          if (at < 0) return false;
          results.push({ type, boardId: id, elementId, text: excerpt(String(text), at, query.length), path: where });
          return true;
        };
        for (const el of board.elements || []) {
          elementTexts(el).some(text => hit(el.type, el.id, text));
          (el.comments || []).some(comment => hit('comment', el.id, comment.text));
        }
        for (const conn of board.connections || []) hit('line', conn.from?.elementId, conn.label);
      }
      res.json(results.slice(0, 60));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Uploads and link previews ---

  app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    res.json({
      kind: IMAGE_TYPES[req.file.mimetype] ? 'image' : 'file',
      filename: req.file.filename,
      originalName: uploadedName(req.file),
      url: `/media/${req.file.filename}`,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
  });

  app.post('/api/link-preview', async (req, res) => {
    const url = parseHttpUrl(req.body?.url);
    if (!url) return res.status(400).json({ error: 'A http(s) link is required' });
    // Whatever goes wrong with the page, the card still gets made from the address alone
    const fallback = { title: url.href, description: '', image: null, siteName: url.hostname, url: url.href };
    try {
      res.json({ ...fallback, ...await linkPreview(url) });
    } catch {
      res.json(fallback);
    }
  });

  // Unknown API calls answer in JSON instead of falling through to the page below
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // The app has one page; boards are addressed by #/b/<id>
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Broken JSON, an upload over the size limit and the like: a JSON error, not an HTML stack trace
  app.use((err, req, res, next) => {
    const status = err instanceof multer.MulterError ? 400 : err.status || err.statusCode || 500;
    res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
  });

  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  // MILASLOP_PASSWORD is how the variable was called before the rename
  const password = process.env.SKREPKA_PASSWORD || process.env.MILASLOP_PASSWORD;
  const app = createApp({
    dataDir: process.env.DATA_DIR,
    password,
    trustProxy: process.env.TRUST_PROXY
  });

  app.listen(port, () => {
    console.log(`Skrepka running at http://localhost:${port}`);
    // Addresses other devices on the same network can use
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const a of addresses) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  on your network: http://${a.address}:${port}`);
      }
    }
    if (!password) console.log('  no password set: fine at home, set SKREPKA_PASSWORD before opening it to the internet');
  });
}

module.exports = { createApp };
