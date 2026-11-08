// Short messages at the bottom of the screen, optionally with one action ("Undo")

let host = null;

export function toast(message, { action, onAction, duration = 4500 } = {}) {
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }

  const node = document.createElement('div');
  node.className = 'toast';
  node.setAttribute('role', 'status');
  node.append(message);

  const close = () => {
    clearTimeout(timer);
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 180);
  };
  const timer = setTimeout(close, duration);

  if (action) {
    const button = document.createElement('button');
    button.textContent = action;
    button.addEventListener('click', () => { close(); onAction?.(); });
    node.append(button);
  }

  host.appendChild(node);
  return close;
}
