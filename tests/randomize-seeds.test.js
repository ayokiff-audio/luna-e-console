import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

vm.runInThisContext(await readFile(new URL('../vendor/luna.global.js', import.meta.url), 'utf8') + '\nglobalThis.Luna = Luna;');
await import('../logic.js');
await import('../companion.js');
const A = globalThis.EConsoleAnalog;
const L = globalThis.EConsoleLogic;
const ANALOG = 'fixture.econsole.analog.au';
const STRIP = 'uaudio_ssl_e_channel_strip';
const MASTER = 'uaudio_ssl_g_bus_compressor';
const STORE = 'com.econsole.control.analog';

function addAnalogControls(engine, slot, seed, role) {
  const values = [seed, 37, -63, role === 0 ? 1 : 0, 475, role, 4.5, -1.5];
  A.names.forEach((name, i) => {
    const path = `${slot.path}/controls/native_${i}`;
    const discrete = name === 'Crosstalk Enabled' || name === 'Channel Role';
    const steps = name === 'Channel Role' ? [0, 1, 2] : [0, 1];
    engine.addNode(path, {
      properties: { uid: `fixture_${slot.path}_${i}`, name, control_type: 'parameter',
        value: values[i], normalized_value: values[i], real_value: values[i], string_value: String(values[i]),
        initialized: true, automatable: true, discrete, num_steps: discrete ? steps.length : 0,
        real_values: discrete ? steps : [], string_values: discrete ? steps.map(String) : [], touch_count: 0 },
      commands: { set_touch: (data, e, nodePath) => {
        e.touches.push(`${nodePath}:${data.touch ? 'on' : 'off'}`);
        e.setValue(nodePath, 'touch_count', data.touch ? 1 : 0);
        return null;
      } },
    });
  });
}
async function fixture(t) {
  const engine = new Luna.MockEngine();
  engine.addSession('randomize-fixture', { tracks: ['Vocal', 'Bass', 'Empty'] });
  engine.setValue('/sessions/randomize-fixture/contexts/main', 'selection_grouping', true);
  engine.setValue('/sessions/randomize-fixture/contexts/main', 'groups_suspended', false);
  engine.addTrack('randomize-fixture', 'TrackBus', { name: 'Track bus', trackType: 'bus', stemFormat: 'stereo' });
  engine.addBus('randomize-fixture', 'Drums', { name: 'Drums bus', busType: 'aux' });
  engine.addBus('randomize-fixture', 'Container', { name: 'Container', busType: 'aux' });
  engine.setValue('/sessions/randomize-fixture/buses/Container', 'folder_mode', 'container');
  engine.addPlugin(ANALOG, { name: 'E Console Analog', manufacturer: 'E Console' });
  engine.addPlugin(STRIP, { name: 'SSL E Channel Strip', manufacturer: 'Universal Audio' });
  engine.addPlugin(MASTER, { name: 'SSL G Bus Compressor', manufacturer: 'Universal Audio' });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() }); t.after(() => luna.close());
  const session = await luna.session(); await luna.plugins.load();
  const targets = [], excluded = [];
  async function insert(ch, seed, role, destination = targets) {
    await ch.effects.load();
    const slot = await ch.insert(ANALOG);
    addAnalogControls(engine, slot, seed, role);
    await engine.settled(); await slot.controls.reload();
    const entry = { channel: ch, slot, before: seed };
    destination.push(entry); return entry;
  }
  const vocal = session.tracks.byId('Vocal');
  const bass = session.tracks.byId('Bass');
  const trackBus = session.tracks.byId('TrackBus');
  const drums = session.buses.byId('Drums');
  for (const ch of [vocal, bass, trackBus, drums, session.tracks.byId('Empty')]) await L.ensurePlugin(luna, session, ch, 'strip', STRIP);
  await L.ensurePlugin(luna, session, session.master, 'master', MASTER);
  await insert(vocal, 1, 0); await insert(vocal, 65535, 0);
  await insert(bass, 200, 0); await insert(trackBus, 400, 1); await insert(drums, 300, 1);
  await insert(session.master, 2, 2);
  await insert(session.buses.byId('Container'), 600, 1, excluded);
  await session.context.selectionTracks.set([vocal.id]);
  return { engine, luna, session, vocal, bass, targets, excluded };
}
const seedControl = (entry) => A.controls(entry.slot)['Console Seed'];
const targetKey = (entry) => `${entry.channel.id}/${entry.slot.id}`;
const seedWrites = (engine) => engine.requests.filter((r) => r.verb === 'set' && /\/controls\/native_0\/real_value(?:\/value)?$/.test(r.path));
const parameterWrites = (engine) => engine.requests.filter((r) => r.verb === 'set' && r.path.includes('/controls/'));
const storageWrites = (engine) => engine.requests.filter((r) => /\/(?:set|add)_field$/.test(r.path) && r.data?.context === STORE && r.data?.field === 'seed');
function snapshotOtherControls(entries) {
  return entries.map(({ channel, slot }) => ({ channel: channel.id, slot: slot.id, plugin: slot.pluginId.value,
    params: slot.params.filter((p) => p.name.value !== 'Console Seed').map((p) => [p.id, p.real.value, p.normalized.value, p.display.value]) }));
}

