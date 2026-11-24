/* Explicit preview only: real SDK models, fixture catalog, and no audio or live LUNA connection. */
(() => {
  'use strict';
  const IDS = Object.freeze({ strip: 'fixture.uadx.ssl4000e', master: 'fixture.uadx.sslgbuss', analog: 'fixture.econsole.analog' });
  const contexts = new WeakMap();
  let currentEngine;
  const continuous = (name, min, max, value, unit = '', log = false) => ({ name, min, max, value, unit, log });
  const choice = (name, values, labels, value) => ({ name, min: values[0], max: values.at(-1), value, discrete: true, values, labels });
  const integer = (name, value) => ({ name, min: 1, max: 65535, value, discrete: true, integer: true });
  const SPECS = {
    strip: [
      continuous('Input Gain', -20, 20, 0, 'dB'), continuous('HPF', 20, 500, 35, 'Hz', true),
      continuous('LPF', 3000, 20000, 18000, 'Hz', true),
      continuous('LF Gain', -15, 15, 1.2, 'dB'), continuous('LF Frequency', 30, 450, 110, 'Hz', true),
      continuous('LMF Gain', -15, 15, -.6, 'dB'), continuous('LMF Frequency', 200, 2500, 680, 'Hz', true), continuous('LMF Q', .5, 3, 1.2),
      continuous('HMF Gain', -15, 15, .8, 'dB'), continuous('HMF Frequency', 600, 7000, 3200, 'Hz', true), continuous('HMF Q', .5, 3, 1.1),
      continuous('HF Gain', -15, 15, 1.6, 'dB'), continuous('HF Frequency', 1500, 16000, 8800, 'Hz', true),
      continuous('Threshold', -20, 10, -8, 'dB'), continuous('Ratio', 1, 20, 3, ':1'),
      continuous('Attack', .1, 30, 10, 'ms', true), continuous('Release', .1, 4, .4, 's', true),
      continuous('Output Gain', -20, 20, 0, 'dB'),
    ],
    master: [
      continuous('Threshold', -20, 20, -6, 'dB'),
      choice('Ratio', [2, 4, 10], ['2:1', '4:1', '10:1'], 2),
      choice('Attack', [.1, .3, 1, 3, 10, 30], ['0.1 ms', '0.3 ms', '1 ms', '3 ms', '10 ms', '30 ms'], 10),
      choice('Release', [.1, .3, .6, 1.2, 2], ['0.1 s', '0.3 s', '0.6 s', '1.2 s', 'Auto'], .3),
      continuous('Makeup Gain', 0, 20, 1, 'dB'),
    ],
    analog: [
      integer('Console Seed', 4817), continuous('Variation', 0, 100, 20, '%'),
      continuous('Crosstalk', -100, -40, -70, 'dB'),
      choice('Crosstalk Enabled', [0, 1], ['Off', 'On'], 0),
      integer('Console Group', 1), choice('Channel Role', [0, 1, 2], ['Track', 'Bus', 'Master'], 0),
      continuous('Drive', 0, 18, 0, 'dB'), continuous('Output Trim', -12, 12, 0, 'dB'),
    ],
  };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  function toNormalized(spec, value) {
    if (spec.values) return Math.max(0, spec.values.indexOf(value)) / (spec.values.length - 1);
    return spec.log ? Math.log(value / spec.min) / Math.log(spec.max / spec.min) : (value - spec.min) / (spec.max - spec.min);
  }
  function fromNormalized(spec, value) {
    const normalized = clamp(value, 0, 1);
    if (spec.values) return spec.values[Math.round(normalized * (spec.values.length - 1))];
    const real = spec.log ? spec.min * Math.pow(spec.max / spec.min, normalized) : spec.min + normalized * (spec.max - spec.min);
    return spec.integer ? Math.round(real) : real;
  }
  function display(spec, value) {
    if (spec.values) return spec.labels[spec.values.indexOf(value)] ?? String(value);
    if (spec.integer) return String(Math.round(value));
    if (spec.unit === 'Hz') return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${Math.round(value)} Hz`;
    const text = Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2);
    return spec.unit === ':1' ? `${text}:1` : `${text}${spec.unit ? ` ${spec.unit}` : ''}`;
  }
  function publish(engine, path, spec, real) {
    let value = clamp(Number(real), spec.min, spec.max);
    if (spec.integer) value = Math.round(value);
    if (spec.values && !spec.values.includes(value)) value = spec.values.reduce((a, b) => Math.abs(value - a) < Math.abs(value - b) ? a : b);
    const normalized = toNormalized(spec, value);
    for (const [key, item] of Object.entries({ real_value: value, normalized_value: normalized,
      value: spec.values ? spec.values.indexOf(value) : normalized, string_value: display(spec, value) })) engine.setValue(path, key, item);
  }
  function addControl(context, slotPath, index, spec) {
    const { engine, specs } = context;
    const path = `${slotPath}/controls/preview_${index}`;
    specs.set(path, spec);
    const normalized = toNormalized(spec, spec.value);
    engine.addNode(path, {
      properties: { uid: `fixture_control_${slotPath}_${index}`, name: spec.name, control_type: 'parameter',
        initialized: true, automatable: true, discrete: spec.discrete === true, num_steps: spec.integer ? 65535 : spec.values?.length ?? 0,
        value: spec.values ? spec.values.indexOf(spec.value) : normalized, real_value: spec.value,
        normalized_value: normalized, string_value: display(spec, spec.value), touch_count: 0,
        real_values: spec.values ?? [], string_values: spec.labels ?? [], taper: null },
      readOnly: ['uid', 'name', 'control_type', 'initialized', 'automatable', 'discrete', 'num_steps'],
      commands: {
        set_touch: (data, e, nodePath) => {
          e.touches.push(`${nodePath}:${data.touch ? 'on' : 'off'}`);
          e.setValue(nodePath, 'touch_count', data.touch ? 1 : 0);
          return null;
        },
        set_control_default_value: (_data, e, nodePath) => { publish(e, nodePath, spec, spec.value); return spec.value; },
      },
    });
    engine.addNode(`${path}/automation`);
  }
  function portFor(context) {
    const { engine, specs } = context;
    const base = engine.port();
    return {
      get connected() { return base.connected; },
      get: (path, options) => base.get(path, options), post: (path, data) => base.post(path, data),
      subscribe: (path, fn, options) => base.subscribe(path, fn, options),
      onStatus: (fn) => base.onStatus(fn), close: () => base.close(),
      async set(path, data) {
        await base.set(path, data);
        const match = path.match(/^(.*)\/(normalized_value|real_value|value)$/);
        const spec = match && specs.get(match[1]);
        if (!spec) return;
        const numeric = Number(data && typeof data.value === 'number' ? data.value : data);
        if (!Number.isFinite(numeric)) return;
        const real = match[2] === 'real_value' ? numeric : fromNormalized(spec, numeric);
        publish(engine, match[1], spec, real);
        await engine.settled();
      },
    };
  }
  async function populate(slot, role) {
    const context = contexts.get(slot.client);
    if (!context || slot.pluginId.value !== IDS[role]) throw new Error('Preview parameters can only populate this demo’s matching fixture plugin.');
    const marker = `${slot.path}/${slot.instanceId.value}/${role}`;
    if (context.populated.has(marker)) { await slot.controls.reload(); return slot; }
    const { engine, specs } = context;
    // Replacing a mock plugin keeps old control nodes. Remove only this fixture's parameter nodes.
    await slot.controls.reload();
    for (const p of slot.controls.items) {
      if (p.id === 'bypass') { engine.setValue(p.path, 'name', 'Plugin Bypass'); continue; }
      specs.delete(p.path);
      engine.removeNode(p.path);
    }
    SPECS[role].forEach((spec, index) => addControl(context, slot.path, index, spec));
    context.populated.add(marker);
    await engine.settled();
    await slot.controls.reload();
    return slot;
  }
  async function connect() {
    const engine = new Luna.MockEngine();
    const context = { engine, specs: new Map(), populated: new Set() };
    currentEngine = engine;
    engine.addSession('fixture_console_session', { name: 'E Console Preview · No Audio' });
    engine.setValue('/sessions/fixture_console_session/contexts/main', 'selection_grouping', true);
    engine.setValue('/sessions/fixture_console_session/contexts/main', 'groups_suspended', false);
    for (const [id, name, stemFormat] of [['lead-vocal', 'Lead vocal', 'mono'], ['drums', 'Drums', 'stereo'], ['bass', 'Bass', 'mono'], ['guitar', 'Guitar', 'stereo']])
      engine.addTrack('fixture_console_session', id, { name, stemFormat });
    engine.addBus('fixture_console_session', 'drums-bus', { name: 'Drums bus', busType: 'aux', stemFormat: 'stereo' });
    engine.addPlugin(IDS.strip, { name: 'UADx SSL 4000 E Channel Strip', manufacturer: 'Universal Audio', categories: ['EQ', 'Compressors & Limiters'], formats: [['mono', 'mono'], ['stereo', 'stereo']] });
    engine.addPlugin(IDS.master, { name: 'UADx SSL G Buss Compressor', manufacturer: 'Universal Audio', categories: ['Compressors & Limiters'], formats: [['stereo', 'stereo']] });
    engine.addPlugin(IDS.analog, { name: 'E Console Analog', manufacturer: 'E Console', categories: ['Saturation'], formats: [['mono', 'mono'], ['stereo', 'stereo']] });
    await engine.settled();
    const luna = await Luna.connect({ port_: portFor(context), engine: 'mock' });
    contexts.set(luna, context);
    try {
      const session = await luna.session();
      await luna.plugins.load();
      const lead = session.tracks.byId('lead-vocal');
      const strip = await EConsoleLogic.ensurePlugin(luna, session, lead, 'strip', IDS.strip);
      await populate(strip, 'strip');
      const compressor = await EConsoleLogic.ensurePlugin(luna, session, session.master, 'master', IDS.master);
      await populate(compressor, 'master');
      const analog = await lead.insert(IDS.analog);
      await populate(analog, 'analog');
      await session.context.selectionTracks.set([lead.id, 'bass']);
      await EConsoleLogic.saveSettings(session, { selectedChannelId: lead.id, pluginIds: { strip: IDS.strip, master: IDS.master } });
      await Promise.all(EConsoleLogic.channels(session).map((ch) => ch.loadStrip()));
      return luna;
    } catch (e) { await luna.close(); throw e; }
  }
  globalThis.EConsoleDemo = Object.freeze({ connect, populate, IDS, get engine() { return currentEngine; } });
})();
