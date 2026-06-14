declare module "gl" {
  /**
   * headless-gl: create a WebGL-1-compatible rendering context with no window.
   * Returns a WebGLRenderingContext augmented with a few extras (e.g. STACKGL extensions).
   */
  function createContext(
    width: number,
    height: number,
    options?: WebGLContextAttributes
  ): WebGLRenderingContext;
  export = createContext;
}
