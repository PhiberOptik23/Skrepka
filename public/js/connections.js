import {
  getState, getDom, addConnection, renderAllConnections,
  clearSelection, autoAnchor, updateConnection, getAnchorPos
} from './app.js';

let curveHandleNode = null;

export function initConnections() {
  initLineMode();
}

// Line mode: pick the Line tool, click the first card, then the second
function initLineMode() {
  const { viewport, elementsLayer, connectionsLayer } = getDom();
  const state = getState();

  let tempLine = null;

  viewport.addEventListener('mousedown', (e) => {
    if (!state.isLineMode) return;
    if (e.button !== 0) return;

    const card = e.target.closest('.card');
    if (!card) return;

    e.stopPropagation();

    const clickedId = card.dataset.id;

    if (!state.lineFirstClick) {
      state.lineFirstClick = { elementId: clickedId };
      card.classList.add('line-source');

      // a dashed line from the card's centre follows the mouse until the second click
      const fromEl = state.currentBoard?.elements.find(el => el.id === clickedId);
      if (fromEl) {
        const w = fromEl.width || 200;
        const h = fromEl.height || 120;
        const cx = fromEl.x + w / 2;
        const cy = fromEl.y + h / 2;

        tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        tempLine.setAttribute('x1', cx);
        tempLine.setAttribute('y1', cy);
        tempLine.setAttribute('x2', cx);
        tempLine.setAttribute('y2', cy);
        tempLine.setAttribute('stroke', '#f4511c');
        tempLine.setAttribute('stroke-width', '2');
        tempLine.setAttribute('stroke-dasharray', '6,3');
        tempLine.id = 'temp-line-mode';
        connectionsLayer.appendChild(tempLine);
      }
    } else {
      const fromId = state.lineFirstClick.elementId;
      if (clickedId !== fromId) {
        const fromEl = state.currentBoard?.elements.find(el => el.id === fromId);
        const toEl = state.currentBoard?.elements.find(el => el.id === clickedId);
        if (fromEl && toEl) {
          const { fromAnchor, toAnchor } = autoAnchor(fromEl, toEl);
          addConnection(fromId, fromAnchor, clickedId, toAnchor);
        }
      }

      if (tempLine) { tempLine.remove(); tempLine = null; }
      elementsLayer.querySelectorAll('.card.line-source').forEach(c => c.classList.remove('line-source'));
      state.lineFirstClick = null;
    }
  });

  // While picking cards, a click must not also tick a checkbox, open a colour picker, etc.
  viewport.addEventListener('click', (e) => {
    if (state.isLineMode && e.target.closest('.card')) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  viewport.addEventListener('mousemove', (e) => {
    if (!state.isLineMode || !state.lineFirstClick || !tempLine) return;
    const vpRect = viewport.getBoundingClientRect();
    const bx = (e.clientX - vpRect.left - state.panX) / state.zoom;
    const by = (e.clientY - vpRect.top - state.panY) / state.zoom;
    tempLine.setAttribute('x2', bx);
    tempLine.setAttribute('y2', by);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.lineFirstClick) {
      if (tempLine) { tempLine.remove(); tempLine = null; }
      elementsLayer.querySelectorAll('.card.line-source').forEach(c => c.classList.remove('line-source'));
      state.lineFirstClick = null;
    }
  });
}

// --- Curve handle ---
// A dot in the middle of the selected line; dragging it bends the line

export function renderCurveHandles(connId) {
  clearCurveHandles();

  const state = getState();
  if (!state.currentBoard) return;

  const conn = state.currentBoard.connections.find(c => c.id === connId);
  if (!conn) return;

  const fromEl = state.currentBoard.elements.find(e => e.id === conn.from?.elementId);
  const toEl = state.currentBoard.elements.find(e => e.id === conn.to?.elementId);
  if (!fromEl || !toEl) return;

  const fromPos = getAnchorPos(fromEl, conn.from.anchor);
  const toPos = getAnchorPos(toEl, conn.to.anchor);

  const cx = conn.curveOffset?.x || 0;
  const cy = conn.curveOffset?.y || 0;
  const midX = (fromPos.x + toPos.x) / 2 + cx;
  const midY = (fromPos.y + toPos.y) / 2 + cy;

  const handle = document.createElement('div');
  handle.className = 'curve-handle';
  handle.style.left = midX + 'px';
  handle.style.top = midY + 'px';
  handle.title = 'Drag to bend the arrow';

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const state = getState();
    const vpRect = getDom().viewport.getBoundingClientRect();
    const startMX = (e.clientX - vpRect.left - state.panX) / state.zoom;
    const startMY = (e.clientY - vpRect.top - state.panY) / state.zoom;
    const startCX = conn.curveOffset?.x || 0;
    const startCY = conn.curveOffset?.y || 0;

    const onMove = (e) => {
      const mx = (e.clientX - vpRect.left - state.panX) / state.zoom;
      const my = (e.clientY - vpRect.top - state.panY) / state.zoom;
      const dx = mx - startMX;
      const dy = my - startMY;

      conn.curveOffset = { x: startCX + dx, y: startCY + dy };
      renderAllConnections();
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      updateConnection(conn.id, { curveOffset: conn.curveOffset });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  getDom().elementsLayer.appendChild(handle);
  curveHandleNode = handle;
}

export function clearCurveHandles() {
  if (curveHandleNode) {
    curveHandleNode.remove();
    curveHandleNode = null;
  }
}
