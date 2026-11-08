// Columns. A card dragged out of a column becomes a free card again, and a card dropped on a
// column lands at the spot it was dropped, so dragging within a column reorders it.

import { getState, getDom, elementBox, renderBoard, saveBoard, selectElement } from './app.js';
import { createElementData } from './elements.js';

const find = (id) => getState().currentBoard.elements.find(el => el.id === id);

// The column a card sits in, if any
export function columnOf(id) {
  return getState().currentBoard.elements.find(el => el.type === 'column' && el.children?.includes(id)) || null;
}

// Take a card out of its column and leave it, as a free card, exactly where it is on screen.
// When several cards leave at once, measure them all first and pass each its `box`: every
// card that leaves lets the ones below it slide up.
export function liftFromColumn(el, box = elementBox(el)) {
  const column = columnOf(el.id);
  if (!column) return;
  const { elementsLayer } = getDom();
  const node = elementsLayer.querySelector(`[data-id="${el.id}"]`);
  const { x, y } = box;

  column.children = column.children.filter(id => id !== el.id);
  el.x = x;
  el.y = y;
  if (node) {
    delete node.dataset.parentColumn;
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    elementsLayer.appendChild(node);
  }
}

// A column that is being deleted lets go of its cards where they are
export function releaseColumn(column) {
  const cards = (column.children || []).map(find).filter(Boolean);
  const boxes = cards.map(el => elementBox(el));
  cards.forEach((el, i) => liftFromColumn(el, boxes[i]));
}

// Put cards into a column, at a position among the cards already in it
export function insertIntoColumn(columnId, ids, index) {
  const board = getState().currentBoard;
  const column = find(columnId);
  if (!column) return;
  // Columns do not nest
  const moving = ids.filter(id => find(id) && find(id).type !== 'column');

  for (const other of board.elements) {
    if (other.type === 'column' && other.children) {
      other.children = other.children.filter(id => !moving.includes(id));
    }
  }
  column.children ??= [];
  column.children.splice(Math.min(index, column.children.length), 0, ...moving);

  renderBoard({ instant: true });
  moving.forEach(id => selectElement(id, true));
  saveBoard();
}

// The "Add note" row at the foot of a column: a new note, already in the column and ready to type in
export function addNoteToColumn(column) {
  const state = getState();
  const note = createElementData('note', { zIndex: ++state.maxZIndex });
  state.currentBoard.elements.push(note);
  (column.children ??= []).push(note.id);

  renderBoard({ instant: true });
  saveBoard();
  getDom().elementsLayer.querySelector(`[data-id="${note.id}"] .note-content`)
    ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
}

// --- Dropping onto a column ---

// The column under the pointer and the position among its cards where a drop would land.
// `draggedIds` are skipped: the cards being dragged are neither a target nor in the way.
export function columnDropAt(clientX, clientY, draggedIds) {
  const node = document.elementsFromPoint(clientX, clientY)
    .find(n => n.classList?.contains('card-column') && !draggedIds.has(n.dataset.id));
  if (!node) return null;

  const cards = [...node.querySelector('.column-body').children]
    .filter(n => n.classList.contains('card') && !draggedIds.has(n.dataset.id));
  let index = cards.findIndex(n => {
    const rect = n.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2;
  });
  if (index < 0) index = cards.length;
  return { id: node.dataset.id, node, cards, index };
}

let marked = null; // the column currently showing where a drop would land, and its line

export function showColumnDrop(drop) {
  if (marked?.node !== drop.node) {
    clearColumnDrop();
    const line = document.createElement('div');
    line.className = 'column-drop-line';
    drop.node.appendChild(line);
    drop.node.classList.add('drop-target');
    marked = { node: drop.node, line };
  }
  // In the gap above the card it would go before, or under the last card
  const before = drop.cards[drop.index];
  const last = drop.cards.at(-1);
  const body = drop.node.querySelector('.column-body');
  const y = before ? before.offsetTop - 6
    : last ? last.offsetTop + last.offsetHeight + 3
    : body.offsetTop + 2;
  marked.line.style.top = y + 'px';
}

export function clearColumnDrop() {
  if (!marked) return;
  marked.line.remove();
  marked.node.classList.remove('drop-target');
  marked = null;
}
