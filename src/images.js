import sharp from "sharp";

import { cacheKey, readImageCache, writeImageCache } from "./cache.js";
import { downloadImage } from "./providers.js";

const PROVIDER_BOOST = {
  "jikan-pictures": 12,
  anilist: 10,
  jikan: 8,
  acdb: -8
};

export async function getBestImage(character, options = {}) {
  const candidates = uniqueCandidates(character.imageCandidates?.length
    ? character.imageCandidates
    : [{ provider: character.provider, url: character.imageUrl }]);
  const limited = candidates.slice(0, 16);
  const scored = [];

  for (const candidate of limited) {
    try {
      const buffer = await getCachedImage(candidate.url, options.refresh);
      const prepared = await prepareImage(buffer, candidate);
      scored.push({ ...candidate, ...prepared });
    } catch {
      // Skip broken candidate images and keep trying the rest.
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) {
    throw new Error(`Could not download a usable image for "${character.name}".`);
  }

  character.imageUrl = best.url;
  character.imageProvider = best.provider;
  return best.buffer;
}

async function getCachedImage(url, refresh) {
  const key = cacheKey(`image-url:v1:${url}`);

  if (!refresh) {
    const cached = await readImageCache(key);
    if (cached) return cached;
  }

  const image = await downloadImage(url);
  await writeImageCache(key, image);
  return image;
}

async function prepareImage(buffer, candidate) {
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const aspect = width && height ? width / height : 1;
  const preview = sharp(buffer)
    .rotate()
    .resize({
      width: 96,
      height: 144,
      fit: "inside",
      withoutEnlargement: false
    })
    .flatten({ background: "#fff" });
  const [gray, color] = await Promise.all([
    preview
      .clone()
      .grayscale()
      .blur(0.6)
      .normalise()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    preview
      .clone()
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
  ]);

  const edges = sobelEdges(gray.data, gray.info.width, gray.info.height);
  const bbox = edgeBoundingBox(edges, gray.info.width, gray.info.height);
  const skin = skinFocus(color.data, color.info);
  const focus = skin.found ? skin : upperFocus(edges, gray.info.width, gray.info.height, bbox);
  const stats = edgeStats(edges, gray.info.width, gray.info.height, bbox);
  const cropPick = pickFaceCrop(edges, gray.info.width, gray.info.height, bbox, aspect, focus, skin);
  const crop = cropPick.crop;
  const outputBuffer = usesCuratedPortrait(candidate.provider)
    ? await sharp(buffer).rotate().png().toBuffer()
    : await sharp(buffer)
        .rotate()
        .extract(scaleCrop(crop, width, height, gray.info.width, gray.info.height))
        .png()
        .toBuffer();
  const sizeScore = clamp(Math.min(width, height) / 12, 0, 24);
  const aspectScore = clamp(22 - Math.abs(Math.log(aspect / 0.75)) * 11, 0, 22);
  const headScore = clamp(stats.upperShare * 34, 0, 34);
  const centerScore = clamp(stats.centerShare * 24, 0, 24);
  const fullBodyPenalty = clamp(stats.verticalSpread * 50 + stats.bottomShare * 70, 0, 72);
  const borderPenalty = clamp(stats.borderShare * 20, 0, 20);
  const skinScore = skin.found ? clamp(skin.score, 0, 34) : 0;
  const faceScale = skin.found
    ? Math.max((skin.maxX - skin.minX + 1) / gray.info.width, (skin.maxY - skin.minY + 1) / gray.info.height)
    : 0;
  const faceScaleScore = skin.found ? clamp(faceScale * 46, 0, 46) : 0;
  const tinyFacePenalty = skin.found ? clamp((0.24 - faceScale) * 170, 0, 34) : 14;
  const providerBoost = PROVIDER_BOOST[candidate.provider] || 0;
  const score = sizeScore + aspectScore + headScore + centerScore + skinScore + faceScaleScore + cropPick.score + providerBoost - fullBodyPenalty - borderPenalty - tinyFacePenalty;

  return { buffer: outputBuffer, score };
}

function usesCuratedPortrait(provider) {
  return provider === "jikan" || provider === "anilist";
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

function edgeBoundingBox(edges, width, height) {
  const xs = [];
  const ys = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (edges[y * width + x] < 64) continue;
      xs.push(x);
      ys.push(y);
    }
  }

  if (!xs.length) {
    return { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1, total: 0 };
  }

  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);

  return {
    minX: quantile(xs, 0.04),
    minY: quantile(ys, 0.04),
    maxX: quantile(xs, 0.96),
    maxY: quantile(ys, 0.96),
    total: xs.length
  };
}

