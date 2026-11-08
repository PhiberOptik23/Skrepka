// The board tree: every board that can be reached from Home, as an outline to jump around in.
// Hidden until asked for; once opened it stays open (across boards and reloads) until closed.

import { getState, navigate, HOME_ID } from './app.js';
import { escapeHtml, icon } from './utils.js';

let panel, list, button;
let collapsed = new Set(); // ids of boards whose sub-boards are folded away

const remembered = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch {} };

export function initTree() {
  panel = document.querySelector('#tree-panel');
  list = panel.querySelector('#tree-list');
  button = document.querySelector('#btn-tree');
  try { collapsed = new Set(JSON.parse(remembered('treeCollapsed') || '[]')); } catch {}

  const setOpen = (open) => {
    panel.classList.toggle('hidden', !open);
    button.classList.toggle('active', open);
    remember('tree', open ? 'open' : 'closed');
    renderTree();
  };
  button.addEventListener('click', () => {
    button.blur();
    setOpen(panel.classList.contains('hidden'));
  });
  setOpen(remembered('tree') === 'open');

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    if (e.target.closest('.tree-toggle')) {
      if (!collapsed.delete(row.dataset.id)) collapsed.add(row.dataset.id);
      remember('treeCollapsed', JSON.stringify([...collapsed]));
      renderTree();
    } else {
      navigate(row.dataset.id);
    }
  });
}

// Redraw from the outline (called whenever the outline or the open board changes)
export function renderTree() {
  if (!panel || panel.classList.contains('hidden')) return;
  const { outline, currentBoard } = getState();
  if (!outline.has(HOME_ID)) {
    list.innerHTML = '<div class="tree-note">The board tree is not available. If the app was just updated, restart the server.</div>';
    return;
  }

  const children = new Map();
  for (const board of outline.values()) {
    if (!board.parent) continue;
    if (!children.has(board.parent)) children.set(board.parent, []);
    children.get(board.parent).push(board);
  }
  // Never hide the board that is open behind a folded branch
  for (let up = outline.get(currentBoard?.id)?.parent; up; up = outline.get(up)?.parent) collapsed.delete(up);

  const rows = [];
  const walk = (board, depth) => {
    const kids = children.get(board.id) || [];
    rows.push(row(board, depth, kids.length > 0, board.id === currentBoard?.id));
    if (!collapsed.has(board.id)) kids.forEach(kid => walk(kid, depth + 1));
  };
  walk(outline.get(HOME_ID), 0);

  list.innerHTML = rows.join('') +
    (outline.size > 1 ? '' : '<div class="tree-note">No other boards yet. Add one with the Board tool on the left.</div>');
}

function row(board, depth, hasChildren, current) {
  const home = board.id === HOME_ID;
  const picture = home ? icon('home')
    : board.customIcon ? `<img src="${escapeHtml(board.customIcon)}" alt="">`
    : escapeHtml(board.icon || '📋');
  const toggle = hasChildren
    ? `<button class="tree-toggle${collapsed.has(board.id) ? '' : ' open'}" aria-label="Fold or unfold">${icon('chevron')}</button>`
    : '<span class="tree-toggle"></span>';
  return `<div class="tree-row${current ? ' current' : ''}" data-id="${escapeHtml(board.id)}" style="padding-left: ${6 + depth * 16}px">
    ${toggle}
    <span class="tree-icon">${picture}</span>
    <span class="tree-name">${escapeHtml(home ? 'Home' : board.name || 'Untitled')}</span>
  </div>`;
}
