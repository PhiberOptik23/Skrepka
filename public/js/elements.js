import {
  uuid, getColorName, applyCardColor, icon, escapeHtml, sanitizeHtml, openLink,
  downloadFile, fileExtension, formatSize
} from './utils.js';
import {
  getState, getDom, selectElement, updateElement, deleteElement,
  showContextMenu, openSubBoard, renameBoard, saveBoard, clearSelection, renderAllConnections
} from './app.js';
import { api } from './api.js';
import { addNoteToColumn } from './columns.js';
import { commentBadge } from './comments.js';

export function createElementData(type, overrides = {}) {
  const base = {
    id: uuid(),
    type,
    x: 100,
    y: 100,
    width: null,
    height: null,
    color: '#ffffff',
    zIndex: 1,
    content: {},
    ...overrides
  };

  switch (type) {
    case 'note':
      base.width = base.width || 240;
      base.content = { html: '', ...base.content };
      break;
    case 'image':
      base.width = base.width || 280;
      base.content = { src: '', alt: '', caption: '', ...base.content };
      break;
    case 'todo':
      base.width = base.width || 240;
      base.content = {
        title: 'To-Do List',
        items: [
          { id: uuid(), text: '', done: false }
        ],
        ...base.content
      };
      break;
    case 'link':
      base.width = base.width || 280;
      base.content = { url: '', title: '', description: '', image: null, siteName: '', ...base.content };
      break;
    case 'file':
      base.width = base.width || 260;
      base.content = { url: '', name: '', size: 0, mime: '', ...base.content };
      break;
    case 'column':
      base.width = base.width || 260;
      base.height = base.height || 300;
      base.children = [];
      base.color = 'transparent';
      base.content = { title: '', ...base.content };
      break;
    case 'color':
      base.width = 140;
      base.height = 140;
      base.content = { color: '#F4511C', ...base.content };
      base.color = '#ffffff';
      break;
    case 'board':
      base.width = 140;
      base.height = 160;
      base.color = 'transparent';
      base.content = { boardId: '', name: 'Sub Board', icon: '📋', customIcon: null, ...base.content };
      break;
  }
  return base;
}

// --- Rendering ---

export function renderElement(el, board) {
  switch (el.type) {
    case 'note': return renderNote(el);
    case 'image': return renderImage(el);
    case 'todo': return renderTodo(el);
    case 'link': return renderLink(el);
    case 'file': return renderFile(el);
    case 'column': return renderColumn(el, board);
    case 'color': return renderColorSwatch(el);
    case 'board': return renderSubBoard(el);
    default: return null;
  }
}

function createCardBase(el, extraClass = '') {
  const card = document.createElement('div');
  card.className = `card card-${el.type} ${extraClass}`.trim();
  card.dataset.id = el.id;
  card.dataset.type = el.type;
  card.style.left = el.x + 'px';
  card.style.top = el.y + 'px';
  if (el.width) card.style.width = el.width + 'px';
  if (el.height && el.type !== 'note' && el.type !== 'todo') {
    card.style.height = el.height + 'px';
  }
  card.style.zIndex = el.zIndex || 1;
  // a board card is a transparent wrapper around its icon tile, there is nothing to tint or resize
  if (el.type !== 'board') {
    applyCardColor(card, el.color);
    const resize = document.createElement('div');
    resize.className = 'resize-handle';
    card.appendChild(resize);
  }

  const badge = commentBadge(el);
  if (badge) card.appendChild(badge);

  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const state = getState();
    if (!state.selectedElements.has(el.id)) {
      selectElement(el.id);
    }
    showContextMenu(e.clientX, e.clientY, el.id);
  });

  return card;
}

function renderNote(el) {
  const card = createCardBase(el);
  const content = document.createElement('div');
  content.className = 'note-content';
  content.contentEditable = 'false';
  content.innerHTML = sanitizeHtml(el.content.html);

  card.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    content.contentEditable = 'true';
    content.focus();
    showFormatToolbar(card);
  });

  content.addEventListener('blur', () => {
    content.contentEditable = 'false';
    el.content.html = content.innerHTML;
    updateElement(el.id, { content: { ...el.content, html: content.innerHTML } });
    hideFormatToolbar();
  });

  content.addEventListener('input', () => {
    el.content.html = content.innerHTML;
    card.style.height = 'auto';
    el.height = card.offsetHeight;
    updateElement(el.id, {
      content: { ...el.content, html: content.innerHTML },
      height: el.height
    });
  });

  content.addEventListener('mousedown', (e) => {
    if (content.contentEditable === 'true') {
      e.stopPropagation();
    }
  });

  card.appendChild(content);
  return card;
}

