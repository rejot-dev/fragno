// The Worker's bundler imports WebAssembly as a compiled module.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
