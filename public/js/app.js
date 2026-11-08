import { api } from './api.js';
import { uuid, clamp, CARD_COLORS, isLightColor, applyCardColor, boardHasFocus, cloneCards } from './utils.js';
import { renderElement, createElementData, pickBoardIcon } from './elements.js';
import { initInteractions } from './interactions.js';
import { initConnections, renderCurveHandles, clearCurveHandles } from './connections.js';
import { initHistory, trackBoard, recordSoon, recordNow, undo } from './history.js';
import { initClipboard } from './clipboard.js';
import { initSearch } from './search.js';
import { initTrash, refreshTrash } from './trash.js';
import { initArrange, updateArrangeBar, snapsToGrid, toGrid } from './arrange.js';
import { releaseColumn } from './columns.js';
import { initComments, openComments, closeComments } from './comments.js';
import { initTree, renderTree } from './tree.js';
import { toast } from './toast.js';
import { addFiles, pickFiles } from './uploads.js';

export const HOME_ID = '__home__';
const DEFAULT_BG = '#f4f5f5';
// The canvas used to start below a 52px top bar and right of a 60px sidebar
const LEGACY_INSET = { x: 60, y: 52 };

// --- State ---
const state = {
  currentBoard: null,
  // Boards reachable from Home: id -> { id, name, icon, parent, updatedAt }
  outline: new Map(),
  selectedElements: new Set(),
  selectedConnection: null,
  zoom: 1, panX: 0, panY: 0,
  isPanning: false,
  isLineMode: false,
  lineFirstClick: null, // {elementId} for two-click line creation
  maxZIndex: 1
};

export function getState() { return state; }

// --- DOM ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  viewport: $('#board-viewport'),
  canvas: $('#board-canvas'),
  elementsLayer: $('#elements-layer'),
  connectionsLayer: $('#connections-layer'),
  breadcrumb: $('#breadcrumb'),
  boardTitle: $('#board-title'),
  zoomLevel: $('#zoom-level'),
  contextMenu: $('#context-menu'),
  formatToolbar: $('#format-toolbar'),
  settingsPanel: $('#board-settings-panel'),
  themePanel: $('#theme-panel'),
  linePanel: $('#line-style-panel'),
  trashPanel: $('#trash-panel'),
  linkDialog: $('#link-dialog'),
  colorDialog: $('#color-dialog'),
  searchDialog: $('#search-dialog'),
};

export function getDom() { return dom; }

// --- Board Management ---

async function ensureHomeBoard() {
  try {
    return await api.getBoard(HOME_ID);
  } catch {
    const board = {
      id: HOME_ID,
      name: 'Home',
      icon: '🏠',
      backgroundColor: '#f4f5f5',
      viewport: { x: 0, y: 0, zoom: 1 },
      elements: [],
      connections: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      parentId: null
    };
    // PUT, because POST would give it a random id
    await api.saveBoard(board);
    return board;
  }
}

let openTicket = 0;

// Load a board into the canvas. To move between boards use navigate(), which also keeps the address in step.
export async function openBoard(id) {
  const ticket = ++openTicket;
  // Finish with the board being left: close its undo step and write any edit still waiting to be saved
  recordNow();
  await flushSave();
  await pendingRename;

  let board;
  try {
    board = await api.getBoard(id);
  } catch (err) {
    console.error('Failed to open board:', err);
    if (id !== HOME_ID && ticket === openTicket) {
      toast('That board no longer exists');
      await navigate(HOME_ID, { replace: true });
    }
    return;
  }
  // The outline only feeds breadcrumbs and card names; the board opens without it
  const outline = await api.getOutline().catch(() => null);
  if (ticket !== openTicket) return; // a newer navigation overtook this one

  if (outline) state.outline = new Map(outline.map(entry => [entry.id, entry]));
  // A board card shows the board's own name and icon, which may have been changed from inside it
  for (const el of board.elements) {
    const target = el.type === 'board' && state.outline.get(el.content?.boardId);
    if (!target) continue;
    el.content.name = target.name;
    if (target.icon) el.content.icon = target.icon;
  }

  state.currentBoard = board;
  state.maxZIndex = Math.max(1, ...board.elements.map(e => e.zIndex || 1));

  // Views saved before the canvas went full-bleed are shifted so they open on the same spot
  const legacy = !board.viewport?.fullBleed;
  state.zoom = board.viewport?.zoom || 1;
  state.panX = (board.viewport?.x || 0) + (legacy ? LEGACY_INSET.x : 0);
  state.panY = (board.viewport?.y || 0) + (legacy ? LEGACY_INSET.y : 0);
  updateTransform();

  applyBoardBackground(board.backgroundColor);

  renderBoard();
  trackBoard(board);
  updateBreadcrumb();
  updateBoardTitle();
  renderTree();
}

// Re-read which boards exist and how they nest (after one was added, restored or deleted)
export async function refreshOutline() {
  await flushSave(); // the outline is read from what is saved
  const outline = await api.getOutline().catch(() => null);
  if (!outline) return;
  state.outline = new Map(outline.map(entry => [entry.id, entry]));
  renderTree();
}

// The default background follows the theme; a custom one also sets the tone of text drawn on the canvas
function applyBoardBackground(color) {
  const custom = !!color && color.toLowerCase() !== DEFAULT_BG;
  const root = document.documentElement;
  if (custom) {
    dom.viewport.style.setProperty('--board-bg', color);
    dom.viewport.dataset.tone = isLightColor(color) ? 'light' : 'dark';
    // The glass theme is see-through, so its panels have to match the board rather than the wallpaper
    root.dataset.boardTone = dom.viewport.dataset.tone;
  } else {
    dom.viewport.style.removeProperty('--board-bg');
    delete dom.viewport.dataset.tone;
    delete root.dataset.boardTone;
  }
}

