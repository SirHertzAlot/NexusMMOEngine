/**
 * Where the Scenes viewport camera looks, shared outside React: the play
 * menu's "camera position" start moves the avatar there (EA14). The last
 * position outlives the viewport (Play switches workspace, which unmounts it).
 */
let source: (() => [number, number, number]) | null = null;
let last: [number, number, number] | null = null;

export const sceneCamera = {
  set: (fn: (() => [number, number, number]) | null): void => {
    if (fn === null && source) last = source();
    source = fn;
  },
  /** The ground point under the camera: live while a scene viewport is open, else the last seen. */
  centre: (): [number, number, number] | null => (source ? source() : last),
};
