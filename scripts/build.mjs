import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { PACKAGE } from "../src/protocol.js";

// esbuild writes through a native binary that can inherit a lower Windows
// integrity level than the destination. Generate in memory and let Node write
// the files, as for the client bundle, without changing filesystem permissions.
await mkdir("lib", { recursive: true });

const host = await build({ entryPoints: ["src/host.js"], outfile: "lib/host.js", bundle: true, write: false,
  platform: "node", format: "esm", target: "node22", packages: "external", sourcemap: true });

const client = await build({ entryPoints: ["src/client-entry.js"], bundle: true, write: false,
  platform: "browser", format: "cjs", target: "es2022",
  external: ["react", "@deepseek-ai/dsh-client-ui-primitives"] });

for (const file of host.outputFiles) await writeFile(file.path, file.contents);
await writeFile("lib/client.js", `window.__ModuleLoader__.load({id:${JSON.stringify(PACKAGE)},factory:(require)=>{\nvar module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
console.log("Built DSH host and client modules.");