// `instant` skips the cards' appear animation (a redraw of a board that is already on screen)
export function renderBoard({ instant = false } = {}) {
  dom.elementsLayer.innerHTML = '';
  dom.connectionsLayer.innerHTML = '';
  clearCurveHandles();
  state.selectedElements.clear();
  state.selectedConnection = null;
  closeComments();
  updateArrangeBar();

  if (!state.currentBoard) return;

  const columnChildIds = new Set();
  for (const el of state.currentBoard.elements) {
    if (el.type === 'column' && el.children) {
      el.children.forEach(id => columnChildIds.add(id));
    }
  }

  for (const el of state.currentBoard.elements) {
    if (!columnChildIds.has(el.id)) {
      const node = renderElement(el, state.currentBoard);
      if (!node) continue;
      if (instant) node.classList.add('no-appear');
      dom.elementsLayer.appendChild(node);
    }
  }

  renderAllConnections();
}

export function renderAllConnections() {
  if (!state.currentBoard) return;
  dom.connectionsLayer.innerHTML = '';
  // Labels live on the elements layer, so they have to be cleared separately
  dom.elementsLayer.querySelectorAll('.conn-label').forEach(label => label.remove());
  clearCurveHandles();

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  dom.connectionsLayer.appendChild(defs);

  for (const conn of state.currentBoard.connections) {
    renderConnection(conn);
  }

  if (state.selectedConnection) {
    renderCurveHandles(state.selectedConnection);
  }
}

function renderConnection(conn) {
  const fromEl = state.currentBoard.elements.find(e => e.id === conn.from?.elementId);
  const toEl = state.currentBoard.elements.find(e => e.id === conn.to?.elementId);
  if (!fromEl || !toEl) return;

  const fromPos = getAnchorPos(fromEl, conn.from.anchor);
  const toPos = getAnchorPos(toEl, conn.to.anchor);

  const style = conn.style || {};
  const color = style.color || '#a0a4ab';
  const width = style.width || 2;
  const dashed = style.dashed ? '8,4' : 'none';
  const hasArrow = style.arrow !== false;

  const markerId = `arrow-${conn.id}`;
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', markerId);
  marker.setAttribute('markerWidth', '10');
  marker.setAttribute('markerHeight', '7');
  marker.setAttribute('refX', '10');
  marker.setAttribute('refY', '3.5');
  marker.setAttribute('orient', 'auto');
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  poly.setAttribute('points', '0 0, 10 3.5, 0 7');
  poly.setAttribute('fill', color);
  marker.appendChild(poly);
  dom.connectionsLayer.querySelector('defs')?.appendChild(marker);

  const cx = conn.curveOffset?.x || 0;
  const cy = conn.curveOffset?.y || 0;
  const midX = (fromPos.x + toPos.x) / 2 + cx;
  const midY = (fromPos.y + toPos.y) / 2 + cy;

  const d = `M ${fromPos.x} ${fromPos.y} Q ${midX} ${midY} ${toPos.x} ${toPos.y}`;

  const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  hitPath.setAttribute('d', d);
  hitPath.setAttribute('class', 'conn-hitarea');
  hitPath.dataset.connId = conn.id;

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', state.selectedConnection === conn.id ? width + 1.5 : width);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke-dasharray', dashed);
  if (hasArrow) path.setAttribute('marker-end', `url(#${markerId})`);
  path.dataset.connId = conn.id;

  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  group.dataset.connId = conn.id;
  group.appendChild(hitPath);
  group.appendChild(path);

  if (conn.label) {
    const labelDiv = document.createElement('div');
    labelDiv.className = 'conn-label';
    labelDiv.textContent = conn.label;
    labelDiv.style.left = midX + 'px';
    labelDiv.style.top = midY + 'px';
    labelDiv.dataset.connId = conn.id;
    dom.elementsLayer.appendChild(labelDiv);
  }

  hitPath.addEventListener('click', (e) => {
    e.stopPropagation();
    selectConnection(conn.id);
  });

  dom.connectionsLayer.appendChild(group);
}

// Where a card is on the board and how big, measured from the page when it is drawn.
// Stored x/y only hold for free cards (one inside a column is placed by the column),
// and stored sizes go stale as content reflows.
export function elementBox(el) {
  const node = dom.elementsLayer.querySelector(`[data-id="${el.id}"]`);
  if (!node) return { x: el.x, y: el.y, w: el.width || 200, h: el.height || 100 };
  let x = 0;
  let y = 0;
  for (let box = node; box && box !== dom.elementsLayer; box = box.offsetParent) {
    x += box.offsetLeft;
    y += box.offsetTop;
  }
  return { x, y, w: node.offsetWidth, h: node.offsetHeight };
}

export function getAnchorPos(el, anchor) {
  const { x, y, w, h } = elementBox(el);
  switch (anchor) {
    case 'top':    return { x: x + w / 2, y };
    case 'bottom': return { x: x + w / 2, y: y + h };
    case 'left':   return { x,            y: y + h / 2 };
    case 'right':  return { x: x + w,     y: y + h / 2 };
    default:       return { x: x + w / 2, y: y + h / 2 };
  }
}

function selectConnection(connId) {
  clearSelection();
  state.selectedConnection = connId;

  const conn = state.currentBoard.connections.find(c => c.id === connId);
  if (conn) {
    const style = conn.style || {};
    $('#line-color').value = style.color || '#a0a4ab';
    $('#line-width').value = String(style.width || 2);
    $('#line-dashed').checked = !!style.dashed;
    $('#line-arrow').checked = style.arrow !== false;
    $('#line-label').value = conn.label || '';
    dom.linePanel.classList.remove('hidden');
  }

  renderAllConnections();
}

// --- Viewport ---

