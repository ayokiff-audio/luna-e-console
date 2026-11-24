import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

vm.runInThisContext(await readFile(new URL('../vendor/luna.global.js', import.meta.url), 'utf8') + '\nglobalThis.Luna = Luna;');
await import('../logic.js');
const L = globalThis.EConsoleLogic;

// Exact native identifiers from the installed SSL GUI bundles. The GUI binds these
// parameters by ID; it does not contain the host's display-name or range metadata.
const E_IDS = [
  'line_gain', 'input_select', 'mic_gain', 'transformer', 'phase', 'pad',
  'comp_ratio', 'comp_release', 'comp_attack', 'stereo_link', 'comp_thresh',
  'exp_range', 'exp_release', 'exp_attack', 'exp_thresh', 'exp_select',
  'dyn_in', 'exp_in', 'comp_in', 'filt_dyn_sc', 'hp_freq', 'lp_freq', 'filt_pre_dyn',
  'hf_gain', 'hf_freq', 'hf_bell', 'hmf_gain', 'hmf_q', 'hmf_freq', 'eq_type',
  'lmf_gain', 'lmf_q', 'lmf_freq', 'lf_gain', 'lf_freq', 'lf_bell',
  'eq_in', 'eq_dyn_sc', 'eq_pre_dyn', 'power', 'level', 'output', 'hold',
];
const G_IDS = ['ratio', 'thresh', 'make_up', 'attack', 'release', 'sc_filter', 'mix', 'fade_rate', 'headroom', 'fade', 'power'];

// Minimal public parameter metadata captured from a disposable live LUNA test on
// 2026-11-24. These fixtures are self-contained and include no session identifiers.
// Tuple fields: id, host name, host display, normalized, opaque real, discrete, steps.
const LIVE_E = [
  ['input_select', 'Input Select', 'Line', 0, 0, true, 2],
  ['line_gain', 'Line Gain', '0.0 dB', .5, 16384, false, 0],
  ['mic_gain', 'Mic Gain', '20.0 dB', 0, 0, false, 0],
  ['pad', 'Pad', 'Off', 0, 0, true, 2], ['phase', 'Phase', 'Normal', 0, 0, true, 2],
  ['transformer', 'Transformer', 'On', 1, 1, true, 2],
  ['comp_ratio', 'COMP Ratio', '4.98:1', .498046875, 16320, false, 0],
  ['comp_thresh', 'COMP Thresh', '0.0 dB', .331756591796875, 10871, false, 0],
  ['comp_release', 'COMP Release', '0.40 s', .49755859375, 16304, false, 0],
  ['comp_attack', 'COMP Attack', 'Auto', 0, 0, true, 2],
  ['stereo_link', 'Stereo Link', 'Link', 1, 1, true, 2],
  ['exp_select', 'EXP Select', 'Gate 1', .5, 1, true, 3],
  ['exp_thresh', 'EXP Thresh', '-30.0 dB', 0, 0, false, 0],
  ['exp_range', 'EXP Range', '0.0 dB', 0, 0, false, 0],
  ['exp_release', 'EXP Release', '0.40 s', .5, 16384, false, 0],
  ['exp_attack', 'EXP Attack', 'Auto', 0, 0, true, 2],
  ['dyn_in', 'DYN In', 'In', 1, 1, true, 2],
  ['comp_in', 'COMP In', 'Out', 0, 0, true, 2], ['exp_in', 'EXP In', 'Out', 0, 0, true, 2],
  ['hp_freq', 'HP Freq', 'Out', 0, 0, false, 0], ['lp_freq', 'LP Freq', 'Out', 0, 0, false, 0],
  ['filt_dyn_sc', 'Filt Dyn SC', 'Off', 0, 0, true, 2], ['filt_pre_dyn', 'Filt Pre Dyn', 'Off', 0, 0, true, 2],
  ['hf_gain', 'HF Gain', '0.0 dB', .5, 16384, false, 0], ['hf_freq', 'HF Freq', '8.00 k', .5, 16384, false, 0],
  ['hf_bell', 'HF Bell', 'Shelf', 0, 0, true, 2],
  ['hmf_gain', 'HMF Gain', '0.0 dB', .5, 16384, false, 0], ['hmf_freq', 'HMF Freq', '3.00 k', .5, 16384, false, 0],
  ['hmf_q', 'HMF Q', '1.50', .5, 16384, false, 0],
  ['lmf_gain', 'LMF Gain', '0.0 dB', .5, 16384, false, 0], ['lmf_freq', 'LMF Freq', '1.00 k', .5, 16384, false, 0],
  ['lmf_q', 'LMF Q', '1.50', .5, 16384, false, 0],
  ['lf_gain', 'LF Gain', '0.0 dB', .5, 16384, false, 0], ['lf_freq', 'LF Freq', '200 Hz', .5, 16384, false, 0],
  ['lf_bell', 'LF Bell', 'Shelf', 0, 0, true, 2],
  ['eq_in', 'EQ In', 'Out', 0, 0, true, 2], ['eq_dyn_sc', 'EQ Dyn SC', 'Off', 0, 0, true, 2],
  ['eq_pre_dyn', 'EQ Pre Dyn', 'Off', 0, 0, true, 2], ['eq_type', 'EQ Type', 'Brown', 1, 1, true, 2],
  ['hold', 'Hold', 'Off', 0, 0, true, 2], ['level', 'Level', '0.0 dB', .75, 24576, false, 0],
  ['output', 'Output', '0.0 dB', .5, 16384, false, 0], ['power', 'Power', 'On', 1, 1, true, 2],
];
const LIVE_G = [
  ['thresh', 'Thresh', '15.0 dB', 1, 1, false, 0], ['make_up', 'Make Up', '3.0 dB', .200012, .200012, false, 0],
  ['attack', 'Attack', '1 ms', .4, 2, true, 6], ['release', 'Release', 'Auto', 1, 4, true, 5],
  ['ratio', 'Ratio', '2:1', 0, 0, true, 3], ['sc_filter', 'SC Filter', 'Off', 0, 0, false, 0],
  ['headroom', 'Headroom', '16 dB', .5, 3, true, 7], ['mix', 'Mix', '100%', 1, 1, false, 0],
  ['fade_rate', 'Fade Rate', '24.8 s', .674, .674, false, 0], ['fade', 'Fade', 'In', 0, false, true, 2],
  ['power', 'Power', 'On', 1, true, true, 2],
];
function capturedSlot(tuples) {
  return { isEmpty: false, params: tuples.map(([id, name, display, normalized, real, discrete, numSteps]) => ({
    id, name: { value: name }, display: { value: display }, normalized: { value: normalized }, real: { value: real },
    discrete: { value: discrete }, numSteps: { value: numSteps },
  })) };
}

