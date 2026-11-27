// A keyboard is far taller than the browser's own bars collapsing and expanding.
const MIN_KEYBOARD_HEIGHT_PX = 100;

/**
 * Whether an on-screen keyboard covers part of the page: the visible area is shorter than the
 * layout viewport, which the keyboard does not resize. Measured against the root element rather
 * than window.innerHeight, which follows the visible area in iOS Safari on some screens. False
 * while pinch-zoomed, where the visible area is the zoomed-in part, and while the visible area
 * is 0px tall, as an iOS home-screen web app can report it from launch or once the phone has
 * folded and unfolded, until a keyboard next rises; no keyboard leaves nothing visible.
 */
export function onScreenKeyboardCoversPage(viewport: VisualViewport): boolean {
  return (
    viewport.height > 0 &&
    document.documentElement.clientHeight - viewport.height > MIN_KEYBOARD_HEIGHT_PX &&
    Math.abs(viewport.scale - 1) < 0.01
  );
}
