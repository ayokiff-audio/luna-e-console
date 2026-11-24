import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'e-console-pack-'));
const staged = join(temp, 'e-console'); mkdirSync(staged);
try {
  for (const name of ['manifest.json','console.html','console.css','console.js','index.html','style.css','logic.js','main.js','companion.js','demo.js','vendor']) cpSync(join(root,name),join(staged,name),{recursive:true});
  const out = resolve(process.argv[2] ?? join(root, '..', 'E Console.lunaaddon'));
  const result = spawnSync(process.execPath,[join(root,'tools/builder.mjs'),'pack',staged,'--no-vendor','--out',out],{stdio:'inherit'});
  process.exitCode = result.status ?? 1;
} finally { rmSync(temp,{recursive:true,force:true}); }
