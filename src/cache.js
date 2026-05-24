import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const APP_DIR = "animeonterminal";

export function getCacheDir() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, APP_DIR);
}

export function cacheKey(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export async function ensureCacheDir() {
  const dir = getCacheDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function readJsonCache(name) {
  try {
    const file = path.join(getCacheDir(), `${name}.json`);
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function writeJsonCache(name, value) {
  const dir = await ensureCacheDir();
  await writeFile(path.join(dir, `${name}.json`), JSON.stringify(value, null, 2));
}

export async function readImageCache(name) {
  try {
    return await readFile(path.join(getCacheDir(), `${name}.img`));
  } catch {
    return null;
  }
}

export async function writeImageCache(name, buffer) {
  const dir = await ensureCacheDir();
  await writeFile(path.join(dir, `${name}.img`), buffer);
}