function updateTransform() {
  dom.canvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  dom.canvas.style.setProperty('--zoom', state.zoom); // lets guide lines stay one screen pixel thin
  dom.zoomLevel.textContent = Math.round(state.zoom * 100) + '%';

  // Dot grid follows the canvas; spacing doubles/halves so it never gets too dense or too sparse
  let grid = 24 * state.zoom;
  while (grid < 16) grid *= 2;
  while (grid > 48) grid /= 2;
  dom.viewport.style.setProperty('--grid-size', grid + 'px');
  dom.viewport.style.setProperty('--grid-x', state.panX + 'px');
  dom.viewport.style.setProperty('--grid-y', state.panY + 'px');
}

function zoomAtCenter(newZoom) {
  const vpRect = dom.viewport.getBoundingClientRect();
  zoomTo(newZoom, vpRect.left + vpRect.width / 2, vpRect.top + vpRect.height / 2);
}

function zoomTo(newZoom, centerX, centerY) {
  newZoom = clamp(newZoom, 0.1, 5);
  if (centerX !== undefined && centerY !== undefined) {
    const vpRect = dom.viewport.getBoundingClientRect();
    const cx = centerX - vpRect.left;
    const cy = centerY - vpRect.top;
    state.panX = cx - (cx - state.panX) * (newZoom / state.zoom);
    state.panY = cy - (cy - state.panY) * (newZoom / state.zoom);
  }
  state.zoom = newZoom;
  updateTransform();
  saveViewport();
}

function zoomToFit() {
  if (!state.currentBoard || state.currentBoard.elements.length === 0) {
    state.zoom = 1; state.panX = 0; state.panY = 0;
    updateTransform(); return;
  }
  const els = state.currentBoard.elements;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of els) {
    const box = elementBox(el);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  const pad = 80;
  const vpRect = dom.viewport.getBoundingClientRect();
  const contentW = maxX - minX + pad * 2;
  const contentH = maxY - minY + pad * 2;
  const zoom = clamp(Math.min(vpRect.width / contentW, vpRect.height / contentH), 0.1, 2);
  state.zoom = zoom;
  state.panX = (vpRect.width - contentW * zoom) / 2 - (minX - pad) * zoom;
  state.panY = (vpRect.height - contentH * zoom) / 2 - (minY - pad) * zoom;
  updateTransform();
  saveViewport();
}

// --- Selection ---

export function clearSelection() {
  state.selectedElements.forEach(id => {
    const el = dom.elementsLayer.querySelector(`[data-id="${id}"]`);
    if (el) el.classList.remove('selected');
  });
  state.selectedElements.clear();
  state.selectedConnection = null;
  state.lineFirstClick = null;
  dom.linePanel.classList.add('hidden');
  dom.formatToolbar.classList.add('hidden');
  clearCurveHandles();
  updateArrangeBar();
}

export function selectElement(id, addToSelection = false) {
  if (!addToSelection) clearSelection();
  state.selectedElements.add(id);
  const el = dom.elementsLayer.querySelector(`[data-id="${id}"]`);
  if (el) el.classList.add('selected');
  updateArrangeBar();
}

// --- Element CRUD ---

export function addElement(type, extraData = {}) {
  if (!state.currentBoard) return null;

  const vpRect = dom.viewport.getBoundingClientRect();
  const centerX = (vpRect.width / 2 - state.panX) / state.zoom;
  const centerY = (vpRect.height / 2 - state.panY) / state.zoom;

  const el = createElementData(type, {
    x: extraData.x ?? (centerX - 60),
    y: extraData.y ?? (centerY - 60),
    zIndex: ++state.maxZIndex,
    ...extraData
  });
  if (snapsToGrid()) {
    el.x = toGrid(el.x);
    el.y = toGrid(el.y);
  }

  state.currentBoard.elements.push(el);

  const node = renderElement(el, state.currentBoard);
  if (node) dom.elementsLayer.appendChild(node);

  saveBoard();
  return el;
}

// Add ready-made elements (a paste), along with any lines between them, and select them
export function addElements(elements, connections = []) {
  if (!state.currentBoard) return;
  for (const el of elements) el.zIndex = ++state.maxZIndex;
  state.currentBoard.elements.push(...elements);
  state.currentBoard.connections.push(...connections);

  const inColumn = new Set(elements.flatMap(el => el.children || []));
  clearSelection();
  for (const el of elements) {
    if (inColumn.has(el.id)) continue; // drawn by its column
    const node = renderElement(el, state.currentBoard);
    if (node) dom.elementsLayer.appendChild(node);
    selectElement(el.id, true);
  }
  renderAllConnections();
  saveBoard();
}

export function updateElement(id, updates) {
  if (!state.currentBoard) return;
  const el = state.currentBoard.elements.find(e => e.id === id);
  if (!el) return;
  Object.assign(el, updates);
  saveBoard();
}

// Redraw one card after its data changed underneath it
export function refreshElement(id) {
  const el = state.currentBoard?.elements.find(e => e.id === id);
  const node = dom.elementsLayer.querySelector(`[data-id="${id}"]`);
  if (!el || !node) return;
  const fresh = renderElement(el, state.currentBoard);
  fresh.classList.add('no-appear');
  fresh.classList.toggle('selected', state.selectedElements.has(id));
  if (node.dataset.parentColumn) fresh.dataset.parentColumn = node.dataset.parentColumn;
  node.replaceWith(fresh);
  renderAllConnections();
}

// Swap in a whole set of cards and lines (undo and redo)
export function replaceContent(elements, connections) {
  state.currentBoard.elements = elements;
  state.currentBoard.connections = connections;
  state.maxZIndex = Math.max(1, ...elements.map(e => e.zIndex || 1));
  dom.linePanel.classList.add('hidden');
  dom.formatToolbar.classList.add('hidden');
  renderBoard({ instant: true });
  queueSave(500);
}

