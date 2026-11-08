// crypto.randomUUID() only exists on https and localhost, and the app is also opened as
// http://192.168.x.x from other devices at home
export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

export function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100)
  };
}

export function getColorName(hex) {
  const { h, s, l } = rgbToHsl(...Object.values(hexToRgb(hex)));
  if (l < 10) return 'Black';
  if (l > 95) return 'White';
  if (s < 10) return l < 50 ? 'Dark Gray' : 'Light Gray';
  const names = [
    [0, 'Red'], [30, 'Orange'], [55, 'Yellow'], [80, 'Lime'],
    [140, 'Green'], [175, 'Teal'], [200, 'Cyan'], [230, 'Blue'],
    [270, 'Purple'], [310, 'Magenta'], [345, 'Rose'], [360, 'Red']
  ];
  for (let i = 0; i < names.length - 1; i++) {
    if (h >= names[i][0] && h < names[i + 1][0]) {
      const prefix = l < 35 ? 'Dark ' : l > 70 ? 'Light ' : '';
      return prefix + names[i][1];
    }
  }
  return 'Color';
}

// for picking dark or light text on top of it
export function isLightColor(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 > 128;
}

// Pastel card colors: two rows of light tints, two rows of stronger ones.
// The first entry (white) means "default": the card follows the theme.
export const CARD_COLORS = [
  '#ffffff', '#f1f1ee', '#ffe9e7', '#ffeedd', '#fff6cc',
  '#e6f6e1', '#dcf5f0', '#e0f0ff', '#e8e7ff', '#fbe6f4',
  '#d8d8d3', '#ffc9c4', '#ffd3ad', '#ffe680', '#d6ef9a',
  '#b6e8c0', '#a9e5dc', '#b5dbff', '#cbc8ff', '#f6c3e3'
];

// Paint a card with a user-picked color; white/none falls back to the themed surface
export function applyCardColor(node, color) {
  const custom = !!color && color !== 'transparent' && color.toLowerCase() !== '#ffffff';
  // The stylesheet decides how --tint is used (opaque, or see-through in the glass theme)
  if (custom) node.style.setProperty('--tint', color);
  else node.style.removeProperty('--tint');
  node.classList.toggle('tinted', custom);
}

// Inline icon from the SVG sprite (public/icons.svg)
export function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
}

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

// Notes are stored as HTML and drawn with innerHTML, and that HTML can come from outside:
// cards pasted from the clipboard (any web page can put our format there) or an imported
// board file. Only what the note editor itself produces is kept, everything else is dropped.
const NOTE_TAGS = new Set([
  'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'BR', 'DIV', 'P', 'SPAN', 'FONT',
  'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'MARK', 'SUB', 'SUP'
]);
const DROPPED_WITH_CONTENT = new Set([
  'SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'SVG', 'MATH', 'TITLE', 'TEXTAREA', 'SELECT'
]);

export function sanitizeHtml(html) {
  // parsed inside a <template>: nothing in there loads or runs, so an <img onerror> stays harmless
  const template = document.createElement('template');
  template.innerHTML = html || '';
  cleanNodes(template.content);
  return template.innerHTML;
}

function cleanNodes(parent) {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.COMMENT_NODE) { node.remove(); continue; }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = node.tagName.toUpperCase();
    if (DROPPED_WITH_CONTENT.has(tag)) { node.remove(); continue; }
    cleanNodes(node);
    // an unknown tag goes, its text stays
    if (!NOTE_TAGS.has(tag)) { node.replaceWith(...node.childNodes); continue; }

    // text color and highlight are the only styling the editor makes
    const { color, backgroundColor } = node.style;
    const fontColor = tag === 'FONT' ? node.getAttribute('color') : null;
    for (const { name } of [...node.attributes]) node.removeAttribute(name);
    if (color) node.style.color = color;
    if (backgroundColor) node.style.backgroundColor = backgroundColor;
    if (fontColor) node.setAttribute('color', fontColor);
  }
}

// Only web links: a javascript: address saved in a card would run with access to the app
export function openLink(url) {
  if (/^https?:\/\//i.test(url || '')) window.open(url, '_blank', 'noopener');
}

// Only files uploaded here, for the same reason
export function downloadFile({ url, name }) {
  if (!/^\/media\/[\w-]+(\.[a-z0-9]+)?$/i.test(url || '')) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = name || '';
  a.click();
}

export const fileExtension = (name) => /\.([a-z0-9]{1,10})$/i.exec(name || '')?.[1].toLowerCase() || '';

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function isTyping(target = document.activeElement) {
  return !!target?.closest?.('input, textarea, select, [contenteditable="true"]');
}

// Board-wide shortcuts (undo, paste, delete, Space to pan…) only apply while the user
// is not typing and no dialog is open on top of the board
export function boardHasFocus(target = document.activeElement) {
  return !isTyping(target) && !document.querySelector('.dialog-overlay:not(.hidden)');
}

// Copies of cards under fresh ids, shifted by dx/dy. A copied column points at the copies of
// its cards, and lines between copied cards connect the copies.
export function cloneCards(elements, connections = [], dx = 0, dy = 0) {
  const ids = new Map(elements.map(el => [el.id, uuid()]));
  return {
    elements: elements.map(el => ({
      ...structuredClone(el),
      id: ids.get(el.id),
      x: el.x + dx,
      y: el.y + dy,
      ...(el.children && { children: el.children.filter(id => ids.has(id)).map(id => ids.get(id)) })
    })),
    connections: connections.map(c => ({
      ...structuredClone(c),
      id: uuid(),
      from: { ...c.from, elementId: ids.get(c.from.elementId) },
      to: { ...c.to, elementId: ids.get(c.to.elementId) }
    }))
  };
}

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

// "5 minutes ago", "yesterday"
export function timeAgo(iso) {
  const minutes = Math.round((new Date(iso) - Date.now()) / 60000);
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, 'minute');
  if (Math.abs(minutes) < 60 * 24) return relativeTime.format(Math.round(minutes / 60), 'hour');
  return relativeTime.format(Math.round(minutes / 60 / 24), 'day');
}
