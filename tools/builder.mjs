import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = homedir();
const roots = [process.env.UA_BUILDER_ROOT, join(root, 'node_modules/@uaudio/luna-builder-sdk')].filter(Boolean);
const plugin = join(home, '.codex/plugins/cache/luna-builder-sdk/ua-luna-builder');
if (existsSync(plugin)) for (const v of readdirSync(plugin).sort((a,b) => b.localeCompare(a,undefined,{numeric:true}))) roots.push(join(plugin,v));
const cli = roots.flatMap((r) => [join(r,'sdk/cli.js'), join(r,'dist/cli.js')]).find(existsSync);
if (!cli) { console.error('Install the ua-luna-builder Codex plugin, or set UA_BUILDER_ROOT to the LUNA Builder SDK folder.'); process.exit(1); }
const args = process.argv.slice(2); if (!args.length) args.push('doctor');
const result = spawnSync(process.execPath, [cli, ...args], {cwd:root, stdio:'inherit', env:{...process.env, PATH:`${dirname(process.execPath)}:${process.env.PATH ?? ''}`}});
process.exit(result.status ?? 1);
