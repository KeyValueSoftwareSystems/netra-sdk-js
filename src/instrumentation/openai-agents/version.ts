import { createRequire } from "module";

let _version = "1.0.0";
try {
  const req = createRequire(import.meta.url);
  const pkg = req("../../../package.json");
  if (pkg?.version) _version = pkg.version;
} catch {
  // Fall back to hardcoded version if package.json is unavailable at runtime
}

export const __version__ = _version;