export function deleteElement(id) {
  if (!state.currentBoard) return;

  // A board card takes its board to the trash, unless another card here still opens that board
  const el = state.currentBoard.elements.find(e => e.id === id);
  if (el?.type === 'board' && el.content?.boardId) {
    const boardId = el.content.boardId;
    const shared = state.currentBoard.elements.some(
      e => e.id !== id && e.type === 'board' && e.content?.boardId === boardId
    );
    if (!shared) {
      api.trashBoard(boardId, el.content).then(() => {
        toast(`“${el.content.name || 'Board'}” moved to the trash`, { action: 'Undo', onAction: undo });
        refreshTrash();
        refreshOutline();
      }).catch(() => {});
    }
  }
  // A column lets go of its cards: they stay on the board where they are
  if (el?.type === 'column') releaseColumn(el);

  for (const e of state.currentBoard.elements) {
    if (e.type === 'column' && e.children) {
      e.children = e.children.filter(cid => cid !== id);
    }
  }

  state.currentBoard.connections = state.currentBoard.connections.filter(
    c => c.from?.elementId !== id && c.to?.elementId !== id
  );

  state.currentBoard.elements = state.currentBoard.elements.filter(e => e.id !== id);
  state.selectedElements.delete(id);

  const node = dom.elementsLayer.querySelector(`[data-id="${id}"]`);
  if (node) node.remove();

  closeComments();
  updateArrangeBar();
  renderAllConnections();
  saveBoard();
}

export function duplicateElement(id) {
  const board = state.currentBoard;
  const el = board?.elements.find(e => e.id === id);
  if (!el) return;
  // A column is duplicated together with the cards in it
  const group = [el, ...(el.children || []).map(childId => board.elements.find(e => e.id === childId)).filter(Boolean)];
  // The copy lands a little down and right of where the card is drawn (which, for a card
  // inside a column, is not where its stored x/y say)
  const box = elementBox(el);
  const { elements } = cloneCards(group, [], box.x + 20 - el.x, box.y + 20 - el.y);
  addElements(elements);
}

export function bringToFront(id) {
  const el = state.currentBoard?.elements.find(e => e.id === id);
  if (!el) return;
  el.zIndex = ++state.maxZIndex;
  const node = dom.elementsLayer.querySelector(`[data-id="${id}"]`);
  if (node) node.style.zIndex = el.zIndex;
  saveBoard();
}

export function sendToBack(id) {
  const el = state.currentBoard?.elements.find(e => e.id === id);
  if (!el) return;
  el.zIndex = 0;
  const node = dom.elementsLayer.querySelector(`[data-id="${id}"]`);
  if (node) node.style.zIndex = 0;
  saveBoard();
}

export function setElementColor(id, color) {
  updateElement(id, { color });
  const node = dom.elementsLayer.querySelector(`[data-id="${id}"]`);
  if (node && node.dataset.type !== 'board') applyCardColor(node, color);
  saveBoard();
}

// --- Connections ---

export function addConnection(fromId, fromAnchor, toId, toAnchor) {
  if (!state.currentBoard || fromId === toId) return;

  const conn = {
    id: uuid(),
    from: { elementId: fromId, anchor: fromAnchor },
    to: { elementId: toId, anchor: toAnchor },
    style: { color: '#a0a4ab', width: 2, dashed: false, arrow: true },
    label: '',
    curveOffset: { x: 0, y: 0 }
  };
  state.currentBoard.connections.push(conn);
  renderAllConnections();
  saveBoard();
  return conn;
}

export function deleteConnection(connId) {
  if (!state.currentBoard) return;
  state.currentBoard.connections = state.currentBoard.connections.filter(c => c.id !== connId);
  state.selectedConnection = null;
  dom.linePanel.classList.add('hidden');
  renderAllConnections();
  saveBoard();
}

export function updateConnection(connId, updates) {
  const conn = state.currentBoard?.connections.find(c => c.id === connId);
  if (!conn) return;
  if (updates.style) conn.style = { ...conn.style, ...updates.style };
  if (updates.label !== undefined) conn.label = updates.label;
  if (updates.curveOffset) conn.curveOffset = updates.curveOffset;
  renderAllConnections();
  saveBoard();
}

// --- Auto-anchor: pick best side based on positions ---

export function autoAnchor(fromEl, toEl) {
  const from = elementBox(fromEl);
  const to = elementBox(toEl);
  const dx = (to.x + to.w / 2) - (from.x + from.w / 2);
  const dy = (to.y + to.h / 2) - (from.y + from.h / 2);

  let fromAnchor, toAnchor;
  if (Math.abs(dx) > Math.abs(dy)) {
    fromAnchor = dx > 0 ? 'right' : 'left';
    toAnchor = dx > 0 ? 'left' : 'right';
  } else {
    fromAnchor = dy > 0 ? 'bottom' : 'top';
    toAnchor = dy > 0 ? 'top' : 'bottom';
  }
  return { fromAnchor, toAnchor };
}

// --- Persistence ---

function currentViewport() {
  return { x: state.panX, y: state.panY, zoom: state.zoom, fullBleed: true };
}

// Changes are written a moment after they stop coming, as one request. A save that is running
// is never dropped or doubled up: the next one waits for it, and a failed one is retried.
let saveTimer = null;
let saveInFlight = null;
let dirtyBoard = null; // the board whose changes are not on the server yet
let saveFailing = false;

function queueSave(delay) {
  dirtyBoard = state.currentBoard;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, delay);
}

// Call after any change to the board's cards or lines: records an undo step and saves
export function saveBoard() {
  recordSoon();
  queueSave(500);
}

// Pan and zoom are saved too, but are not something to undo
function saveViewport() {
  queueSave(1000);
}

// Save a change that is not an undo step of its own (see amend() in history.js)
export function saveQuietly() {
  queueSave(500);
}

