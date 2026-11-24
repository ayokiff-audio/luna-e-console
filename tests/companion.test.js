import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the same bundled SDK used by the panel, without connecting to LUNA.
vm.runInThisContext(await readFile(new URL('../vendor/luna.global.js', import.meta.url), 'utf8') + '\nglobalThis.Luna = Luna;');
await import('../logic.js');
await import('../companion.js');
const A = globalThis.EConsoleAnalog;
const L = globalThis.EConsoleLogic;
const ANALOG = 'com.econsole.analog.au';
const STRIP = 'fixture.uadx.ssl-e';
const MASTER = 'fixture.uadx.ssl-g';
const defaults = [1, 20, -70, 0, 1, 0, 0, 0];

function addAnalogControls(engine, slotPath) {
  A.names.forEach((name, i) => {
    const path = `${slotPath}/controls/analog_${i}`;
    const discrete = name === 'Crosstalk Enabled' || name === 'Channel Role';
    const values = name === 'Channel Role' ? [0, 1, 2] : [0, 1];
    engine.addNode(path, {
      properties: {
        uid: `fixture_analog_${i}`, name, control_type: 'parameter', value: defaults[i],
        real_value: defaults[i], normalized_value: defaults[i], string_value: String(defaults[i]),
        automatable: true, discrete, num_steps: discrete ? values.length : 0,
        initialized: true, touch_count: 0, real_values: discrete ? values : [],
        string_values: discrete ? values.map(String) : [],
      },
      commands: { set_touch: (data, e, nodePath) => {
        e.touches.push(`${nodePath}:${data.touch ? 'on' : 'off'}`);
        e.setValue(nodePath, 'touch_count', data.touch ? 1 : 0);
        return null;
      } },
    });
  });
}

async function fixture(t, { companionInstalled = true, controlNames = true } = {}) {
  const engine = new Luna.MockEngine();
  engine.addSession('session', { tracks: ['Vocal', 'Bass'] });
  engine.setValue('/sessions/session/contexts/main', 'selection_grouping', true);
  engine.setValue('/sessions/session/contexts/main', 'groups_suspended', false);
  engine.addBus('session', 'drums', { name: 'Drums', busType: 'aux' });
  engine.addPlugin(STRIP, { name: 'UADx SSL 4000 E Channel Strip', manufacturer: 'Universal Audio' });
  engine.addPlugin(MASTER, { name: 'UADx SSL G Buss Compressor', manufacturer: 'Universal Audio' });
  engine.addPlugin('fixture.other', { name: 'Existing Effect' });
  if (companionInstalled) engine.addPlugin(ANALOG, { name: 'E Console Analog', manufacturer: 'E Console' });
  // The generic MockEngine gives every effect only input/bypass controls. Give our
  // fixture companion its actual native parameter contract when it is inserted.
  const addControl = engine.addControl.bind(engine);
  engine.addControl = (path, type, options) => {
    addControl(path, type, options);
    const slotPath = path.replace(/\/controls\/[^/]+$/, '');
    if (controlNames && path.endsWith('/controls/input') && engine.value(slotPath, 'plugin_id') === ANALOG) addAnalogControls(engine, slotPath);
  };
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  t.after(() => luna.close());
  const session = await luna.session();
  await luna.plugins.load();
  const track = session.tracks.byId('Vocal');
  const ssl = await L.ensurePlugin(luna, session, track);
  return { engine, luna, session, track, ssl };
}

const loads = (engine) => engine.requests.filter((r) => r.path.endsWith('/set_inserts'));

test('companion contract matches every named native parameter', async () => {
  const native = await readFile(new URL('../native/src/ConsoleDSP.hpp', import.meta.url), 'utf8');
  for (const name of A.names) assert.ok(native.includes(`{"${name}",`), name);
  assert.equal(new Set(A.names).size, 8);
});

test('new companion is placed after SSL, receives a stable seed/group, and starts with crosstalk off', async (t) => {
  const { engine, luna, session, track, ssl } = await fixture(t);
  const slot = await A.ensure(luna, session, track, ssl);
  assert.equal(slot.id, 'effect_1');
  assert.equal(slot.pluginId.value, ANALOG);
  const p = A.controls(slot);
  assert.ok(A.names.every((name) => p[name]));
  assert.equal(p['Crosstalk Enabled'].real.value, 0);
  assert.equal(p['Channel Role'].real.value, 0);
  assert.equal(p['Console Seed'].real.value, (await L.loadChannelState(session, track.id)).seed % 65535 + 1);
  assert.equal(p['Console Group'].real.value, A.hash(session.uid) % 65535 + 1);
  assert.equal(p.Variation.real.value, 20);
  assert.equal(p.Drive.real.value, 0);
  assert.deepEqual(engine.transactions, ['begin', 'commit']);
});