test('randomizes every loaded eligible companion including master across the session without inserting or changing other controls', async (t) => {
  const f = await fixture(t);
  const sslEntries = L.channels(f.session).flatMap((channel) => channel.effectSlots
    .filter((slot) => [STRIP, MASTER].includes(slot.pluginId.value)).map((slot) => ({ channel, slot })));
  await Promise.all(sslEntries.map((entry) => entry.slot.controls.load()));
  const all = [...f.targets, ...f.excluded, ...sslEntries];
  const beforeOther = snapshotOtherControls(all);
  const beforeLoads = f.engine.requests.filter((r) => r.path.endsWith('/set_inserts')).length;
  const result = await A.randomizeSeeds(f.luna, f.session, { random: () => 0 });
  await f.engine.settled();
  assert.equal(result.count, 6);
  assert.equal(result.seeds.length, 6);
  assert.deepEqual(new Set(result.seeds.map((x) => `${x.channelId}/${x.slotId}`)), new Set(f.targets.map(targetKey)));
  const assigned = result.seeds.map((x) => x.seed);
  assert.equal(new Set(assigned).size, 6);
  assert.ok(assigned.every((seed) => Number.isInteger(seed) && seed >= 1 && seed <= 65535 && seed !== 2));
  for (const target of f.targets) {
    const actual = Number(seedControl(target).real.value);
    assert.notEqual(actual, target.before);
    assert.equal(actual, result.seeds.find((x) => `${x.channelId}/${x.slotId}` === targetKey(target)).seed);
  }
  assert.deepEqual(f.excluded.map((x) => Number(seedControl(x).real.value)), f.excluded.map((x) => x.before));
  assert.deepEqual(snapshotOtherControls(all), beforeOther);
  assert.equal(f.engine.requests.filter((r) => r.path.endsWith('/set_inserts')).length, beforeLoads);
  assert.deepEqual(f.engine.transactions, ['begin', 'commit']);
  const writes = seedWrites(f.engine);
  assert.equal(writes.length, 6);
  assert.deepEqual(f.engine.touches, result.seeds.flatMap((row) => {
    const entry = f.targets.find((target) => targetKey(target) === `${row.channelId}/${row.slotId}`);
    return [`${seedControl(entry).path}:on`, `${seedControl(entry).path}:off`];
  }));
  const persisted = storageWrites(f.engine);
  const firstByChannel = new Map();
  for (const entry of f.targets) if (!firstByChannel.has(entry.channel.id)) firstByChannel.set(entry.channel.id, entry);
  assert.equal(persisted.length, firstByChannel.size * 3);
  for (const [channelId, first] of firstByChannel) {
    const changed = result.seeds.find((row) => `${row.channelId}/${row.slotId}` === targetKey(first)).seed;
    assert.deepEqual(persisted.filter((r) => r.data.record === channelId).map((r) => ({
      command: r.path.split('/').at(-1), value: r.data.value, undoable: r.data.undoable,
    })), [
      { command: 'add_field', value: first.before, undoable: false },
      { command: 'set_field', value: first.before, undoable: false },
      { command: 'set_field', value: changed, undoable: true },
    ]);
  }
  const begin = f.engine.requests.findIndex((r) => r.path.endsWith('/begin_transaction'));
  const commit = f.engine.requests.findIndex((r) => r.path.endsWith('/commit_transaction'));
  assert.equal(f.engine.requests[begin].data.name, 'Randomize analog strip seeds');
  for (const request of [...writes, ...persisted]) {
    const index = f.engine.requests.indexOf(request);
    assert.ok(index > begin && index < commit, 'parameter edits and persisted identities share the same undo transaction');
  }
});

test('a session with no eligible loaded companion returns zero without creating undo history', async (t) => {
  const f = await fixture(t);
  for (const target of f.targets) await target.slot.clear();
  await f.engine.settled();
  const loadsBefore = f.engine.requests.filter((r) => r.path.endsWith('/set_inserts')).length;
  assert.deepEqual(await A.randomizeSeeds(f.luna, f.session), { count: 0, seeds: [] });
  assert.equal(f.engine.requests.filter((r) => r.path.endsWith('/set_inserts')).length, loadsBefore);
  assert.deepEqual(f.engine.transactions, []);
  assert.equal(storageWrites(f.engine).length, 0);
  assert.deepEqual(f.excluded.map((entry) => Number(seedControl(entry).real.value)), [600]);
});

test('a master-only loaded companion is randomized instead of silently returning zero', async (t) => {
  const f = await fixture(t);
  const master = f.targets.find((entry) => entry.channel === f.session.master);
  for (const target of f.targets.filter((entry) => entry !== master)) await target.slot.clear();
  await f.engine.settled();
  const result = await A.randomizeSeeds(f.luna, f.session, { random: () => .6 });
  assert.equal(result.count, 1);
  assert.equal(result.seeds[0].channelId, f.session.master.id);
  assert.notEqual(result.seeds[0].seed, master.before);
  assert.equal(Number(seedControl(master).real.value), result.seeds[0].seed);
  assert.equal(A.controls(master.slot)['Channel Role'].real.value, 2);
});

test('first companion seed persists for seedFor, another client, and a removed/reinserted single strip', async (t) => {
  const f = await fixture(t);
  const store = f.session.storage.context(STORE); await store.load();
  await store.add(f.vocal.id, 'seed', 1); // Exercise the existing-field update branch.
  const result = await A.randomizeSeeds(f.luna, f.session, { random: () => .75 });
  const firstVocal = f.targets.find((entry) => entry.channel.id === f.vocal.id);
  const firstResult = result.seeds.find((row) => `${row.channelId}/${row.slotId}` === targetKey(firstVocal));
  assert.equal(await A.seedFor(f.session, f.vocal), firstResult.seed);
  assert.ok(storageWrites(f.engine).some((r) => r.path.endsWith('/set_field') && r.data.record === f.vocal.id && r.data.undoable === true));
  const second = await Luna.connect({ port_: f.engine.port() }); t.after(() => second.close());
  const otherSession = await second.session(); await second.plugins.load();
  const otherVocal = otherSession.tracks.byId(f.vocal.id);
  assert.equal(await A.seedFor(otherSession, otherVocal), firstResult.seed);
  const bassEntry = f.targets.find((entry) => entry.channel.id === f.bass.id);
  const bassSeed = result.seeds.find((row) => row.channelId === f.bass.id).seed;
  await bassEntry.slot.clear(); await f.engine.settled();
  const otherBass = otherSession.tracks.byId(f.bass.id); await otherBass.effects.reload();
  const ssl = L.matchingEffects(otherBass, second, 'strip')[0];
  const reinserted = await A.ensure(second, otherSession, otherBass, ssl, async (slot) => {
    addAnalogControls(f.engine, slot, 1, 0);
    await f.engine.settled(); await slot.controls.reload();
  });
  assert.equal(Number(A.controls(reinserted)['Console Seed'].real.value), bassSeed);
});

