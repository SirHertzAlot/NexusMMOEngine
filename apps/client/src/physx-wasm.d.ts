// Vite asset imports of the PhysX wasm: `import url from "physx-js-webidl/physx-js-webidl.wasm?url"`.
declare module "*.wasm?url" {
  const url: string;
  export default url;
}