async function parameterFixture(t, role, ids) {
  const engine = new Luna.MockEngine();
  engine.addSession('ssl-metadata', { tracks: ['Channel'] });
  const pluginId = role === 'strip' ? 'uaudio_ssl_e_channel_strip' : 'uaudio_ssl_g_bus_compressor';
  engine.addPlugin(pluginId, { name: role === 'strip' ? 'SSL E Channel Strip' : 'SSL G Bus Compressor', manufacturer: 'Universal Audio' });
  const luna = await Luna.connect({ port_: engine.port() }); t.after(() => luna.close());
  const session = await luna.session();
  const channel = role === 'strip' ? session.visibleTracks[0] : session.master;
  const slot = await L.ensurePlugin(luna, session, channel, role, pluginId);
  await slot.controls.load();
  for (const control of slot.controls.items) engine.removeNode(control.path);
  ids.forEach((id, index) => {
    // Names/displays are deliberately synthetic host metadata. No physical unit or
    // normalization curve is inferred from the GUI identifiers or knob artwork.
    engine.addNode(`${slot.path}/controls/${id}`, { properties: {
      uid: `fixture_${id}`, name: `Host label ${index}`, control_type: 'parameter',
      value: .37, normalized_value: .37, real_value: 100 + index,
      string_value: `Host display ${index}`, initialized: true, automatable: true,
      discrete: false, num_steps: 0, real_values: [], string_values: [], touch_count: 0,
    } });
  });
  await engine.settled(); await slot.controls.reload();
  return { engine, luna, session, channel, slot };
}

test('all 43 native E-strip parameter identifiers survive dynamic reading with host metadata intact', async (t) => {
  const { slot } = await parameterFixture(t, 'strip', E_IDS);
  const rows = L.parameters(slot);
  assert.deepEqual(rows.map((r) => r.id), E_IDS);
  rows.forEach((row, index) => {
    assert.equal(row.name, `Host label ${index}`);
    assert.equal(row.display, `Host display ${index}`);
    assert.equal(row.normalized, .37);
    assert.equal(row.control.real.value, 100 + index);
  });
});

test('all 11 native G-bus identifiers survive even when no semantic alias matches the host name', async (t) => {
  const { slot } = await parameterFixture(t, 'master', G_IDS);
  const rows = L.parameters(slot);
  assert.deepEqual(rows.map((r) => r.id), G_IDS);
  assert.ok(rows.some((r) => r.id === 'sc_filter'));
  assert.ok(rows.some((r) => r.id === 'make_up'));
  assert.ok(rows.some((r) => r.id === 'headroom'));
  assert.ok(rows.every((r) => r.control === slot.controls.byId(r.id)));
});