test('a stale saved identity is synced to the manually edited actual seed before the undoable replacement', async (t) => {
  const f = await fixture(t);
  const first = f.targets.find((entry) => entry.channel.id === f.vocal.id);
  const store = f.session.storage.context(STORE); await store.load();
  await store.add(f.vocal.id, 'seed', 99);
  await seedControl(first).real.set(1234);
  const before = f.engine.requests.length;
  const result = await A.randomizeSeeds(f.luna, f.session, { random: () => .4 });
  const changed = result.seeds.find((row) => `${row.channelId}/${row.slotId}` === targetKey(first)).seed;
  const writes = storageWrites(f.engine).filter((r) => f.engine.requests.indexOf(r) >= before && r.data.record === f.vocal.id);
  assert.deepEqual(writes.map((r) => ({ command: r.path.split('/').at(-1), value: r.data.value, undoable: r.data.undoable })), [
    { command: 'set_field', value: 1234, undoable: false },
    { command: 'set_field', value: changed, undoable: true },
  ]);
  assert.notEqual(changed, 1234);
  assert.equal(await A.seedFor(f.session, f.vocal), changed);
  const begin = f.engine.requests.findIndex((r, i) => i >= before && r.path.endsWith('/begin_transaction'));
  const commit = f.engine.requests.findIndex((r, i) => i >= before && r.path.endsWith('/commit_transaction'));
  assert.ok(writes.every((r) => f.engine.requests.indexOf(r) > begin && f.engine.requests.indexOf(r) < commit));
});

test('read-only sessions reject before seed, storage, or undo writes', async (t) => {
  const f = await fixture(t);
  f.engine.setValue(f.session.path, 'read_only', true); await f.engine.settled();
  await assert.rejects(() => A.randomizeSeeds(f.luna, f.session), /read.only/i);
  assert.equal(seedWrites(f.engine).length, 0);
  assert.equal(storageWrites(f.engine).length, 0);
  assert.deepEqual(f.engine.transactions, []);
});

test('a missing seed control fails preflight before mutating any other strip', async (t) => {
  const f = await fixture(t);
  const target = f.targets.at(-1);
  f.engine.removeNode(seedControl(target).path); await f.engine.settled(); await target.slot.controls.reload();
  await assert.rejects(() => A.randomizeSeeds(f.luna, f.session, { random: () => .5 }), /seed|control/i);
  assert.equal(seedWrites(f.engine).length, 0);
  assert.equal(storageWrites(f.engine).length, 0);
  assert.deepEqual(f.engine.transactions, []);
});

test('invalid random-source values reject before any parameter or storage writes', async (t) => {
  const f = await fixture(t);
  for (const bad of [NaN, Infinity, -.01, 1, 2, '0.5', undefined]) {
    let calls = 0;
    await assert.rejects(() => A.randomizeSeeds(f.luna, f.session, { random: () => ++calls < 3 ? .25 : bad }), /random|finite|range|number|0.*1/i);
    assert.equal(seedWrites(f.engine).length, 0);
    assert.equal(storageWrites(f.engine).length, 0);
    assert.deepEqual(f.engine.transactions, []);
  }
});

test('saved unloaded identities remain reserved while the loaded master receives a new persisted identity', async (t) => {
  const f = await fixture(t);
  const store = f.session.storage.context(STORE); await store.load();
  await store.add('not-loaded-strip', 'seed', 3);
  await store.add(f.session.master.id, 'seed', 2);
  const result = await A.randomizeSeeds(f.luna, f.session, { random: () => 2 / 65535 });
  assert.equal(result.count, 6);
  assert.ok(result.seeds.every((row) => row.seed !== 2 && row.seed !== 3));
  const master = f.targets.find((entry) => entry.channel === f.session.master);
  const changed = result.seeds.find((row) => row.channelId === f.session.master.id).seed;
  assert.notEqual(changed, 2);
  assert.equal(Number(seedControl(master).real.value), changed);
  await store.load();
  assert.equal(store.value('not-loaded-strip', 'seed').value, 3);
  assert.equal(store.value(f.session.master.id, 'seed').value, changed);
});

test('a re-instantiated companion discovered after preflight is rejected before its seed is written', async (t) => {
  const f = await fixture(t);
  const target = f.targets.at(-1);
  const transaction = f.session.transaction.bind(f.session);
  f.session.transaction = async (name, body, ...rest) => {
    if (name === 'Randomize analog strip seeds') {
      await target.slot.setPlugin(ANALOG);
      await f.engine.settled();
    }
    return transaction(name, body, ...rest);
  };
  await assert.rejects(() => A.randomizeSeeds(f.luna, f.session, { random: () => .2 }), /changed|replaced|instance|retry|reload/i);
  assert.equal(seedWrites(f.engine).length, 0);
  assert.equal(storageWrites(f.engine).length, 0);
});

test('an acknowledged but ignored native seed write cannot produce a false success', async (t) => {
  const f = await fixture(t);
  const target = f.targets.find((entry) => entry.channel === f.session.master);
  const control = seedControl(target);
  const set = f.luna.raw.set.bind(f.luna.raw);
  f.luna.raw.set = async (path, value) => {
    await set(path, value);
    // Acknowledge the write, but publish the actual unchanged host value. The SDK
    // may optimistically show the request until its explicit parameter re-read.
    if (path === `${control.path}/real_value`) f.engine.setValue(control.path, 'real_value', target.before);
  };
  await assert.rejects(() => A.randomizeSeeds(f.luna, f.session, { random: () => .3 }), /did not confirm|seed change|confirm.*seed/i);
  assert.equal(f.engine.value(control.path, 'real_value'), target.before);
  assert.ok(seedWrites(f.engine).length > 0, 'the host acknowledged an actual attempted control edit');
});

