import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// The shipped SDK bundle is tested directly; no npm or live LUNA session is required.
vm.runInThisContext(await readFile(new URL('../vendor/luna.global.js', import.meta.url), 'utf8') + '\nglobalThis.Luna = Luna;');
await import('../logic.js');
const L = globalThis.EConsoleLogic;
const STRIP = 'fixture.uadx.ssl-e';
const MASTER = 'fixture.uadx.ssl-g';

async function fixture(t, { plugins = true } = {}) {
  const engine = new Luna.MockEngine();
  engine.addSession('session', { tracks: ['Vocal', 'Bass'] });
  engine.addBus('session', 'drums', { name: 'Drums', busType: 'aux' });
  if (plugins) {
    engine.addPlugin(STRIP, { name: 'UADx SSL 4000 E Channel Strip', manufacturer: 'Universal Audio', formats: [['mono', 'mono'], ['stereo', 'stereo']] });
    engine.addPlugin(MASTER, { name: 'UADx SSL G Buss Compressor', manufacturer: 'Universal Audio', formats: [['stereo', 'stereo']] });
  }
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  t.after(() => luna.close());
  const session = await luna.session();
  await luna.plugins.load();
  return { engine, luna, session, track: session.tracks.byId('Vocal') };
}
async function stripFixture(t) {
  const f = await fixture(t);
  f.slot = await L.ensurePlugin(f.luna, f.session, f.track, 'strip');
  // MockEngine's generic plugin supplies an input control; give it an SSL-like display name.
  f.engine.setValue(`${f.slot.path}/controls/input`, 'name', 'Input Gain');
  await f.engine.settled();
  await f.slot.controls.load();
  return f;
}
function customControl(engine, slot, id, name, { normalized = .5, discrete = false } = {}) {
  const path = `${slot.path}/controls/${id}`;
  engine.addNode(path, {
    properties: { uid: `fixture_${id}`, name, control_type: 'parameter', value: normalized,
      real_value: normalized, normalized_value: normalized, string_value: String(normalized),
      automatable: true, discrete, num_steps: discrete ? 2 : 0, initialized: true,
      touch_count: 0, real_values: discrete ? [0, 1] : [], string_values: discrete ? ['Off', 'On'] : [] },
    commands: { set_touch: (data, e, nodePath) => {
      e.touches.push(`${nodePath}:${data.touch ? 'on' : 'off'}`);
      e.setValue(nodePath, 'touch_count', data.touch ? 1 : 0);
      return null;
    } },
  });
}

test('lists only audio-capable tracks, summing buses, and master; supports selection', async (t) => {
  const { engine, session } = await fixture(t);
  engine.addTrack('session', 'click', { trackType: 'click' });
  engine.addTrack('session', 'midi', { trackType: 'midi_matrix' });
  engine.addBus('session', 'container', { busType: 'aux' });
  engine.setValue('/sessions/session/buses/container', 'folder_mode', 'container');
  engine.addBus('session', 'headphones', { busType: 'headphone' });
  await engine.settled();
  assert.deepEqual(L.channels(session, 'tracks').map((c) => c.id), ['Vocal', 'Bass']);
  assert.deepEqual(L.channels(session, 'buses').map((c) => c.id), ['drums']);
  assert.equal(L.channels(session, 'master')[0].id, session.master.id);
  await session.context.selectionTracks.set(['Vocal', 'drums']);
  assert.deepEqual(L.channels(session, 'selected').map((c) => c.id), ['Vocal', 'drums']);
});

test('catalog identifies exact UADx SSL roles and excludes legacy, wrong vendor, and unlicensed entries', async (t) => {
  const { engine, luna } = await fixture(t);
  engine.addPlugin('third.uadx.ssl', { name: 'UADx SSL 4000 E Channel Strip', manufacturer: 'Another Vendor' });
  engine.addPlugin('fixture.uad.ssl.legacy', { name: 'SSL E Channel Strip Legacy', manufacturer: 'Universal Audio' });
  engine.addPlugin('fixture.uadx.ssl9000', { name: 'UADx SSL 9000 Channel Strip', manufacturer: 'Universal Audio' });
  engine.addPlugin('fixture.uadx.ssl-g-strip', { name: 'UADx SSL G Channel Strip', manufacturer: 'Universal Audio' });
  engine.addPlugin('fixture.uadx.ssl-e-unlicensed', { name: 'UADx SSL E Channel Strip', manufacturer: 'Universal Audio' });
  engine.setValue('/plugins/fixture.uadx.ssl-e-unlicensed', 'authorized', false);
  await engine.settled(); await luna.plugins.reload();
  assert.deepEqual(L.pluginCandidates(luna, 'strip').map((p) => p.id), [STRIP]);
  assert.deepEqual(L.pluginCandidates(luna, 'master').map((p) => p.id), [MASTER]);
});

