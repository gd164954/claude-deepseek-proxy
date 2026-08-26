import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifestPath = new URL("../assets/icon-manifest.json", import.meta.url);
const iconPath = new URL("../assets/DeepSeekProxyManager.ico", import.meta.url);
const sourcePath = new URL("../assets/DeepSeekProxyManager-icon.png", import.meta.url);
const maskPath = new URL("../assets/DeepSeekProxyManager-icon-mask.png", import.meta.url);
const generatorPath = new URL("../assets/build-icon.ps1", import.meta.url);

function luminance(hex) {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

test("ships the approved lower-left-light to upper-right-deep icon assets", async () => {
  const [manifestText, icon, source, mask, generator] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(iconPath),
    readFile(sourcePath),
    readFile(maskPath),
    readFile(generatorPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.version, "1.6.11");
  assert.equal(manifest.direction, "lower-left light to upper-right deep");
  assert.equal(manifest.framing, "edge-to-edge on all four sides");
  assert.equal(manifest.segmentPaletteClockwiseFromTop.length, 8);
  assert.ok(
    luminance(manifest.segmentPaletteClockwiseFromTop[5]) >
      luminance(manifest.segmentPaletteClockwiseFromTop[1]),
    "lower-left segment must be lighter than upper-right segment",
  );

  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(source.subarray(0, 8), pngSignature);
  assert.deepEqual(mask.subarray(0, 8), pngSignature);
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), 9);
  assert.match(generator, /public static Bitmap FillCanvas\(Bitmap input\)/);
  assert.match(generator, /new Rectangle\(0, 0, input\.Width, input\.Height\)/);
});