function edgeStats(edges, width, height, bbox) {
  let total = 0;
  let center = 0;
  let border = 0;
  let upper = 0;
  let bottom = 0;
  const left = width * 0.2;
  const right = width * 0.8;
  const top = height * 0.08;
  const lower = height * 0.7;
  const upperLimit = height * 0.52;
  const bottomLimit = height * 0.72;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = edges[y * width + x];
      if (value < 64) continue;

      total += 1;
      if (x >= left && x <= right && y >= top && y <= lower) center += 1;
      if (y <= upperLimit) upper += 1;
      if (y >= bottomLimit) bottom += 1;
      if (x < 4 || x >= width - 4 || y < 4 || y >= height - 4) border += 1;
    }
  }

  return {
    density: total / (width * height),
    centerShare: total ? center / total : 0,
    upperShare: total ? upper / total : 0,
    bottomShare: total ? bottom / total : 0,
    borderShare: total ? border / total : 0,
    verticalSpread: (bbox.maxY - bbox.minY + 1) / height
  };
}

function upperFocus(edges, width, height, bbox) {
  const boxWidth = Math.max(8, bbox.maxX - bbox.minX + 1);
  const boxHeight = Math.max(8, bbox.maxY - bbox.minY + 1);
  const top = bbox.minY;
  const bottom = Math.min(height - 1, bbox.minY + boxHeight * 0.42);
  const left = Math.max(0, bbox.minX - boxWidth * 0.08);
  const right = Math.min(width - 1, bbox.maxX + boxWidth * 0.08);
  let sumX = 0;
  let sumY = 0;
  let weight = 0;

  for (let y = Math.floor(top); y <= bottom; y += 1) {
    for (let x = Math.floor(left); x <= right; x += 1) {
      const value = edges[y * width + x];
      if (value < 64) continue;

      sumX += x * value;
      sumY += y * value;
      weight += value;
    }
  }

  if (!weight) {
    return {
      x: (bbox.minX + bbox.maxX) / 2,
      y: bbox.minY + boxHeight * 0.18
    };
  }

  return { x: sumX / weight, y: sumY / weight };
}

function skinFocus(data, info) {
  const width = info.width;
  const height = info.height;
  const channels = info.channels;
  const mask = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * channels;
      if (isSkinPixel(data[index], data[index + 1], data[index + 2])) {
        mask[y * width + x] = 1;
      }
    }
  }

  let best = skinAggregate(mask, width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (!mask[start] || visited[start]) continue;

      const component = skinComponent(mask, visited, width, height, start);
      if (component.count < 12) continue;

      const score = scoreSkinComponent(component, width, height);
      if (!best || score > best.score + 38) {
        best = { ...component, score };
      }
    }
  }

  if (!best) {
    return { found: false, x: width / 2, y: height * 0.24, score: 0 };
  }

  return {
    found: true,
    x: best.x,
    y: best.y,
    minX: best.minX,
    minY: best.minY,
    maxX: best.maxX,
    maxY: best.maxY,
    score: best.score
  };
}

function skinAggregate(mask, width, height) {
  const points = [];
  let sumX = 0;
  let sumY = 0;
  let weightTotal = 0;
  let count = 0;

  for (let y = 0; y < height; y += 1) {
    if (y > height * 0.86) continue;

    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;

      const center = 1 - Math.min(1, Math.abs(x - width * 0.5) / (width * 0.5));
      const upper = clamp((height * 0.82 - y) / (height * 0.76), 0, 1);
      const edge = x < width * 0.06 || x > width * 0.94 || y < height * 0.02;
      const weight = (0.25 + center * 1.45 + upper * 1.15) * (edge ? 0.45 : 1);

      points.push({ x, y, weight });
      sumX += x * weight;
      sumY += y * weight;
      weightTotal += weight;
      count += 1;
    }
  }

  if (count < 18 || !weightTotal) return null;

  const component = {
    count,
    x: sumX / weightTotal,
    y: sumY / weightTotal,
    minX: weightedQuantile(points, "x", 0.08),
    minY: weightedQuantile(points, "y", 0.04),
    maxX: weightedQuantile(points, "x", 0.92),
    maxY: weightedQuantile(points, "y", 0.9)
  };
  const verticalShare = (component.maxY - component.minY + 1) / height;
  const skinShare = component.count / (width * height);

  if (verticalShare > 0.58 && skinShare < 0.12) return null;

  return {
    ...component,
    score: scoreSkinComponent(component, width, height) + 10
  };
}

