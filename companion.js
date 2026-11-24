/* Native companion integration. No audio ever crosses the Add On SDK. */
(() => {
  const names = ['Console Seed', 'Variation', 'Crosstalk', 'Crosstalk Enabled', 'Console Group', 'Channel Role', 'Drive', 'Output Trim'];
  const hash = (text) => { let h = 2166136261; for (const c of String(text)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
  const candidates = (luna) => luna.plugins.items.filter((p) => p.installed.value === true && String(p.name.value).replace(/^E Console:\s*/i, '') === 'E Console Analog' && /^(?:E Console|ECns)$/i.test(String(p.manufacturer ?? '').trim()));
  const find = (luna, ch) => ch.effectSlots.find((s) => candidates(luna).some((p) => p.id === s.pluginId.value));
  const controls = (slot) => Object.fromEntries(names.map((name) => {
    const matches = slot.params.filter((p) => p.name.value === name);
    return [name, matches.length === 1 ? matches[0] : undefined];
  }));
  const independentEdits = new WeakMap();
  async function independently(session, edit) {
    // LUNA otherwise mirrors plugin touches onto selected and mix-group tracks.
    // These context settings are writable in LUNA 3.1.2, but not typed by the SDK.
    // Read them from the engine, and keep them outside the parameter undo batch.
    const previous = independentEdits.get(session) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const context = session.context;
      const fields = ['selection_grouping', 'groups_suspended'];
      const read = () => context.reload({ children: false, commands: false, flatvalue: true, propfilter: fields });
      await read();
      const settings = fields.map((name, i) => ({ name, prop: context.property(name), wanted: i === 1 }));
      for (const setting of settings) {
        setting.before = setting.prop.value;
        if (typeof setting.before !== 'boolean') throw new Error('Cannot read LUNA selection and mix-group linking. No companion parameters were changed.');
      }
      const changed = [];
      let failure;
      try {
        for (const setting of settings) if (setting.before !== setting.wanted) {
          changed.push(setting);
          await setting.prop.set(setting.wanted);
        }
        await read();
        if (settings.some(({ prop, wanted }) => prop.value !== wanted)) throw new Error('LUNA did not disable linked companion editing. No companion parameters were changed.');
        return await edit();
      } catch (error) { failure = error; throw error; }
      finally {
        const errors = [];
        for (const setting of changed.reverse()) {
          try { await setting.prop.set(setting.before); } catch (error) { errors.push(error); }
        }
        try {
          await read();
          if (settings.some(({ prop, before }) => prop.value !== before)) errors.push(new Error('The linking settings did not match their original values.'));
        } catch (error) { errors.push(error); }
        if (errors.length) throw new Error(`${failure ? `${failure.message} ` : ''}Could not restore LUNA selection/mix-group linking. Check those settings in LUNA.`, { cause: errors[0] });
      }
    });
    independentEdits.set(session, task);
    try { return await task; }
    finally { if (independentEdits.get(session) === task) independentEdits.delete(session); }
  }
  async function setIdentity(control, value) {
    if (!control || !Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Console Seed and Console Group must be integers from 1 to 65535.');
    // Verified in LUNA: generic AU indexed identities acknowledge real_value
    // without applying it. Their ordinal range is 0..65535 (65536 host steps).
    // The normalized view reaches the actual native parameter correctly.
    if (['Console Seed', 'Console Group'].includes(control.name.value) && control.discrete.value === true && Number(control.numSteps.value) === 65536 && !(control.realValues.value?.length)) {
      await control.normalized.set(value / 65535);
    } else await control.real.set(value);
  }
  async function seedFor(session, ch) {
    const store = session.storage.context('com.econsole.control.analog');
    await store.load();
    const saved = store.value(ch.id, 'seed').value;
    if (Number.isInteger(saved) && saved >= 1 && saved <= 65535) return saved;
    const state = await EConsoleLogic.loadChannelState(session, ch.id);
    const used = new Set((store.records.value ?? []).map((id) => store.value(id, 'seed').value));
    if (used.size >= 65535) throw new Error('All analog channel identities in this session are in use.');
    let value = state.seed % 65535 + 1;
    while (used.has(value)) value = value % 65535 + 1;
    await store.add(ch.id, 'seed', value);
    return store.value(ch.id, 'seed').value;
  }
  async function randomizeSeeds(luna, session, { random = Math.random } = {}) {
    if (session.readOnly.value === true) throw new Error('The session is read only.');
    if (typeof random !== 'function') throw new Error('A valid random number source is required.');
    await luna.plugins.load();
    const channels = EConsoleLogic.channels(session);
    await Promise.all(channels.map((ch) => ch.effects.load()));
    const ids = new Set(candidates(luna).map((p) => p.id));
    const instances = channels.flatMap((ch) => ch.effectSlots.filter((slot) => ids.has(slot.pluginId.value)).map((slot) => ({ ch, slot })));
    await Promise.all(instances.map(({ slot }) => slot.controls.load()));
    const validSeed = (value) => Number.isInteger(value) && value >= 1 && value <= 65535;
    const used = new Set(), plan = [], first = new Map();
    for (const { ch, slot } of instances) {
      const control = controls(slot)['Console Seed'];
      const before = Number(control?.real.value);
      if (validSeed(before)) used.add(before);
      if (!slot.loaded.value || !control || !validSeed(before)) throw new Error(`Cannot read Console Seed on ${ch.name.value ?? ch.id}. No seeds were changed.`);
      const item = { ch, slot, control, before, pluginId: slot.pluginId.value, instanceId: slot.instanceId.value };
      plan.push(item);
      if (!first.has(ch.id)) first.set(ch.id, item);
    }
    if (!plan.length) return { count: 0, seeds: [] };
    const store = session.storage.context('com.econsole.control.analog');
    await store.load();
    for (const id of store.records.value ?? []) {
      const value = store.value(id, 'seed').value;
      if (!first.has(id) && validSeed(value)) used.add(value);
    }
    // Sample without replacement; even a repeated RNG result cannot cause a loop.
    // Excluding old identities guarantees every affected strip gets a new seed.
    const available = Array.from({ length: 65535 }, (_, i) => i + 1).filter((value) => !used.has(value));
    if (available.length < plan.length) throw new Error('There are not enough unused console seeds for every loaded strip.');
    for (const item of plan) {
      const value = random();
      if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('The random source must return a number from 0 up to, but excluding, 1. No seeds were changed.');
      const index = Math.floor(value * available.length);
      item.seed = available[index];
      available[index] = available[available.length - 1]; available.pop();
    }
    const check = ({ ch, slot, control, before, pluginId, instanceId }) => {
      if (session.readOnly.value === true) throw new Error('The session is read only.');
      if (!session.channelsInOrder.includes(ch) || !ch.effectSlots.includes(slot) ||
          slot.pluginId.value !== pluginId || slot.instanceId.value !== instanceId || !slot.loaded.value ||
          controls(slot)['Console Seed'] !== control || Number(control.real.value) !== before) {
        throw new Error('A console strip changed while preparing the seeds. Please retry.');
      }
    };
    // Refresh before opening the batch, then recheck before each individual write.
    await Promise.all([...new Set(plan.map(({ ch }) => ch))].map((ch) => ch.effects.reload()));
    plan.forEach(check);
    await independently(session, () => session.transaction('Randomize analog strip seeds', async () => {
      plan.forEach(check);
      for (const item of plan) { check(item); await setIdentity(item.control, item.seed); }
      for (const [channelId, item] of first) {
        const body = { context: 'com.econsole.control.analog', record: channelId, field: 'seed' };
        // Raw storage commands avoid waiting for pushes held by the open batch.
        // Initialize/sync the baseline so Undo also restores a manually edited seed.
        const saved = store.value(channelId, 'seed').value;
        if (saved === undefined) await session.storage.post('add_field', { ...body, value: item.before, undoable: false });
        if (saved !== item.before) await session.storage.post('set_field', { ...body, value: item.before, undoable: false });
        await session.storage.post('set_field', { ...body, value: item.seed, undoable: true });
      }
    }));
    await store.load();
    // A successful command is not proof that an AU accepted the value. Re-read the
    // actual host controls after commit; never announce a randomization that failed.
    await Promise.all(plan.map(({ slot }) => slot.controls.reload()));
    for (const item of plan) {
      if (item.slot.pluginId.value !== item.pluginId || item.slot.instanceId.value !== item.instanceId ||
          Number(controls(item.slot)['Console Seed']?.real.value) !== item.seed) {
        throw new Error('LUNA did not confirm a native Console Seed change. Reopen or update E Console Analog and try again.');
      }
    }
    return { count: plan.length, seeds: plan.map(({ ch, slot, seed }) => ({ channelId: ch.id, slotId: slot.id, seed })) };
  }
  async function linkCompanions(luna, session, { group = hash(session.uid) % 65535 + 1, enabled = true } = {}) {
    if (session.readOnly.value === true) throw new Error('The session is read only.');
    if (enabled && (!Number.isInteger(group) || group < 1 || group > 65535)) throw new Error('Console Group must be an integer from 1 to 65535.');
    await luna.plugins.load();
    const channels = EConsoleLogic.channels(session);
    await Promise.all(channels.map((ch) => ch.effects.load()));
    const ids = new Set(candidates(luna).map((p) => p.id));
    const plan = channels.flatMap((ch) => ch.effectSlots.filter((slot) => ids.has(slot.pluginId.value)).map((slot) => ({ ch, slot, pluginId: slot.pluginId.value, instanceId: slot.instanceId.value })));
    await Promise.all(plan.map(({ slot }) => slot.controls.load()));
    for (const item of plan) {
      item.params = controls(item.slot);
      const required = enabled ? ['Console Group', 'Crosstalk Enabled', 'Channel Role'] : ['Crosstalk Enabled'];
      if (!item.slot.loaded.value || required.some((name) => !item.params[name])) throw new Error('A companion has not exposed its native link controls. No companions were changed.');
      if (enabled) item.role = EConsoleLogic.channelKind(item.ch) === 'master' ? 2 : EConsoleLogic.channelKind(item.ch) === 'bus' ? 1 : 0;
    }
    const check = (item) => {
      if (session.readOnly.value === true) throw new Error('The session is read only.');
      if (!session.channelsInOrder.includes(item.ch) || item.slot.pluginId.value !== item.pluginId || item.slot.instanceId.value !== item.instanceId || !item.slot.loaded.value) throw new Error('A companion changed while preparing the link. Please retry.');
    };
    if (plan.length) await independently(session, () => session.transaction(enabled ? 'Link analog console companions' : 'Unlink analog console companions', async () => {
      plan.forEach(check);
      for (const item of plan) {
        check(item);
        if (enabled) {
          await item.params['Channel Role'].normalized.set(item.role / 2);
          await setIdentity(item.params['Console Group'], group);
        }
        await item.params['Crosstalk Enabled'].normalized.set(enabled ? 1 : 0);
      }
    }));
    await Promise.all(plan.map(({ slot }) => slot.controls.reload()));
    for (const item of plan) {
      check(item);
      const p = controls(item.slot);
      if (Number(p['Crosstalk Enabled']?.real.value) !== (enabled ? 1 : 0) ||
          (enabled && (Number(p['Console Group']?.real.value) !== group || Number(p['Channel Role']?.real.value) !== item.role))) throw new Error('LUNA did not confirm the native companion link.');
    }
    return { count: plan.length, group, enabled };
  }
  async function enforceRole(session, ch, slot) {
    const kind = EConsoleLogic.channelKind(ch);
    if (kind === 'track') return;
    await slot.controls.load();
    const params = controls(slot), expected = kind === 'master' ? 2 : 1;
    if (!params['Channel Role']) throw new Error('Cannot verify the companion channel role.');
    if (Number(params['Channel Role'].real.value) === expected) return;
    await independently(session, () => session.transaction('Set analog console channel role', async () => {
      await params['Channel Role'].normalized.set(expected / 2);
    }));
  }
  async function ensure(luna, session, ch, sslSlot, initializeFixture) {
    if (!EConsoleLogic.channels(session).includes(ch)) throw new Error('Choose an audio channel, aux bus or master from this session.');
    if (session.readOnly.value === true) throw new Error('The session is read only.');
    await ch.effects.load();
    const existing = find(luna, ch);
    if (existing) { await existing.controls.load(); await enforceRole(session, ch, existing); return existing; }
    const plugins = candidates(luna);
    if (!plugins.length) throw new Error('Install E Console Analog.component, restart LUNA, and rescan plugins before adding the companion.');
    if (!sslSlot?.loaded.value || !ch.effectSlots.includes(sslSlot)) throw new Error('Load this channel’s SSL strip first. The companion is placed after it.');
    const slots = ch.effectSlots;
    const free = slots.slice(slots.indexOf(sslSlot) + 1).find((s) => s.isEmpty);
    if (!free) throw new Error('There is no empty insert after the SSL plugin. Make an empty slot there in LUNA, then retry.');
    const valid = await free.validPlugins({ search: 'E Console Analog' });
    if (!valid.some((p) => p.pluginId === plugins[0].id)) throw new Error('The analog companion is unavailable for this channel’s audio format.');
    if (!free.isEmpty) throw new Error('That insert was filled by another action. Please retry.');
    await independently(session, async () => {
      await free.setPlugin(plugins[0].id);
      if (initializeFixture) await initializeFixture(free);
      await free.controls.load();
      const params = controls(free);
      const missing = names.filter((n) => !params[n]);
      if (missing.length) throw new Error(`Companion loaded, but LUNA has not exposed these controls: ${missing.join(', ')}. Its crosstalk remains off by default.`);
      const seed = await seedFor(session, ch);
      const kind = EConsoleLogic.channelKind(ch);
      await session.transaction('Set up analog console channel', async () => {
        await params['Crosstalk Enabled'].normalized.set(0);
        await params['Channel Role'].normalized.set((kind === 'master' ? 2 : kind === 'bus' ? 1 : 0) / 2);
        await setIdentity(params['Console Seed'], seed);
        await setIdentity(params['Console Group'], hash(session.uid) % 65535 + 1);
      });
    });
    return free;
  }
  globalThis.EConsoleAnalog = { names, hash, candidates, find, controls, independently, setIdentity, seedFor, randomizeSeeds, linkCompanions, enforceRole, ensure };
})();