function renderImage(el) {
  const card = createCardBase(el);

  if (el.content.src) {
    const img = document.createElement('img');
    img.src = el.content.src;
    img.alt = el.content.alt || '';
    img.draggable = false;
    img.addEventListener('load', () => {
      if (!el.height) {
        el.height = card.offsetHeight;
      }
      // the card just grew to fit the picture, so lines anchored to it have to follow
      if (getState().currentBoard?.connections.length) renderAllConnections();
    });
    card.appendChild(img);
  }

  const caption = document.createElement('div');
  caption.className = 'image-caption';
  caption.contentEditable = 'false';
  caption.textContent = el.content.caption || '';

  caption.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    caption.contentEditable = 'true';
    caption.focus();
  });
  caption.addEventListener('blur', () => {
    caption.contentEditable = 'false';
    el.content.caption = caption.textContent;
    updateElement(el.id, { content: { ...el.content, caption: caption.textContent } });
  });
  caption.addEventListener('mousedown', (e) => {
    if (caption.contentEditable === 'true') e.stopPropagation();
  });

  card.appendChild(caption);
  return card;
}

function renderTodo(el) {
  const card = createCardBase(el);

  const header = document.createElement('div');
  header.className = 'todo-header';
  header.contentEditable = 'false';
  header.textContent = el.content.title || '';

  header.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    header.contentEditable = 'true';
    header.focus();
  });
  header.addEventListener('blur', () => {
    header.contentEditable = 'false';
    el.content.title = header.textContent;
    updateElement(el.id, { content: el.content });
  });
  header.addEventListener('mousedown', (e) => {
    if (header.contentEditable === 'true') e.stopPropagation();
  });
  card.appendChild(header);

  const itemsContainer = document.createElement('div');
  itemsContainer.className = 'todo-items';
  card.appendChild(itemsContainer);

  function renderItems() {
    itemsContainer.innerHTML = '';
    el.content.items.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'todo-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.done;
      checkbox.addEventListener('change', () => {
        item.done = checkbox.checked;
        textSpan.classList.toggle('done', item.done);
        updateElement(el.id, { content: el.content });
      });

      const textSpan = document.createElement('span');
      textSpan.className = 'todo-text' + (item.done ? ' done' : '');
      textSpan.contentEditable = 'false';
      textSpan.textContent = item.text;

      textSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        textSpan.contentEditable = 'true';
        textSpan.focus();
      });
      textSpan.addEventListener('blur', () => {
        textSpan.contentEditable = 'false';
        item.text = textSpan.textContent;
        updateElement(el.id, { content: el.content });
      });
      textSpan.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          textSpan.blur();
          el.content.items.splice(idx + 1, 0, { id: uuid(), text: '', done: false });
          renderItems();
          updateElement(el.id, { content: el.content });
          const newItems = itemsContainer.querySelectorAll('.todo-text');
          if (newItems[idx + 1]) {
            newItems[idx + 1].contentEditable = 'true';
            newItems[idx + 1].focus();
          }
        }
      });
      textSpan.addEventListener('mousedown', (e) => {
        if (textSpan.contentEditable === 'true') e.stopPropagation();
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'todo-delete';
      deleteBtn.innerHTML = icon('x');
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        el.content.items.splice(idx, 1);
        if (el.content.items.length === 0) {
          el.content.items.push({ id: uuid(), text: '', done: false });
        }
        renderItems();
        updateElement(el.id, { content: el.content });
      });

      row.appendChild(checkbox);
      row.appendChild(textSpan);
      row.appendChild(deleteBtn);
      itemsContainer.appendChild(row);
    });
  }

  renderItems();

  const addBtn = document.createElement('div');
  addBtn.className = 'todo-add';
  addBtn.innerHTML = `${icon('plus')} Add item`;
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    el.content.items.push({ id: uuid(), text: '', done: false });
    renderItems();
    updateElement(el.id, { content: el.content });
    const items = itemsContainer.querySelectorAll('.todo-text');
    const last = items[items.length - 1];
    if (last) {
      last.contentEditable = 'true';
      last.focus();
    }
  });
  card.appendChild(addBtn);

  return card;
}