function weightedQuantile(points, key, q) {
  const sorted = [...points].sort((a, b) => a[key] - b[key]);
  const total = sorted.reduce((sum, point) => sum + point.weight, 0);
  const target = total * q;
  let sum = 0;

  for (const point of sorted) {
    sum += point.weight;
    if (sum >= target) return point[key];
  }

  return sorted[sorted.length - 1][key];
}

function skinComponent(mask, visited, width, height, start) {
  const stack = [start];
  const pixels = [];
  let minX = width - 1;
  let minY = height - 1;
  let maxX = 0;
  let maxY = 0;
  let count = 0;

  visited[start] = 1;

  while (stack.length) {
    const index = stack.pop();
    const x = index % width;
    const y = Math.floor(index / width);

    pixels.push(index);
    count += 1;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);

    pushSkinNeighbor(mask, visited, stack, width, height, x - 1, y);
    pushSkinNeighbor(mask, visited, stack, width, height, x + 1, y);
    pushSkinNeighbor(mask, visited, stack, width, height, x, y - 1);
    pushSkinNeighbor(mask, visited, stack, width, height, x, y + 1);
  }

  const boxHeight = maxY - minY + 1;
  const focusLimit = minY + boxHeight * 0.82;
  const cropLimit = minY + boxHeight * 0.92;
  let sumX = 0;
  let sumY = 0;
  let focusCount = 0;
  let cropMinX = width - 1;
  let cropMinY = height - 1;
  let cropMaxX = 0;
  let cropMaxY = 0;
  let cropCount = 0;

  for (const index of pixels) {
    const x = index % width;
    const y = Math.floor(index / width);

    if (y <= focusLimit) {
      sumX += x;
      sumY += y;
      focusCount += 1;
    }

    if (y <= cropLimit) {
      cropCount += 1;
      cropMinX = Math.min(cropMinX, x);
      cropMinY = Math.min(cropMinY, y);
      cropMaxX = Math.max(cropMaxX, x);
      cropMaxY = Math.max(cropMaxY, y);
    }
  }

  if (focusCount < 8 || cropCount < 8) {
    sumX = 0;
    sumY = 0;

    for (const index of pixels) {
      sumX += index % width;
      sumY += Math.floor(index / width);
    }

    return {
      count,
      x: sumX / count,
      y: sumY / count,
      minX,
      minY,
      maxX,
      maxY
    };
  }

  return {
    count,
    x: sumX / focusCount,
    y: sumY / focusCount,
    minX: cropMinX,
    minY: cropMinY,
    maxX: cropMaxX,
    maxY: cropMaxY
  };
}

function pushSkinNeighbor(mask, visited, stack, width, height, x, y) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;

  const index = y * width + x;
  if (!mask[index] || visited[index]) return;

  visited[index] = 1;
  stack.push(index);
}

function scoreSkinComponent(component, width, height) {
  const boxWidth = Math.max(1, component.maxX - component.minX + 1);
  const boxHeight = Math.max(1, component.maxY - component.minY + 1);
  const aspect = boxWidth / boxHeight;
  const fill = component.count / Math.max(1, boxWidth * boxHeight);
  const center = 1 - Math.min(1, Math.abs(component.x - width * 0.5) / (width * 0.5));
  const upper = clamp((height * 0.78 - component.y) / (height * 0.55), 0, 1);
  const edgePenalty = component.minX <= 1
    || component.maxX >= width - 2
    || component.minY <= 1
    || component.maxY >= height - 2
    ? 18
    : 0;
  const widePenalty = boxWidth > width * 0.78 ? 18 : 0;

  return clamp(Math.sqrt(component.count) * 3.1, 0, 34)
    + clamp(center * 24, 0, 24)
    + clamp(upper * 20, 0, 20)
    + clamp(fill * 14, 0, 14)
    + bell(aspect, 0.28, 1.55, 16)
    - edgePenalty
    - widePenalty;
}

function isSkinPixel(red, green, blue) {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const chroma = max - min;
  const saturation = max ? chroma / max : 0;
  let hue = 0;

  if (chroma) {
    if (max === red) {
      hue = ((green - blue) / chroma) % 6;
    } else if (max === green) {
      hue = (blue - red) / chroma + 2;
    } else {
      hue = (red - green) / chroma + 4;
    }

    hue *= 60;
    if (hue < 0) hue += 360;
  }

  return max > 76
    && saturation > 0.055
    && saturation < 0.62
    && (hue <= 56 || hue >= 338)
    && red >= green * 0.88
    && green >= blue * 0.72
    && red >= blue * 1.03;
}

