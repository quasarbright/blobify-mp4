# blobify — majority automaton video effect

A GPU-accelerated CLI that applies a **dither + majority-vote cellular automaton** effect to every
frame of a video, producing a blobby, stained-glass "modern art" look.

Each frame is dithered down to a small color palette, then run through a cellular automaton where
every cell becomes the most common color among its 8 neighbors (ties broken randomly). Iterating this
merges the dithered noise into organic colored blobs. It's a port of
[image-majority-automaton](https://github.com/quasarbright/quasarbright.github.io/tree/master/p5js/image-majority-automaton)
from a single-image browser app to a streaming video CLI.

All image processing runs on the GPU via headless WebGL (the `gl` package); `ffmpeg` handles video
decode/encode and audio passthrough.

## Requirements

- **Node.js ≥ 18**
- **ffmpeg** and **ffprobe** on your `PATH`
- A working C toolchain for the `gl` native addon (on macOS: Xcode Command Line Tools, `xcode-select --install`)

## Install

Install dependencies and expose the `blobify` command globally:

```bash
npm install
npm link        # builds (via the prepare script) and links `blobify` onto your PATH
```

`npm link` runs the `prepare` script, which compiles TypeScript to `dist/` and copies the shaders, so
there's no separate build step. To remove the global command later, run `npm unlink -g blobify`.

If you'd rather not link globally, you can build and invoke directly instead:

```bash
npm run build
node dist/cli.js <input> <output> [options]
```

## Usage

```bash
blobify <input> <output> [options]
```

During development you can also run the TypeScript source without building:

```bash
npx tsx src/cli.ts <input> <output> [options]
```

### Options

| Flag | | Description | Default |
|------|---|-------------|---------|
| `--palette-size` | `-p` | Palette size, 2–256 | `32` |
| `--iterations`   | `-i` | Automaton steps per frame; more = blobbier everywhere | `10` |
| `--dither`       | `-d` | `ordered` or `nearest` | `ordered` |
| `--crf`          |      | x264 quality (lower = better) | `18` |
| `--fps`          |      | Override output fps | source fps |
| `--scale`        | `-s` | Downscale frames by a factor ≤ 1 (e.g. `0.5`) | `1` (none) |
| `--frames`       | `-n` | Process only the first N frames (quick preview) | all |
| `--help`         | `-h` | Show help | |

> **Note:** palettes of 8 or fewer colors use a grayscale path (matching the reference); larger
> palettes quantize per RGB channel.

### Example

```bash
blobify input.mp4 blobified.mp4 -p 16 -i 20 -d ordered
```

More iterations make the result blobbier everywhere — each step lets the majority vote grow regions
outward, so blobs get larger and smoother across the whole frame. Smaller palettes give chunkier,
flatter color regions. Audio from the input is copied into the output unchanged.

## How it works

```
input.mp4 ──ffmpeg──▶ raw RGBA frames ──▶ GPU: dither → N automaton steps ──▶ raw RGBA frames ──ffmpeg──▶ output.mp4
                                                                                                   ▲
                                                            original audio stream ─────────────────┘
```

Frames stream through pipes — no intermediate files are written to disk. The GL pipeline (shaders,
textures, ping-pong framebuffers) is created once and reused for every frame.

## Limitations

- Output uses H.264 / `yuv420p`, which requires **even** width and height. The tool errors out on odd
  dimensions; pre-scale or crop the source if needed.
- A fresh random seed is used per frame, so tie-breaking shimmers slightly frame-to-frame — this is
  intentional and gives the result a living quality.
