import sharp from "sharp";

const RESET = "\x1b[0m";
const ASCII_RAMP = " .:-=+*#%@";
const BRAILLE_BLANK = 0x2800;
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80]
];
const BRAILLE_DITHER = [
  [24, 152],
  [216, 88],
  [56, 184],
  [248, 120]
];

export async function renderImage(buffer, options = {}) {
  const style = options.style || (options.color ? "color" : "braille");
  if (style === "color") return renderColor(buffer, options);
  if (style === "color-braille") return renderColorBraille(buffer, options);
  if (style === "ascii") return renderAscii(buffer, options);
  if (style === "shade") return renderBrailleShade(buffer, options);
  return renderBraille(buffer, options);
}

export function terminalWidth() {
  return process.stdout.columns || 80;
}

export function terminalRows() {
  return process.stdout.rows || 40;
}

export function columnsForSize(size, width) {
  if (width) return clamp(width, 16, 160);

  const available = Math.max(20, terminalWidth() - 2);
  if (size === "small") return Math.min(40, available);
  if (size === "large") return Math.min(100, available);
  return Math.min(64, available);
}

function rowsForColumns(columns) {
  const available = Math.max(12, terminalRows() - 6);
  return clamp(Math.round(columns * 0.55), 12, available);
}

async function renderColor(buffer, options) {
  const columns = columnsForSize(options.size, options.width);
  const rows = rowsForColumns(columns);
  const sampleColumns = Math.ceil(columns / 2);
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({
      width: sampleColumns,
      height: rows,
      fit: "cover",
      position: "centre"
    })
    .flatten({ background: "#fff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const lines = [];

  for (let y = 0; y < info.height; y += 1) {
    let line = "";
    for (let x = 0; x < info.width; x += 1) {
      const finalCell = x === info.width - 1 && columns % 2;
      line += bg(pixel(data, info, x, y)) + (finalCell ? " " : "  ");
    }
    lines.push(line + RESET);
  }

  return lines.join("\n");
}

async function renderBraille(buffer, options) {
  const columns = columnsForSize(options.size, options.width);
  const rows = rowsForColumns(columns);
  const imageWidth = columns * 2;
  const imageHeight = rows * 4;
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({
      width: imageWidth,
      height: imageHeight,
      fit: "cover",
      position: "centre"
    })
    .flatten({ background: "#fff" })
    .grayscale()
    .blur(0.8)
    .normalise()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const edges = sobelEdges(data, info.width, info.height);
  const threshold = edgeThreshold(edges);
  const lines = [];

  for (let cellY = 0; cellY < info.height; cellY += 4) {
    let line = "";
    for (let cellX = 0; cellX < info.width; cellX += 2) {
      let bits = 0;

      for (let dotY = 0; dotY < 4; dotY += 1) {
        for (let dotX = 0; dotX < 2; dotX += 1) {
          const x = cellX + dotX;
          const y = cellY + dotY;
          const edge = edges[y * info.width + x];

          if (edge >= threshold) {
            bits |= BRAILLE_BITS[dotY][dotX];
          }
        }
      }

      line += bits ? String.fromCharCode(BRAILLE_BLANK + bits) : " ";
    }
    lines.push(line.trimEnd());
  }

  return trimEmptyLines(lines).join("\n");
}

async function renderColorBraille(buffer, options) {
  const columns = columnsForSize(options.size, options.width);
  const rows = rowsForColumns(columns);
  const imageWidth = columns * 2;
  const imageHeight = rows * 4;
  const resize = {
    width: imageWidth,
    height: imageHeight,
    fit: "cover",
    position: "centre"
  };
  const [gray, color] = await Promise.all([
    sharp(buffer)
      .rotate()
      .resize(resize)
      .flatten({ background: "#fff" })
      .grayscale()
      .blur(0.8)
      .normalise()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(buffer)
      .rotate()
      .resize(resize)
      .flatten({ background: "#fff" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
  ]);
  const edges = sobelEdges(gray.data, gray.info.width, gray.info.height);
  const threshold = edgeThreshold(edges);
  const lines = [];

  for (let cellY = 0; cellY < gray.info.height; cellY += 4) {
    let line = "";
    for (let cellX = 0; cellX < gray.info.width; cellX += 2) {
      let bits = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;

      for (let dotY = 0; dotY < 4; dotY += 1) {
        for (let dotX = 0; dotX < 2; dotX += 1) {
          const x = cellX + dotX;
          const y = cellY + dotY;
          const edge = edges[y * gray.info.width + x];

          if (edge >= threshold) {
            const index = (y * color.info.width + x) * color.info.channels;
            bits |= BRAILLE_BITS[dotY][dotX];
            red += color.data[index];
            green += color.data[index + 1];
            blue += color.data[index + 2];
            count += 1;
          }
        }
      }

      if (bits) {
        line += fg([
          Math.round(red / count),
          Math.round(green / count),
          Math.round(blue / count)
        ]) + String.fromCharCode(BRAILLE_BLANK + bits) + RESET;
      } else {
        line += " ";
      }
    }
    lines.push(line.trimEnd());
  }

  return trimEmptyLines(lines).join("\n");
}

async function renderBrailleShade(buffer, options) {
  const columns = columnsForSize(options.size, options.width);
  const rows = rowsForColumns(columns);
  const imageWidth = columns * 2;
  const imageHeight = rows * 4;
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({
      width: imageWidth,
      height: imageHeight,
      fit: "cover",
      position: "centre"
    })
    .flatten({ background: "#fff" })
    .grayscale()
    .normalise()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const lines = [];

  for (let cellY = 0; cellY < info.height; cellY += 4) {
    let line = "";
    for (let cellX = 0; cellX < info.width; cellX += 2) {
      let bits = 0;

      for (let dotY = 0; dotY < 4; dotY += 1) {
        for (let dotX = 0; dotX < 2; dotX += 1) {
          const x = cellX + dotX;
          const y = cellY + dotY;
          const value = data[y * info.width + x];
          const darkness = 255 - value;

          if (darkness > BRAILLE_DITHER[dotY][dotX]) {
            bits |= BRAILLE_BITS[dotY][dotX];
          }
        }
      }

      line += String.fromCharCode(BRAILLE_BLANK + bits);
    }
    lines.push(line.trimEnd());
  }

  return lines.join("\n");
}

function sobelEdges(data, width, height) {
  const edges = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const topLeft = data[(y - 1) * width + x - 1];
      const top = data[(y - 1) * width + x];
      const topRight = data[(y - 1) * width + x + 1];
      const left = data[y * width + x - 1];
      const right = data[y * width + x + 1];
      const bottomLeft = data[(y + 1) * width + x - 1];
      const bottom = data[(y + 1) * width + x];
      const bottomRight = data[(y + 1) * width + x + 1];

      const gx = -topLeft - 2 * left - bottomLeft + topRight + 2 * right + bottomRight;
      const gy = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      edges[y * width + x] = Math.hypot(gx, gy);
    }
  }

  return edges;
}

function edgeThreshold(edges) {
  const values = [];

  for (const value of edges) {
    if (value > 12) values.push(value);
  }

  if (!values.length) return 40;

  values.sort((a, b) => a - b);
  const percentile = values[Math.floor(values.length * 0.88)];
  return clamp(percentile, 70, 220);
}

function trimEmptyLines(lines) {
  let start = 0;
  let end = lines.length;

  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;

  return lines.slice(start, end);
}

async function renderAscii(buffer, options) {
  const columns = columnsForSize(options.size, options.width);
  const rows = rowsForColumns(columns);
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({
      width: columns,
      height: rows,
      fit: "cover",
      position: "centre"
    })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const lines = [];

  for (let y = 0; y < info.height; y += 1) {
    let line = "";
    for (let x = 0; x < info.width; x += 1) {
      const value = data[y * info.width + x];
      const index = Math.round((value / 255) * (ASCII_RAMP.length - 1));
      line += ASCII_RAMP[index];
    }
    lines.push(line);
  }

  return lines.join("\n");
}

function pixel(data, info, x, y) {
  const index = (y * info.width + x) * info.channels;
  return [data[index], data[index + 1], data[index + 2]];
}

function fg([r, g, b]) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bg([r, g, b]) {
  return `\x1b[48;2;${r};${g};${b}m`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}