// Write pending changes right now (before leaving the board, or when the tab is being hidden)
export async function flushSave({ keepalive = false } = {}) {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (saveInFlight) await saveInFlight;
  const board = dirtyBoard;
  if (!board) return;

  dirtyBoard = null;
  if (board === state.currentBoard) board.viewport = currentViewport();
  saveInFlight = api.saveBoard(board, { keepalive })
    .then(() => {
      if (saveFailing) toast('Saving works again');
      saveFailing = false;
    })
    .catch((err) => {
      console.error('Save failed:', err);
      dirtyBoard ??= board; // unless something newer is already waiting
      if (!saveFailing) toast('Could not save. Is the server running?', { duration: 8000 });
      saveFailing = true;
      saveTimer = setTimeout(flushSave, 5000);
    })
    .finally(() => { saveInFlight = null; });
  await saveInFlight;
}

// --- Navigation ---
// Every board has its own address (#/b/<id>), so a reload stays on the board and the
// browser's Back and Forward buttons move between boards.

const boardInAddress = () => location.hash.match(/^#\/b\/([\w-]+)$/)?.[1] || HOME_ID;

// Go to a board; `focus` is the id of a card to bring into view once it is open
export async function navigate(id, { replace = false, focus = null } = {}) {
  const address = id === HOME_ID ? location.pathname + location.search : `#/b/${id}`;
  if (replace) history.replaceState(null, '', address);
  else if (id !== boardInAddress()) history.pushState(null, '', address);
  await openBoard(id);
  if (focus) focusElement(focus);
}

export function openSubBoard(boardId) {
  return navigate(boardId);
}

// The boards above the current one, Home first. A board the outline does not know
// (nothing links to it) still gets a way back Home.
function trail() {
  const id = state.currentBoard?.id;
  if (!id || id === HOME_ID) return [];
  const chain = [];
  for (let up = state.outline.get(id)?.parent; up && chain.length < 50; up = state.outline.get(up)?.parent) {
    chain.unshift({ id: up, name: up === HOME_ID ? 'Home' : state.outline.get(up)?.name || 'Board' });
  }
  return chain.length ? chain : [{ id: HOME_ID, name: 'Home' }];
}

function updateBreadcrumb() {
  dom.breadcrumb.innerHTML = '';
  for (const { id, name } of trail()) {
    const crumb = document.createElement('span');
    crumb.className = 'crumb';
    crumb.textContent = name;
    crumb.addEventListener('click', () => navigate(id));
    dom.breadcrumb.appendChild(crumb);
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '/';
    dom.breadcrumb.appendChild(sep);
  }
  // the current board is not repeated here, its title comes right after the trail
}

function updateBoardTitle() {
  if (!state.currentBoard) return;
  const isHome = state.currentBoard.id === HOME_ID;
  dom.boardTitle.textContent = isHome ? 'Skrepka' : state.currentBoard.name;
  dom.boardTitle.title = isHome ? '' : 'Double-click to rename';
  document.title = isHome ? 'Skrepka' : `${state.currentBoard.name} — Skrepka`;
}

// Rename the board that is open
function setBoardName(name) {
  state.currentBoard.name = name;
  const known = state.outline.get(state.currentBoard.id);
  if (known) known.name = name;
  updateBoardTitle();
  renderTree();
  saveBoard();
}

// A board card was renamed on the canvas: the board itself takes the new name.
// Renames run one at a time, and openBoard waits for them, so a board is never loaded half-renamed.
let pendingRename = Promise.resolve();

export function renameBoard(id, name) {
  pendingRename = pendingRename.then(async () => {
    const board = await api.getBoard(id);
    if (board.name === name) return;
    await api.saveBoard({ ...board, name });
    const known = state.outline.get(id);
    if (known) known.name = name;
    renderTree();
  }).catch(() => {});
  return pendingRename;
}

// Screen position -> board coordinates
export function toBoardPoint(clientX, clientY) {
  const vpRect = dom.viewport.getBoundingClientRect();
  return {
    x: (clientX - vpRect.left - state.panX) / state.zoom,
    y: (clientY - vpRect.top - state.panY) / state.zoom
  };
}

export function viewportCenter() {
  const vpRect = dom.viewport.getBoundingClientRect();
  return toBoardPoint(vpRect.left + vpRect.width / 2, vpRect.top + vpRect.height / 2);
}

// Bring a card to the middle of the screen and select it (search results)
export function focusElement(id) {
  const el = state.currentBoard?.elements.find(e => e.id === id);
  const node = dom.elementsLayer.querySelector(`[data-id="${id}"]`);
  if (!el || !node) return;
  const box = elementBox(el);
  const vpRect = dom.viewport.getBoundingClientRect();
  if (state.zoom < 0.5) state.zoom = 1; // zoomed out too far to read the card
  state.panX = vpRect.width / 2 - (box.x + box.w / 2) * state.zoom;
  state.panY = vpRect.height / 2 - (box.y + box.h / 2) * state.zoom;
  updateTransform();
  saveViewport();
  selectElement(id);
  node.classList.add('no-appear', 'flash');
  node.addEventListener('animationend', () => node.classList.remove('flash'), { once: true });
}

// --- Toolbar ---

function initToolbar() {
  $$('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // don't leave focus on the dock, or the next key press (Esc, Space) shows its focus ring
      btn.blur();
      const tool = btn.dataset.tool;
      if (tool === 'line') { toggleLineMode(); return; }
      handleToolAction(tool);
    });
  });

  $('#btn-zoom-in').addEventListener('click', () => zoomAtCenter(state.zoom * 1.2));
  $('#btn-zoom-out').addEventListener('click', () => zoomAtCenter(state.zoom / 1.2));
  $('#btn-zoom-fit').addEventListener('click', zoomToFit);
  dom.zoomLevel.addEventListener('click', () => zoomAtCenter(1));

  $('#btn-home').addEventListener('click', () => navigate(HOME_ID));

  initTheme();

  dom.boardTitle.addEventListener('dblclick', () => {
    if (state.currentBoard?.id === HOME_ID) return;
    dom.boardTitle.contentEditable = 'true';
    dom.boardTitle.focus();
    document.execCommand('selectAll');
  });
  dom.boardTitle.addEventListener('blur', () => {
    dom.boardTitle.contentEditable = 'false';
    if (state.currentBoard && state.currentBoard.id !== HOME_ID) {
      setBoardName(dom.boardTitle.textContent.trim() || 'Untitled');
    }
  });
  dom.boardTitle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); dom.boardTitle.blur(); }
  });

  $('#btn-board-settings').addEventListener('click', () => {
    dom.themePanel.classList.add('hidden');
    dom.settingsPanel.classList.toggle('hidden');
    if (!dom.settingsPanel.classList.contains('hidden') && state.currentBoard) {
      $('#setting-bg-color').value = state.currentBoard.backgroundColor || DEFAULT_BG;
      $('#setting-board-name').value = state.currentBoard.name;
      $('#setting-board-icon').value = state.currentBoard.icon || '📋';
    }
  });
  const setBoardBackground = (color) => {
    if (!state.currentBoard) return;
    state.currentBoard.backgroundColor = color;
    applyBoardBackground(color);
    saveBoard();
  };
  $('#setting-bg-color').addEventListener('input', (e) => setBoardBackground(e.target.value));
  $('#btn-reset-bg').addEventListener('click', () => {
    $('#setting-bg-color').value = DEFAULT_BG;
    setBoardBackground(DEFAULT_BG);
  });
  $('#setting-board-name').addEventListener('input', (e) => {
    if (state.currentBoard) setBoardName(e.target.value);
  });
  $('#setting-board-icon').addEventListener('input', (e) => {
    if (state.currentBoard) {
      state.currentBoard.icon = e.target.value;
      saveBoard();
    }
  });

  $('#btn-export-board').addEventListener('click', () => {
    if (!state.currentBoard) return;
    const blob = new Blob([JSON.stringify(state.currentBoard, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.currentBoard.name}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#btn-import-board').addEventListener('click', () => $('#import-file-input').click());
  $('#import-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      data.id = uuid();
      data.parentId = state.currentBoard.id;
      const board = await api.createBoard(data);
      await api.saveBoard({ ...data, id: board.id });
      addElement('board', { content: { boardId: board.id, name: data.name || 'Imported', icon: data.icon || '📋' } });
    } catch { alert('Invalid board file'); }
    e.target.value = '';
  });

  $('#line-color').addEventListener('input', () => updateSelectedLineStyle());
  $('#line-width').addEventListener('change', () => updateSelectedLineStyle());
  $('#line-dashed').addEventListener('change', () => updateSelectedLineStyle());
  $('#line-arrow').addEventListener('change', () => updateSelectedLineStyle());
  $('#line-label').addEventListener('input', () => {
    if (state.selectedConnection) {
      updateConnection(state.selectedConnection, { label: $('#line-label').value });
    }
  });

  $('#link-cancel').addEventListener('click', () => dom.linkDialog.classList.add('hidden'));
  $('#link-submit').addEventListener('click', submitLink);
  $('#link-url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitLink();
    if (e.key === 'Escape') dom.linkDialog.classList.add('hidden');
  });

  $('#color-cancel').addEventListener('click', () => dom.colorDialog.classList.add('hidden'));
  $('#color-submit').addEventListener('click', submitColorSwatch);
  $('#swatch-color-input').addEventListener('input', (e) => {
    $('#swatch-color-hex').value = e.target.value;
  });
  $('#swatch-color-hex').addEventListener('input', (e) => {
    if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
      $('#swatch-color-input').value = e.target.value;
    }
  });

  // Clicking the dimmed backdrop closes a dialog
  [dom.linkDialog, dom.colorDialog].forEach(overlay => {
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });

  $$('#format-toolbar button').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const cmd = btn.dataset.cmd;
      if (!cmd) return;
      if (cmd.includes(':')) {
        const [c, val] = cmd.split(':');
        document.execCommand(c, false, val);
      } else {
        document.execCommand(cmd, false);
      }
    });
  });
  $('#fmt-text-color').addEventListener('input', (e) => document.execCommand('foreColor', false, e.target.value));
  $('#fmt-highlight').addEventListener('input', (e) => document.execCommand('hiliteColor', false, e.target.value));

  const colorGrid = dom.contextMenu.querySelector('.color-picker-grid');
  CARD_COLORS.forEach((c, i) => {
    const opt = document.createElement('div');
    opt.className = 'color-opt';
    // The first swatch is "default" and is drawn in the theme's own card color
    if (i === 0) { opt.classList.add('color-opt-default'); opt.title = 'Default'; }
    else opt.style.backgroundColor = c;
    opt.addEventListener('click', () => {
      state.selectedElements.forEach(id => setElementColor(id, c));
      dom.contextMenu.classList.add('hidden');
    });
    colorGrid.appendChild(opt);
  });
}

