import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";

import { getBestImage } from "../src/images.js";
import { downloadImage, resolveCharacter } from "../src/providers.js";
import { renderImage } from "../src/render.js";

const DEFAULT_QUERIES = [
  "hitori gotou",
  "nijika ijichi",
  "ryo yamada",
  "mikasa ackerman",
  "levi ackerman",
  "eren yeager",
  "naruto uzumaki",
  "monkey d luffy",
  "satoru gojo",
  "tanjiro kamado",
  "nezuko kamado",
  "frieren",
  "rem",
  "asuna yuuki",
  "marin kitagawa",
  "takagi",
  "bocchi"
];
const TILE_WIDTH = 828;
const TILE_HEIGHT = 250;
const IMAGE_WIDTH = 190;
const IMAGE_HEIGHT = 198;

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const providerArg = args.find((arg) => arg.startsWith("--provider="));
const provider = providerArg ? providerArg.slice("--provider=".length) : "auto";
const queries = args.filter((arg) => arg !== "--refresh" && !arg.startsWith("--provider="));
const cases = queries.length ? queries : DEFAULT_QUERIES;
const directory = process.env.AOT_EVAL_DIR || path.join(os.tmpdir(), `animeonterminal-evaluation-${provider}`);

await mkdir(directory, { recursive: true });

const tiles = [];
const report = [];

for (const query of cases) {
  try {
    const character = await resolveCharacter(query, { provider });
    const crop = await getBestImage(character, { refresh });
    const original = await downloadImage(character.imageUrl);
    const art = await renderImage(crop, { style: "braille", width: 36, size: "medium" });
    const slug = query.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

    await writeFile(path.join(directory, `${slug}-original.png`), original);
    await writeFile(path.join(directory, `${slug}.png`), crop);
    await writeFile(path.join(directory, `${slug}.txt`), `${art}\n`);
    tiles.push(await makeTile(query, character, original, crop, art));
    report.push({
      query,
      id: character.id,
      result: character.name,
      provider: character.imageProvider || character.provider,
      imageUrl: character.imageUrl,
      crop: `${slug}.png`,
      art: `${slug}.txt`
    });
  } catch (error) {
    tiles.push(await makeErrorTile(query, error.message));
    report.push({ query, error: error.message });
  }
}

const columns = 3;
const rows = Math.ceil(tiles.length / columns);
const sheet = sharp({
  create: {
    width: columns * TILE_WIDTH,
    height: rows * TILE_HEIGHT,
    channels: 3,
    background: "#f5f5f5"
  }
});
const composites = tiles.map((tile, index) => ({
  input: tile,
  left: (index % columns) * TILE_WIDTH,
  top: Math.floor(index / columns) * TILE_HEIGHT
}));

await sheet.composite(composites).png().toFile(path.join(directory, "contact-sheet.png"));
await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));

console.log(path.join(directory, "contact-sheet.png"));

async function makeTile(query, character, original, crop, cropArt) {
  const [originalPanel, cropPanel, originalArtPanel, cropArtPanel] = await Promise.all([
    imagePanel(original),
    imagePanel(crop),
    renderImage(original, { style: "braille", width: 36, size: "medium" }).then(braillePanel),
    braillePanel(cropArt)
  ]);
  const title = escapeXml(`${query} -> ${character.name}`);
  const source = escapeXml(character.imageProvider || character.provider);

  return sharp({
    create: {
      width: TILE_WIDTH,
      height: TILE_HEIGHT,
      channels: 3,
      background: "#ffffff"
    }
  })
    .composite([
      { input: originalPanel, left: 8, top: 40 },
      { input: cropPanel, left: 212, top: 40 },
      { input: originalArtPanel, left: 416, top: 40 },
      { input: cropArtPanel, left: 620, top: 40 },
      {
        input: Buffer.from(`<svg width="${TILE_WIDTH}" height="${TILE_HEIGHT}">
          <rect width="${TILE_WIDTH}" height="${TILE_HEIGHT}" fill="none" stroke="#dddddd"/>
          <text x="9" y="18" font-family="Arial" font-size="13" font-weight="bold" fill="#111111">${title}</text>
          <text x="9" y="33" font-family="Arial" font-size="11" fill="#555555">original | selected frame | original braille | selected braille | ${source}</text>
        </svg>`),
        left: 0,
        top: 0
      }
    ])
    .png()
    .toBuffer();
}

async function makeErrorTile(query, message) {
  return sharp(Buffer.from(`<svg width="${TILE_WIDTH}" height="${TILE_HEIGHT}">
    <rect width="${TILE_WIDTH}" height="${TILE_HEIGHT}" fill="#ffffff" stroke="#dddddd"/>
    <text x="9" y="20" font-family="Arial" font-size="13" font-weight="bold">${escapeXml(query)}</text>
    <text x="9" y="48" font-family="Arial" font-size="12" fill="#aa2222">${escapeXml(message).slice(0, 58)}</text>
  </svg>`)).png().toBuffer();
}

async function imagePanel(buffer) {
  return sharp(buffer)
    .rotate()
    .resize({
      width: IMAGE_WIDTH,
      height: IMAGE_HEIGHT,
      fit: "contain",
      background: "#f0f0f0"
    })
    .png()
    .toBuffer();
}

async function braillePanel(text) {
  const lines = text.split("\n");
  const width = Math.max(...lines.map((line) => [...line].length)) * 2;
  const height = lines.length * 4;
  const dots = Buffer.alloc(width * height, 255);
  const bitRows = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80]
  ];

  lines.forEach((line, row) => {
    [...line].forEach((character, column) => {
      const mask = character.codePointAt(0) - 0x2800;
      if (mask < 0 || mask > 0xff) return;

      bitRows.forEach((bits, dotY) => {
        bits.forEach((bit, dotX) => {
          if (mask & bit) dots[(row * 4 + dotY) * width + column * 2 + dotX] = 0;
        });
      });
    });
  });

  return sharp(dots, { raw: { width, height, channels: 1 } })
    .resize({
      width: IMAGE_WIDTH,
      height: IMAGE_HEIGHT,
      fit: "contain",
      kernel: "nearest",
      background: "#ffffff"
    })
    .png()
    .toBuffer();
}

function escapeXml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
