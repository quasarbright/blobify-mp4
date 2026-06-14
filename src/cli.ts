#!/usr/bin/env node
/**
 * blobify — apply a GPU dither + majority-vote cellular automaton effect to every frame of a video.
 *
 *   blobify <input> <output> [options]
 */
import { parseArgs } from "node:util";
import { once } from "node:events";
import { Renderer, type DitherMode } from "./renderer.js";
import { probe, spawnDecoder, spawnEncoder } from "./video.js";

interface Options {
  input: string;
  output: string;
  paletteSize: number;
  iterations: number;
  ditherMode: DitherMode;
  crf: number;
  fps: number | null;
  scale: number | null;
  maxFrames: number | null;
}

const USAGE = `blobify — blobify a video with a dither + majority-vote cellular automaton

Usage:
  blobify <input> <output> [options]

Options:
  -p, --palette-size <n>   palette size 2-256          (default 32)
  -i, --iterations <n>     automaton steps per frame; more = blobbier (default 10)
  -d, --dither <mode>      ordered | nearest            (default ordered)
      --crf <n>            x264 quality, lower=better   (default 18)
      --fps <n>            override output fps          (default: source fps)
  -s, --scale <factor>     downscale frames, e.g. 0.5   (default: 1, no scaling)
  -n, --frames <n>         process only the first n frames (quick preview)
  -h, --help               show this help
`;

