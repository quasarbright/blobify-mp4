/**
 * Headless GL pipeline that applies dither + majority-vote cellular automaton to a single frame.
 *
 * Adapted from the reference browser app's `js/webgl-renderer.js`. Key differences:
 *  - Uses headless-gl (`gl`) instead of a canvas context.
 *  - No canvas blit / copy-to-screen step; we render into framebuffers and read pixels back.
 *  - No UNPACK_FLIP_Y (unsupported by headless-gl). Upload and readback share the same
 *    orientation, so the frame round-trips correctly without flipping.
 *  - All GL resources are created once and reused across every frame.
 */
import createGL from "gl";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SHADER_DIR = join(dirname(fileURLToPath(import.meta.url)), "shaders");

export type DitherMode = "ordered" | "nearest";

export interface ProcessOptions {
  paletteSize: number;
  iterations: number;
  ditherMode: DitherMode;
  /** Use the content-derived palette (set via setPalette) instead of the uniform RGB grid. */
  adaptive: boolean;
}

export class Renderer {
  private readonly gl: WebGLRenderingContext;
  private readonly width: number;
  private readonly height: number;

  private readonly ditherProgram: WebGLProgram;
  private readonly adaptiveDitherProgram: WebGLProgram;
  private readonly automatonProgram: WebGLProgram;

  private readonly quadBuffer: WebGLBuffer;

  // Adaptive palette: 256x1 RGBA texture; only the first `paletteCount` texels are valid.
  private readonly paletteTexture: WebGLTexture;
  private paletteCount = 0;

  // Input frame texture (re-uploaded each frame).
  private readonly inputTexture: WebGLTexture;
  private inputAllocated = false;

  // Ping-pong buffers for dither output + automaton iterations.
  private readonly pingTexture: WebGLTexture;
  private readonly pongTexture: WebGLTexture;
  private readonly pingFbo: WebGLFramebuffer;
  private readonly pongFbo: WebGLFramebuffer;

  // Reusable readback buffer.
  private readonly pixels: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;

    const gl = createGL(width, height, { preserveDrawingBuffer: true });
    if (!gl) {
      throw new Error(
        "Failed to create a headless WebGL context. Is the `gl` native addon built correctly?"
      );
    }
    this.gl = gl;

    const vertexSrc = readFileSync(join(SHADER_DIR, "vertex.vert"), "utf8");
    this.ditherProgram = this.createProgram(
      vertexSrc,
      readFileSync(join(SHADER_DIR, "dither.frag"), "utf8")
    );
    this.adaptiveDitherProgram = this.createProgram(
      vertexSrc,
      readFileSync(join(SHADER_DIR, "dither-adaptive.frag"), "utf8")
    );
    this.automatonProgram = this.createProgram(
      vertexSrc,
      readFileSync(join(SHADER_DIR, "automaton.frag"), "utf8")
    );

    this.quadBuffer = this.createQuadBuffer();

    this.inputTexture = this.createRenderTexture();
    this.pingTexture = this.createRenderTexture();
    this.pongTexture = this.createRenderTexture();
    this.allocateTexture(this.pingTexture);
    this.allocateTexture(this.pongTexture);
    this.pingFbo = this.createFramebuffer(this.pingTexture);
    this.pongFbo = this.createFramebuffer(this.pongTexture);

    this.paletteTexture = this.createRenderTexture();

