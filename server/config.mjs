// Single site config. CA stays empty until the owner launches the token (then: "Announced at launch" disappears).
import { readFileSync } from "node:fs";
const FILE = new URL("../config/site.json", import.meta.url);
export function siteConfig(local) {
  const c = JSON.parse(readFileSync(FILE, "utf8"));
  const fill = (u) => (c.ca && u ? u.replace("{ca}", c.ca) : "");
  return { ...c, buyUrl: fill(c.buyUrl), chartUrl: fill(c.chartUrl), local: !!local };
}
