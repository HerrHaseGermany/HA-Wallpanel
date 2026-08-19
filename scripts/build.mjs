import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf8"),
);
const source = await readFile(
  resolve(projectRoot, "src/ha-wallpanel.js"),
  "utf8",
);
const output = `/* HA-Wallpanel v${packageJson.version} */\n${source.replaceAll(
  "__PACKAGE_VERSION__",
  packageJson.version,
)}`;

const outputPath = resolve(
  projectRoot,
  "custom_components/ha_wallpanel/frontend/ha-wallpanel.js",
);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, output, "utf8");

console.log(`Built HA-Wallpanel frontend (v${packageJson.version})`);
