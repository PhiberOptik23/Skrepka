// Copy, cut and paste.
//  - Cards: Ctrl+C / Ctrl+X on a selection, Ctrl+V to paste (on this or any other board).
//  - From outside: a pasted picture becomes an image card, another file a file card,
//    a link a link card, other text a note.

import { api } from './api.js';
import { boardHasFocus, escapeHtml, sanitizeHtml, cloneCards } from './utils.js';
import {
  getState, getDom, addElement, addElements, deleteElement, refreshElement,
  saveQuietly, toBoardPoint, viewportCenter
} from './app.js';
import { amend } from './history.js';
import { toast } from './toast.js';
import { addFiles } from './uploads.js';

// Our own clipboard format, so cards survive the trip with everything they hold
const CARDS_TYPE = 'application/x-skrepka-cards';

// Last mouse position over the canvas: pasted things land there (or mid-screen if the mouse is elsewhere)
let pointer = null;

export function initClipboard() {
  const { viewport } = getDom();
  viewport.addEventListener('mousemove', (e) => { pointer = { x: e.clientX, y: e.clientY }; });
  viewport.addEventListener('mouseleave', () => { pointer = null; });

  document.addEventListener('copy', (e) => {
    if (copySelection(e)) e.preventDefault();
  });
  document.addEventListener('cut', (e) => {
    const copied = copySelection(e);
    if (!copied) return;
    e.preventDefault();
    // Only what actually went to the clipboard is removed (a selected board card stays)
    copied.forEach(id => deleteElement(id));
  });
  document.addEventListener('paste', onPaste);
}

// --- Copy ---

// Puts the selected cards on the clipboard; returns their ids, or null if there was nothing to copy
function copySelection(e) {
  const state = getState();
  const board = state.currentBoard;
  if (!boardHasFocus() || !board || !state.selectedElements.size) return null;
  // Text selected somewhere on the page is copied the normal way
  if (String(getSelection())) return null;

  const byId = new Map(board.elements.map(el => [el.id, el]));
  const picked = new Map();
  const pick = (id) => {
    const el = byId.get(id);
    // A board card is a doorway to a board, not the board itself, so it is not copied
    if (!el || el.type === 'board') return;
    picked.set(id, el);
    (el.children || []).forEach(pick); // a column brings its cards along
  };
  state.selectedElements.forEach(pick);
  if (!picked.size) {
    toast('Board cards cannot be copied');
    return null;
  }

  const elements = [...picked.values()];
  const connections = board.connections.filter(c => picked.has(c.from?.elementId) && picked.has(c.to?.elementId));
  e.clipboardData.setData(CARDS_TYPE, JSON.stringify({ elements, connections }));
  // Other apps get the cards' text
  e.clipboardData.setData('text/plain', elements.map(plainText).filter(Boolean).join('\n\n'));
  return [...picked.keys()];
}

function plainText(el) {
  const c = el.content || {};
  switch (el.type) {
    case 'note': {
      // a detached <div> still loads images, so the HTML is cleaned first
      const div = document.createElement('div');
      div.innerHTML = sanitizeHtml(c.html);
      return div.innerText.trim();
    }
    case 'todo': return [c.title, ...(c.items || []).map(item => `${item.done ? '[x]' : '[ ]'} ${item.text}`)].join('\n');
    case 'link': return c.url;
    case 'file': return c.name;
    case 'image': return c.caption;
    case 'column': return c.title;
    case 'color': return c.color;
    default: return '';
  }
}

// --- Paste ---

async function onPaste(e) {
  const data = e.clipboardData;

  // Into a card that is being edited: plain text only, so foreign fonts and colors stay out
  if (document.activeElement?.closest?.('[contenteditable="true"]')) {
    e.preventDefault();
    document.execCommand('insertText', false, data.getData('text/plain'));
    return;
  }
  if (!boardHasFocus() || !getState().currentBoard) return;
  e.preventDefault();

  // Everything is read from the clipboard right away: it is gone once this handler yields
  const cards = data.getData(CARDS_TYPE);
  const files = [...data.files];
  const text = data.getData('text/plain').trim();
  const at = pointer ? toBoardPoint(pointer.x, pointer.y) : viewportCenter();

  if (cards) pasteCards(cards, at);
  else if (files.length) await addFiles(files, at);
  else if (/^https?:\/\/\S+$/i.test(text)) pasteLink(text, at);
  else if (text) pasteNote(text, at);
}

function pasteCards(json, at) {
  let elements, connections;
  try { ({ elements, connections } = JSON.parse(json)); } catch { return; }
  if (!Array.isArray(elements) || !elements.length) return;

  const inColumn = new Set(elements.flatMap(el => el.children || []));
  const loose = elements.filter(el => !inColumn.has(el.id));

  // Keep the cards' arrangement and centre it on the paste point
  const left = Math.min(...loose.map(el => el.x));
  const top = Math.min(...loose.map(el => el.y));
  const right = Math.max(...loose.map(el => el.x + (el.width || 200)));
  const bottom = Math.max(...loose.map(el => el.y + (el.height || 100)));
  const ordered = [...elements].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0)); // same stacking as the originals
  const copies = cloneCards(ordered, connections || [], at.x - (left + right) / 2, at.y - (top + bottom) / 2);
  addElements(copies.elements, copies.connections);
}

function pasteLink(url, at) {
  let site = '';
  try { site = new URL(url).hostname; } catch {}
  const el = addElement('link', {
    x: at.x - 140, y: at.y - 40, width: 280,
    content: { url, title: url, siteName: site }
  });

  // The card appears at once; its title and picture follow when the page has been fetched
  api.getLinkPreview(url).then(preview => {
    const card = getState().currentBoard?.elements.find(e => e.id === el.id);
    if (!card) return;
    amend(() => { card.content = preview; });
    refreshElement(card.id);
    saveQuietly();
  }).catch(() => {});
}

function pasteNote(text, at) {
  addElement('note', {
    x: at.x - 120, y: at.y - 30,
    width: text.length > 280 ? 320 : 240,
    content: { html: escapeHtml(text).replace(/\r?\n/g, '<br>') }
  });
}
