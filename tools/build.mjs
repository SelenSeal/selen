// Bundle the shared crypto for the browser. Run after changing anything in lib/.
import { build } from "esbuild";
const common = { bundle: true, format: "esm", minify: true, target: "es2022", platform: "browser", legalComments: "none" };
await build({ ...common, entryPoints: ["lib/client.mjs"], outfile: "public/vendor/selen.js" });
await build({ ...common, entryPoints: ["lib/argon-entry.mjs"], outfile: "public/vendor/argon2.js" });
await build({ ...common, entryPoints: ["lib/three-entry.mjs"], outfile: "public/vendor/three.js" });
console.log("built public/vendor/selen.js + argon2.js");