function faceCropFromBox(bbox, width, height, aspect, focus) {
  const boxWidth = Math.max(8, bbox.maxX - bbox.minX + 1);
  const boxHeight = Math.max(8, bbox.maxY - bbox.minY + 1);
  const centerX = clamp(focus.x, bbox.minX + boxWidth * 0.2, bbox.maxX - boxWidth * 0.2);
  const verticalSpread = boxHeight / height;
  const likelyFullBody = verticalSpread > 0.46 || boxHeight > boxWidth * 1.25 || aspect < 0.9;
  const targetAspect = 0.95;
  let cropHeight = likelyFullBody ? boxHeight * 0.16 : boxHeight * 0.32;
  let cropWidth = likelyFullBody
    ? cropHeight * targetAspect
    : Math.max(boxWidth * 0.58, cropHeight * targetAspect);

  cropHeight = clamp(cropHeight, height * 0.12, height * 0.46);
  cropWidth = clamp(cropWidth, width * 0.18, width);
  cropHeight = Math.max(cropHeight, cropWidth / targetAspect);

  const topBias = likelyFullBody ? 0.02 : 0.12;
  let y = Math.min(bbox.minY - cropHeight * topBias, focus.y - cropHeight * 0.38);
  let x = centerX - cropWidth / 2;

  if (!likelyFullBody && bbox.minY > height * 0.18) {
    y = Math.max(0, bbox.minY - cropHeight * 0.2);
  }

  x = clamp(x, 0, Math.max(0, width - cropWidth));
  y = clamp(y, 0, Math.max(0, height - cropHeight));
  cropWidth = Math.min(cropWidth, width - x);
  cropHeight = Math.min(cropHeight, height - y);

  return { x, y, width: cropWidth, height: cropHeight };
}

function pickFaceCrop(edges, width, height, bbox, aspect, focus, skin) {
  const boxWidth = Math.max(8, bbox.maxX - bbox.minX + 1);
  const boxHeight = Math.max(8, bbox.maxY - bbox.minY + 1);
  const targetAspect = 0.95;
  const proposals = [];

  if (skin?.found) {
    const skinScale = Math.max((skin.maxX - skin.minX + 1) / width, (skin.maxY - skin.minY + 1) / height);
    proposals.push({
      crop: faceCropFromSkin(width, height, skin, targetAspect),
      bias: skinScale > 0.48 ? 84 : 26
    });
    proposals.push({
      crop: fixedCrop(width, height, skin.x, skin.y, boxHeight * 0.22, targetAspect),
      bias: 14
    });
  }

  proposals.push(
    { crop: faceCropFromBox(bbox, width, height, aspect, focus), bias: 0 },
    { crop: fixedCrop(width, height, width * 0.5, height * 0.16, height * 0.18, targetAspect), bias: 0 },
    { crop: fixedCrop(width, height, (bbox.minX + bbox.maxX) / 2, bbox.minY + boxHeight * 0.1, boxHeight * 0.16, targetAspect), bias: 0 },
    { crop: fixedCrop(width, height, focus.x, focus.y, boxHeight * 0.18, targetAspect), bias: 0 },
    { crop: fixedCrop(width, height, width * 0.5, height * 0.22, height * 0.24, targetAspect), bias: 0 }
  );
  let best = { crop: proposals[0].crop, score: -Infinity };

  for (const proposal of proposals) {
    const score = scoreCrop(edges, width, height, proposal.crop) + scoreSkinCrop(proposal.crop, skin) + proposal.bias;
    if (score > best.score) best = { crop: proposal.crop, score };
  }

  return best;
}

function faceCropFromSkin(width, height, skin, targetAspect) {
  const skinWidth = Math.max(4, skin.maxX - skin.minX + 1);
  const skinHeight = Math.max(4, skin.maxY - skin.minY + 1);
  const skinScale = Math.max(skinWidth / width, skinHeight / height);
  const closeUp = skinScale > 0.48;
  let boxHeight = closeUp
    ? Math.max(skinHeight * 1.35, skinWidth * 1.45)
    : Math.max(skinHeight * 2.15, skinWidth * 1.35);
  boxHeight = closeUp
    ? clamp(boxHeight, height * 0.42, height * 0.98)
    : clamp(boxHeight, height * 0.16, height * 0.58);
  let boxWidth = clamp(
    Math.max(boxHeight * targetAspect, skinWidth * (closeUp ? 1.2 : 1.65)),
    closeUp ? width * 0.55 : width * 0.2,
    width
  );
  boxHeight = Math.max(boxHeight, boxWidth / targetAspect);
  const centerX = clamp(skin.x, boxWidth / 2, Math.max(boxWidth / 2, width - boxWidth / 2));
  let x = centerX - boxWidth / 2;
  let y = Math.min(skin.minY - boxHeight * 0.34, skin.y - boxHeight * 0.48);

  x = clamp(x, 0, Math.max(0, width - boxWidth));
  y = clamp(y, 0, Math.max(0, height - boxHeight));
  boxWidth = Math.min(boxWidth, width - x);
  boxHeight = Math.min(boxHeight, height - y);

  return { x, y, width: boxWidth, height: boxHeight };
}

