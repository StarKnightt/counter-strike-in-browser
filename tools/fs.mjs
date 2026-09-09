// Freesound CC0 helper (no API key): `node tools/fs.mjs search "query"` lists CC0 hits, `node tools/fs.mjs get <id> <name>` saves the HQ preview mp3 to assets_src/audio_raw/<name>.mp3
import fs from 'node:fs';
const UA = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' } };
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'search') {
  const q = encodeURIComponent(rest.join(' '));
  const html = await (await fetch(`https://freesound.org/search/?q=${q}&f=license:%22Creative+Commons+0%22&s=score+desc`, UA)).text();
  const re = /href="\/people\/([^/]+)\/sounds\/(\d+)\/"[^>]*title="([^"]*)"/g; let m; const seen = new Set();
  while ((m = re.exec(html))) { if (seen.has(m[2])) continue; seen.add(m[2]); console.log(m[2].padEnd(8), m[3].slice(0, 70).padEnd(72), m[1]); }
  // durations appear near each result as e.g. "0:03" -- print them roughly in order
  const durs = [...html.matchAll(/<span class="[^"]*duration[^"]*">\s*([\d:.]+)/g)].map((x) => x[1]);
  if (durs.length) console.log('durations:', durs.slice(0, 20).join(' '));
} else if (cmd === 'get') {
  const [id, name] = rest;
  const html = await (await fetch(`https://freesound.org/s/${id}/`, UA)).text();
  const url = html.match(/https:\/\/cdn\.freesound\.org\/previews\/[^"' ]+-hq\.mp3/)?.[0];
  if (!url) { console.error('no preview url for', id); process.exit(1); }
  fs.mkdirSync('assets_src/audio_raw', { recursive: true });
  const buf = Buffer.from(await (await fetch(url, UA)).arrayBuffer());
  fs.writeFileSync(`assets_src/audio_raw/${name}.mp3`, buf);
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1]?.trim();
  console.log(name, buf.length, 'bytes', '-', title);
  fs.appendFileSync('public/audio/CREDITS.txt', `${name}.mp3  <- freesound.org/s/${id}/  (${title})  CC0\n`);
} else console.log('usage: search <q> | get <id> <name>');