function characterSnapshot(entries) {
  const linkControls = new Set(['Console Group', 'Crosstalk Enabled', 'Channel Role']);
  return entries.map((entry) => ({ channel: entry.channel.id, slot: entry.slot.id,
    params: entry.slot.params.filter((p) => !linkControls.has(p.name.value))
      .map((p) => [p.id, p.real.value, p.normalized.value, p.display.value]) }));
}

async function indexedAUHost(f) {
  const identities = new Map();
  async function markSlot(slot) {
    await slot.controls.reload();
    const p = A.controls(slot);
    for (const name of ['Console Seed', 'Console Group']) {
      const c = p[name];
      const actual = Number(c.real.value);
      identities.set(c.path, name);
      for (const [key, value] of Object.entries({ discrete: true, num_steps: 65536,
        real_values: null, string_values: null, real_value: actual, value: actual,
        normalized_value: actual / 65535, string_value: '' })) f.engine.setValue(c.path, key, value);
    }
    await f.engine.settled(); await slot.controls.reload();
  }
  for (const entry of [...f.targets, ...f.excluded]) await markSlot(entry.slot);
  const set = f.luna.raw.set.bind(f.luna.raw);
  f.luna.raw.set = async (path, data) => {
    const match = path.match(/^(.*)\/(real_value|normalized_value)$/);
    if (!match || !identities.has(match[1])) return set(path, data);
    const node = match[1];
    const before = Object.fromEntries(['real_value', 'normalized_value', 'value', 'string_value']
      .map((key) => [key, f.engine.value(node, key)]));
    await set(path, data);
    if (match[2] === 'real_value') {
      // Observed LUNA AU contract: acknowledged integer real writes do not apply.
      for (const [key, value] of Object.entries(before)) f.engine.setValue(node, key, value);
    } else {
      // Observed AU indexed contract has 65,536 ordinal positions including zero;
      // the plugin clamps identity zero to one and accepts positions1..65535.
      const numeric = Number(data && typeof data.value === 'number' ? data.value : data);
      const actual = Math.max(1, Math.min(65535, Math.round(numeric * 65535)));
      for (const [key, value] of Object.entries({ real_value: actual, value: actual,
        normalized_value: actual / 65535, string_value: '' })) f.engine.setValue(node, key, value);
    }
    await f.engine.settled();
  };
  return { markSlot };
}

async function groupingAUHost(f, { selectionGrouping = true, groupsSuspended = false } = {}) {
  await indexedAUHost(f);
  const context = f.session.context.path;
  f.engine.setValue(context, 'selection_grouping', selectionGrouping);
  f.engine.setValue(context, 'groups_suspended', groupsSuspended);
  const selection = ['Vocal', 'Bass', 'TrackBus', 'Drums'];
  await f.session.context.selectionTracks.set(selection);
  await f.engine.settled();
  const namedGroup = new Set(['Vocal', 'TrackBus', 'Drums', f.session.master.id]);
  const state = { writes: [], propagated: [], selection, before: { selectionGrouping, groupsSuspended } };
  const set = f.luna.raw.set.bind(f.luna.raw);
  f.luna.raw.set = async (path, data) => {
    const match = path.match(/^(.*)\/controls\/native_(\d+)\/(?:real_value|normalized_value)$/);
    const source = match && f.targets.find((entry) => entry.slot.path === match[1]);
    if (!source) return set(path, data);
    const selected = f.engine.value(context, 'selection_tracks') ?? [];
    const grouping = f.engine.value(context, 'selection_grouping') !== false;
    const suspended = f.engine.value(context, 'groups_suspended') === true;
    state.writes.push({ path, selectionGrouping: grouping, groupsSuspended: suspended });
    await set(path, data);
    const affected = new Set([source.channel.id]);
    if (grouping && selected.includes(source.channel.id)) for (const id of selected) affected.add(id);
    if (!suspended && namedGroup.has(source.channel.id)) for (const id of namedGroup) affected.add(id);
    const sourcePath = `${source.slot.path}/controls/native_${match[2]}`;
    for (const peer of f.targets) {
      if (peer === source || peer.slot.id !== source.slot.id || !affected.has(peer.channel.id)) continue;
      const targetPath = `${peer.slot.path}/controls/native_${match[2]}`;
      for (const key of ['real_value', 'normalized_value', 'value', 'string_value'])
        f.engine.setValue(targetPath, key, f.engine.value(sourcePath, key));
      state.propagated.push({ from: targetKey(source), to: targetKey(peer), parameter: A.names[Number(match[2])] });
    }
    await f.engine.settled();
  };
  return state;
}
function assertGroupingRestored(f, host) {
  assert.equal(f.engine.value(f.session.context.path, 'selection_grouping'), host.before.selectionGrouping);
  assert.equal(f.engine.value(f.session.context.path, 'groups_suspended'), host.before.groupsSuspended);
  assert.deepEqual(f.engine.value(f.session.context.path, 'selection_tracks'), host.selection);
}
function assertNativeWritesIsolated(host) {
  assert.ok(host.writes.length > 0);
  assert.ok(host.writes.every((write) => write.selectionGrouping === false && write.groupsSuspended === true));
  assert.deepEqual(host.propagated, []);
}

test('native seed randomization isolates selection and named-group propagation and restores prior grouping preferences', async (t) => {
  for (const preferences of [
    { selectionGrouping: true, groupsSuspended: false },
    { selectionGrouping: false, groupsSuspended: false },
    { selectionGrouping: true, groupsSuspended: true },
  ]) {
    const f = await fixture(t); const host = await groupingAUHost(f, preferences);
    const result = await A.randomizeSeeds(f.luna, f.session, { random: () => .2 });
    assert.equal(result.count, 6);
    assert.equal(new Set(f.targets.map((entry) => Number(seedControl(entry).real.value))).size, 6);
    assertNativeWritesIsolated(host);
    assertGroupingRestored(f, host);
    assert.deepEqual(f.engine.transactions, ['begin', 'commit']);
  }
});

