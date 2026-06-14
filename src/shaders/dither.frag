precision mediump float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_paletteSize;
uniform int u_ditherMode; // 0 = ordered dithering, 1 = nearest-neighbor

varying vec2 v_texCoord;

// 8x8 Bayer matrix for ordered dithering
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

// Get Bayer matrix value at position (x, y)
float getBayerValue(vec2 pos) {
    // Use mod function instead of % operator for GLSL ES 1.00 compatibility
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
    // Sample the current pixel color
    vec4 color = texture2D(u_image, v_texCoord);
    
    vec3 dithered;
    
    // Per-channel RGB quantization onto a uniform color cube. The number of levels per channel is
    // the cube root of the palette size, so the palette is always in color (never grayscale).
    float levelsPerChannel = ceil(pow(u_paletteSize, 1.0 / 3.0));
    float steps = max(levelsPerChannel - 1.0, 1.0);

    if (u_ditherMode == 1) {
        // Naive nearest-neighbor: quantize each channel to the nearest cube level.
        dithered.r = floor(color.r * steps + 0.5) / steps;
        dithered.g = floor(color.g * steps + 0.5) / steps;
        dithered.b = floor(color.b * steps + 0.5) / steps;
        dithered = clamp(dithered, 0.0, 1.0);
    } else {
        // Ordered dithering (Bayer matrix): perturb each channel before quantizing.
        float threshold = getBayerValue(v_texCoord * u_resolution) / 64.0;

        dithered.r = color.r + (threshold - 0.5) / steps;
        dithered.g = color.g + (threshold - 0.5) / steps;
        dithered.b = color.b + (threshold - 0.5) / steps;

        dithered.r = floor(dithered.r * steps + 0.5) / steps;
        dithered.g = floor(dithered.g * steps + 0.5) / steps;
        dithered.b = floor(dithered.b * steps + 0.5) / steps;

        dithered = clamp(dithered, 0.0, 1.0);
    }
    
    gl_FragColor = vec4(dithered, color.a);
}
