// Comments: a thread of short remarks attached to any card. A card that has some wears a
// badge with their number; the badge (or "Comment" in the card's menu) opens the thread beside it.

import { getState, getDom, saveBoard, refreshElement } from './app.js';
import { uuid, escapeHtml, icon, timeAgo, clamp } from './utils.js';

let panel, list, input;
let openFor = null; // id of the card whose thread is showing

const card = () => getState().currentBoard?.elements.find(el => el.id === openFor);

// The badge a card shows when it has comments (null when it has none)
export function commentBadge(el) {
  const count = el.comments?.length || 0;
  if (!count) return null;
  const badge = document.createElement('button');
  badge.className = 'comment-badge';
  badge.title = count === 1 ? '1 comment' : `${count} comments`;
  badge.innerHTML = `${icon('comment')}<span>${count}</span>`;
  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    openComments(el.id);
  });
  // A double-click here is not a request to edit the card (or to open the board)
  badge.addEventListener('dblclick', (e) => e.stopPropagation());
  return badge;
}

export function openComments(id) {
  const node = getDom().elementsLayer.querySelector(`[data-id="${id}"]`);
  if (!node || !getState().currentBoard?.elements.some(el => el.id === id)) return;
  openFor = id;
  render();
  panel.classList.remove('hidden');

  // Beside the card: to its right if there is room, otherwise to its left
  const anchor = node.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = panel;
  const gap = 12;
  let left = anchor.right + gap;
  if (left + width > window.innerWidth - gap) left = anchor.left - gap - width;
  panel.style.left = clamp(left, gap, window.innerWidth - width - gap) + 'px';
  panel.style.top = clamp(anchor.top, gap, window.innerHeight - height - gap) + 'px';
  input.focus();
}

export function closeComments() {
  if (!panel) return;
  panel.classList.add('hidden');
  openFor = null;
}

function render() {
  const comments = card()?.comments || [];
  list.innerHTML = comments.length
    ? comments.map(comment => `<div class="comment" data-id="${escapeHtml(comment.id)}">
        <div class="comment-text">${escapeHtml(comment.text)}</div>
        <div class="comment-meta">
          <span>${timeAgo(comment.createdAt)}</span>
          <button class="text-btn" data-action="delete">Delete</button>
        </div>
      </div>`).join('')
    : '<div class="comment-none">No comments yet</div>';
  list.scrollTop = list.scrollHeight;
}

// After the thread changed: save (one undo step), redraw the card's badge and the list
function changed(el) {
  if (!el.comments.length) delete el.comments;
  saveBoard();
  refreshElement(el.id);
  render();
}

function add() {
  const el = card();
  const text = input.value.trim();
  if (!el || !text) return;
  (el.comments ??= []).push({ id: uuid(), text, createdAt: new Date().toISOString() });
  input.value = '';
  changed(el);
}

export function initComments() {
  panel = document.querySelector('#comments-panel');
  list = panel.querySelector('#comments-list');
  input = panel.querySelector('#comment-input');

  // Enter adds the comment, Shift+Enter starts a new line
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      add();
    }
  });
  list.addEventListener('click', (e) => {
    const el = card();
    const row = e.target.closest('[data-action="delete"]')?.closest('.comment');
    if (!el || !row) return;
    el.comments = el.comments.filter(comment => comment.id !== row.dataset.id);
    changed(el);
  });
}