test('linking native companions isolates role writes so tracks, buses, and master retain distinct roles', async (t) => {
  const f = await fixture(t); const host = await groupingAUHost(f);
  const result = await A.linkCompanions(f.luna, f.session, { group: 22111 });
  assert.equal(result.count, 6);
  for (const entry of f.targets) {
    const p = A.controls(entry.slot), kind = L.channelKind(entry.channel);
    assert.equal(Number(p['Channel Role'].real.value), kind === 'master' ? 2 : kind === 'bus' ? 1 : 0);
    assert.equal(Number(p['Console Group'].real.value), 22111);
    assert.equal(Number(p['Crosstalk Enabled'].real.value), 1);
  }
  assertNativeWritesIsolated(host);
  assertGroupingRestored(f, host);
  assert.deepEqual(f.engine.transactions, ['begin', 'commit']);
});

test('randomization restores both grouping switches and selection when a native write fails', async (t) => {
  const f = await fixture(t); const host = await groupingAUHost(f);
  const failPath = `${seedControl(f.targets[0]).path}/normalized_value`;
  const set = f.luna.raw.set.bind(f.luna.raw);
  f.luna.raw.set = async (path, data) => {
    if (path === failPath) throw new Error('Forced native seed write failure');
    return set(path, data);
  };
  await assert.rejects(() => A.randomizeSeeds(f.luna, f.session, { random: () => .2 }), /forced native seed write failure/i);
  assertGroupingRestored(f, host);
  assertNativeWritesIsolated(host);
  assert.deepEqual(f.engine.transactions, ['begin', 'abort']);
});

test('linking restores preexisting grouping preferences when a native group write fails', async (t) => {
  const f = await fixture(t); const host = await groupingAUHost(f, { selectionGrouping: false, groupsSuspended: false });
  const failPath = `${A.controls(f.targets[0].slot)['Console Group'].path}/normalized_value`;
  const set = f.luna.raw.set.bind(f.luna.raw);
  f.luna.raw.set = async (path, data) => {
    if (path === failPath) throw new Error('Forced native group write failure');
    return set(path, data);
  };
  await assert.rejects(() => A.linkCompanions(f.luna, f.session, { group: 22111 }), /forced native group write failure/i);
  assertGroupingRestored(f, host);
  assertNativeWritesIsolated(host);
  assert.deepEqual(f.engine.transactions, ['begin', 'abort']);
});

test('unavailable or malformed linking metadata fails closed before any companion parameter or storage edit', async (t) => {
  for (const [field, value] of [['selection_grouping', null], ['groups_suspended', undefined], ['selection_grouping', 1]]) {
    const f = await fixture(t); await indexedAUHost(f);
    f.engine.setValue(f.session.context.path, field, value); await f.engine.settled();
    const before = snapshotOtherControls(f.targets);
    await assert.rejects(() => A.randomizeSeeds(f.luna, f.session, { random: () => .2 }), /cannot read.*linking|no companion parameters/i);
    await assert.rejects(() => A.linkCompanions(f.luna, f.session, { group: 22111 }), /cannot read.*linking|no companion parameters/i);
    assert.equal(parameterWrites(f.engine).length, 0);
    assert.equal(storageWrites(f.engine).length, 0);
    assert.deepEqual(f.engine.transactions, []);
    assert.deepEqual(snapshotOtherControls(f.targets), before);
  }
});

test('acknowledged but ignored linking-switch writes block native edits and restore the original preferences', async (t) => {
  for (const field of ['selection_grouping', 'groups_suspended']) {
    const f = await fixture(t); const host = await groupingAUHost(f);
    const set = f.luna.raw.set.bind(f.luna.raw);
    f.luna.raw.set = async (path, data) => {
      const before = f.engine.value(f.session.context.path, field);
      await set(path, data);
      if (path === `${f.session.context.path}/${field}`) {
        // Match the native failure mode: acknowledge the command, then let a
        // raw reload expose the host's unchanged authoritative setting.
        f.engine.setValue(f.session.context.path, field, before);
        await f.engine.settled();
      }
    };
    await assert.rejects(() => A.randomizeSeeds(f.luna, f.session, { random: () => .2 }), /did not disable linked|no companion parameters/i);
    assert.equal(parameterWrites(f.engine).length, 0);
    assert.equal(storageWrites(f.engine).length, 0);
    assert.deepEqual(f.engine.transactions, []);
    assert.deepEqual(host.writes, []);
    assertGroupingRestored(f, host);
  }
});

test('independent edit queue restores failed edits before beginning the next callback', async (t) => {
  const f = await fixture(t);
  const context = f.session.context.path;
  const events = [];
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const first = A.independently(f.session, async () => {
    events.push('first'); entered(); await held; throw new Error('First callback failed');
  });
  await started;
  const second = A.independently(f.session, async () => {
    events.push('second');
    assert.equal(f.engine.value(context, 'selection_grouping'), false);
    assert.equal(f.engine.value(context, 'groups_suspended'), true);
    return 42;
  });
  await Promise.resolve();
  assert.deepEqual(events, ['first']);
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /first callback failed/i);
  assert.deepEqual(results[1], { status: 'fulfilled', value: 42 });
  assert.deepEqual(events, ['first', 'second']);
  assert.equal(f.engine.value(context, 'selection_grouping'), true);
  assert.equal(f.engine.value(context, 'groups_suspended'), false);
  const switches = f.engine.requests.filter((r) => r.verb === 'set' &&
    [context + '/selection_grouping', context + '/groups_suspended'].includes(r.path));
  assert.deepEqual(switches.map((r) => [r.path.split('/').at(-1), r.data]), [
    ['selection_grouping', false], ['groups_suspended', true],
    ['groups_suspended', false], ['selection_grouping', true],
    ['selection_grouping', false], ['groups_suspended', true],
    ['groups_suspended', false], ['selection_grouping', true],
  ]);
  assert.deepEqual(f.engine.transactions, []);
});

