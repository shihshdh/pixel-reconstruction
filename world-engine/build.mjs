// 打包漫游引擎：单个 ESM 文件 → ../public/world/engine.js（three、Spark、three-mesh-bvh 全部打进去，wasm 与 worker 由 Spark 内联）
import { build } from "esbuild";
import { statSync } from "node:fs";

const outfile = new URL("../public/world/engine.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
await build({
  entryPoints: [new URL("./src/engine.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020", "chrome100", "safari16"],
  minify: true,
  legalComments: "eof",
  outfile,
  logLevel: "info",
});
console.log(`engine.js ${(statSync(outfile).size / 1048576).toFixed(2)} MB`);
