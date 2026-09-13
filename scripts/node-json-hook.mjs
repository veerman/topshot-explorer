// Node module hook so scripts can import the app's service modules unchanged.
// The services import JSON files the Vite way (no import attributes); plain
// Node ESM refuses those. This resolve hook adds `type: "json"` to any .json
// import so the same source runs in both places.
//
// Usage: node --import ./scripts/node-json-hook.mjs scripts/<script>.mjs
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        let result;
        try {
          result = await next(specifier, context);
        } catch (err) {
          // Vite resolves extensionless relative imports; plain Node does not
          if (err.code === "ERR_MODULE_NOT_FOUND" && (specifier.startsWith("./") || specifier.startsWith("../")) && !specifier.endsWith(".js")) {
            result = await next(specifier + ".js", context);
          } else {
            throw err;
          }
        }
        if (result.url && result.url.split("?")[0].endsWith(".json")) {
          return { ...result, importAttributes: { type: "json" } };
        }
        return result;
      }
    `)
);
