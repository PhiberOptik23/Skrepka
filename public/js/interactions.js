import {
  getState, getDom, selectElement, clearSelection,
  updateElement, showContextMenu, saveBoard,
  renderAllConnections, elementBox
} from './app.js';
import { GRID, snapsToGrid, toGrid, snapTargets, snapToCards, clearGuides } from './arrange.js';
import {
  columnOf, liftFromColumn, insertIntoColumn,
  columnDropAt, showColumnDrop, clearColumnDrop
} from './columns.js';

export function initInteractions() {
  initDragAndResize();
  initSelectionBox();
}

// --- Drag & Resize ---

function initDragAndResize() {
  const { elementsLayer } = getDom();
  const state = getState();

  elementsLayer.addEventListener('mousedown', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;

    const id = card.dataset.id;
    const isResize = e.target.classList.contains('resize-handle');
    const isEditable = e.target.closest('[contenteditable="true"]');
    const isCheckbox = e.target.type === 'checkbox';
    const isButton = e.target.closest('button, .todo-add, .column-add');

    if (isEditable || isCheckbox || isButton) return;
    // Space or the middle button pans the canvas, even when the drag starts on a card
    if (state.isPanning || e.button === 1) return;
    // In line mode clicks pick the cards to connect (connections.js), they don't drag
    if (state.isLineMode) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.button === 0) {
      if (!state.selectedElements.has(id)) {
        selectElement(id, e.shiftKey || e.ctrlKey);
      }
    }

    if (e.button === 2) {
      if (!state.selectedElements.has(id)) selectElement(id);
      showContextMenu(e.clientX, e.clientY, id);
      return;
    }

    if (e.button !== 0) return;

    const board = state.currentBoard;
    if (!board) return;

    const el = board.elements.find(el => el.id === id);
    if (!el) return;

    if (isResize) {
        const startX = e.clientX;
      const startY = e.clientY;
      const startW = el.width || card.offsetWidth;
      const startH = el.height || card.offsetHeight;

      const onMove = (e) => {
        const dx = (e.clientX - startX) / state.zoom;
        const dy = (e.clientY - startY) / state.zoom;
        let newW = Math.max(120, startW + dx);
        let newH = Math.max(60, startH + dy);
        // With snap to grid on, sizes go in grid steps too (Alt resizes freely)
        if (snapsToGrid() && !e.altKey) {
          newW = Math.max(GRID * 5, toGrid(newW));
          newH = Math.max(GRID * 3, toGrid(newH));
        }

        el.width = newW;
        el.height = newH;
        card.style.width = newW + 'px';
        card.style.height = newH + 'px';
        renderAllConnections();
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        updateElement(el.id, { width: el.width, height: el.height });
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      return;
    }

    const startX = e.clientX;
    const startY = e.clientY;
    let drag = null; // set up on the first real movement, so a plain click changes nothing

    card.classList.add('dragging');

    const beginDrag = () => {
      // What moves: the selected cards, except those riding along inside a selected column
      const selected = [...state.selectedElements]
        .map(sid => board.elements.find(e => e.id === sid))
        .filter(Boolean);
      const selectedIds = new Set(selected.map(s => s.id));
      const moving = selected.filter(s => !selectedIds.has(columnOf(s.id)?.id));

      // A card dragged out of its column is a free card from here on. The column keeps its
      // height until the drop, so the space under the cursor does not jump away.
      const boxes = moving.map(elementBox);
      const held = [...new Set(moving.map(m => columnOf(m.id)).filter(Boolean))]
        .map(column => elementsLayer.querySelector(`[data-id="${column.id}"]`));
      held.forEach(node => { node.style.minHeight = node.offsetHeight + 'px'; });
      moving.forEach((m, i) => liftFromColumn(m, boxes[i]));

      const ids = new Set(moving.map(m => m.id));
      const items = moving.map(m => ({
        el: m,
        node: elementsLayer.querySelector(`[data-id="${m.id}"]`),
        x: m.x,
        y: m.y
      }));
      const left = Math.min(...boxes.map(b => b.x));
      const top = Math.min(...boxes.map(b => b.y));
      return {
        items,
        ids,
        // The group's outline, which is what lines up with other cards
        box: {
          x: left, y: top,
          w: Math.max(...boxes.map(b => b.x + b.w)) - left,
          h: Math.max(...boxes.map(b => b.y + b.h)) - top
        },
        targets: snapTargets(ids),
        // The grid is followed by the card under the cursor
        lead: items.find(item => item.el === el) || items[0],
        // Columns do not nest, so a dragged column is never dropped into another one
        canEnterColumn: !moving.some(m => m.type === 'column'),
        drop: null,
        letGo: () => held.forEach(node => { node.style.minHeight = ''; })
      };
    };

    const onMove = (e) => {
      let dx = (e.clientX - startX) / state.zoom;
      let dy = (e.clientY - startY) / state.zoom;

      if (!drag) {
        if (Math.abs(e.clientX - startX) <= 3 && Math.abs(e.clientY - startY) <= 3) return;
        drag = beginDrag();
        if (!drag.items.length) return;
      }

      drag.drop = drag.canEnterColumn ? columnDropAt(e.clientX, e.clientY, drag.ids) : null;
      clearGuides();
      if (drag.drop) {
        showColumnDrop(drag.drop);
      } else {
        clearColumnDrop();
        // Snap to the grid or, failing that, to nearby cards. Alt places freely.
        if (!e.altKey && drag.lead) {
          if (snapsToGrid()) {
            dx = toGrid(drag.lead.x + dx) - drag.lead.x;
            dy = toGrid(drag.lead.y + dy) - drag.lead.y;
          } else {
            const pull = snapToCards({ ...drag.box, x: drag.box.x + dx, y: drag.box.y + dy }, drag.targets);
            dx += pull.dx;
            dy += pull.dy;
          }
        }
      }

      for (const item of drag.items) {
        item.el.x = item.x + dx;
        item.el.y = item.y + dy;
        if (item.node) {
          item.node.style.left = item.el.x + 'px';
          item.node.style.top = item.el.y + 'px';
        }
      }

      renderAllConnections();
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      card.classList.remove('dragging');
      clearGuides();
      clearColumnDrop();
      if (!drag || !drag.items.length) return;
      drag.letGo();

      if (drag.drop) {
        insertIntoColumn(drag.drop.id, drag.items.map(item => item.el.id), drag.drop.index);
      } else {
        saveBoard();
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// --- Selection Box ---

function initSelectionBox() {
  const { viewport, elementsLayer } = getDom();
  const state = getState();

  let selBox = null;

  viewport.addEventListener('mousedown', (e) => {
    // A plain drag on empty canvas pans (app.js); the selection box needs Shift
    if (e.button !== 0 || !e.shiftKey) return;
    if (state.isPanning || state.isLineMode) return;

    const isBackground = e.target === viewport || e.target.id === 'board-canvas' ||
                         e.target === elementsLayer || e.target.id === 'connections-layer';
    if (!isBackground) return;

    if (e.target.closest('.card')) return;

    const vpRect = viewport.getBoundingClientRect();
    const startX = e.clientX - vpRect.left;
    const startY = e.clientY - vpRect.top;
    let hasMoved = false;

    const onMove = (e) => {
      const curX = e.clientX - vpRect.left;
      const curY = e.clientY - vpRect.top;

      if (!hasMoved && (Math.abs(curX - startX) > 5 || Math.abs(curY - startY) > 5)) {
        hasMoved = true;
        selBox = document.createElement('div');
        selBox.className = 'selection-box';
        viewport.appendChild(selBox);
      }

      if (!hasMoved || !selBox) return;

      const x = Math.min(startX, curX);
      const y = Math.min(startY, curY);
      const w = Math.abs(curX - startX);
      const h = Math.abs(curY - startY);

      selBox.style.left = x + 'px';
      selBox.style.top = y + 'px';
      selBox.style.width = w + 'px';
      selBox.style.height = h + 'px';
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);

      if (hasMoved && selBox && state.currentBoard) {
        const selRect = selBox.getBoundingClientRect();

            const vpRect2 = viewport.getBoundingClientRect();
        const bx1 = (selRect.left - vpRect2.left - state.panX) / state.zoom;
        const by1 = (selRect.top - vpRect2.top - state.panY) / state.zoom;
        const bx2 = (selRect.right - vpRect2.left - state.panX) / state.zoom;
        const by2 = (selRect.bottom - vpRect2.top - state.panY) / state.zoom;

        clearSelection();

        for (const el of state.currentBoard.elements) {
          // Cards inside a column come with their column, not on their own
          if (columnOf(el.id)) continue;
          const box = elementBox(el);

                if (box.x < bx2 && box.x + box.w > bx1 && box.y < by2 && box.y + box.h > by1) {
            selectElement(el.id, true);
          }
        }

        selBox.remove();
        selBox = null;
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
