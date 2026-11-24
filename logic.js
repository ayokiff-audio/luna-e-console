/* E Console's control model. Audio processing belongs to the optional native companion. */
(() => {
  'use strict';
  const CONTEXT_ID = 'com.econsole.control';
  const PARAMETER_GROUPS = [
    { id: 'input', label: 'Input' }, { id: 'filters', label: 'Filters' },
    { id: 'eq', label: 'EQ' }, { id: 'dynamics', label: 'Dynamics' },
    { id: 'output', label: 'Output' }, { id: 'other', label: 'Other' },
  ];
  const ALIASES = {
    inputGain: ['input', ['input', 'input gain', 'input level', 'preamp gain']],
    lineGain: ['input', ['line gain']],
    micGain: ['input', ['mic gain']],
    hpf: ['filters', ['hpf', 'hp freq', 'hp frequency', 'high pass', 'high pass frequency']],
    lpf: ['filters', ['lpf', 'lp freq', 'lp frequency', 'low pass', 'low pass frequency']],
    lfGain: ['eq', ['lf gain', 'low gain', 'low frequency gain']],
    lfFrequency: ['eq', ['lf freq', 'lf frequency', 'low frequency']],
    lmfGain: ['eq', ['lmf gain', 'low mid gain', 'low mid frequency gain']],
    lmfFrequency: ['eq', ['lmf freq', 'lmf frequency', 'low mid frequency']],
    lmfQ: ['eq', ['lmf q', 'low mid q', 'low mid bandwidth']],
    hmfGain: ['eq', ['hmf gain', 'high mid gain', 'high mid frequency gain']],
    hmfFrequency: ['eq', ['hmf freq', 'hmf frequency', 'high mid frequency']],
    hmfQ: ['eq', ['hmf q', 'high mid q', 'high mid bandwidth']],
    hfGain: ['eq', ['hf gain', 'high gain', 'high frequency gain']],
    hfFrequency: ['eq', ['hf freq', 'hf frequency', 'high frequency']],
    threshold: ['dynamics', ['threshold', 'thresh', 'comp thresh', 'comp threshold', 'compressor threshold']],
    ratio: ['dynamics', ['ratio', 'comp ratio', 'compressor ratio']],
    attack: ['dynamics', ['attack', 'comp attack', 'compressor attack']],
    release: ['dynamics', ['release', 'comp release', 'compressor release']],
    makeup: ['dynamics', ['makeup', 'makeup gain', 'make up', 'make up gain']],
    outputGain: ['output', ['output', 'output gain', 'output level']],
  };
  // These are normalized control tolerances, NOT harmonic or component modeling.
  const VARIATION_LIMITS = { inputGain: .006, outputGain: .003, lfGain: .008, lmfGain: .008, hmfGain: .008, hfGain: .008, threshold: .004 };
  const DEFAULT_SETTINGS = {
    version: 1, scope: 'all', selectedChannelId: null,
    pluginIds: { strip: null, master: null }, parameterOverrides: {},
    variationAmount: .2, crosstalk: { enabled: false, amountDb: -72, group: 1 },
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const normalizedName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const error = (code, message) => Object.assign(new Error(message), { code });
  const closeEnough = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-5;
  const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
  function hash(text) {
    let h = 2166136261;
    for (const c of String(text)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return (h >>> 0) || 1;
  }
  function channelKind(channel) {
    if (channel.isMaster === true || channel.busType?.value === 'master') return 'master';
    return channel.busType || channel.trackType?.value === 'bus' ? 'bus' : 'track';
  }
  function eligible(channel) {
    const kind = channelKind(channel);
    if (kind === 'master') return true;
    if (kind === 'bus') return (channel.trackType?.value === 'bus' || channel.busType?.value === 'aux') && channel.folderMode?.value !== 'container';
    return ['audio', 'instrument', 'multi_output', 'bus'].includes(channel.trackType?.value);
  }
  function roleForChannel(channel) { return channelKind(channel) === 'master' ? 'master' : 'strip'; }
  function channels(session, scope = 'all') {
    const selected = new Set(session.context.selectionTracks.value ?? []);
    return session.channelsInOrder.filter(eligible).filter((ch) => {
      const kind = channelKind(ch);
      if (scope === 'selected') return selected.has(ch.id);
      if (scope === 'tracks') return kind === 'track';
      if (scope === 'buses') return kind === 'bus';
      if (scope === 'master') return kind === 'master';
      return true;
    });
  }
  function pluginMatches(plugin, role) {
    if (!plugin || plugin.installed.value === false || plugin.authorized.value === false) return false;
    const manifest = plugin.manifest?.value ?? {};
    const name = normalizedName(plugin.name.value ?? manifest.name);
    const manufacturer = normalizedName(plugin.manufacturer ?? manifest.manufacturer ?? manifest.author);
    const identity = normalizedName(`${plugin.id} ${manufacturer} ${name}`);
    if (manufacturer && !/\b(?:universal audio|uaudio|uadx|uad)\b/.test(manufacturer)) return false;
    // LUNA's actual native entries are uaudio_ssl_*, named "SSL E/G ...".
    // AU/VST3 entries also need not contain the marketing label "UADx".
    const trusted = /\b(?:universal audio|uaudio|uadx|uad)\b/.test(manufacturer) ||
      /^(?:uaudio_|com\.uaudio\.)/i.test(plugin.id) || /^uadx\b/.test(name);
    if (!trusted || !/\bssl\b/.test(name) || /\blegacy\b|\buad ?2\b|\bdsp\b/.test(identity)) return false;
    if (role === 'strip') return /\bchannel strip\b/.test(name) && /\b(?:4000 ?e|e)\b/.test(name) && !/\b(?:9000|g)\b/.test(name);
    if (role === 'master') return /\b(?:4000 ?g|g)\b/.test(name) && /\bbuss?\b/.test(name) && /\bcompressor\b/.test(name) && !/\bchannel strip\b/.test(name);
    return false;
  }
  function pluginFormat(plugin) {
    const id = String(plugin?.id ?? '');
    const declared = normalizedName(plugin?.manifest?.value?.format ?? plugin?.manifest?.value?.plugin_format);
    if (/^vst ?3$/.test(declared)) return 'VST3';
    if (/^(?:au|audio ?units?)$/.test(declared)) return 'AU';
    if (/^(?:luna|luna native|lunacomponent)$/.test(declared)) return 'LUNA native';
    if (/vst3/i.test(id)) return 'VST3';
    if (/(?:^|[.:/_-])(?:au|aufx|aumu)(?:[.:/_-]|$)/i.test(id)) return 'AU';
    if (/^uaudio_/i.test(id)) return 'LUNA native';
    return 'Unknown format';
  }
  function pluginLabel(plugin) {
    const name = plugin.name.value ?? plugin.manifest?.value?.name ?? plugin.id;
    const format = pluginFormat(plugin);
    return format === 'Unknown format' ? name : `${name} · ${format}`;
  }
  function pluginCandidates(luna, role) {
    return luna.plugins.items.filter((p) => pluginMatches(p, role)).sort((a, b) => (a.name.value ?? a.id).localeCompare(b.name.value ?? b.id));
  }
  function matchingEffects(channel, luna, role = roleForChannel(channel)) {
    return channel.effectSlots.filter((slot) => pluginMatches(luna.plugins.byId(slot.pluginId.value ?? ''), role));
  }
  async function ensurePlugin(luna, session, channel, role = roleForChannel(channel), pluginId) {
    if (!session.channelsInOrder.includes(channel)) throw error('FOREIGN_CHANNEL', 'This channel does not belong to the selected session.');
    if (!eligible(channel)) throw error('INELIGIBLE_CHANNEL', 'This channel cannot host an E Console strip.');
    if (role !== roleForChannel(channel)) throw error('WRONG_ROLE', 'Use the SSL G Buss Compressor on the master and the SSL E strip on tracks or buses.');
    if (session.readOnly.value === true) throw error('READ_ONLY', 'The session is read only.');
    await Promise.all([luna.plugins.reload(), channel.effects.reload()]);
    const candidates = pluginCandidates(luna, role);
    if (pluginId && !candidates.some((p) => p.id === pluginId)) throw error('INVALID_PLUGIN', 'The chosen plugin is not an available Universal Audio SSL plugin for this role.');
    const already = matchingEffects(channel, luna, role).filter((s) => !pluginId || s.pluginId.value === pluginId);
    if (already.length) { await already[0].waitForPlugin(); return already[0]; }
    if (!candidates.length) throw error('MISSING_PLUGIN', role === 'master' ? 'Install and authorize the UADx SSL G Buss Compressor first.' : 'Install and authorize the UADx SSL E Channel Strip first.');
    if (!pluginId && candidates.length > 1) throw error('CHOOSE_PLUGIN', 'Choose the UADx SSL plugin format before adding it.');
    const target = channel.effectSlots.find((s) => s.isEmpty);
    if (!target) throw error('NO_EMPTY_SLOT', 'All audio insert slots are full; no existing plugin was replaced.');
    const chosen = pluginId ?? candidates[0].id;
    try {
      const valid = await target.validPlugins();
      if (!valid.some((p) => p.pluginId === chosen)) throw error('INCOMPATIBLE_PLUGIN', 'This plugin format does not run on the chosen channel.');
    } catch (e) { if (!(globalThis.Luna?.Unsupported && e instanceof globalThis.Luna.Unsupported)) throw e; }
    // Only user-facing effect_N slots are eligible; native console slots are untouched.
    if (!target.isEmpty) throw error('SLOT_CHANGED', 'The chosen insert was filled by another action; no existing plugin was replaced. Please retry.');
    await target.setPlugin(chosen);
    return target;
  }
  function parameterMap(slot, overrides = {}) {
    const params = slot.isEmpty ? [] : slot.params;
    const result = {};
    for (const [key, [, aliases]] of Object.entries(ALIASES)) {
      if (Object.hasOwn(overrides, key)) {
        const found = params.find((p) => p.id === overrides[key]);
        if (found) result[key] = found;
        continue;
      }
      const found = params.filter((p) => aliases.includes(normalizedName(p.name.value)));
      if (found.length === 1) result[key] = found[0];
    }
    const count = new Map();
    for (const p of Object.values(result)) count.set(p.id, (count.get(p.id) ?? 0) + 1);
    return Object.fromEntries(Object.entries(result).filter(([, p]) => count.get(p.id) === 1));
  }
  function parameters(slot, overrides = {}) {
    const map = parameterMap(slot, overrides);
    const keys = new Map(Object.entries(map).map(([key, p]) => [p.id, key]));
    return (slot.isEmpty ? [] : slot.params).map((p) => {
      const key = keys.get(p.id) ?? null;
      const name = p.name.value ?? p.id;
      const n = normalizedName(name);
      const group = key ? ALIASES[key][0] :
        /^(input select|line gain|mic gain|pad|phase|transformer)$/.test(n) ? 'input' :
        /^(?:hp|lp) (?:freq|frequency)$|^filt\b/.test(n) ? 'filters' :
        /^(?:hf|hmf|lmf|lf)\b|^eq\b/.test(n) ? 'eq' :
        /^(?:comp|exp|dyn)\b|^(?:stereo link|sc filter|headroom|mix)$/.test(n) ? 'dynamics' :
        /^(?:level|output|hold|power|fade|fade rate)$/.test(n) ? 'output' : 'other';
      return { id: p.id, name, display: p.display.value ?? '', normalized: p.normalized.value,
        discrete: p.discrete.value === true, numSteps: p.numSteps.value ?? 0,
        group, key, control: p };
    });
  }
  async function storeFor(session) {
    const store = session.storage.context(CONTEXT_ID);
    await store.load();
    return store;
  }
  async function loadSettings(session) {
    const store = await storeFor(session);
    await store.add('settings', 'ui', clone(DEFAULT_SETTINGS));
    const saved = store.value('settings', 'ui').value ?? {};
    return { ...clone(DEFAULT_SETTINGS), ...saved, pluginIds: { ...DEFAULT_SETTINGS.pluginIds, ...saved.pluginIds },
      crosstalk: { ...DEFAULT_SETTINGS.crosstalk, ...saved.crosstalk } };
  }
  async function saveSettings(session, patch) {
    const current = await loadSettings(session);
    const next = { ...current, ...patch, pluginIds: { ...current.pluginIds, ...patch.pluginIds },
      crosstalk: { ...current.crosstalk, ...patch.crosstalk } };
    const store = await storeFor(session);
    await store.set('settings', 'ui', next);
    return next;
  }
  async function loadChannelState(session, channelId) {
    const store = await storeFor(session);
    await store.add(channelId, 'state', { version: 1, seed: hash(`${session.uid}/${channelId}`), variation: null });
    return clone(store.value(channelId, 'state').value);
  }
  async function saveChannelState(session, channelId, state) {
    const store = await storeFor(session);
    await store.set(channelId, 'state', state);
  }
  function fingerprint(slot) { return { slotId: slot.id, pluginId: slot.pluginId.value, instanceId: slot.instanceId.value }; }
  function sameInstance(profile, slot) {
    return profile.slotId === slot.id && profile.pluginId === slot.pluginId.value && profile.instanceId === slot.instanceId.value;
  }
  async function applyVariation(session, channel, slot, { amount = .2, seed, overrides = {} } = {}) {
    if (!Number.isFinite(amount) || amount < 0 || amount > 1) throw error('INVALID_AMOUNT', 'Parameter variation amount must be between 0 and 1.');
    if (session.readOnly.value === true) throw error('READ_ONLY', 'The session is read only.');
    if (!slot.loaded.value) throw error('PLUGIN_NOT_LOADED', 'Load the SSL plugin before applying parameter variation.');
    if (!eligible(channel)) throw error('INELIGIBLE_CHANNEL', 'This channel cannot host parameter variation.');
    await slot.controls.reload();
    const state = await loadChannelState(session, channel.id);
    const selectedSeed = seed === undefined ? state.seed : Number(seed);
    if (!Number.isSafeInteger(selectedSeed) || selectedSeed < 1 || selectedSeed > 0xffffffff) throw error('INVALID_SEED', 'The seed must be an integer from 1 through 4294967295.');
    const previous = state.variation;
    if (previous?.active && !sameInstance(previous, slot)) throw error('INSTANCE_CHANGED', 'The plugin instance changed; the saved parameter profile was not applied.');
    const profile = previous && sameInstance(previous, slot) ? clone(previous) : { version: 1, ...fingerprint(slot), baseline: {}, lastWritten: {}, active: false };
    profile.seed = selectedSeed;
    profile.amount = amount;
    const mapped = parameterMap(slot, overrides);
    let applied = 0, skipped = 0;
    const edits = [];
    const limits = roleForChannel(channel) === 'master' ? { threshold: VARIATION_LIMITS.threshold, makeup: .003 } : VARIATION_LIMITS;
    for (const [key, limit] of Object.entries(limits)) {
      const p = mapped[key];
      if (!p || p.discrete.value === true || typeof p.normalized.value !== 'number' || !Number.isFinite(p.normalized.value)) { skipped++; continue; }
      const current = p.normalized.value;
      if (previous?.active && Object.hasOwn(profile.lastWritten, p.id) && !closeEnough(current, profile.lastWritten[p.id])) { skipped++; continue; }
      if (!Object.hasOwn(profile.baseline, p.id)) profile.baseline[p.id] = current;
      const offset = ((hash(`${selectedSeed}/${channel.id}/${p.id}`) / 0xffffffff) * 2 - 1) * limit * amount;
      edits.push([p, clamp(profile.baseline[p.id] + offset, 0, 1)]);
    }
    if (!edits.length) throw error('NO_VARIATION_PARAMETERS', 'No unambiguous continuous tolerance controls are available, or these controls were changed by the user.');
    await session.transaction('E Console parameter variation', async () => {
      for (const [p, value] of edits) { await p.normalized.set(value); profile.lastWritten[p.id] = value; applied++; }
    });
    profile.active = true;
    state.seed = selectedSeed;
    state.variation = profile;
    await saveChannelState(session, channel.id, state);
    return { applied, skipped, profile };
  }
  async function restoreVariation(session, channel, slot) {
    if (session.readOnly.value === true) throw error('READ_ONLY', 'The session is read only.');
    const state = await loadChannelState(session, channel.id);
    const profile = state.variation;
    if (!profile?.active) return { restored: 0, skipped: 0 };
    if (!sameInstance(profile, slot)) throw error('INSTANCE_CHANGED', 'The plugin instance changed; the old baseline was not restored.');
    await slot.controls.reload();
    let restored = 0, skipped = 0;
    const byId = new Map(slot.params.map((p) => [p.id, p]));
    await session.transaction('Restore E Console parameters', async () => {
      for (const [id, value] of Object.entries(profile.lastWritten)) {
        const p = byId.get(id);
        if (!p || p.discrete.value === true || !closeEnough(p.normalized.value, value)) { skipped++; continue; }
        await p.normalized.set(profile.baseline[id]);
        restored++;
      }
    });
    state.variation = null;
    await saveChannelState(session, channel.id, state);
    return { restored, skipped };
  }
  globalThis.EConsoleLogic = Object.freeze({
    CONTEXT_ID, PARAMETER_GROUPS, PARAMETER_KEYS: Object.keys(ALIASES), DEFAULT_SETTINGS,
    hash, channelKind, roleForChannel, eligible, channels, pluginMatches, pluginFormat, pluginLabel, pluginCandidates,
    matchingEffects, ensurePlugin, parameterMap, parameters,
    loadSettings, saveSettings, loadChannelState, applyVariation, restoreVariation,
  });
})();
