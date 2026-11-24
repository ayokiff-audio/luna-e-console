import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

vm.runInThisContext(await readFile(new URL('../vendor/luna.global.js', import.meta.url), 'utf8') + '\nglobalThis.Luna = Luna;');
await import('../logic.js');
await import('../companion.js');
await import('../demo.js');

test('explicit preview connects fixture SDK models with strip, master, and eight native companion controls', async (t) => {
  const luna = await EConsoleDemo.connect(); t.after(() => luna.close());
  const session = await luna.session();
  assert.equal(luna.engine, 'mock');
  assert.deepEqual(session.visibleTracks.map((ch) => ch.name.value), ['Lead vocal', 'Drums', 'Bass', 'Guitar']);
  assert.equal(EConsoleLogic.channels(session, 'buses')[0].name.value, 'Drums bus');
  assert.ok(luna.plugins.items.every((p) => p.id.startsWith('fixture.')));
  const lead = session.tracks.byId('lead-vocal');
  const ssl = EConsoleLogic.matchingEffects(lead, luna, 'strip')[0];
  assert.ok(ssl.loaded.value);
  assert.ok(EConsoleLogic.parameters(ssl).some((p) => p.name === 'LF Gain' && p.group === 'eq'));
  assert.ok(EConsoleLogic.matchingEffects(session.master, luna, 'master')[0].loaded.value);
  const analog = EConsoleAnalog.find(luna, lead);
  assert.ok(analog);
  const mapped = EConsoleAnalog.controls(analog);
  assert.deepEqual(Object.keys(mapped), EConsoleAnalog.names);
  assert.ok(Object.values(mapped).every(Boolean));
  assert.equal(mapped['Crosstalk Enabled'].real.value, 0);
  assert.equal(mapped['Crosstalk'].real.value, -70);
  assert.equal((await EConsoleLogic.loadSettings(session)).selectedChannelId, lead.id);
});

test('preview knobs, discrete seed/role controls, touches, and default reset remain live', async (t) => {
  const luna = await EConsoleDemo.connect(); t.after(() => luna.close());
  const session = await luna.session();
  const lead = session.tracks.byId('lead-vocal');
  const analog = EConsoleAnalog.find(luna, lead);
  const controls = EConsoleAnalog.controls(analog);
  await controls['Drive'].normalized.set(.5);
  assert.equal(controls['Drive'].real.value, 9);
  assert.equal(controls['Drive'].display.value, '9.00 dB');
  await controls['Console Seed'].real.set(32768);
  assert.equal(controls['Console Seed'].real.value, 32768);
  assert.equal(controls['Console Seed'].normalized.value, .5);
  await controls['Channel Role'].real.set(2);
  assert.equal(controls['Channel Role'].display.value, 'Master');
  await controls['Crosstalk Enabled'].normalized.set(1);
  assert.equal(controls['Crosstalk Enabled'].real.value, 1);
  assert.equal(controls['Crosstalk Enabled'].display.value, 'On');
  await controls['Drive'].resetToDefault();
  await EConsoleDemo.engine.settled();
  assert.equal(controls['Drive'].real.value, 0);
  assert.ok(EConsoleDemo.engine.touches.length >= 10);
});

test('populate is idempotent and new channel inserts gain interactive fixture parameters', async (t) => {
  const luna = await EConsoleDemo.connect(); t.after(() => luna.close());
  const session = await luna.session();
  const bass = session.tracks.byId('bass');
  const slot = await EConsoleLogic.ensurePlugin(luna, session, bass, 'strip', EConsoleDemo.IDS.strip);
  await EConsoleDemo.populate(slot, 'strip');
  const count = slot.params.length;
  await EConsoleDemo.populate(slot, 'strip');
  assert.equal(slot.params.length, count);
  const input = EConsoleLogic.parameterMap(slot).inputGain;
  await input.normalized.set(.75);
  assert.equal(input.real.value, 10);
  assert.equal(input.display.value, '10.0 dB');
  await assert.rejects(() => EConsoleDemo.populate(slot, 'analog'), /fixture/);
});
