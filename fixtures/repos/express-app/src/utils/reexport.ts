export { parse, stringify } from "qs";

export function formatUrl(base: string, _params: Record<string, unknown>): string {
  return `${base}?formatted=true`;
}