test('manual mappings can choose line or mic gain independently without losing either control', async (t) => {
  const { slot } = await parameterFixture(t, 'strip', E_IDS);
  const line = L.parameterMap(slot, { inputGain: 'line_gain' });
  const mic = L.parameterMap(slot, { inputGain: 'mic_gain' });
  assert.equal(line.inputGain.id, 'line_gain');
  assert.equal(mic.inputGain.id, 'mic_gain');
  assert.notEqual(line.inputGain, mic.inputGain);
  for (const overrides of [{ inputGain: 'line_gain' }, { inputGain: 'mic_gain' }]) {
    const rows = L.parameters(slot, overrides);
    assert.equal(rows.length, E_IDS.length);
    assert.ok(rows.some((r) => r.id === 'line_gain'));
    assert.ok(rows.some((r) => r.id === 'mic_gain'));
  }
});

test('a native parameter marked uninitialized is omitted while remaining parameters stay readable', async (t) => {
  const { engine, slot } = await parameterFixture(t, 'master', G_IDS);
  engine.setValue(`${slot.path}/controls/fade_rate`, 'initialized', null);
  await engine.settled(); await slot.controls.reload();
  const rows = L.parameters(slot);
  assert.equal(rows.length, G_IDS.length - 1);
  assert.ok(!rows.some((r) => r.id === 'fade_rate'));
  assert.ok(rows.some((r) => r.id === 'thresh'));
});

test('captured E host names map compressor threshold and filters while keeping line/mic gain distinct', () => {
  const slot = capturedSlot(LIVE_E);
  const mapped = L.parameterMap(slot);
  assert.equal(mapped.threshold?.id, 'comp_thresh');
  assert.equal(mapped.hpf?.id, 'hp_freq');
  assert.equal(mapped.lpf?.id, 'lp_freq');
  assert.equal(mapped.lineGain?.id, 'line_gain');
  assert.equal(mapped.micGain?.id, 'mic_gain');
  assert.notEqual(mapped.lineGain, mapped.micGain);
  assert.equal(mapped.ratio?.id, 'comp_ratio');
  assert.equal(mapped.attack?.id, 'comp_attack');
  assert.equal(mapped.release?.id, 'comp_release');
});

test('captured G host names map Thresh and Make Up to the correct semantic controls', () => {
  const mapped = L.parameterMap(capturedSlot(LIVE_G));
  assert.equal(mapped.threshold?.id, 'thresh');
  assert.equal(mapped.makeup?.id, 'make_up');
  assert.equal(mapped.attack?.id, 'attack');
  assert.equal(mapped.release?.id, 'release');
  assert.equal(mapped.ratio?.id, 'ratio');
});

test('every captured native E/G control receives a known console section without losing metadata', () => {
  const allowed = new Set(L.PARAMETER_GROUPS.filter((g) => g.id !== 'other').map((g) => g.id));
  for (const tuples of [LIVE_E, LIVE_G]) {
    const rows = L.parameters(capturedSlot(tuples));
    assert.equal(rows.length, tuples.length);
    rows.forEach((row, index) => {
      const [id, name, display, normalized, real, discrete, numSteps] = tuples[index];
      assert.ok(allowed.has(row.group), `${name} should belong to a console section`);
      assert.equal(row.id, id); assert.equal(row.name, name); assert.equal(row.display, display);
      assert.equal(row.normalized, normalized); assert.equal(row.control.real.value, real);
      assert.equal(row.discrete, discrete); assert.equal(row.numSteps, numSteps);
    });
  }
});

test('E gain raw values stay opaque and never replace plugin-provided displays or normalized values', () => {
  const rows = L.parameters(capturedSlot(LIVE_E));
  const line = rows.find((row) => row.id === 'line_gain');
  const level = rows.find((row) => row.id === 'level');
  assert.equal(line.control.real.value, 16384);
  assert.equal(line.normalized, .5);
  assert.equal(line.display, '0.0 dB');
  assert.equal(level.control.real.value, 24576);
  assert.equal(level.normalized, .75);
  assert.equal(level.display, '0.0 dB');
  const twoStateNames = rows.filter((r) => r.discrete && r.numSteps === 2).map((r) => r.display);
  assert.ok(twoStateNames.includes('Line'));
  assert.ok(twoStateNames.includes('Auto'));
  assert.ok(twoStateNames.includes('Shelf'));
  assert.ok(twoStateNames.includes('Brown'));
});