test('track-backed bus channels remain eligible and use bus scope and companion role', async (t) => {
  const { engine, luna, session } = await fixture(t);
  engine.addTrack('session', 'track-bus', { name: 'Track bus', trackType: 'bus' });
  await engine.settled(); await session.tracks.reload();
  const bus = session.tracks.byId('track-bus');
  assert.equal(L.channelKind(bus), 'bus');
  assert.equal(L.eligible(bus), true);
  assert.equal(L.roleForChannel(bus), 'strip');
  assert.ok(L.channels(session, 'buses').includes(bus));
  assert.ok(!L.channels(session, 'tracks').includes(bus));
  assert.equal((await L.ensurePlugin(luna, session, bus)).pluginId.value, STRIP);
});

test('insertion rejects a same-id channel object from a different session client', async (t) => {
  const first = await fixture(t);
  const other = await fixture(t);
  assert.equal(first.track.id, other.track.id);
  const requestsBefore = other.engine.requests.length;
  await assert.rejects(() => L.ensurePlugin(first.luna, first.session, other.track), { code: 'FOREIGN_CHANNEL' });
  assert.equal(other.engine.requests.length, requestsBefore);
});

test('insertion uses first empty effect slot, preserves existing plugins/native console, and reuses exact match', async (t) => {
  const { engine, luna, session, track } = await fixture(t);
  engine.addPlugin('fixture.other', { name: 'Other Effect' });
  await track.effects.load();
  await track.effects.byId('effect_0').setPlugin('fixture.other');
  await track.effects.byId('console').setPlugin('fixture.other');
  const slot = await L.ensurePlugin(luna, session, track, 'strip');
  assert.equal(slot.id, 'effect_1');
  const second = await L.ensurePlugin(luna, session, track, 'strip');
  assert.equal(second, slot);
  assert.equal(track.effects.byId('effect_0').pluginId.value, 'fixture.other');
  assert.equal(track.effects.byId('console').pluginId.value, 'fixture.other');
  const sslLoads = engine.requests.filter((r) => r.path.endsWith('/set_inserts') && r.data.inserts.some((i) => i.plugin_id === STRIP));
  assert.equal(sslLoads.length, 1);
});

test('full slots fail without replacing any plugin', async (t) => {
  const { engine, luna, session, track } = await fixture(t);
  engine.addPlugin('fixture.other', { name: 'Other Effect' });
  await track.effects.load();
  for (const slot of track.effectSlots) await slot.setPlugin('fixture.other');
  const before = engine.requests.filter((r) => r.path.endsWith('/set_inserts')).length;
  await assert.rejects(() => L.ensurePlugin(luna, session, track), { code: 'NO_EMPTY_SLOT' });
  assert.equal(engine.requests.filter((r) => r.path.endsWith('/set_inserts')).length, before);
  assert.ok(track.effectSlots.every((s) => s.pluginId.value === 'fixture.other'));
});

test('insertion preserves a slot filled while the compatibility query is pending', async (t) => {
  const { engine, luna, session, track } = await fixture(t);
  engine.addPlugin('fixture.other', { name: 'Other Effect' });
  await track.effects.load();
  const target = track.effectSlots[0];
  const validPlugins = target.validPlugins.bind(target);
  target.validPlugins = async () => {
    const rows = await validPlugins();
    await target.setPlugin('fixture.other');
    return rows;
  };
  await assert.rejects(() => L.ensurePlugin(luna, session, track), { code: 'SLOT_CHANGED' });
  assert.equal(target.pluginId.value, 'fixture.other');
});

test('missing, ambiguous, incompatible plugins and wrong roles produce explicit failures', async (t) => {
  const f = await fixture(t, { plugins: false });
  await assert.rejects(() => L.ensurePlugin(f.luna, f.session, f.track), { code: 'MISSING_PLUGIN' });
  f.engine.addPlugin(STRIP, { name: 'UADx SSL E Channel Strip', manufacturer: 'Universal Audio', formats: [['stereo', 'stereo']] });
  await f.engine.settled();
  await assert.rejects(() => L.ensurePlugin(f.luna, f.session, f.track), { code: 'INCOMPATIBLE_PLUGIN' });
  f.engine.addPlugin('fixture.uadx.ssl-e-au', { name: 'UADx SSL E Channel Strip', manufacturer: 'Universal Audio' });
  await f.engine.settled();
  await assert.rejects(() => L.ensurePlugin(f.luna, f.session, f.track), { code: 'CHOOSE_PLUGIN' });
  await assert.rejects(() => L.ensurePlugin(f.luna, f.session, f.track, 'master'), { code: 'WRONG_ROLE' });
});

test('buses receive the E strip and master receives the G compressor', async (t) => {
  const { luna, session } = await fixture(t);
  const bus = session.buses.byId('drums');
  assert.equal(L.roleForChannel(bus), 'strip');
  assert.equal((await L.ensurePlugin(luna, session, bus)).pluginId.value, STRIP);
  assert.equal(L.roleForChannel(session.master), 'master');
  assert.equal((await L.ensurePlugin(luna, session, session.master)).pluginId.value, MASTER);
});

