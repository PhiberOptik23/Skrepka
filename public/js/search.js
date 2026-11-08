// Ctrl+K: jump to a board by name, or find a card by its text on any board

import { api } from './api.js';
import { getState, getDom, navigate, HOME_ID } from './app.js';
import { escapeHtml, icon } from './utils.js';
import { openComments } from './comments.js';

// result type -> icon in the sprite
const ICONS = {
  board: 'board', note: 'note', image: 'image', todo: 'todo',
  link: 'link', file: 'file', column: 'column', color: 'palette', line: 'line', comment: 'comment'
};

// Same folding as the server: case-insensitive, "ё" matches "е"
const fold = (text) => String(text).toLowerCase().replace(/ё/g, 'е');

let input, list;
let results = [];
let active = 0;
let latest = 0;
let timer = null;

export function initSearch() {
  const { searchDialog } = getDom();
  input = searchDialog.querySelector('#search-input');
  list = searchDialog.querySelector('#search-results');

  document.querySelector('#btn-search').addEventListener('click', open);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
      e.preventDefault();
      open();
    }
  });
  searchDialog.addEventListener('mousedown', (e) => {
    if (e.target === searchDialog) close();
  });

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[active]);
    }
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.search-row');
    if (row) go(results[row.dataset.index]);
  });
}

function open() {
  getDom().searchDialog.classList.remove('hidden');
  input.value = '';
  input.focus();
  run();
}

function close() {
  getDom().searchDialog.classList.add('hidden');
}

async function go(result) {
  if (!result) return;
  close();
  await navigate(result.boardId, { focus: result.elementId });
  if (result.type === 'comment') openComments(result.elementId);
}

// With nothing typed the list offers every other board, most recently changed first
function otherBoards() {
  const { outline, currentBoard } = getState();
  const nameOf = (id) => id === HOME_ID ? 'Home' : outline.get(id)?.name || 'Board';
  return [...outline.values()]
    .filter(board => board.id !== currentBoard?.id)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(board => {
      const path = [];
      for (let up = board.parent; up && path.length < 50; up = outline.get(up)?.parent) path.unshift(nameOf(up));
      return { type: 'board', boardId: board.id, text: nameOf(board.id), path };
    });
}

async function run() {
  const query = input.value.trim();
  const mine = ++latest;
  let found = [];
  let failed = false;
  try {
    found = query ? await api.search(query) : otherBoards();
  } catch {
    failed = true;
  }
  if (mine !== latest) return; // a newer keystroke is already being answered

  results = found;
  if (failed) {
    list.innerHTML = '<div class="search-note">Search is not available. If the app was just updated, restart the server.</div>';
  } else if (!results.length) {
    list.innerHTML = `<div class="search-note">${query ? 'Nothing found' : 'Type to search every board'}</div>`;
  } else {
    list.innerHTML = (query ? '' : '<div class="search-heading">Boards</div>') +
      results.map((result, index) => row(result, index, query)).join('');
  }
  setActive(0);
}

function row(result, index, query) {
  return `<div class="search-row" data-index="${index}">
    ${icon(ICONS[result.type] || 'note')}
    <span class="search-text">${highlight(result.text, query)}</span>
    <span class="search-path">${escapeHtml(result.path.join(' / '))}</span>
  </div>`;
}

function highlight(text, query) {
  const at = query ? fold(text).indexOf(fold(query)) : -1;
  if (at < 0) return escapeHtml(text);
  const end = at + query.length;
  return `${escapeHtml(text.slice(0, at))}<mark>${escapeHtml(text.slice(at, end))}</mark>${escapeHtml(text.slice(end))}`;
}

function setActive(index) {
  const rows = list.querySelectorAll('.search-row');
  active = Math.max(0, Math.min(index, rows.length - 1));
  rows.forEach((node, i) => node.classList.toggle('active', i === active));
  rows[active]?.scrollIntoView({ block: 'nearest' });
}