test('different tracks receive different repeatable harmonic identities in the same console group', async (t) => {
  const { luna, session, track, ssl } = await fixture(t);
  const first = A.controls(await A.ensure(luna, session, track, ssl));
  const bass = session.tracks.byId('Bass');
  const bassSSL = await L.ensurePlugin(luna, session, bass);
  const second = A.controls(await A.ensure(luna, session, bass, bassSSL));
  assert.notEqual(first['Console Seed'].real.value, second['Console Seed'].real.value);
  assert.equal(first['Console Group'].real.value, second['Console Group'].real.value);
  assert.equal(second['Crosstalk Enabled'].real.value, 0);
});

test('colliding 32-bit channel seeds receive unique persistent native identities, including range wrap', async (t) => {
  const { engine, luna, session, track, ssl } = await fixture(t);
  const bass = session.tracks.byId('Bass');
  const bassSSL = await L.ensurePlugin(luna, session, bass);
  const stateStore = session.storage.context(L.CONTEXT_ID);
  await stateStore.load();
  // These distinct 32-bit seeds both truncate to native identity 65535. The
  // collision must advance and wrap inside the native AU's 1..65535 range.
  await stateStore.add(track.id, 'state', { version: 1, seed: 65534, variation: null });
  await stateStore.add(bass.id, 'state', { version: 1, seed: 131069, variation: null });
  const firstSlot = await A.ensure(luna, session, track, ssl);
  const secondSlot = await A.ensure(luna, session, bass, bassSSL);
  const first = A.controls(firstSlot)['Console Seed'].real.value;
  const second = A.controls(secondSlot)['Console Seed'].real.value;
  assert.equal(first, 65535);
  assert.equal(second, 1);
  assert.notEqual(first, second);
  // A new client, reinserted companion, and subsequently changed control seed
  // state must all retain the separately saved native identity.
  await stateStore.set(bass.id, 'state', { version: 1, seed: 42, variation: null });
  await secondSlot.clear();
  const other = await Luna.connect({ port_: engine.port() });
  t.after(() => other.close());
  const reloadedSession = await other.session();
  await other.plugins.load();
  const reloadedBass = reloadedSession.tracks.byId('Bass');
  await reloadedBass.effects.load();
  const reloadedSSL = L.matchingEffects(reloadedBass, other)[0];
  const reinserted = await A.ensure(other, reloadedSession, reloadedBass, reloadedSSL);
  assert.equal(A.controls(reinserted)['Console Seed'].real.value, second);
  assert.equal(await A.seedFor(reloadedSession, reloadedSession.tracks.byId('Vocal')), first);
});

test('native AU qualified name and four-character manufacturer discover and load the companion', async (t) => {
  const { engine, luna, session, track, ssl } = await fixture(t);
  engine.addPlugin(ANALOG, { name: 'E Console: E Console Analog', manufacturer: 'ECns' });
  engine.addPlugin('fixture.spoof', { name: 'E Console: E Console Analog', manufacturer: 'Another Vendor' });
  await engine.settled();
  await luna.plugins.reload();
  assert.deepEqual(A.candidates(luna).map((p) => p.id), [ANALOG]);
  const slot = await A.ensure(luna, session, track, ssl);
  assert.equal(slot.pluginId.value, ANALOG);
  assert.equal(A.controls(slot)['Crosstalk Enabled'].real.value, 0);
});

test('reuse preserves a track companion’s user-edited character and enabled peer group', async (t) => {
  const { engine, luna, session, track, ssl } = await fixture(t);
  const first = await A.ensure(luna, session, track, ssl);
  const p = A.controls(first);
  await p['Console Seed'].real.set(1234);
  await p['Console Group'].real.set(4321);
  await p.Variation.real.set(42);
  await p['Crosstalk Enabled'].real.set(1);
  const before = loads(engine).length;
  const second = await A.ensure(luna, session, track, ssl);
  assert.equal(second, first);
  assert.equal(loads(engine).length, before);
  assert.equal(p['Console Seed'].real.value, 1234);
  assert.equal(p['Console Group'].real.value, 4321);
  assert.equal(p.Variation.real.value, 42);
  assert.equal(p['Crosstalk Enabled'].real.value, 1);
});

test('occupied inserts and native console slots are preserved; an empty slot before SSL is skipped', async (t) => {
  const { engine, luna, session, track, ssl } = await fixture(t);
  await ssl.clear();
  await track.effects.byId('console').setPlugin('fixture.other');
  const laterSSL = track.effects.byId('effect_2');
  await laterSSL.setPlugin(STRIP);
  await track.effects.byId('effect_3').setPlugin('fixture.other');
  const slot = await A.ensure(luna, session, track, laterSSL);
  assert.equal(slot.id, 'effect_4');
  assert.equal(track.effects.byId('effect_0').isEmpty, true);
  assert.equal(track.effects.byId('console').pluginId.value, 'fixture.other');
  assert.equal(track.effects.byId('effect_3').pluginId.value, 'fixture.other');
  assert.equal(loads(engine).at(-1).data.inserts[0].insert_type, 'effect_4');
});

test('full inserts after SSL fail without replacing audio effects', async (t) => {
  const { engine, luna, session, track, ssl } = await fixture(t);
  for (const slot of track.effectSlots.slice(1)) await slot.setPlugin('fixture.other');
  const before = loads(engine).length;
  await assert.rejects(() => A.ensure(luna, session, track, ssl), /empty insert after the SSL/);
  assert.equal(loads(engine).length, before);
  assert.equal(ssl.pluginId.value, STRIP);
});

