import { parse } from "../utils/reexport.js";
import { get as lodashGet } from "lodash";

export function processData(raw: string): Record<string, unknown> {
  // Call site of re-exported parse
  const parsed = parse(raw);
  const val = lodashGet(parsed, "key", "default_value");
  return { parsed, val };
}
