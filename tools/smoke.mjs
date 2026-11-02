// Smoke test: generate every set in every style and report piece counts / errors.
// Usage: node tools/smoke.mjs [SET] [STYLE]
import { generate, DEFAULT_PARAMS } from '../js/generator.js';
import { SETS } from '../js/sets.js';

const [onlySet, onlyStyle] = process.argv.slice(2);
const styles = onlyStyle ? [onlyStyle] : ['auto', 'dungeon', 'cave', 'wilds', 'town', 'swamp', 'ship', 'colossal'];
let failures = 0;
for (const set of SETS) {
  if (onlySet && set.id !== onlySet) continue;
  const line = [];
  for (const style of styles) {
    for (const seed of [1, 2, 3]) {
      try {
        const r = generate({ ...DEFAULT_PARAMS, theme: set.id, style, seed, width: 30, height: 30 });
        const top = r.design.levels.flatMap((l) => l.tiles).filter((t) => t.element !== 'BB-001');
        const bad = top.filter((t) => !t.element || t.orientation < 0 || t.orientation > 3 || !Number.isInteger(t.x) || !Number.isInteger(t.y));
        if (bad.length) throw new Error(`invalid tiles ${JSON.stringify(bad[0])}`);
        if (seed === 1) line.push(`${style}:${top.length}${top.length < 10 ? '!' : ''}`);
      } catch (e) {
        failures++;
        line.push(`${style}#${seed}:ERR ${e.message}`);
      }
    }
  }
  console.log(set.id.padEnd(4), set.style.padEnd(8), line.join(' '));
}
console.log(failures ? `${failures} failures` : 'all ok');