test('uninstalled companion and unavailable native controls return clear failures', async (t) => {
  const missing = await fixture(t, { companionInstalled: false });
  await assert.rejects(() => A.ensure(missing.luna, missing.session, missing.track, missing.ssl), /Install E Console Analog/);
  const controls = await fixture(t, { controlNames: false });
  await assert.rejects(() => A.ensure(controls.luna, controls.session, controls.track, controls.ssl), /has not exposed these controls/);
  assert.equal(controls.track.effectSlots[0].pluginId.value, STRIP);
  assert.equal(controls.track.effectSlots[1].pluginId.value, ANALOG);
});

test('new bus and master companions are isolated from cross-channel leakage', async (t) => {
  const { luna, session } = await fixture(t);
  for (const [ch, role] of [[session.buses.byId('drums'), 1], [session.master, 2]]) {
    const ssl = await L.ensurePlugin(luna, session, ch);
    const p = A.controls(await A.ensure(luna, session, ch, ssl));
    assert.equal(p['Channel Role'].real.value, role);
    assert.equal(p['Crosstalk Enabled'].real.value, 0);
  }
});

test('reused bus and master companion receives the correct receive-only role without disabling its link', async (t) => {
  const { luna, session } = await fixture(t);
  for (const [ch, role] of [[session.buses.byId('drums'), 1], [session.master, 2]]) {
    const ssl = await L.ensurePlugin(luna, session, ch);
    const slot = await A.ensure(luna, session, ch, ssl);
    const p = A.controls(slot);
    await p['Channel Role'].real.set(0);
    await p['Crosstalk Enabled'].real.set(1);
    await p['Console Seed'].real.set(2456);
    await A.ensure(luna, session, ch, ssl);
    assert.equal(p['Channel Role'].real.value, role);
    assert.equal(p['Crosstalk Enabled'].real.value, 1);
    assert.equal(p['Console Seed'].real.value, 2456);
  }
});

test('read-only session blocks companion insertion before any insert mutation', async (t) => {
  const { engine, luna, session, track, ssl } = await fixture(t);
  engine.setValue(session.path, 'read_only', true);
  await engine.settled();
  const before = loads(engine).length;
  await assert.rejects(() => A.ensure(luna, session, track, ssl), /read.only/i);
  assert.equal(loads(engine).length, before);
});

test('another channel’s SSL insert cannot authorize companion placement', async (t) => {
  const { engine, luna, session, track } = await fixture(t);
  const bass = session.tracks.byId('Bass');
  const otherSSL = await L.ensurePlugin(luna, session, bass);
  const before = loads(engine).length;
  await assert.rejects(() => A.ensure(luna, session, track, otherSSL), /this channel.*SSL strip/i);
  assert.equal(loads(engine).length, before);
});

test('ineligible channels cannot receive the analog companion', async (t) => {
  const { engine, luna, session, ssl } = await fixture(t);
  engine.addTrack('session', 'click', { trackType: 'click' });
  await engine.settled();
  const before = loads(engine).length;
  await assert.rejects(() => A.ensure(luna, session, session.tracks.byId('click'), ssl), /audio channel, aux bus or master/i);
  assert.equal(loads(engine).length, before);
});

test('another session’s same-named channel cannot receive this session’s companion setup', async (t) => {
  const { engine, luna, session, ssl } = await fixture(t);
  engine.addSession('other', { tracks: ['Vocal'] });
  await engine.settled();
  const other = luna.sessions.items.byId('other');
  await other.ready();
  const foreignTrack = other.tracks.byId('Vocal');
  const before = loads(engine).length;
  await assert.rejects(() => A.ensure(luna, session, foreignTrack, ssl), /from this session/i);
  assert.equal(loads(engine).length, before);
});

test('the selected empty insert is rechecked after the asynchronous format query', async (t) => {
  const { engine, luna, session, track, ssl } = await fixture(t);
  const target = track.effects.byId('effect_1');
  const query = target.validPlugins.bind(target);
  target.validPlugins = async (...args) => {
    const valid = await query(...args);
    await target.setPlugin('fixture.other');
    return valid;
  };
  await assert.rejects(() => A.ensure(luna, session, track, ssl), /filled by another action/i);
  assert.equal(target.pluginId.value, 'fixture.other');
  assert.equal(loads(engine).filter((r) => r.data.inserts.some((i) => i.plugin_id === ANALOG)).length, 0);
});

test('channel format incompatibility cannot insert the companion', async (t) => {
  const { engine, luna, session, track, ssl } = await fixture(t);
  engine.addPlugin(ANALOG, { name: 'E Console Analog', manufacturer: 'E Console', formats: [['stereo', 'stereo']] });
  await engine.settled(); await luna.plugins.reload();
  const before = loads(engine).length;
  await assert.rejects(() => A.ensure(luna, session, track, ssl), /unavailable for this channel.*audio format/i);
  assert.equal(loads(engine).length, before);
});