    this.pixels = new Uint8Array(width * height * 4);
  }

  /**
   * Upload an adaptive palette for use by the adaptive dither path. `data` is 256*4 RGBA bytes;
   * only the first `count` entries are treated as valid.
   */
  setPalette(data: Uint8Array, count: number): void {
    const gl = this.gl;
    this.paletteCount = count;
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  /**
   * Run the full effect on one RGBA frame buffer (length width*height*4) and return the
   * processed RGBA buffer. The returned buffer is reused between calls — copy it if you
   * need to retain it.
   *
   * If `out` is provided (length width*height*4), the result is read back into it and returned;
   * this lets the caller pool output buffers and avoid a per-frame copy. Otherwise an internal
   * reusable buffer is used.
   */
  processFrame(frame: Uint8Array, opts: ProcessOptions, out?: Uint8Array): Uint8Array {
    const gl = this.gl;

    this.uploadFrame(frame);

    // 1. Dither the input texture into the ping buffer.
    const ditherMode = opts.ditherMode === "nearest" ? 1 : 0;
    if (opts.adaptive) {
      this.runPass(this.adaptiveDitherProgram, this.inputTexture, this.pingFbo, (program) => {
        gl.uniform1i(gl.getUniformLocation(program, "u_image"), 0);
        gl.uniform2f(gl.getUniformLocation(program, "u_resolution"), this.width, this.height);
        gl.uniform1i(gl.getUniformLocation(program, "u_ditherMode"), ditherMode);
        gl.uniform1i(gl.getUniformLocation(program, "u_paletteCount"), this.paletteCount);
        // Bind the palette to texture unit 1; runPass binds the source to unit 0 afterwards.
        gl.uniform1i(gl.getUniformLocation(program, "u_palette"), 1);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
      });
    } else {
      this.runPass(this.ditherProgram, this.inputTexture, this.pingFbo, (program) => {
        gl.uniform1i(gl.getUniformLocation(program, "u_image"), 0);
        gl.uniform2f(gl.getUniformLocation(program, "u_resolution"), this.width, this.height);
        gl.uniform1f(gl.getUniformLocation(program, "u_paletteSize"), opts.paletteSize);
        gl.uniform1i(gl.getUniformLocation(program, "u_ditherMode"), ditherMode);
      });
    }

    // 2. Run N automaton steps, ping-ponging between buffers.
    let srcTex = this.pingTexture;
    let dstFbo = this.pongFbo;
    let dstTex = this.pongTexture;
    for (let i = 0; i < opts.iterations; i++) {
      this.runPass(this.automatonProgram, srcTex, dstFbo, (program) => {
        gl.uniform1i(gl.getUniformLocation(program, "u_state"), 0);
        gl.uniform2f(gl.getUniformLocation(program, "u_resolution"), this.width, this.height);
        gl.uniform1f(gl.getUniformLocation(program, "u_paletteSize"), opts.paletteSize);
        gl.uniform1f(gl.getUniformLocation(program, "u_random"), Math.random());
      });
      // Swap: result we just wrote becomes the next source.
      if (srcTex === this.pingTexture) {
        srcTex = this.pongTexture;
        dstFbo = this.pingFbo;
        dstTex = this.pingTexture;
      } else {
        srcTex = this.pingTexture;
        dstFbo = this.pongFbo;
        dstTex = this.pongTexture;
      }
    }

    // After the loop, the final result lives in `srcTex` (last written). Read it back.
    const finalFbo = srcTex === this.pingTexture ? this.pingFbo : this.pongFbo;
    const dst = out ?? this.pixels;
    gl.bindFramebuffer(gl.FRAMEBUFFER, finalFbo);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, dst);
    return dst;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.ditherProgram);
    gl.deleteProgram(this.adaptiveDitherProgram);
    gl.deleteProgram(this.automatonProgram);
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteTexture(this.inputTexture);
    gl.deleteTexture(this.pingTexture);
    gl.deleteTexture(this.pongTexture);
    gl.deleteTexture(this.paletteTexture);
    gl.deleteFramebuffer(this.pingFbo);
    gl.deleteFramebuffer(this.pongFbo);
    const ext = gl.getExtension("STACKGL_destroy_context") as
      | { destroy(): void }
      | null;
    ext?.destroy();
  }

  // --- internals ---------------------------------------------------------

  /** Render a full-screen quad with `program`, sampling `srcTex` into `dstFbo`. */
  private runPass(
    program: WebGLProgram,
    srcTex: WebGLTexture,
    dstFbo: WebGLFramebuffer,
    setUniforms: (program: WebGLProgram) => void
  ): void {
    const gl = this.gl;
    gl.useProgram(program);
    setUniforms(program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);

    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
    gl.viewport(0, 0, this.width, this.height);

    const loc = gl.getAttribLocation(program, "a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private uploadFrame(frame: Uint8Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.inputTexture);
    if (this.inputAllocated) {
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, frame
      );
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame
      );
      this.inputAllocated = true;
    }
  }

  private createRenderTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("Failed to create texture");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return tex;
  }

  private allocateTexture(tex: WebGLTexture): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null
    );
  }

  private createFramebuffer(tex: WebGLTexture): WebGLFramebuffer {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("Failed to create framebuffer");
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Framebuffer is incomplete");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fbo;
  }

  private createQuadBuffer(): WebGLBuffer {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error("Failed to create quad buffer");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // Full-screen quad as a triangle strip.
    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    return buffer;
  }

  private createProgram(vertexSrc: string, fragmentSrc: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.compileShader(vertexSrc, gl.VERTEX_SHADER);
    const fs = this.compileShader(fragmentSrc, gl.FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!program) throw new Error("Failed to create program");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      throw new Error(`Program linking failed: ${info}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
  }

  private compileShader(source: string, type: number): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Failed to create shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compilation failed: ${info}`);
    }
    return shader;
  }
}
