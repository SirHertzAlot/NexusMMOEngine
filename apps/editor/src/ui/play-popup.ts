/**
 * Play "New window" — pop the game view out into a separate window.
 *
 * Proven pattern (Khronos WebGL list precedent): move the live canvas
 * wrapper into a `window.open` popup via adoptNode. The WebGL context
 * survives the move; no second renderer, no state sync — the editor's JS
 * context keeps owning the game.
 *
 * Pure helpers (tested): popupFeatures(), buildPopupShell(), escapeHtml(),
 * canPopOut(). DOM orchestration: popOutGameView().
 *
 * Known v1 limits (documented, not hidden):
 * - Keyboard is forwarded to the opener via synthetic events, so WASD
 *   keeps driving the avatar.
 * - Pointer-lock mouse-look does NOT follow: the input module reads the
 *   opener's document.pointerLockElement. Wheel/drag camera still work.
 * - If the editor window is minimized, the opener's rAF stops and the
 *   popup view pauses.
 */

export const POPUP_NAME = "mmo-editor-play";
export const POPUP_MOUNT_ID = "mmo-play-mount";

/**
 * Gesture-to-mount handoff. openPlayPopupShell() must run in the click
 * gesture; the game view mounts later (async server start). The click
 * handler arms the popup here; the view attaches it on mount.
 */
let pendingPopup: Window | null = null;

export function armPlayPopup(popup: Window | null): void {
  pendingPopup = popup;
}

/** Take the armed popup (once). Null when none was armed or it closed. */
export function takePendingPopup(): Window | null {
  const p = pendingPopup;
  pendingPopup = null;
  return p && !p.closed ? p : null;
}

/** Feature detection: window.open available (not SSR, not blocked API). */
export function canPopOut(): boolean {
  return typeof window !== "undefined" && typeof window.open === "function";
}

/** window.open features string for a clean game window. */
export function popupFeatures(width: number, height: number): string {
  return [
    `width=${Math.round(width)}`,
    `height=${Math.round(height)}`,
    "menubar=no",
    "toolbar=no",
    "location=no",
    "status=no",
    "resizable=yes",
    "scrollbars=no",
  ].join(",");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The popup document. Includes:
 * - a full-viewport mount div for the adopted game view,
 * - keyboard forwarding so WASD/keys keep driving the avatar
 *   (the input module listens on the opener's window),
 * - a beforeunload hook that lets the opener restore the view.
 */
export function buildPopupShell(title: string): string {
  const t = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${t}</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #0b1020; overflow: hidden; }
  #${POPUP_MOUNT_ID} { position: fixed; inset: 0; }
  #${POPUP_MOUNT_ID} > * { width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="${POPUP_MOUNT_ID}"></div>
<script>
  // Forward keyboard to the opener: the game's input module listens on the
  // opener's window, and key events fire on this window after the move.
  for (const type of ["keydown", "keyup"]) {
    window.addEventListener(type, (e) => {
      if (!window.opener || window.opener.closed) return;
      window.opener.dispatchEvent(new KeyboardEvent(type, {
        key: e.key, code: e.code,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
        altKey: e.altKey, metaKey: e.metaKey,
        repeat: e.repeat, bubbles: true,
      }));
    });
  }
  window.addEventListener("blur", () => {
    if (window.opener && !window.opener.closed) window.opener.dispatchEvent(new Event("blur"));
  });
  // Tell the opener we're going away so it can restore the game view.
  window.addEventListener("beforeunload", () => {
    try { window.opener?.__mmoPlayPopupClosed?.(); } catch { /* opener gone */ }
  });
</script>
</body>
</html>`;
}

export interface PoppedOutView {
  /** The popup window (for focus checks). */
  readonly popup: Window;
  /** Move the view back and close the popup. Idempotent. */
  close(): void;
  /** True while the popup is open. */
  readonly isOpen: boolean;
}

/**
 * Open the popup shell. Call this synchronously in the user gesture
 * (menu/button click) or the popup blocker eats it. The game view is
 * attached later with attachMountToPopup() once it has mounted.
 * Returns null when blocked.
 */
export function openPlayPopupShell(title = "Play"): Window | null {
  const popup = window.open("", POPUP_NAME, popupFeatures(1280, 800));
  if (!popup) return null;
  popup.focus();
  popup.document.open();
  popup.document.write(buildPopupShell(title));
  popup.document.close();
  return popup;
}

/**
 * Move `mount` into an already-open popup. Returns a handle whose close()
 * restores the view. `onClose` fires after the restore.
 */
export function attachMountToPopup(
  popup: Window,
  mount: HTMLElement,
  opts: { onClose?: () => void } = {},
): PoppedOutView | null {
  const parent = mount.parentNode;
  const next = mount.nextSibling;
  const target = popup.document.getElementById(POPUP_MOUNT_ID);
  if (!target || !parent || popup.closed) {
    return null;
  }
  target.appendChild(popup.document.adoptNode(mount));

  let open = true;
  let timer = 0;
  const restore = (): void => {
    if (!open) return;
    open = false;
    window.clearInterval(timer);
    try {
      // Move the view back where it was before the pop-out.
      if (next && next.parentNode === parent) parent.insertBefore(document.adoptNode(mount), next);
      else parent.appendChild(document.adoptNode(mount));
    } catch {
      /* parent gone (unmounted) — nothing to restore into */
    }
    try {
      if (!popup.closed) popup.close();
    } catch {
      /* already closed */
    }
    opts.onClose?.();
  };

  // The popup's beforeunload calls this on the opener.
  (window as unknown as { __mmoPlayPopupClosed?: () => void }).__mmoPlayPopupClosed = restore;
  // Backstop: the user may close the popup without beforeunload firing
  // (or the opener hook may be blocked); poll cheaply.
  timer = window.setInterval(() => {
    if (popup.closed) restore();
  }, 500);

  return {
    popup,
    get isOpen() {
      return open;
    },
    close: restore,
  };
}

/**
 * Move `mount` (the game view wrapper) into a new popup window.
 * Must be called in the user gesture (menu click) or the popup is blocked.
 * Returns null when the popup was blocked.
 *
 * The caller keeps ownership: call close() (or let the user close the
 * popup) to move the view back. `onClose` fires after the restore.
 */
export function popOutGameView(mount: HTMLElement, opts: { title?: string; onClose?: () => void } = {}): PoppedOutView | null {
  const popup = openPlayPopupShell(opts.title ?? "Play");
  if (!popup) return null;
  const handle = attachMountToPopup(popup, mount, opts);
  if (!handle) {
    try {
      popup.close();
    } catch {
      /* ignore */
    }
    return null;
  }
  return handle;
}