test('unconfirmed linking preference restoration reports a failure and does not poison subsequent edits', async (t) => {
  const f = await fixture(t);
  const context = f.session.context.path;
  const set = f.luna.raw.set.bind(f.luna.raw);
  let ignoreRestore = true;
  f.luna.raw.set = async (path, data) => {
    await set(path, data);
    if (ignoreRestore && path === `${context}/selection_grouping` && data === true) {
      f.engine.setValue(context, 'selection_grouping', false); await f.engine.settled();
    }
  };
  await assert.rejects(() => A.independently(f.session, async () => {}), /could not restore.*linking/i);
  assert.equal(f.engine.value(context, 'selection_grouping'), false);
  assert.equal(f.engine.value(context, 'groups_suspended'), false, 'restoration still attempts the other switch');
  ignoreRestore = false;
  f.engine.setValue(context, 'selection_grouping', true); await f.engine.settled();
  assert.equal(await A.independently(f.session, async () => 'recovered'), 'recovered');
  assert.equal(f.engine.value(context, 'selection_grouping'), true);
  assert.equal(f.engine.value(context, 'groups_suspended'), false);
});

test('native AU identity setter uses the verified ordinal normalization with one undo touch', async (t) => {
  const f = await fixture(t); await indexedAUHost(f);
  const entry = f.targets[0];
  const seed = A.controls(entry.slot)['Console Seed'];
  await seed.real.set(12345);
  await entry.slot.controls.reload();
  assert.equal(seed.real.value, entry.before, 'the native AU mock reproduces acknowledged but ignored real writes');
  const touchStart = f.engine.touches.length;
  const requestStart = f.engine.requests.length;
  await A.setIdentity(seed, 12345);
  await entry.slot.controls.reload();
  assert.equal(seed.real.value, 12345);
  assert.equal(seed.normalized.value, 12345 / 65535);
  assert.deepEqual(f.engine.touches.slice(touchStart), [`${seed.path}:on`, `${seed.path}:off`]);
  const writes = f.engine.requests.slice(requestStart).filter((r) => r.verb === 'set');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, `${seed.path}/normalized_value`);
  assert.equal(writes[0].data, 12345 / 65535);
  const second = await Luna.connect({ port_: f.engine.port() }); t.after(() => second.close());
  const session = await second.session(); const channel = session.tracks.byId(entry.channel.id);
  await channel.effects.load(); const slot = channel.effects.byId(entry.slot.id); await slot.controls.load();
  assert.equal(A.controls(slot)['Console Seed'].real.value, 12345, 'a second client reads the applied native value');
  const group = A.controls(entry.slot)['Console Group'];
  f.engine.setValue(group.path, 'real_values', []);
  await f.engine.settled(); await entry.slot.controls.reload();
  const groupTouchStart = f.engine.touches.length;
  await A.setIdentity(group, 65535); await entry.slot.controls.reload();
  assert.equal(group.real.value, 65535);
  assert.equal(group.normalized.value, 1);
  assert.deepEqual(f.engine.touches.slice(groupTouchStart), [`${group.path}:on`, `${group.path}:off`]);
});

test('native identity setter rejects invalid seeds/groups before writes or touches', async (t) => {
  const f = await fixture(t); await indexedAUHost(f);
  const p = A.controls(f.targets[0].slot);
  const requestStart = f.engine.requests.length;
  for (const value of [0, -1, 65536, 1.5, NaN, Infinity, '42', undefined]) {
    for (const name of ['Console Seed', 'Console Group']) await assert.rejects(() => A.setIdentity(p[name], value), /integer|identity|65535|seed|group/i);
  }
  assert.equal(f.engine.requests.slice(requestStart).filter((r) => r.verb === 'set').length, 0);
  assert.deepEqual(f.engine.touches, []);
});

test('identity setter retains real-value writes for legacy fixtures and unrelated parameter contracts', async (t) => {
  const f = await fixture(t);
  const seed = seedControl(f.targets[0]);
  const before = f.engine.requests.length;
  await A.setIdentity(seed, 4321);
  assert.equal(seed.real.value, 4321);
  assert.equal(f.engine.requests.slice(before).filter((r) => r.verb === 'set')[0].path, `${seed.path}/real_value`);
  const calls = [];
  const unrelated = { name: { value: 'Unrelated ordinal' }, discrete: { value: true }, numSteps: { value: 65536 }, realValues: { value: null },
    real: { set: async (value) => calls.push(['real', value]) }, normalized: { set: async (value) => calls.push(['normalized', value]) } };
  await A.setIdentity(unrelated, 321);
  assert.deepEqual(calls, [['real', 321]], 'the verified Seed/Group workaround is not generalized to unrelated parameters');
  calls.length = 0;
  const otherFormat = { ...unrelated, name: { value: 'Console Seed' }, numSteps: { value: 65535 } };
  await A.setIdentity(otherFormat, 321);
  assert.deepEqual(calls, [['real', 321]], 'a different format contract keeps the ordinary real-value setter');
});

test('randomization confirms actual native AU ordinal seed writes on every companion including master', async (t) => {
  const f = await fixture(t); await indexedAUHost(f);
  const result = await A.randomizeSeeds(f.luna, f.session, { random: () => .25 });
  assert.equal(result.count, 6);
  assert.equal(new Set(result.seeds.map((row) => row.seed)).size, 6);
  for (const entry of f.targets) {
    const seed = result.seeds.find((row) => `${row.channelId}/${row.slotId}` === targetKey(entry)).seed;
    const actual = A.controls(entry.slot)['Console Seed'];
    assert.equal(actual.real.value, seed);
    assert.equal(actual.normalized.value, seed / 65535);
    assert.notEqual(seed, entry.before);
  }
  assert.equal(seedWrites(f.engine).length, 0, 'native indexed seeds do not take the ignored real-value path');
  const writes = f.engine.requests.filter((r) => r.verb === 'set' && /\/controls\/native_0\/normalized_value$/.test(r.path));
  assert.equal(writes.length, 6);
  assert.equal(f.engine.touches.length, 12);
  assert.deepEqual(f.engine.transactions, ['begin', 'commit']);
});

