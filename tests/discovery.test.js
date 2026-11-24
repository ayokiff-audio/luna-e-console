import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

vm.runInThisContext(await readFile(new URL('../vendor/luna.global.js', import.meta.url), 'utf8') + '\nglobalThis.Luna = Luna;');
await import('../logic.js');
const L = globalThis.EConsoleLogic;
const NATIVE_E = 'uaudio_ssl_e_channel_strip';
const NATIVE_G = 'uaudio_ssl_g_bus_compressor';

async function catalog(t, rows) {
  const engine = new Luna.MockEngine();
  for (const [id, name, manufacturer = 'Universal Audio'] of rows) engine.addPlugin(id, { name, manufacturer });
  const luna = await Luna.connect({ port_: engine.port() });
  t.after(() => luna.close());
  await luna.plugins.load();
  return { engine, luna };
}

test('discovers the exact scanned LUNA-native SSL names and IDs on this Mac without a UADx token', async (t) => {
  // These IDs/names/manufacturer values were read from Universal Audio/workspace/plugin_cache/uadx.json.
  const { luna } = await catalog(t, [
    [NATIVE_E, 'SSL E Channel Strip'],
    [NATIVE_G, 'SSL G Bus Compressor'],
  ]);
  assert.deepEqual(L.pluginCandidates(luna, 'strip').map((p) => p.id), [NATIVE_E]);
  assert.deepEqual(L.pluginCandidates(luna, 'master').map((p) => p.id), [NATIVE_G]);
});

test('accepts Universal Audio AU and VST3 SSL names that omit the UADx prefix', async (t) => {
  // AU/VST3 IDs below are explicit fixtures, not claimed production plugin identifiers.
  const { luna } = await catalog(t, [
    ['fixture.com.uaudio.au.ssl-e', 'SSL E Channel Strip'],
    ['fixture.com.uaudio.vst3.ssl-e', 'SSL 4000 E Channel Strip'],
    ['fixture.com.uaudio.au.ssl-g', 'SSL G Buss Compressor'],
    ['fixture.com.uaudio.vst3.ssl-g', 'SSL G Bus Compressor'],
  ]);
  assert.equal(L.pluginCandidates(luna, 'strip').length, 2);
  assert.equal(L.pluginCandidates(luna, 'master').length, 2);
});

test('recognizes trusted manufacturer with opaque IDs and compact SSL 4000E/4000G names', async (t) => {
  const { luna } = await catalog(t, [
    ['fixture-opaque-e', 'SSL 4000E Channel Strip'],
    ['fixture-opaque-g', 'SSL 4000G Bus Compressor'],
    ['fixture-opaque-other', 'SSL G Channel Strip'],
  ]);
  assert.deepEqual(L.pluginCandidates(luna, 'strip').map((p) => p.id), ['fixture-opaque-e']);
  assert.deepEqual(L.pluginCandidates(luna, 'master').map((p) => p.id), ['fixture-opaque-g']);
});

test('continues excluding other vendors, legacy SSLs, wrong product roles, and refused licenses', async (t) => {
  const { engine, luna } = await catalog(t, [
    ['fixture.thirdparty.ssl-e', 'SSL E Channel Strip', 'Another Vendor'],
    ['fixture.thirdparty.uadx.ssl-g', 'UADx SSL G Bus Compressor', 'Another Vendor'],
    ['fixture.uaudio.legacy.e', 'SSL E Channel Strip Legacy'],
    ['fixture.uaudio.legacy.g', 'SSL G Bus Compressor Legacy'],
    ['fixture.uaudio.ssl9000', 'SSL 9000 Channel Strip'],
    ['fixture.uaudio.g-channel', 'SSL G Channel Strip'],
    ['fixture.uaudio.refused-e', 'SSL E Channel Strip'],
    ['fixture.uaudio.uninstalled-g', 'SSL G Bus Compressor'],
  ]);
  engine.setValue('/plugins/fixture.uaudio.refused-e', 'authorized', false);
  engine.setValue('/plugins/fixture.uaudio.uninstalled-g', 'installed', false);
  await engine.settled(); await luna.plugins.reload();
  assert.deepEqual(L.pluginCandidates(luna, 'strip').map((p) => p.id), []);
  assert.deepEqual(L.pluginCandidates(luna, 'master').map((p) => p.id), []);
});

test('accepts author-only Universal Audio metadata from native manifests', async (t) => {
  const { engine, luna } = await catalog(t, [['fixture-author-only', 'SSL E Channel Strip']]);
  const plugin = luna.plugins.byId('fixture-author-only');
  const { manufacturer, ...manifest } = plugin.manifest.value;
  engine.setValue('/plugins/fixture-author-only', 'manifest', { ...manifest, author: 'Universal Audio' });
  await engine.settled(); await luna.plugins.reload();
  assert.deepEqual(L.pluginCandidates(luna, 'strip').map((p) => p.id), ['fixture-author-only']);
});

test('format labels distinguish native, AU, and VST3 while preserving the product name', async (t) => {
  const { luna } = await catalog(t, [
    [NATIVE_E, 'SSL E Channel Strip'],
    ['fixture.com.uaudio.au.ssl-e', 'SSL E Channel Strip'],
    ['fixture.com.uaudio.vst3.ssl-e', 'SSL E Channel Strip'],
  ]);
  const native = luna.plugins.byId(NATIVE_E);
  const au = luna.plugins.byId('fixture.com.uaudio.au.ssl-e');
  const vst3 = luna.plugins.byId('fixture.com.uaudio.vst3.ssl-e');
  assert.equal(L.pluginFormat(native), 'LUNA native');
  assert.equal(L.pluginFormat(au), 'AU');
  assert.equal(L.pluginFormat(vst3), 'VST3');
  for (const plugin of [native, au, vst3]) {
    const label = L.pluginLabel(plugin);
    assert.ok(label.includes('SSL E Channel Strip'));
    assert.ok(label.includes(L.pluginFormat(plugin)));
  }
});

test('format labels use explicit manifest format when the plugin ID is opaque', async (t) => {
  const { engine, luna } = await catalog(t, [['fixture-opaque', 'SSL E Channel Strip']]);
  const plugin = luna.plugins.byId('fixture-opaque');
  engine.setValue('/plugins/fixture-opaque', 'manifest', { ...plugin.manifest.value, format: 'VST3' });
  await engine.settled(); await luna.plugins.reload();
  assert.equal(L.pluginFormat(plugin), 'VST3');
});

test('unknown plugin format keeps the visible label limited to its product name', async (t) => {
  const { luna } = await catalog(t, [['fixture-opaque-format', 'SSL E Channel Strip']]);
  const plugin = luna.plugins.byId('fixture-opaque-format');
  assert.equal(L.pluginFormat(plugin), 'Unknown format');
  assert.equal(L.pluginLabel(plugin), 'SSL E Channel Strip');
});
