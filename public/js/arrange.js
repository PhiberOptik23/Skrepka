// Keeping a board tidy: while dragged, cards snap to the grid or to each other (with guide
// lines), and a selection can be aligned or spaced out evenly.

import { getState, getDom, renderAllConnections, saveBoard } from './app.js';

export const GRID = 24;    // the dot grid's spacing, in board units
const SNAP_DISTANCE = 6;   // how close (in screen pixels) an edge must come to catch on another card

let gridSnap = false;
let guides, bar;

export const snapsToGrid = () => gridSnap;
export const toGrid = (value) => Math.round(value / GRID) * GRID;

// --- Snapping to other cards ---

// The cards a dragged group can line up with (free cards that are not being dragged)
export function snapTargets(draggedIds) {
  return [...getDom().elementsLayer.children]
    .filter(node => node.classList.contains('card') && !draggedIds.has(node.dataset.id))
    .map(boxOf);
}

const boxOf = (node) => ({ x: node.offsetLeft, y: node.offsetTop, w: node.offsetWidth, h: node.offsetHeight });

// The three places on a box that can line up along one axis: start, middle, end
const stops = (start, size) => [start, start + size / 2, start + size];

// Given where a dragged box would be, find the small shift that brings an edge or the centre
// in line with a nearby card, and draw guide lines for whatever lines up after it.
// Returns the shift as { dx, dy }.
export function snapToCards(box, targets) {
  const reach = SNAP_DISTANCE / getState().zoom;
  const closest = (mine, theirs) => {
    let best = null;
    for (const a of mine) for (const b of theirs) {
      if (Math.abs(b - a) <= reach && (best === null || Math.abs(b - a) < Math.abs(best))) best = b - a;
    }
    return best;
  };

  const dx = closest(stops(box.x, box.w), targets.flatMap(t => stops(t.x, t.w))) ?? 0;
  const dy = closest(stops(box.y, box.h), targets.flatMap(t => stops(t.y, t.h))) ?? 0;
  const snapped = { ...box, x: box.x + dx, y: box.y + dy };

  clearGuides();
  for (const t of targets) {
    // Vertical guide where an x of ours meets an x of theirs; it spans both cards
    for (const x of stops(t.x, t.w)) {
      if (stops(snapped.x, snapped.w).some(mine => Math.abs(mine - x) < 0.5)) {
        const top = Math.min(snapped.y, t.y);
        drawGuide('v', x, top, Math.max(snapped.y + snapped.h, t.y + t.h) - top);
      }
    }
    for (const y of stops(t.y, t.h)) {
      if (stops(snapped.y, snapped.h).some(mine => Math.abs(mine - y) < 0.5)) {
        const left = Math.min(snapped.x, t.x);
        drawGuide('h', y, left, Math.max(snapped.x + snapped.w, t.x + t.w) - left);
      }
    }
  }
  return { dx, dy };
}

function drawGuide(direction, at, from, length) {
  const line = document.createElement('div');
  line.className = `guide guide-${direction}`;
  if (direction === 'v') Object.assign(line.style, { left: at + 'px', top: from + 'px', height: length + 'px' });
  else Object.assign(line.style, { top: at + 'px', left: from + 'px', width: length + 'px' });
  guides.appendChild(line);
}

export function clearGuides() {
  guides.replaceChildren();
}

// --- Align / distribute a selection ---

// Selected cards that can be moved freely (a card inside a column is placed by the column)
function movable() {
  const { currentBoard, selectedElements } = getState();
  if (!currentBoard) return [];
  return [...getDom().elementsLayer.children]
    .filter(node => node.classList.contains('card') && selectedElements.has(node.dataset.id))
    .map(node => ({ node, el: currentBoard.elements.find(e => e.id === node.dataset.id), ...boxOf(node) }))
    .filter(item => item.el);
}

function moveTo(item, x, y) {
  item.el.x = x;
  item.el.y = y;
  item.node.style.left = x + 'px';
  item.node.style.top = y + 'px';
}

function alignSelection(edge) {
  const items = movable();
  if (items.length < 2) return;
  const left = Math.min(...items.map(i => i.x));
  const right = Math.max(...items.map(i => i.x + i.w));
  const top = Math.min(...items.map(i => i.y));
  const bottom = Math.max(...items.map(i => i.y + i.h));
  for (const item of items) {
    switch (edge) {
      case 'left': moveTo(item, left, item.y); break;
      case 'center': moveTo(item, (left + right) / 2 - item.w / 2, item.y); break;
      case 'right': moveTo(item, right - item.w, item.y); break;
      case 'top': moveTo(item, item.x, top); break;
      case 'middle': moveTo(item, item.x, (top + bottom) / 2 - item.h / 2); break;
      case 'bottom': moveTo(item, item.x, bottom - item.h); break;
    }
  }
  renderAllConnections();
  saveBoard();
}

// Equal gaps between the cards; the outermost two stay where they are
function distributeSelection(axis) {
  const [pos, size] = axis === 'x' ? ['x', 'w'] : ['y', 'h'];
  const items = movable().sort((a, b) => a[pos] - b[pos]);
  if (items.length < 3) return;
  const first = items[0];
  const last = items.at(-1);
  const free = (last[pos] + last[size] - first[pos]) - items.reduce((sum, i) => sum + i[size], 0);
  const gap = free / (items.length - 1);
  let at = first[pos];
  for (const item of items) {
    if (axis === 'x') moveTo(item, at, item.y);
    else moveTo(item, item.x, at);
    at += item[size] + gap;
  }
  renderAllConnections();
  saveBoard();
}

// The align bar shows while two or more free cards are selected
export function updateArrangeBar() {
  if (!bar) return;
  const count = movable().length;
  bar.classList.toggle('hidden', count < 2);
  bar.querySelectorAll('[data-distribute]').forEach(button => { button.disabled = count < 3; });
}

// --- Init ---

export function initArrange() {
  guides = document.querySelector('#guides-layer');
  bar = document.querySelector('#arrange-bar');

  bar.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.dataset.align) alignSelection(button.dataset.align);
    else if (button.dataset.distribute) distributeSelection(button.dataset.distribute);
  });

  // Snap to grid is a preference of this browser, not of a board
  const toggle = document.querySelector('#btn-snap-grid');
  const apply = (on) => {
    gridSnap = on;
    toggle.classList.toggle('active', on);
    toggle.setAttribute('aria-pressed', on);
  };
  try { apply(localStorage.getItem('snapGrid') === 'on'); } catch { apply(false); }
  toggle.addEventListener('click', () => {
    toggle.blur(); // no focus ring left behind once a key is pressed
    apply(!gridSnap);
    try { localStorage.setItem('snapGrid', gridSnap ? 'on' : 'off'); } catch {}
  });
}