function fixedCrop(width, height, centerX, centerY, cropHeight, targetAspect) {
  let boxHeight = clamp(cropHeight, height * 0.12, height * 0.38);
  let boxWidth = clamp(boxHeight * targetAspect, width * 0.18, width);
  let x = clamp(centerX - boxWidth / 2, 0, Math.max(0, width - boxWidth));
  let y = clamp(centerY - boxHeight * 0.38, 0, Math.max(0, height - boxHeight));
  boxWidth = Math.min(boxWidth, width - x);
  boxHeight = Math.min(boxHeight, height - y);

  return { x, y, width: boxWidth, height: boxHeight };
}

function scoreSkinCrop(crop, skin) {
  if (!skin?.found) return 0;

  const relativeX = (skin.x - crop.x) / crop.width;
  const relativeY = (skin.y - crop.y) / crop.height;
  if (relativeX < 0 || relativeX > 1 || relativeY < 0 || relativeY > 1) return -52;

  const skinWidth = Math.max(1, skin.maxX - skin.minX + 1);
  const skinHeight = Math.max(1, skin.maxY - skin.minY + 1);
  const widthShare = skinWidth / crop.width;
  const heightShare = skinHeight / crop.height;

  return bell(relativeX, 0.32, 0.7, 24)
    + bell(relativeY, 0.34, 0.72, 24)
    + bell(widthShare, 0.18, 0.62, 18)
    + bell(heightShare, 0.16, 0.64, 18);
}

function scoreCrop(edges, width, height, crop) {
  const left = Math.max(0, Math.floor(crop.x));
  const top = Math.max(0, Math.floor(crop.y));
  const right = Math.min(width - 1, Math.ceil(crop.x + crop.width));
  const bottom = Math.min(height - 1, Math.ceil(crop.y + crop.height));
  let total = 0;
  let center = 0;
  let upper = 0;
  let border = 0;
  const area = Math.max(1, (right - left + 1) * (bottom - top + 1));
  const centerLeft = left + (right - left) * 0.18;
  const centerRight = left + (right - left) * 0.82;
  const centerTop = top + (bottom - top) * 0.12;
  const centerBottom = top + (bottom - top) * 0.84;
  const upperBottom = top + (bottom - top) * 0.58;

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const value = edges[y * width + x];
      if (value < 64) continue;

      total += 1;
      if (x >= centerLeft && x <= centerRight && y >= centerTop && y <= centerBottom) center += 1;
      if (y <= upperBottom) upper += 1;
      if (x <= left + 1 || x >= right - 1 || y <= top + 1 || y >= bottom - 1) border += 1;
    }
  }

  const density = total / area;
  const centerShare = total ? center / total : 0;
  const upperShare = total ? upper / total : 0;
  const borderShare = total ? border / total : 0;
  const heightShare = (bottom - top + 1) / height;

  return bell(density, 0.05, 0.24, 34)
    + clamp(centerShare * 34, 0, 34)
    + clamp(upperShare * 16, 0, 16)
    - clamp(borderShare * 28, 0, 28)
    - clamp(heightShare * 22, 0, 22);
}

function scaleCrop(crop, originalWidth, originalHeight, previewWidth, previewHeight) {
  const xScale = originalWidth / previewWidth;
  const yScale = originalHeight / previewHeight;
  const left = Math.floor(crop.x * xScale);
  const top = Math.floor(crop.y * yScale);
  const width = Math.max(1, Math.min(originalWidth - left, Math.round(crop.width * xScale)));
  const height = Math.max(1, Math.min(originalHeight - top, Math.round(crop.height * yScale)));

  return { left, top, width, height };
}

function quantile(values, q) {
  return values[Math.max(0, Math.min(values.length - 1, Math.floor((values.length - 1) * q)))];
}

function bell(value, min, max, points) {
  if (value >= min && value <= max) return points;
  const target = value < min ? min : max;
  return clamp(points - Math.abs(value - target) * 180, 0, points);
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const unique = [];

  for (const candidate of candidates) {
    if (!candidate?.url || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    unique.push(candidate);
  }

  return unique;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}
