import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Regenerate the distributable shell icon set from the installed Lucide package.
// All embedded artwork is Lucide ISC; the copied commercial originals are never used.
const original = 'native-shell/assets/icons';
const output = 'native-shell/assets-safe/icons';
const base = resolve('node_modules/.pnpm/lucide@0.468.0/node_modules/lucide/dist/esm/icons');
const strokeWidth = '1.7';

await mkdir(output, {recursive:true});

// Upstream filenames kept during the shell transition. Values are Lucide names.
const aliases = {
  batch:'list-checks', bin:'trash-2', braces:'braces', divider:'minus', doc:'file-text',
  'eye-open':'eye', export:'upload', 'home-filled':'house',home:'house','image-broken':'image-off',
  'info-mark':'info',library:'library-big','page-width':'between-horizontal-start',
  'pin-filled':'pin','search-clear':'circle-x','settings-gear':'settings',sigma:'sigma',
  'sort-down':'arrow-down-wide-narrow','star-off':'star','storage':'hard-drive',
  'todo-check':'square-check','tree-triangle':'chevron-right','view-grid':'layout-grid',
  'view-list':'list','view-settings':'sliders-horizontal','circle-filled':'circle',
  'list-todo':'list-todo',restore:'rotate-ccw',
};

// The lean shell's complete semantic set. Filenames are API: do not rename them
// without changing every icon call site. Every value exists in lucide@0.468.0.
const leanIcons = {
  home:'house',
  library:'library-big',
  tabs:'notebook-tabs',
  search:'search',
  plus:'plus',
  settings:'settings',
  favourite:'star',
  translate:'languages',
  capture:'scan-line',
  'window-minimize':'minus',
  'window-maximize':'maximize',
  'window-close':'x',
  'window-restore':'copy',
  'chevron-down':'chevron-down',
  'chevron-right':'chevron-right',
  'chevron-left':'chevron-left',
  'chevron-up':'chevron-up',
  check:'check',
  x:'x',
  grid:'layout-grid',
  list:'list',
  sort:'arrow-up-down',
  filter:'filter',
  folder:'folder',
  file:'file-text',
  more:'ellipsis',
  pause:'pause',
  play:'play',
  refresh:'refresh-cw',
  external:'external-link',
  trash:'trash-2',
  pin:'pin',
  moon:'moon',
  sun:'sun',
  palette:'palette',
  monitor:'monitor',
  'sidebar-collapse':'panel-left-close',
  'sidebar-expand':'panel-left-open',
};

const legacy = new Map();
let legacyFromOutput = false;
try {
  for (const file of await readdir(original)) {
    if (!file.endsWith('.svg')) continue;
    const name = file.slice(0, -4);
    legacy.set(name, aliases[name] ?? name);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  // native-shell/assets/icons is no longer in this checkout. Keep the existing
  // transition aliases buildable by regenerating them from the safe output at
  // the lean stroke weight. Remove this fallback when the legacy shell leaves
  // the release path.
  legacyFromOutput = true;
  for (const file of await readdir(output)) {
    if (!file.endsWith('.svg')) continue;
    const name = file.slice(0, -4);
    if (Object.hasOwn(leanIcons, name)) continue;
    legacy.set(name, aliases[name] ?? name);
  }
}

const targets = new Map([...legacy, ...Object.entries(leanIcons)]);
const escape = value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
function svg(node) { const [tag,attrs,children=[]] = node; return `<${tag} ${Object.entries(attrs).map(([k,v])=>`${k}="${escape(v)}"`).join(' ')}>${children.map(svg).join('')}</${tag}>`; }
function render(icon) {
  const attrs = { ...icon[1], width:'24', height:'24', viewBox:'0 0 24 24', fill:'none', stroke:'currentColor', 'stroke-width':strokeWidth, 'stroke-linecap':'round', 'stroke-linejoin':'round' };
  return svg(['svg', attrs, icon[2]]);
}
async function load(name, required) {
  try { return (await import(pathToFileURL(`${base}/${name}.js`).href)).default; }
  catch (error) {
    if (required) throw new Error(`lean icon maps to missing Lucide icon "${name}": ${error.message}`);
    return (await import(pathToFileURL(`${base}/file-text.js`).href)).default;
  }
}

for (const [name, lucideName] of [...targets].sort(([a], [b]) => a.localeCompare(b))) {
  const icon = await load(lucideName, Object.hasOwn(leanIcons, name));
  await writeFile(`${output}/${name}.svg`, render(icon));
}

console.log(`Generated ${targets.size} Lucide SVGs at 24x24, stroke ${strokeWidth}, currentColor: ${legacy.size} ${legacyFromOutput ? 'transition' : 'upstream'} aliases + ${Object.keys(leanIcons).length} lean semantic icons.`);
console.log('Original commercial icons will not be embedded.');
