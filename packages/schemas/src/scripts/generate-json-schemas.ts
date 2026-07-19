/**
 * Build step: write JSON Schemas generated from the Zod schemas to
 * packages/schemas/json/<name>.schema.json. The generated files are checked
 * in (contract section 1); a test asserts they stay in sync.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildJsonSchemas } from "../json-schemas.js";

const outDir = fileURLToPath(new URL("../../json/", import.meta.url));
const documents = buildJsonSchemas();

await mkdir(outDir, { recursive: true });
await Promise.all(
  Object.entries(documents).map(([name, document]) =>
    writeFile(
      `${outDir}${name}.schema.json`,
      `${JSON.stringify(document, null, 2)}\n`,
      "utf8",
    ),
  ),
);

console.log(
  `generated ${Object.keys(documents).length} JSON Schemas in ${outDir}`,
);