function renderLink(el) {
  const card = createCardBase(el);

  if (el.content.image) {
    const img = document.createElement('img');
    img.className = 'link-preview-image';
    img.src = el.content.image;
    img.alt = '';
    img.draggable = false;
    img.addEventListener('error', () => img.remove());
    card.appendChild(img);
  }

  const info = document.createElement('div');
  info.className = 'link-info';
  info.innerHTML = `
    <div class="link-title">${escapeHtml(el.content.title || el.content.url)}</div>
    ${el.content.description ? `<div class="link-description">${escapeHtml(el.content.description)}</div>` : ''}
    <div class="link-site">${icon('globe')} ${escapeHtml(el.content.siteName || '')}</div>`;
  card.appendChild(info);

  const openBtn = document.createElement('button');
  openBtn.className = 'link-open';
  openBtn.innerHTML = icon('external');
  openBtn.title = 'Open link';
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openLink(el.content.url);
  });
  card.appendChild(openBtn);

  card.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    openLink(el.content.url);
  });

  return card;
}

function renderFile(el) {
  const card = createCardBase(el);
  const { name, size } = el.content;
  const meta = [fileExtension(name).toUpperCase(), formatSize(size)].filter(Boolean).join(' · ');

  const body = document.createElement('div');
  body.className = 'file-body';
  body.innerHTML = `
    <div class="file-icon">${icon('file')}</div>
    <div class="file-info">
      <div class="file-name">${escapeHtml(name || 'File')}</div>
      ${meta ? `<div class="file-meta">${escapeHtml(meta)}</div>` : ''}
    </div>`;
  card.appendChild(body);

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'file-download';
  downloadBtn.innerHTML = icon('download');
  downloadBtn.title = 'Download';
  downloadBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    downloadFile(el.content);
  });
  card.appendChild(downloadBtn);

  card.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    downloadFile(el.content);
  });

  return card;
}

function renderColumn(el, board) {
  const card = createCardBase(el);

  const title = document.createElement('div');
  title.className = 'column-title';
  title.contentEditable = 'false';
  title.textContent = el.content?.title || '';

  title.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    title.contentEditable = 'true';
    title.focus();
  });
  title.addEventListener('blur', () => {
    title.contentEditable = 'false';
    if (!el.content) el.content = {};
    el.content.title = title.textContent;
    updateElement(el.id, { content: el.content });
  });
  title.addEventListener('mousedown', (e) => {
    if (title.contentEditable === 'true') e.stopPropagation();
  });
  card.appendChild(title);

  const body = document.createElement('div');
  body.className = 'column-body';
  body.dataset.columnId = el.id;

  if (el.children && board) {
    for (const childId of el.children) {
      const childEl = board.elements.find(e => e.id === childId);
      if (childEl) {
        const childNode = renderElement(childEl, board);
        if (childNode) {
          childNode.dataset.parentColumn = el.id;
          body.appendChild(childNode);
        }
      }
    }
  }

  card.appendChild(body);

  // Cards are dragged in and out (interactions.js); this adds a note straight into the column
  const add = document.createElement('div');
  add.className = 'column-add';
  add.innerHTML = `${icon('plus')} Add note`;
  add.addEventListener('click', (e) => {
    e.stopPropagation();
    addNoteToColumn(el);
  });
  card.appendChild(add);

  return card;
}