// --- Theme ---
// Auto (follows the system), Light, Dark or Glass; the glass theme also has a choice of wallpaper.
// The saved choice is applied before first paint by the inline script in index.html.

function initTheme() {
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const saved = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const save = (key, value) => {
    try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch {}
  };

  const choices = $$('#theme-panel [data-theme-choice]');
  const wallpapers = $$('#theme-panel [data-wallpaper]');
  const sync = () => {
    const choice = saved('theme') || 'auto';
    root.dataset.theme = choice === 'auto' ? (system.matches ? 'dark' : 'light') : choice;
    const wallpaper = root.dataset.wallpaper || wallpapers[0].dataset.wallpaper;
    choices.forEach(btn => btn.classList.toggle('active', btn.dataset.themeChoice === choice));
    wallpapers.forEach(btn => btn.classList.toggle('active', btn.dataset.wallpaper === wallpaper));
  };

  choices.forEach(btn => btn.addEventListener('click', () => {
    save('theme', btn.dataset.themeChoice === 'auto' ? null : btn.dataset.themeChoice);
    sync();
  }));
  wallpapers.forEach(btn => btn.addEventListener('click', () => {
    root.dataset.wallpaper = btn.dataset.wallpaper;
    save('wallpaper', btn.dataset.wallpaper);
    sync();
  }));
  system.addEventListener('change', sync);

  $('#btn-theme').addEventListener('click', () => {
    dom.settingsPanel.classList.add('hidden');
    dom.themePanel.classList.toggle('hidden');
  });
  sync();
}

