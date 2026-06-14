precision mediump float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform sampler2D u_palette;   // 256x1 RGBA, first u_paletteCount texels are the palette
uniform int u_paletteCount;    // number of valid palette entries (<= 256)
uniform int u_ditherMode;      // 0 = ordered (Bayer jitter), 1 = nearest (no jitter)

varying vec2 v_texCoord;

// 8x8 Bayer matrix for ordered dithering (copied from dither.frag).
const mat4 bayerMatrix0 = mat4(
     0.0,  32.0,   8.0,  40.0,
    48.0,  16.0,  56.0,  24.0,
    12.0,  44.0,   4.0,  36.0,
    60.0,  28.0,  52.0,  20.0
);

const mat4 bayerMatrix1 = mat4(
     2.0,  34.0,  10.0,  42.0,
    50.0,  18.0,  58.0,  26.0,
    14.0,  46.0,   6.0,  38.0,
    62.0,  30.0,  54.0,  22.0
);

float getBayerValue(vec2 pos) {
    int x = int(mod(pos.x, 8.0));
    int y = int(mod(pos.y, 8.0));

    int row = int(mod(float(y), 4.0));
    int col = int(mod(float(x), 4.0));
    int matrixIndex = int(mod(floor(float(x) / 4.0), 2.0));

    mat4 matrix = (matrixIndex == 0) ? bayerMatrix0 : bayerMatrix1;

    if (row == 0) {
        if (col == 0) return matrix[0][0];
        if (col == 1) return matrix[0][1];
        if (col == 2) return matrix[0][2];
        return matrix[0][3];
    } else if (row == 1) {
        if (col == 0) return matrix[1][0];
        if (col == 1) return matrix[1][1];
        if (col == 2) return matrix[1][2];
        return matrix[1][3];
    } else if (row == 2) {
        if (col == 0) return matrix[2][0];
        if (col == 1) return matrix[2][1];
        if (col == 2) return matrix[2][2];
        return matrix[2][3];
    } else {
        if (col == 0) return matrix[3][0];
        if (col == 1) return matrix[3][1];
        if (col == 2) return matrix[3][2];
        return matrix[3][3];
    }
}

void main() {
    vec4 color = texture2D(u_image, v_texCoord);
    vec3 rgb = color.rgb;

    // Optional ordered-dither perturbation. The palette is not uniformly spaced, so we use a
    // heuristic amplitude based on roughly cube-rooting the color count into per-axis spacing.
    if (u_ditherMode == 0) {
        float threshold = getBayerValue(v_texCoord * u_resolution) / 64.0; // 0..1
        float amplitude = 0.5 / pow(max(float(u_paletteCount), 1.0), 1.0 / 3.0);
        rgb += (threshold - 0.5) * amplitude;
        rgb = clamp(rgb, 0.0, 1.0);
    }

    // Nearest-color search over the palette (constant loop bound required by GLSL ES 1.00).
    vec3 best = rgb;
    float bestDist = 1.0e9;
    for (int i = 0; i < 256; i++) {
        if (i >= u_paletteCount) break;
        vec3 entry = texture2D(u_palette, vec2((float(i) + 0.5) / 256.0, 0.5)).rgb;
        vec3 d = entry - rgb;
        float dist = dot(d, d);
        if (dist < bestDist) {
            bestDist = dist;
            best = entry;
        }
    }

    gl_FragColor = vec4(best, color.a);
}