function renderColorSwatch(el) {
  const card = createCardBase(el);
  const color = el.content.color || '#F4511C';

  const preview = document.createElement('div');
  preview.className = 'color-preview';
  preview.style.backgroundColor = color;
  preview.addEventListener('click', (e) => {
    e.stopPropagation();
    const input = document.createElement('input');
    input.type = 'color';
    input.value = color;
    input.style.position = 'absolute';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    document.body.appendChild(input);
    input.addEventListener('input', () => {
      el.content.color = input.value;
      preview.style.backgroundColor = input.value;
      valueDiv.textContent = input.value.toUpperCase();
      updateElement(el.id, { content: el.content });
    });
    input.addEventListener('change', () => {
      input.remove();
    });
    input.click();
  });
  card.appendChild(preview);

  const valueDiv = document.createElement('div');
  valueDiv.className = 'color-value';
  valueDiv.textContent = color.toUpperCase();
  valueDiv.title = getColorName(color);
  card.appendChild(valueDiv);

  return card;
}

function renderSubBoard(el) {
  const card = createCardBase(el);

  const delBtn = document.createElement('button');
  delBtn.className = 'board-card-delete';
  delBtn.innerHTML = icon('x');
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteElement(el.id);
  });
  card.appendChild(delBtn);

  const iconArea = document.createElement('div');
  iconArea.className = 'board-icon-area';

  if (el.content.customIcon) {
    const img = document.createElement('img');
    img.className = 'board-custom-icon';
    img.src = el.content.customIcon;
    img.alt = '';
    img.draggable = false;
    iconArea.appendChild(img);
  } else {
    const emoji = document.createElement('span');
    emoji.className = 'board-emoji';
    emoji.textContent = el.content.icon || '📋';
    iconArea.appendChild(emoji);
  }

  iconArea.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (el.content.boardId) {
      openSubBoard(el.content.boardId);
    }
  });

  card.appendChild(iconArea);

  const name = document.createElement('div');
  name.className = 'board-name';
  name.contentEditable = 'false';
  name.textContent = el.content.name || '';

  name.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    name.contentEditable = 'true';
    name.focus();
  });
  name.addEventListener('blur', () => {
    name.contentEditable = 'false';
    // The card shows the board's own name, so the board is renamed along with it
    const text = name.textContent.trim() || 'Untitled';
    name.textContent = text;
    if (text === el.content.name) return;
    el.content.name = text;
    updateElement(el.id, { content: el.content });
    if (el.content.boardId) renameBoard(el.content.boardId, text);
  });
  name.addEventListener('mousedown', (e) => {
    if (name.contentEditable === 'true') e.stopPropagation();
  });

  card.appendChild(name);
  return card;
}

// --- Board icon ---

export function pickBoardIcon(el, iconArea) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;

    // the tile is 112px, about twice that keeps it sharp on retina screens
    const resized = await resizeImage(file, 220, 220);
    const result = await api.uploadFile(resized);
    el.content.customIcon = result.url;
    updateElement(el.id, { content: el.content });

    iconArea.querySelectorAll('.board-emoji, .board-custom-icon').forEach(n => n.remove());
    const img = document.createElement('img');
    img.className = 'board-custom-icon';
    img.src = result.url;
    img.alt = '';
    img.draggable = false;
    iconArea.insertBefore(img, iconArea.querySelector('.icon-upload-overlay'));
  });
  input.click();
}

function resizeImage(file, maxW, maxH) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;

      // crop the middle square, then scale it to maxW x maxH
      const size = Math.min(w, h);
      const sx = (w - size) / 2;
      const sy = (h - size) / 2;

      canvas.width = maxW;
      canvas.height = maxH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, size, size, 0, 0, maxW, maxH);

      canvas.toBlob((blob) => {
        resolve(new File([blob], file.name, { type: 'image/png' }));
      }, 'image/png');
    };
    img.src = URL.createObjectURL(file);
  });
}

// --- Format toolbar ---

function showFormatToolbar(cardNode) {
  const dom = getDom();
  const rect = cardNode.getBoundingClientRect();
  dom.formatToolbar.classList.remove('hidden');
  dom.formatToolbar.style.left = rect.left + 'px';
  dom.formatToolbar.style.top = (rect.top - 50) + 'px';

  const tbRect = dom.formatToolbar.getBoundingClientRect();
  if (tbRect.right > window.innerWidth) {
    dom.formatToolbar.style.left = (window.innerWidth - tbRect.width - 8) + 'px';
  }
  if (tbRect.top < 0) {
    dom.formatToolbar.style.top = (rect.bottom + 8) + 'px';
  }
}

function hideFormatToolbar() {
  getDom().formatToolbar.classList.add('hidden');
}