function updateSelectedLineStyle() {
  if (!state.selectedConnection) return;
  updateConnection(state.selectedConnection, {
    style: {
      color: $('#line-color').value,
      width: parseInt($('#line-width').value),
      dashed: $('#line-dashed').checked,
      arrow: $('#line-arrow').checked
    }
  });
}

function handleToolAction(tool) {
  switch (tool) {
    case 'note': addElement('note'); break;
    case 'image': pickFiles(viewportCenter(), 'image/*'); break;
    case 'file': pickFiles(viewportCenter()); break;
    case 'todo': addElement('todo'); break;
    case 'link':
      dom.linkDialog.classList.remove('hidden');
      $('#link-url-input').value = '';
      $('#link-url-input').focus();
      break;
    case 'column': addElement('column'); break;
    case 'color':
      dom.colorDialog.classList.remove('hidden');
      $('#swatch-color-input').value = '#F4511C';
      $('#swatch-color-hex').value = '#F4511C';
      break;
    case 'board': createSubBoard(); break;
  }
}

async function submitLink() {
  const url = $('#link-url-input').value.trim();
  if (!url) return;
  dom.linkDialog.classList.add('hidden');
  try {
    const preview = await api.getLinkPreview(url);
    addElement('link', { content: preview, width: 280 });
  } catch {
    addElement('link', { content: { url, title: url, description: '', image: null, siteName: '' }, width: 280 });
  }
}

function submitColorSwatch() {
  const color = $('#swatch-color-input').value;
  dom.colorDialog.classList.add('hidden');
  addElement('color', { content: { color } });
}

async function createSubBoard() {
  const board = await api.createBoard({ name: 'New Board', parentId: state.currentBoard?.id });
  addElement('board', { content: { boardId: board.id, name: board.name } });
  refreshOutline();
}

export function toggleLineMode() {
  state.isLineMode = !state.isLineMode;
  state.lineFirstClick = null;
  $('#btn-line-mode').classList.toggle('active', state.isLineMode);
  dom.viewport.classList.toggle('line-mode', state.isLineMode);
  dom.elementsLayer.querySelectorAll('.card.line-source').forEach(c => c.classList.remove('line-source'));
}

// --- Context Menu ---

export function showContextMenu(x, y, cardId) {
  const hasBoardSelected = [...state.selectedElements].some(id => {
    const el = state.currentBoard?.elements.find(e => e.id === id);
    return el?.type === 'board';
  });
  dom.contextMenu.querySelectorAll('.ctx-board-only').forEach(item => {
    item.style.display = hasBoardSelected ? '' : 'none';
  });

  dom.contextMenu.style.left = x + 'px';
  dom.contextMenu.style.top = y + 'px';
  dom.contextMenu.classList.remove('hidden');

  let rect = dom.contextMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) dom.contextMenu.style.left = (x - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) dom.contextMenu.style.top = (y - rect.height) + 'px';
  // Open the color submenu to the left when there is no room on the right
  rect = dom.contextMenu.getBoundingClientRect();
  dom.contextMenu.classList.toggle('submenu-left', rect.right + 190 > window.innerWidth);

  dom.contextMenu.querySelectorAll('.ctx-item[data-action]').forEach(item => {
    item.onclick = () => {
      const action = item.dataset.action;
      dom.contextMenu.classList.add('hidden');
      if (action === 'color') return;
      if (action === 'comment') {
        // One thread at a time: the card the menu was opened on
        openComments(cardId ?? [...state.selectedElements][0]);
        return;
      }

      state.selectedElements.forEach(id => {
        switch (action) {
          case 'edit': {
            // Editing starts on double-click everywhere, so replay one on the card's text
            const node = dom.elementsLayer.querySelector(`[data-id="${id}"]`);
            const target = node?.querySelector('[contenteditable]') || node;
            target?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            break;
          }
          case 'duplicate': duplicateElement(id); break;
          case 'to-front': bringToFront(id); break;
          case 'to-back': sendToBack(id); break;
          case 'delete': deleteElement(id); break;
          case 'change-icon': {
            const el = state.currentBoard?.elements.find(e => e.id === id);
            if (el?.type === 'board') {
              const cardNode = dom.elementsLayer.querySelector(`[data-id="${id}"]`);
              const iconArea = cardNode?.querySelector('.board-icon-area');
              if (iconArea) pickBoardIcon(el, iconArea);
            }
            break;
          }
        }
      });
      if (state.selectedConnection && action === 'delete') deleteConnection(state.selectedConnection);
    };
  });
}

// --- Zoom/Pan ---