test('linking uses the native AU ordinal group setter while preserving seeds and character controls', async (t) => {
  const f = await fixture(t); await indexedAUHost(f);
  const before = characterSnapshot(f.targets);
  const result = await A.linkCompanions(f.luna, f.session, { group: 22001 });
  assert.deepEqual(result, { count: 6, group: 22001, enabled: true });
  for (const entry of f.targets) {
    const p = A.controls(entry.slot);
    assert.equal(p['Console Group'].real.value, 22001);
    assert.equal(p['Console Group'].normalized.value, 22001 / 65535);
  }
  assert.deepEqual(characterSnapshot(f.targets), before);
  assert.equal(f.engine.requests.filter((r) => r.verb === 'set' && /\/controls\/native_4\/real_value$/.test(r.path)).length, 0);
  assert.equal(f.engine.requests.filter((r) => r.verb === 'set' && /\/controls\/native_4\/normalized_value$/.test(r.path)).length, 6);
});

test('new companion initialization uses verified ordinal writes for both native identity controls', async (t) => {
  const f = await fixture(t); const host = await indexedAUHost(f);
  const entry = f.targets.find((row) => row.channel === f.bass);
  await entry.slot.clear(); await f.bass.effects.reload();
  const ssl = L.matchingEffects(f.bass, f.luna, 'strip')[0];
  const before = f.engine.requests.length;
  const slot = await A.ensure(f.luna, f.session, f.bass, ssl, async (inserted) => {
    addAnalogControls(f.engine, inserted, 1, 0);
    await f.engine.settled(); await host.markSlot(inserted);
  });
  const p = A.controls(slot);
  assert.equal(p['Console Seed'].real.value, await A.seedFor(f.session, f.bass));
  assert.equal(p['Console Group'].real.value, A.hash(f.session.uid) % 65535 + 1);
  const identityWrites = f.engine.requests.slice(before).filter((r) => r.verb === 'set' && /\/controls\/native_[04]\//.test(r.path));
  assert.equal(identityWrites.length, 2);
  assert.ok(identityWrites.every((r) => r.path.endsWith('/normalized_value')));
});

test('linking configures one peer group and correct roles on every track, bus, and master companion', async (t) => {
  const f = await fixture(t);
  const all = [...f.targets, ...f.excluded];
  const before = characterSnapshot(all);
  const excluded = A.controls(f.excluded[0].slot);
  const excludedBefore = ['Console Group', 'Crosstalk Enabled', 'Channel Role'].map((name) => excluded[name].real.value);
  // Model bus/master instances copied from a track; linking must correct role metadata.
  for (const entry of f.targets) f.engine.setValue(A.controls(entry.slot)['Channel Role'].path, 'real_value', 0);
  await f.engine.settled();
  const loads = f.engine.requests.filter((r) => r.path.endsWith('/set_inserts')).length;
  const result = await A.linkCompanions(f.luna, f.session, { group: 12345, enabled: true });
  assert.deepEqual(result, { count: 6, group: 12345, enabled: true });
  for (const entry of f.targets) {
    const p = A.controls(entry.slot);
    const kind = L.channelKind(entry.channel);
    assert.equal(Number(p['Console Group'].real.value), 12345);
    assert.equal(Number(p['Crosstalk Enabled'].real.value), 1);
    assert.equal(Number(p['Channel Role'].real.value), kind === 'master' ? 2 : kind === 'bus' ? 1 : 0);
  }
  assert.deepEqual(characterSnapshot(all), before, 'seed, variation, drive, trim, crosstalk amount, and other controls are preserved');
  assert.deepEqual(['Console Group', 'Crosstalk Enabled', 'Channel Role'].map((name) => excluded[name].real.value), excludedBefore);
  assert.equal(f.engine.requests.filter((r) => r.path.endsWith('/set_inserts')).length, loads);
  assert.deepEqual(f.engine.transactions, ['begin', 'commit']);
  assert.equal(f.engine.requests.find((r) => r.path.endsWith('/begin_transaction')).data.name, 'Link analog console companions');
  assert.equal(seedWrites(f.engine).length, 0);
  assert.equal(storageWrites(f.engine).length, 0);
});

test('unlinking disables the peer exchange while preserving every character parameter and channel role', async (t) => {
  const f = await fixture(t);
  await A.linkCompanions(f.luna, f.session, { group: 322, enabled: true });
  const before = characterSnapshot(f.targets);
  const result = await A.linkCompanions(f.luna, f.session, { group: 322, enabled: false });
  assert.deepEqual(result, { count: 6, group: 322, enabled: false });
  for (const entry of f.targets) {
    const p = A.controls(entry.slot);
    assert.equal(Number(p['Console Group'].real.value), 322);
    assert.equal(Number(p['Crosstalk Enabled'].real.value), 0);
  }
  assert.deepEqual(characterSnapshot(f.targets), before);
  assert.equal(f.engine.requests.filter((r) => r.path.endsWith('/begin_transaction')).at(-1).data.name, 'Unlink analog console companions');
});

test('global crosstalk Off preserves mixed groups and roles while independently disabling every eligible instance', async (t) => {
  const f = await fixture(t); const host = await groupingAUHost(f);
  for (const [index, entry] of f.targets.entries()) {
    const p = A.controls(entry.slot);
    const group = 101 + index * 71, role = (index + 1) % 3;
    for (const [name, actual, normalized] of [['Console Group', group, group / 65535], ['Channel Role', role, role / 2], ['Crosstalk Enabled', 1, 1]]) {
      for (const [key, value] of Object.entries({ real_value: actual, value: actual, normalized_value: normalized, string_value: String(actual) }))
        f.engine.setValue(p[name].path, key, value);
    }
  }
  await f.engine.settled();
  const all = [...f.targets, ...f.excluded];
  const unchanged = () => all.map((entry) => ({ key: targetKey(entry),
    params: entry.slot.params.filter((p) => p.name.value !== 'Crosstalk Enabled').map((p) => [p.id, p.real.value, p.normalized.value, p.display.value]) }));
  const before = unchanged();
  const result = await A.linkCompanions(f.luna, f.session, { group: NaN, enabled: false });
  assert.deepEqual(result, { count: 6, group: NaN, enabled: false });
  assert.ok(f.targets.every((entry) => Number(A.controls(entry.slot)['Crosstalk Enabled'].real.value) === 0));
  assert.deepEqual(unchanged(), before, 'off does not reassign existing groups, roles, identities, or character settings');
  const writes = parameterWrites(f.engine);
  assert.equal(writes.length, 6);
  assert.ok(writes.every((r) => /\/controls\/native_3\/normalized_value$/.test(r.path) && r.data === 0));
  assert.equal(storageWrites(f.engine).length, 0);
  assertNativeWritesIsolated(host);
  assertGroupingRestored(f, host);
  assert.deepEqual(f.engine.transactions, ['begin', 'commit']);
});

test('global crosstalk Off requires only its enable control and accepts an unused invalid group input', async (t) => {
  const f = await fixture(t); await indexedAUHost(f);
  for (const entry of f.targets) {
    const p = A.controls(entry.slot);
    f.engine.removeNode(p['Console Group'].path); f.engine.removeNode(p['Channel Role'].path);
  }
  await f.engine.settled(); await Promise.all(f.targets.map((entry) => entry.slot.controls.reload()));
  assert.deepEqual(await A.linkCompanions(f.luna, f.session, { group: 'unused off input', enabled: false }),
    { count: 6, group: 'unused off input', enabled: false });
  assert.equal(parameterWrites(f.engine).length, 6);
  assert.ok(f.targets.every((entry) => A.controls(entry.slot)['Crosstalk Enabled'].real.value === 0));
  assert.ok(f.targets.every((entry) => !A.controls(entry.slot)['Console Group'] && !A.controls(entry.slot)['Channel Role']));
});

test('global crosstalk Off rejects a missing enable control or read-only session before any edit', async (t) => {
  for (const failure of ['missing enable', 'read only']) {
    const f = await fixture(t);
    if (failure === 'missing enable') {
      const target = f.targets.at(-1);
      f.engine.removeNode(A.controls(target.slot)['Crosstalk Enabled'].path);
      await f.engine.settled(); await target.slot.controls.reload();
    } else {
      f.engine.setValue(f.session.path, 'read_only', true); await f.engine.settled();
    }
    await assert.rejects(() => A.linkCompanions(f.luna, f.session, { group: NaN, enabled: false }),
      failure === 'missing enable' ? /link controls|exposed|control/i : /read.only/i);
    assert.equal(parameterWrites(f.engine).length, 0);
    assert.equal(storageWrites(f.engine).length, 0);
    assert.deepEqual(f.engine.transactions, []);
  }
});

test('global crosstalk Off rejects acknowledged but ignored enable writes and restores grouping preferences', async (t) => {
  const f = await fixture(t); const host = await groupingAUHost(f);
  const control = A.controls(f.targets.find((entry) => entry.channel === f.session.master).slot)['Crosstalk Enabled'];
  f.engine.setValue(control.path, 'real_value', 1); f.engine.setValue(control.path, 'normalized_value', 1);
  f.engine.setValue(control.path, 'value', 1); await f.engine.settled();
  const set = f.luna.raw.set.bind(f.luna.raw);
  f.luna.raw.set = async (path, data) => {
    await set(path, data);
    if (path === `${control.path}/normalized_value`) {
      f.engine.setValue(control.path, 'real_value', 1); f.engine.setValue(control.path, 'normalized_value', 1);
      f.engine.setValue(control.path, 'value', 1); await f.engine.settled();
    }
  };
  await assert.rejects(() => A.linkCompanions(f.luna, f.session, { enabled: false }), /did not confirm.*link|confirm.*crosstalk/i);
  assert.equal(f.engine.value(control.path, 'real_value'), 1);
  assertNativeWritesIsolated(host);
  assertGroupingRestored(f, host);
});

test('invalid group identifiers and read-only sessions reject linking before any native control writes', async (t) => {
  const f = await fixture(t);
  const before = f.engine.requests.filter((r) => r.verb === 'set').length;
  for (const group of [0, -1, 65536, 1.5, NaN, Infinity, '32']) {
    await assert.rejects(() => A.linkCompanions(f.luna, f.session, { group }), /group|integer|65535/i);
  }
  f.engine.setValue(f.session.path, 'read_only', true); await f.engine.settled();
  await assert.rejects(() => A.linkCompanions(f.luna, f.session, { group: 15 }), /read.only/i);
  assert.equal(f.engine.requests.filter((r) => r.verb === 'set').length, before);
  assert.deepEqual(f.engine.transactions, []);
});

test('missing native link controls fail preflight before editing any companion', async (t) => {
  const f = await fixture(t);
  const target = f.targets.at(-1);
  f.engine.removeNode(A.controls(target.slot)['Console Group'].path);
  await f.engine.settled(); await target.slot.controls.reload();
  await assert.rejects(() => A.linkCompanions(f.luna, f.session, { group: 15 }), /link controls|exposed|control/i);
  assert.equal(parameterWrites(f.engine).length, 0);
  assert.deepEqual(f.engine.transactions, []);
});

test('linking with no loaded eligible companions returns zero without inserting plugins or undo history', async (t) => {
  const f = await fixture(t);
  for (const target of f.targets) await target.slot.clear();
  await f.engine.settled();
  const loads = f.engine.requests.filter((r) => r.path.endsWith('/set_inserts')).length;
  assert.deepEqual(await A.linkCompanions(f.luna, f.session, { group: 915 }), { count: 0, group: 915, enabled: true });
  assert.equal(f.engine.requests.filter((r) => r.path.endsWith('/set_inserts')).length, loads);
  assert.deepEqual(f.engine.transactions, []);
  assert.equal(parameterWrites(f.engine).length, 0);
});
