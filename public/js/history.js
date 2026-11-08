// Undo / redo for the cards and lines of the open board.
//
// Every change already ends in saveBoard(), so history hooks in there: a moment after the
// last change the board is compared with the previous snapshot and, if it differs, that
// snapshot becomes an undo step. A burst of typing or a multi-card delete is one step.

import { api } from './api.js';
import { getState, replaceContent, refreshOutline } from './app.js';
import { boardHasFocus } from './utils.js';
import { refreshTrash } from './trash.js';

const LIMIT = 100;

// board id -> { undo: [snapshot], redo: [snapshot], present: snapshot }
const histories = new Map();
let current = null;
let timer = null;
let travelling = false;

const snapshot = (board) => JSON.stringify({ elements: board.elements, connections: board.connections });

// --- Recording ---

// A board was opened. Its history survives going to another board and back,
// unless the board has changed in the meantime (edited from another tab or device).
export function trackBoard(board) {
  const present = snapshot(board);
  const known = histories.get(board.id);
  current = known?.present === present ? known : { undo: [], redo: [], present };
  histories.set(board.id, current);
  updateButtons();
}

export function recordSoon() {
  clearTimeout(timer);
  timer = setTimeout(recordNow, 400);
}

// Close the step that is waiting to be recorded, if any. It only ever acts on a change that went
// through saveBoard(): cards also adjust themselves on their own (an image notes its height once
// it has loaded), and that must not count as an edit: it would wipe out redo.
export function recordNow() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
  const board = getState().currentBoard;
  if (!board || !current) return;
  const now = snapshot(board);
  if (now === current.present) return;

  current.undo.push(current.present);
  if (current.undo.length > LIMIT) current.undo.shift();
  current.redo = [];
  current.present = now;
  updateButtons();
}

// Make a change that completes the latest step instead of adding its own
// (a link preview arriving for a card that was just pasted)
export function amend(change) {
  recordNow();
  change();
  const board = getState().currentBoard;
  if (board && current) current.present = snapshot(board);
}

// --- Undo / Redo ---

export const undo = () => travel('undo', 'redo');
export const redo = () => travel('redo', 'undo');

async function travel(from, to) {
  recordNow();
  const board = getState().currentBoard;
  if (travelling || !board || !current?.[from].length) return;

  travelling = true;
  try {
    const before = JSON.parse(current.present);
    const target = current[from].pop();
    current[to].push(current.present);
    current.present = target;
    const after = JSON.parse(target);

    const boardsChanged = await syncSubBoards(board.id, before.elements, after.elements);
    if (getState().currentBoard === board) replaceContent(after.elements, after.connections);
    // Only now, with the cards swapped in (and about to be saved), does the outline add up
    if (boardsChanged) refreshOutline();
  } finally {
    travelling = false;
    updateButtons();
  }
}

// A board card that comes back needs its board back from the trash, and one that
// disappears sends its board there. Resolves to whether any board was moved.
async function syncSubBoards(parentId, before, after) {
  const cards = (elements) => new Map(
    elements.filter(el => el.type === 'board' && el.content?.boardId).map(el => [el.content.boardId, el])
  );
  const was = cards(before);
  const now = cards(after);
  const calls = [];
  for (const [id, card] of was) if (!now.has(id)) calls.push(api.trashBoard(id, card.content));
  for (const id of now.keys()) if (!was.has(id)) calls.push(api.restoreBoard(id, parentId));
  if (!calls.length) return false;
  await Promise.allSettled(calls);
  refreshTrash();
  return true;
}

// --- UI ---

function updateButtons() {
  document.querySelector('#btn-undo').disabled = !current?.undo.length;
  document.querySelector('#btn-redo').disabled = !current?.redo.length;
}

export function initHistory() {
  document.querySelector('#btn-undo').addEventListener('click', undo);
  document.querySelector('#btn-redo').addEventListener('click', redo);

  // Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y. While a card is being edited the browser's own text undo applies.
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !boardHasFocus(e.target)) return;
    if (e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    } else if (e.code === 'KeyY') {
      e.preventDefault();
      redo();
    }
  });
}