function initZoomPan() {
  dom.viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    closeComments(); // the thread is pinned to where its card was on screen
    // A mouse wheel notch arrives as ±100 (about 10% zoom); trackpads send streams of small
    // deltas, and a trackpad pinch is reported as a wheel event with ctrlKey set
    const delta = clamp(e.deltaY * (e.deltaMode === 1 ? 33 : 1), -200, 200);
    zoomTo(state.zoom * Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.00095)), e.clientX, e.clientY);
  }, { passive: false });

  let panStartX, panStartY, panOrigX, panOrigY;

  document.addEventListener('keydown', (e) => {
    // Shortcuts go by the physical key (e.code), so they also work on a Russian keyboard layout
    const onBoard = boardHasFocus(e.target);
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.code === 'Space' && onBoard) {
      e.preventDefault();
      state.isPanning = true;
      dom.viewport.classList.add('panning');
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && onBoard) {
      state.selectedElements.forEach(id => deleteElement(id));
      if (state.selectedConnection) deleteConnection(state.selectedConnection);
    }
    if (ctrl && e.code === 'KeyA' && onBoard) {
      e.preventDefault();
      state.currentBoard?.elements.forEach(el => selectElement(el.id, true));
    }
    if (ctrl && e.code === 'KeyD' && onBoard) {
      e.preventDefault();
      [...state.selectedElements].forEach(id => duplicateElement(id));
    }
    if (e.key === 'Escape') {
      clearSelection();
      closeComments();
      dom.settingsPanel.classList.add('hidden');
      dom.themePanel.classList.add('hidden');
      dom.trashPanel.classList.add('hidden');
      dom.linePanel.classList.add('hidden');
      dom.linkDialog.classList.add('hidden');
      dom.colorDialog.classList.add('hidden');
      dom.searchDialog.classList.add('hidden');
      dom.contextMenu.classList.add('hidden');
      dom.formatToolbar.classList.add('hidden');
      if (state.isLineMode) toggleLineMode();
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      state.isPanning = false;
      dom.viewport.classList.remove('panning');
    }
  });

  dom.viewport.addEventListener('mousedown', (e) => {
    dom.contextMenu.classList.add('hidden');
    dom.settingsPanel.classList.add('hidden');
    dom.themePanel.classList.add('hidden');
    dom.trashPanel.classList.add('hidden');
    closeComments();

    const onBackground = e.target === dom.viewport || e.target === dom.canvas || e.target === dom.elementsLayer;
    // A click on empty canvas deselects (but in line mode it must not drop the card picked so far)
    if (onBackground && e.button === 0 && !state.isLineMode) clearSelection();

    // Pan by dragging empty canvas, or from anywhere with Space held or the middle button.
    // Shift+drag on empty canvas draws a selection box instead (interactions.js).
    const dragsCanvas = onBackground && e.button === 0 && !e.shiftKey;
    if (e.button === 1) e.preventDefault();
    if (!state.isPanning && e.button !== 1 && !dragsCanvas) return;

    panStartX = e.clientX; panStartY = e.clientY;
    panOrigX = state.panX; panOrigY = state.panY;
    let moved = false;

    const onMove = (e) => {
      if (!moved) {
        moved = true;
        dom.viewport.classList.add('pan-active');
      }
      state.panX = panOrigX + (e.clientX - panStartX);
      state.panY = panOrigY + (e.clientY - panStartY);
      updateTransform();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      dom.viewport.classList.remove('pan-active');
      if (moved) saveViewport();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Touch: one finger pans, two fingers pinch-zoom (cards cannot be dragged by touch yet)
  const fingers = new Map();
  let touchStart = null;
  let touchMoved = false;
  const touchCenter = () => {
    const pts = [...fingers.values()].slice(0, 2);
    return {
      x: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
      y: pts.reduce((sum, p) => sum + p.y, 0) / pts.length,
      spread: pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0
    };
  };
  // Re-anchor whenever a finger lands or lifts, so the view never jumps
  const anchorTouch = () => {
    touchStart = fingers.size ? { ...touchCenter(), panX: state.panX, panY: state.panY, zoom: state.zoom } : null;
  };
  dom.viewport.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || e.target.closest('[contenteditable="true"]')) return;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    anchorTouch();
  });
  dom.viewport.addEventListener('pointermove', (e) => {
    if (!fingers.has(e.pointerId)) return;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = touchCenter();
    const vpRect = dom.viewport.getBoundingClientRect();
    const zoom = touchStart.spread
      ? clamp(touchStart.zoom * now.spread / touchStart.spread, 0.1, 5)
      : touchStart.zoom;
    // Keep the board point that was under the fingers under them
    const boardX = (touchStart.x - vpRect.left - touchStart.panX) / touchStart.zoom;
    const boardY = (touchStart.y - vpRect.top - touchStart.panY) / touchStart.zoom;
    state.zoom = zoom;
    state.panX = now.x - vpRect.left - boardX * zoom;
    state.panY = now.y - vpRect.top - boardY * zoom;
    touchMoved = true;
    updateTransform();
  });
  const endTouch = (e) => {
    if (!fingers.delete(e.pointerId)) return;
    anchorTouch();
    if (!fingers.size && touchMoved) {
      touchMoved = false;
      saveViewport();
    }
  };
  dom.viewport.addEventListener('pointerup', endTouch);
  dom.viewport.addEventListener('pointercancel', endTouch);

  dom.viewport.addEventListener('contextmenu', (e) => e.preventDefault());

  dom.viewport.addEventListener('dragover', (e) => {
    e.preventDefault();
    dom.viewport.classList.add('drag-over');
  });
  dom.viewport.addEventListener('dragleave', () => dom.viewport.classList.remove('drag-over'));
  dom.viewport.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.viewport.classList.remove('drag-over');
    const files = [...e.dataTransfer.files];
    if (files.length) addFiles(files, toBoardPoint(e.clientX, e.clientY));
  });
}

// --- Init ---

async function init() {
  initToolbar();
  initZoomPan();
  initInteractions();
  initConnections();
  initHistory();
  initClipboard();
  initSearch();
  initTrash();
  initArrange();
  initComments();
  initTree();

  // An edit made a moment before the tab is hidden or closed still gets saved
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave({ keepalive: true });
  });
  window.addEventListener('popstate', () => openBoard(boardInAddress()));

  await ensureHomeBoard();
  await navigate(boardInAddress(), { replace: true });
  // Text reflows once the web fonts arrive, which moves the points lines are anchored to
  document.fonts?.ready.then(renderAllConnections);
}

document.addEventListener('DOMContentLoaded', init);
