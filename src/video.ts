/**
 * ffprobe / ffmpeg helpers for streaming raw RGBA frames in and out of the GPU pipeline.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/** Decoder: stdin ignored, stdout (raw frames) + stderr piped. */
export type DecoderProcess = ChildProcessByStdio<null, Readable, Readable>;
/** Encoder: stdin (raw frames) piped, stdout ignored, stderr piped. */
export type EncoderProcess = ChildProcessByStdio<Writable, null, Readable>;

export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  /** Total frame count if ffprobe could determine it, else null. */
  frameCount: number | null;
}

/** Probe a video for dimensions, frame rate, audio presence and (best-effort) frame count. */
export async function probe(input: string): Promise<VideoInfo> {
  const json = await runJson("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    input,
  ]);

  const streams: any[] = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  if (!video) throw new Error(`No video stream found in ${input}`);

  const width = Number(video.width);
  const height = Number(video.height);
  if (!width || !height) throw new Error(`Could not read video dimensions from ${input}`);

  const fps = parseFraction(video.avg_frame_rate) || parseFraction(video.r_frame_rate) || 30;

  let frameCount: number | null = null;
  if (video.nb_frames && /^\d+$/.test(video.nb_frames)) {
    frameCount = Number(video.nb_frames);
  } else {
    const dur = Number(video.duration ?? json.format?.duration);
    if (Number.isFinite(dur) && dur > 0) frameCount = Math.round(dur * fps);
  }

  return {
    width,
    height,
    fps,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    frameCount,
  };
}

export interface DecoderOptions {
  /** If set, scale decoded frames to these (even) dimensions before output. */
  width?: number;
  height?: number;
  /** If set, decode at most this many video frames. */
  maxFrames?: number;
}

/** Spawn ffmpeg decoding `input` into a stream of raw RGBA frames on stdout. */
export function spawnDecoder(input: string, opts: DecoderOptions = {}): DecoderProcess {
  const args = ["-nostdin", "-loglevel", "error", "-i", input];
  if (opts.maxFrames !== undefined) args.push("-frames:v", String(opts.maxFrames));
  if (opts.width !== undefined && opts.height !== undefined) {
    args.push("-vf", `scale=${opts.width}:${opts.height}:flags=bilinear`);
  }
  args.push("-f", "rawvideo", "-pix_fmt", "rgba", "-");
  return spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
}

export interface EncoderOptions {
  width: number;
  height: number;
  fps: number;
  crf: number;
  /** Original input, used as the audio source when `hasAudio` is true. */
  audioSource: string;
  hasAudio: boolean;
}

/** Spawn ffmpeg consuming raw RGBA frames on stdin, muxing original audio, writing `output`. */
export function spawnEncoder(
  output: string,
  opts: EncoderOptions
): EncoderProcess {
  const args = [
    "-nostdin",
    "-loglevel", "error",
    "-y",
    // Raw video from stdin (input 0).
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "-s", `${opts.width}x${opts.height}`,
    "-r", String(opts.fps),
    "-i", "-",
  ];

  if (opts.hasAudio) {
    // Original file as input 1, only for its audio.
    args.push("-i", opts.audioSource);
    args.push("-map", "0:v:0", "-map", "1:a:0", "-c:a", "copy", "-shortest");
  } else {
    args.push("-map", "0:v:0");
  }

  args.push(
    "-c:v", "libx264",
    "-crf", String(opts.crf),
    "-pix_fmt", "yuv420p",
    output
  );

  return spawn("ffmpeg", args, {
    stdio: ["pipe", "ignore", "pipe"],
  });
}

function parseFraction(value: unknown): number {
  if (typeof value !== "string") return 0;
  const [num, den] = value.split("/");
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

export interface Palette {
  /** 256*4 RGBA bytes; the first `count` entries are the palette, the rest are zero. */
  data: Uint8Array;
  count: number;
}

/**
 * Compute an adaptive palette from the whole video using ffmpeg's `palettegen`. The filter emits a
 * single 16x16 RGBA frame (256 texels) containing up to `maxColors` unique colors. We collect the
 * raw bytes, dedupe to the distinct colors, and pack them into the front of a 256-entry buffer.
 */
export async function generatePalette(input: string, maxColors: number): Promise<Palette> {
  const raw = await runBinary("ffmpeg", [
    "-nostdin",
    "-loglevel", "error",
    "-i", input,
    "-vf", `palettegen=max_colors=${maxColors}`,
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "-",
  ]);

  const data = new Uint8Array(256 * 4);
  const seen = new Set<number>();
  let count = 0;
  for (let i = 0; i + 3 < raw.length && count < 256; i += 4) {
    const r = raw[i], g = raw[i + 1], b = raw[i + 2];
    const key = (r << 16) | (g << 8) | b;
    if (seen.has(key)) continue;
    seen.add(key);
    const o = count * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
    count++;
  }

  if (count === 0) throw new Error(`palettegen produced no colors for ${input}`);
  return { data, count };
}

function runBinary(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d) => chunks.push(d as Buffer));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} exited with code ${code}: ${err.trim()}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

function runJson(cmd: string, args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} exited with code ${code}: ${err.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`Failed to parse ${cmd} output: ${(e as Error).message}`));
      }
    });
  });
}
