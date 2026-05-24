import process from "node:process";

import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";
import { getBestImage } from "./images.js";
import { resolveCharacter } from "./providers.js";
import { renderImage } from "./render.js";

export async function main(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

  if (options.version) {
    console.log("animeonterminal 0.1.0");
    return;
  }

  if (!options.query) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const character = await getCharacter(options.query, options);
  const image = await getBestImage(character, options);
  const art = await renderImage(image, {
    size: options.size,
    style: options.style,
    width: options.width
  });

  if (options.info && !options.artOnly) {
    console.log(formatHeader(character));
  }

  console.log(art);

  if (options.source && !options.artOnly) {
    console.log(`source: ${character.sourceUrl}`);
  }
}

function parseArgs(argv) {
  const options = {
    artOnly: false,
    info: false,
    provider: "auto",
    queryParts: [],
    refresh: false,
    size: "medium",
    source: false,
    style: "braille",
    width: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--version" || arg === "-v") {
      options.version = true;
    } else if (arg === "--no-color") {
      options.style = "ascii";
    } else if (arg === "--color") {
      options.style = "color";
    } else if (arg === "--style") {
      options.style = readValue(argv, ++index, "--style");
    } else if (arg.startsWith("--style=")) {
      options.style = arg.slice("--style=".length);
    } else if (arg === "--info") {
      options.info = true;
    } else if (arg === "--art-only") {
      options.artOnly = true;
      options.info = false;
    } else if (arg === "--refresh") {
      options.refresh = true;
    } else if (arg === "--source") {
      options.source = true;
    } else if (arg === "--provider") {
      options.provider = readValue(argv, ++index, "--provider");
    } else if (arg.startsWith("--provider=")) {
      options.provider = arg.slice("--provider=".length);
    } else if (arg === "--size") {
      options.size = readValue(argv, ++index, "--size");
    } else if (arg.startsWith("--size=")) {
      options.size = arg.slice("--size=".length);
    } else if (arg === "--width") {
      options.width = parseWidth(readValue(argv, ++index, "--width"));
    } else if (arg.startsWith("--width=")) {
      options.width = parseWidth(arg.slice("--width=".length));
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option "${arg}"`);
    } else {
      options.queryParts.push(arg);
    }
  }

  if (!["small", "medium", "large"].includes(options.size)) {
    throw new Error("Invalid --size. Use small, medium, or large.");
  }

  if (!["braille", "color-braille", "shade", "ascii", "color"].includes(options.style)) {
    throw new Error("Invalid --style. Use braille, color-braille, shade, ascii, or color.");
  }

  options.query = options.queryParts.join(" ").trim();
  return options;
}

async function getCharacter(query, options) {
  const key = cacheKey(`character:v9:${options.provider}:${query.toLowerCase()}`);

  if (!options.refresh) {
    const cached = await readJsonCache(key);
    if (cached) return cached;
  }

  const character = await resolveCharacter(query, { provider: options.provider });
  await writeJsonCache(key, character);
  return character;
}

function formatHeader(character) {
  const parts = [`${character.name}`, `via ${character.provider}`];

  if (character.nativeName) parts.splice(1, 0, character.nativeName);
  if (character.mediaTitles?.length) parts.push(character.mediaTitles[0]);

  return parts.join(" | ");
}

function readValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function parseWidth(value) {
  const width = Number.parseInt(value, 10);
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error("--width must be a positive integer");
  }
  return width;
}

function printHelp() {
  console.log(`Usage:
  animeonterminal <character name...> [options]

Examples:
  animeonterminal hitori goto
  animeonterminal "Hitori Gotou" --size large
  animeonterminal bocchi --provider anilist --width 72

Options:
  --provider <auto|anilist|jikan|acdb>  Character lookup provider (default: auto)
  --size <small|medium|large>           Output size (default: medium)
  --width <columns>                     Override output width
  --style <braille|color-braille|shade|ascii|color>
                                      Output style (default: braille outline)
  --color                               Shortcut for --style color
  --no-color                            Shortcut for --style ascii
  --info                                Print character metadata header
  --art-only                            Hide all metadata
  --source                              Print source URL after the art
  --refresh                             Ignore local cache
  -h, --help                            Show help
  -v, --version                         Show version`);
}
