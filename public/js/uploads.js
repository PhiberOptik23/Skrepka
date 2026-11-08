// Files that are dropped, pasted or picked: pictures become image cards, anything else a file card

import { api } from './api.js';
import { getState, addElement } from './app.js';
import { toast } from './toast.js';

// `at` is the board point the first card is centred on; the next ones step down and right
export async function addFiles(files, at) {
  const board = getState().currentBoard;
  let shift = 0;
  for (const file of files) {
    let uploaded;
    try {
      uploaded = await api.uploadFile(file);
    } catch {
      toast(`Could not upload ${file.name || 'the file'}`);
      continue;
    }
    if (getState().currentBoard !== board) return; // moved to another board while it was uploading

    if (uploaded.kind === 'image') {
      addElement('image', {
        x: at.x - 140 + shift, y: at.y - 100 + shift, width: 280,
        content: { src: uploaded.url, alt: uploaded.originalName }
      });
    } else {
      addElement('file', {
        x: at.x - 130 + shift, y: at.y - 40 + shift, width: 260,
        content: { url: uploaded.url, name: uploaded.originalName, size: uploaded.size, mime: uploaded.mimetype }
      });
    }
    shift += 24;
  }
}

// Pick files from disk; `accept` narrows the dialog (e.g. 'image/*')
export function pickFiles(at, accept = '') {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  if (accept) input.accept = accept;
  input.addEventListener('change', () => addFiles([...input.files], at));
  input.click();
}
