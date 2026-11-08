// The trash: boards whose card was deleted. From here a board can be put back
// on the board that is open, or erased for good.

import { api } from './api.js';
import { getState, getDom, addElement, refreshOutline } from './app.js';
import { escapeHtml, icon, timeAgo } from './utils.js';
import { toast } from './toast.js';

let panel, list, actions, emptyButton, trashButton;

export function initTrash() {
  panel = getDom().trashPanel;
  list = panel.querySelector('#trash-list');
  actions = panel.querySelector('.trash-actions');
  emptyButton = panel.querySelector('#btn-empty-trash');
  trashButton = document.querySelector('#btn-trash');

  trashButton.addEventListener('click', () => {
    panel.classList.toggle('hidden');
    refreshTrash();
  });
  list.addEventListener('click', onRowClick);
  emptyButton.addEventListener('click', async () => {
    if (!confirmed(emptyButton)) return;
    await api.emptyTrash().catch(() => toast('Could not empty the trash'));
    refreshTrash();
  });
  refreshTrash();
}

// Re-read the trash: updates the dot on the dock button and, if the panel is open, its list
export async function refreshTrash() {
  let items;
  try {
    items = await api.listTrash();
  } catch {
    list.innerHTML = '<div class="trash-note">The trash is not available. If the app was just updated, restart the server.</div>';
    actions.classList.add('hidden');
    return;
  }
  trashButton.classList.toggle('has-items', items.length > 0);
  if (panel.classList.contains('hidden')) return;

  actions.classList.toggle('hidden', !items.length);
  list.innerHTML = items.length
    ? items.map(row).join('')
    : '<div class="trash-note">Nothing here. A deleted board waits in the trash until you put it back or delete it for good.</div>';
}

function row(item) {
  const picture = item.customIcon
    ? `<img src="${escapeHtml(item.customIcon)}" alt="">`
    : escapeHtml(item.icon || '📋');
  return `<div class="trash-row" data-id="${escapeHtml(item.id)}">
    <div class="trash-icon">${picture}</div>
    <div class="trash-info">
      <div class="trash-name">${escapeHtml(item.name || 'Board')}</div>
      <div class="trash-meta">${timeAgo(item.deletedAt)} · ${item.cards} ${item.cards === 1 ? 'card' : 'cards'}</div>
    </div>
    <button class="icon-btn" data-action="restore" title="Put back on this board">${icon('undo')}</button>
    <button class="icon-btn danger" data-action="purge" data-confirm="Delete?" title="Delete forever">${icon('trash')}</button>
  </div>`;
}

async function onRowClick(e) {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const id = button.closest('.trash-row').dataset.id;

  if (button.dataset.action === 'restore') {
    try {
      const card = await api.restoreBoard(id, getState().currentBoard.id);
      addElement('board', {
        content: { boardId: id, name: card.name, icon: card.icon || '📋', customIcon: card.customIcon }
      });
      toast(`“${card.name}” is back on this board`);
      refreshOutline();
    } catch {
      toast('Could not restore the board');
    }
  } else {
    if (!confirmed(button)) return;
    await api.purgeBoard(id).catch(() => toast('Could not delete the board'));
  }
  refreshTrash();
}

// Deleting for good asks once more: the first click arms the button (it shows its
// data-confirm text for a few seconds), the second click goes through
function confirmed(button) {
  if (button.disarm) {
    button.disarm();
    return true;
  }
  const label = button.innerHTML;
  const timer = setTimeout(() => button.disarm(), 3000);
  button.disarm = () => {
    clearTimeout(timer);
    button.removeEventListener('mouseleave', button.disarm);
    button.classList.remove('armed');
    button.innerHTML = label;
    delete button.disarm;
  };
  button.addEventListener('mouseleave', button.disarm);
  button.classList.add('armed');
  button.textContent = button.dataset.confirm;
  return false;
}