test('ambiguous names stay unmapped; manual mappings resolve only unique initialized parameters', async (t) => {
  const { engine, slot } = await stripFixture(t);
  customControl(engine, slot, 'input2', 'Input Gain');
  customControl(engine, slot, 'lf', 'LF Gain');
  customControl(engine, slot, 'ghost', 'Output Gain');
  engine.setValue(`${slot.path}/controls/ghost`, 'initialized', null);
  await engine.settled(); await slot.controls.reload();
  assert.equal(Boolean(L.parameterMap(slot).inputGain), false);
  assert.equal(L.parameterMap(slot, { inputGain: 'input2' }).inputGain.id, 'input2');
  assert.equal(Boolean(L.parameterMap(slot).outputGain), false);
  const rows = L.parameters(slot, { inputGain: 'input2' });
  assert.equal(rows.find((r) => r.id === 'lf').group, 'eq');
  assert.ok(!rows.some((r) => r.id === 'ghost'));
  assert.equal(Boolean(L.parameterMap(slot, { inputGain: 'lf', lfGain: 'lf' }).inputGain), false);
});

test('session settings and stable channel seeds survive a second client connection', async (t) => {
  const { engine, session } = await fixture(t);
  const initial = await L.loadChannelState(session, 'Vocal');
  const bass = await L.loadChannelState(session, 'Bass');
  assert.notEqual(initial.seed, bass.seed);
  await L.saveSettings(session, { scope: 'buses', pluginIds: { strip: STRIP }, crosstalk: { amountDb: -64 } });
  const other = await Luna.connect({ port_: engine.port() });
  t.after(() => other.close());
  const otherSession = await other.session();
  assert.deepEqual(await L.loadChannelState(otherSession, 'Vocal'), initial);
  const settings = await L.loadSettings(otherSession);
  assert.equal(settings.scope, 'buses');
  assert.equal(settings.pluginIds.strip, STRIP);
  assert.equal(settings.pluginIds.master, null);
  assert.equal(settings.crosstalk.amountDb, -64);
  assert.equal(settings.crosstalk.enabled, false);
});

test('parameter variation is deterministic, noncumulative, role-aware, and touch-bracketed', async (t) => {
  const { engine, session, track, slot } = await stripFixture(t);
  const first = await L.applyVariation(session, track, slot, { amount: .8, seed: 12345 });
  const input = slot.controls.byId('input');
  const value = input.normalized.value;
  assert.equal(first.applied, 1);
  assert.notEqual(value, .5);
  assert.ok(Math.abs(value - .5) <= .006 * .8);
  await L.applyVariation(session, track, slot, { amount: .8, seed: 12345 });
  assert.equal(input.normalized.value, value);
  await L.applyVariation(session, track, slot, { amount: 0, seed: 12345 });
  assert.equal(input.normalized.value, .5);
  assert.deepEqual(engine.transactions, ['begin', 'commit', 'begin', 'commit', 'begin', 'commit']);
  assert.deepEqual(engine.touches, Array.from({ length: 3 }, () => [`${input.path}:on`, `${input.path}:off`]).flat());
});

test('variation rejects discrete controls and invalid amounts', async (t) => {
  const { engine, session, track, slot } = await stripFixture(t);
  engine.setValue(`${slot.path}/controls/input`, 'discrete', true);
  await engine.settled();
  await assert.rejects(() => L.applyVariation(session, track, slot), { code: 'NO_VARIATION_PARAMETERS' });
  await assert.rejects(() => L.applyVariation(session, track, slot, { amount: NaN }), { code: 'INVALID_AMOUNT' });
  assert.equal(engine.touches.length, 0);
});

test('restore protects a subsequent user edit while restoring unchanged parameters', async (t) => {
  const { engine, session, track, slot } = await stripFixture(t);
  customControl(engine, slot, 'output', 'Output Gain');
  await engine.settled(); await slot.controls.reload();
  await L.applyVariation(session, track, slot, { amount: .8 });
  await slot.controls.byId('input').normalized.set(.7);
  const result = await L.restoreVariation(session, track, slot);
  assert.deepEqual(result, { restored: 1, skipped: 1 });
  assert.equal(slot.controls.byId('input').normalized.value, .7);
  assert.equal(slot.controls.byId('output').normalized.value, .5);
  assert.equal((await L.loadChannelState(session, track.id)).variation, null);
});

test('variation reapply preserves user edits and restore refuses a replacement instance', async (t) => {
  const { engine, session, track, slot } = await stripFixture(t);
  await L.applyVariation(session, track, slot);
  await slot.controls.byId('input').normalized.set(.65);
  await assert.rejects(() => L.applyVariation(session, track, slot), { code: 'NO_VARIATION_PARAMETERS' });
  assert.equal(slot.controls.byId('input').normalized.value, .65);
  await slot.setPlugin(STRIP);
  await engine.settled();
  await assert.rejects(() => L.restoreVariation(session, track, slot), { code: 'INSTANCE_CHANGED' });
});
