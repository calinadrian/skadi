/**
 * A custom slider: a role=slider div with a filled track, a centre-positioned
 * thumb and a floating value bubble.
 *
 * The thumb is positioned by its centre and the bubble reuses the exact same
 * --thumb-x, so it cannot teleport away from the thumb mid-drag. The pointer
 * is captured on down, so the drag keeps going outside the track.
 *
 * Self-contained: the app (app.js) and the standalone preview
 * (slider-preview.html) both import this, so the preview always exercises the
 * real component.
 */
export function makeSlider({ min, max, step, value, label, format, compact = false, disabled = false, onInput, onCommit }) {
  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

  const root = el('div', 'slider' + (compact ? ' compact' : ''));
  root.setAttribute('role', 'slider');
  root.tabIndex = 0;
  root.setAttribute('aria-label', label);
  root.setAttribute('aria-valuemin', min);
  root.setAttribute('aria-valuemax', max);
  if (disabled) root.setAttribute('aria-disabled', 'true');

  const fill = el('div', 'fill');
  const track = el('div', 'track');
  track.append(fill);
  const bubble = el('div', 'value');
  const thumb = el('div', 'thumb');
  root.append(track, bubble, thumb);

  // Snap to the step grid without float drift (0.07000000000000001 et al.).
  const decimals = step >= 1 ? 0 : Math.min(6, -Math.floor(Math.log10(step)));
  const snap = (n) => Number((min + Math.round((n - min) / step) * step).toFixed(decimals));
  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

  let val = snap(clamp(Number(value), min, max));
  let dragging = false;
  let downVal = null;
  let activePointerId = null;

  function render() {
    // One source for positioning: fill, thumb and bubble all read the same %.
    const pct = ((val - min) / (max - min)) * 100;
    fill.style.width = `${pct}%`;
    thumb.style.left = `${pct}%`;
    bubble.style.setProperty('--thumb-x', `${pct}%`);
    if (!compact) bubble.textContent = format ? format(val) : String(val);
    root.setAttribute('aria-valuenow', val);
    if (format) root.setAttribute('aria-valuetext', format(val));
  }

  function updateFromPointer(clientX) {
    const rect = root.getBoundingClientRect();
    // Pointer position as a fraction of the track, clamped to 0..1 so dragging
    // off either end holds at the limit instead of overshooting it.
    const pct = clamp((clientX - rect.left) / rect.width, 0, 1);
    const next = snap(min + pct * (max - min));
    if (next === val) return;
    val = next;
    render();
    if (onInput) onInput(val);
  }

  // Moves and release are tracked on window for the lifetime of the drag, not
  // on the row itself: the hit area is only 28px tall, pointer capture is not
  // reliable in every embedded WebView, and a drag that drifts even a pixel
  // off the row must keep working.
  const onMove = (e) => {
    if (!dragging || e.pointerId !== activePointerId) return;
    updateFromPointer(e.clientX);
  };
  const stopDragging = (e) => {
    if (!dragging || e.pointerId !== activePointerId) return;
    dragging = false;
    activePointerId = null;
    root.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', stopDragging);
    window.removeEventListener('pointercancel', stopDragging);
    if (e.pointerId != null && root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    if (val !== downVal && onCommit) onCommit(val);
    downVal = null;
  };

  root.addEventListener('pointerdown', (e) => {
    if (disabled || dragging) return;
    dragging = true;
    activePointerId = e.pointerId;
    downVal = val;
    root.classList.add('dragging');
    // Clicking anywhere on the row moves the thumb straight there.
    updateFromPointer(e.clientX);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);
    // Capture keeps the drag going even outside the browser window. Never
    // throws for a real pointer; guarded anyway so a rejected capture cannot
    // swallow the click.
    try { root.setPointerCapture(e.pointerId); } catch { /* window listeners cover it */ }
  });

  root.addEventListener('keydown', (e) => {
    if (disabled) return;
    let next;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp': next = val + step; break;
      case 'ArrowLeft':
      case 'ArrowDown': next = val - step; break;
      case 'PageUp': next = val + step * 10; break;
      case 'PageDown': next = val - step * 10; break;
      case 'Home': next = min; break;
      case 'End': next = max; break;
      default: return;
    }
    e.preventDefault();
    const before = val;
    val = snap(clamp(next, min, max));
    render();
    if (val !== before) {
      if (onInput) onInput(val);
      if (onCommit) onCommit(val);
    }
  });

  render();

  return {
    el: root,
    get: () => val,
    set: (v) => { val = snap(clamp(Number(v), min, max)); render(); },
  };
}
