import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const master = process.argv[2] ?? "artifacts/icon-master.png";
const outDir = "docs/assets/icon";
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

await fs.mkdir(outDir, { recursive: true });

const pngs = [];
for (const size of sizes) {
  const buf = await sharp(master).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
  await fs.writeFile(path.join(outDir, `kivora-${size}.png`), buf);
  pngs.push({ size, buf });
}

// Windows .ico container with PNG payloads (Vista and newer).
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoPngs = pngs.filter((p) => icoSizes.includes(p.size));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoPngs.length, 4);

let offset = 6 + icoPngs.length * 16;
const entries = [];
for (const { size, buf } of icoPngs) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(buf.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += buf.length;
  entries.push(entry);
}

const ico = Buffer.concat([header, ...entries, ...icoPngs.map((p) => p.buf)]);
await fs.writeFile(path.join(outDir, "kivora.ico"), ico);

console.log(`wrote ${sizes.length} pngs + ico (${ico.length} bytes) to ${outDir}`);
