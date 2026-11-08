const BASE = '/api';

async function request(url, options = {}) {
  const res = await fetch(BASE + url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const api = {
  getBoard(id) {
    return request(`/boards/${id}`);
  },

  createBoard(data = {}) {
    return request('/boards', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  // keepalive lets the request outlive the page (used when the tab is being hidden or closed);
  // browsers only allow it for small bodies
  saveBoard(board, { keepalive = false } = {}) {
    const body = JSON.stringify(board);
    return request(`/boards/${board.id}`, {
      method: 'PUT',
      body,
      keepalive: keepalive && body.length < 60000
    });
  },

  // Boards reachable from Home: [{ id, name, icon, parent, updatedAt }]
  getOutline() {
    return request('/outline');
  },

  search(query) {
    return request(`/search?q=${encodeURIComponent(query)}`);
  },

  trashBoard(id, card) {
    return request(`/boards/${id}/trash`, {
      method: 'POST',
      body: JSON.stringify({ card })
    });
  },

  listTrash() {
    return request('/trash');
  },

  restoreBoard(id, parentId) {
    return request(`/trash/${id}/restore`, {
      method: 'POST',
      body: JSON.stringify({ parentId })
    });
  },

  purgeBoard(id) {
    return request(`/trash/${id}`, { method: 'DELETE' });
  },

  emptyTrash() {
    return request('/trash', { method: 'DELETE' });
  },

  async uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(BASE + '/upload', { method: 'POST', body: formData });
    if (!res.ok) throw new Error('Upload failed');
    return res.json();
  },

  getLinkPreview(url) {
    return request('/link-preview', {
      method: 'POST',
      body: JSON.stringify({ url })
    });
  }
};