function parseOptions(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "palette-size": { type: "string", short: "p" },
      iterations: { type: "string", short: "i" },
      dither: { type: "string", short: "d" },
      crf: { type: "string" },
      fps: { type: "string" },
      scale: { type: "string", short: "s" },
      frames: { type: "string", short: "n" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  if (positionals.length < 2) fail("Both <input> and <output> are required.\n\n" + USAGE);

  const dither = (values.dither ?? "ordered") as string;
  if (dither !== "ordered" && dither !== "nearest") {
    fail(`Invalid --dither "${dither}". Use "ordered" or "nearest".`);
  }

  const paletteSize = clamp(intOpt(values["palette-size"], "palette-size", 32), 2, 256);
  const iterations = Math.max(0, intOpt(values.iterations, "iterations", 10));
  const crf = clamp(intOpt(values.crf, "crf", 18), 0, 51);
  const fps = values.fps === undefined ? null : numOpt(values.fps, "fps");

  let scale: number | null = null;
  if (values.scale !== undefined) {
    scale = numOpt(values.scale, "scale");
    if (scale > 1) fail(`--scale must be <= 1 (downscaling only), got ${scale}.`);
  }

  let maxFrames: number | null = null;
  if (values.frames !== undefined) {
    maxFrames = intOpt(values.frames, "frames", 0);
    if (maxFrames <= 0) fail(`--frames must be a positive integer, got "${values.frames}".`);
  }

  return {
    input: positionals[0],
    output: positionals[1],
    paletteSize,
    iterations,
    ditherMode: dither as DitherMode,
    crf,
    fps,
    scale,
    maxFrames,
  };
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));

  const info = await probe(opts.input);

  // Resolve processing dimensions (scaled down, rounded to even for yuv420p).
  let width = info.width;
  let height = info.height;
  if (opts.scale !== null && opts.scale < 1) {
    width = Math.max(2, Math.round((info.width * opts.scale) / 2) * 2);
    height = Math.max(2, Math.round((info.height * opts.scale) / 2) * 2);
  }
  if (width % 2 !== 0 || height % 2 !== 0) {
    fail(
      `Frame dimensions ${width}x${height} are odd; the H.264/yuv420p encoder requires even ` +
        `width and height. Use --scale, or pre-crop the source to even dimensions.`
    );
  }
  const scaled = opts.scale !== null && opts.scale < 1;

  const totalFrames =
    opts.maxFrames !== null
      ? info.frameCount === null
        ? opts.maxFrames
        : Math.min(opts.maxFrames, info.frameCount)
      : info.frameCount;

  const outputFps = opts.fps ?? info.fps;
  const frameBytes = width * height * 4;

  process.stderr.write(
    `blobify: ${width}x${height}${scaled ? ` (from ${info.width}x${info.height})` : ""} ` +
      `@ ${outputFps.toFixed(3)}fps${totalFrames ? ` (${totalFrames} frames)` : ""}, ` +
      `palette=${opts.paletteSize} iterations=${opts.iterations} dither=${opts.ditherMode}\n`
  );

  const renderer = new Renderer(width, height);
  const decoder = spawnDecoder(opts.input, {
    width: scaled ? width : undefined,
    height: scaled ? height : undefined,
    maxFrames: opts.maxFrames ?? undefined,
  });
  const encoder = spawnEncoder(opts.output, {
    width,
    height,
    fps: outputFps,
    crf: opts.crf,
    audioSource: opts.input,
    hasAudio: info.hasAudio,
  });

  // Capture close events up front so awaiting them later can't miss an already-fired event.
  const decoderClosed = once(decoder, "close") as Promise<[number | null]>;
  const encoderClosed = once(encoder, "close") as Promise<[number | null]>;

  let decoderErr = "";
  let encoderErr = "";
  decoder.stderr.on("data", (d) => (decoderErr += d));
  encoder.stderr.on("data", (d) => (encoderErr += d));

  let processed = 0;

  // Reassemble decoder output into exact frame-sized buffers without per-frame concat: copy
  // incoming bytes into a fixed accumulator and flush a frame each time it fills.
  const accumulator = Buffer.allocUnsafe(frameBytes);
  let accLen = 0;

  // Pool of output buffers reclaimed via write-completion callbacks, so steady-state encoding
  // reuses a handful of buffers instead of allocating one per frame (avoids GC churn).
  const outPool: Buffer[] = [];
  const acquireOut = (): Buffer => outPool.pop() ?? Buffer.allocUnsafe(frameBytes);

  const emitFrame = async (): Promise<void> => {
    const out = acquireOut();
    // readPixels reads straight into the pooled buffer — no extra copy.
    renderer.processFrame(accumulator, opts, out);
    if (!encoder.stdin.write(out, () => outPool.push(out))) {
      await once(encoder.stdin, "drain");
    }

    processed++;
    if (processed % 30 === 0 || processed === totalFrames) {
      const total = totalFrames ? `/${totalFrames}` : "";
      process.stderr.write(`\rframes: ${processed}${total}   `);
    }
  };

  const processChunk = async (chunk: Buffer): Promise<void> => {
    let pos = 0;
    while (pos < chunk.length) {
      const take = Math.min(frameBytes - accLen, chunk.length - pos);
      chunk.copy(accumulator, accLen, pos, pos + take);
      accLen += take;
      pos += take;
      if (accLen === frameBytes) {
        await emitFrame();
        accLen = 0;
      }
    }
  };

  // Drive decoder stdout serially so processChunk's backpressure await is respected.
  decoder.stdout.on("pause", () => {});
  try {
    for await (const chunk of decoder.stdout) {
      decoder.stdout.pause();
      await processChunk(chunk as Buffer);
      decoder.stdout.resume();
    }

    const [decoderCode] = await decoderClosed;
    // When --frames limits decoding, ffmpeg exits early with SIGPIPE (code null/non-zero)
    // once we stop reading; that's expected, so only treat it as an error without a limit.
    if (decoderCode !== 0 && opts.maxFrames === null) {
      throw new Error(`ffmpeg (decode) failed:\n${decoderErr.trim()}`);
    }

    encoder.stdin.end();
    const [encoderCode] = await encoderClosed;
    process.stderr.write("\n");
    if (encoderCode !== 0) {
      throw new Error(`ffmpeg (encode) failed:\n${encoderErr.trim()}`);
    }
  } finally {
    renderer.dispose();
  }

  process.stderr.write(`Done. Wrote ${processed} frames to ${opts.output}\n`);
}

// --- small helpers ----------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function intOpt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) fail(`--${name} must be an integer, got "${value}".`);
  return n;
}

function numOpt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number, got "${value}".`);
  return n;
}

function fail(message: string): never {
  process.stderr.write(message + "\n");
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
