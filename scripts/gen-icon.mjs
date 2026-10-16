import { readFile, writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";

const SIZE = 128;
const svgPath = new URL("../media/icon.svg", import.meta.url);
const pngPath = new URL("../media/icon.png", import.meta.url);

const svg = await readFile(svgPath);
const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: SIZE },
  background: "rgba(0,0,0,0)",
});
const png = resvg.render().asPng();
await writeFile(pngPath, png);
console.log(`Generado ${pngPath.pathname} (${SIZE}x${SIZE}, ${png.length} bytes)`);
