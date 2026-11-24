/* DOM wiring; all session operations live in logic.js / companion.js. */
(() => {
  const $ = (id) => document.getElementById(id);
  let luna, session, settings = {}, selected, ssl, analog, preview = false, connecting = false;
  let generation = 0, channelGeneration = 0, actionRunning = false;
  const appBindings = new Luna.Bindings();
  const sessionBindings = new Luna.Bindings();
  const stripBindings = new Luna.Bindings();
  const scope = () => settings.scope ?? 'all';
  const safe = (fn) => (...args) => Promise.resolve().then(() => fn(...args)).catch(report);
  function syncSessionActions() {
    const disabled = actionRunning || !session || session.readOnly.value === true || luna?.status.value === 'disconnected';
    for (const id of ['randomize-seeds', 'crosstalk-all-on', 'crosstalk-all-off']) $(id).disabled = disabled;
    for (const id of ['analog-parameters', 'ssl-parameters', 'output-controls']) $(id).inert = disabled;
  }
  function notice(message, kind = '') { $('notice').textContent = message; $('notice').className = `notice ${kind}`; $('notice').hidden = !message; }
  function report(e) { notice(e?.message ?? String(e), 'error'); }
  function connection(mode, text) {
    $('connection').textContent = mode; $('connection').className = `badge ${mode.toLowerCase()}`;
    $('session-name').textContent = text; $('status-dot').classList.toggle('on', mode === 'LIVE');
    $('footer-state').textContent = mode === 'PREVIEW' ? '0.2.1 · DEMO · NO AUDIO' : 'E CONSOLE 0.2.1';
  }
  const text = (tag, content, className) => { const el = document.createElement(tag); el.textContent = content; if (className) el.className = className; return el; };
  async function remember(patch) {
    if (!session) return;
    const target = session;
    const value = await EConsoleLogic.saveSettings(target, patch);
    if (target === session) settings = { ...settings, ...value, ...patch };
  }
  function choice(el, label, value) { const opt = document.createElement('option'); opt.textContent = label; opt.value = value; el.append(opt); }
  function currentChannels() { return session ? EConsoleLogic.channels(session, scope()) : []; }
  function paintChannelPicker() {
    const channels = currentChannels();
    if (!channels.some((ch) => ch.id === selected?.id)) selected = channels.find((ch) => ch.id === settings.selectedChannelId) ?? channels[0];
    $('channel').replaceChildren();
    for (const ch of channels) choice($('channel'), ch.name.value ?? ch.id, ch.id);
    if (selected) $('channel').value = selected.id;
    else choice($('channel'), 'No eligible channels', '');
    $('channel-position').textContent = `${String(Math.max(0, channels.indexOf(selected) + 1)).padStart(2, '0')} / ${String(channels.length).padStart(2, '0')}`;
    $('channel-kind').textContent = selected ? EConsoleLogic.channelKind(selected).toUpperCase() : 'CHANNEL';
    for (const b of document.querySelectorAll('[data-scope]')) b.classList.toggle('active', b.dataset.scope === scope());
  }
  function knob(parent, control, label, tint = '') {
    const row = text('div', '', 'parameter');
    const face = text('div', '', `knob ${tint}`); face.setAttribute('aria-label', label);
    const copy = text('div', '', 'parameter-copy'); copy.append(text('span', label, 'parameter-name'));
    const display = text('span', control.display.value ?? '—', 'parameter-value'); copy.append(display); row.append(face, copy); parent.append(row);
    const paint = () => { display.textContent = control.display.value ?? '—'; face.setAttribute('aria-valuetext', display.textContent); };
    Luna.bindDrag(face, control, { bindings: stripBindings, label, onError: report, render: (v) => { face.style.setProperty('--turn', `${(v - 0.5) * 280}deg`); paint(); } });
    stripBindings.on(control.display, paint);
  }
  function parameter(parent, p, tint, disabled = false) {
    const control = p.control ?? p;
    const name = p.name?.value ?? p.name ?? control.name.value ?? control.id;
    if (control.discrete.value || ['Console Seed', 'Console Group'].includes(name)) {
      const row = text('label', '', 'toggle-param');
      const caption = text('span', '', 'parameter-copy'); caption.append(text('span', name));
      const current = text('span', control.display.value ?? '—', 'parameter-value'); caption.append(current); row.append(caption);
      stripBindings.on(control.display, () => { current.textContent = control.display.value ?? '—'; });
      const values = control.realValues.value ?? [], labels = control.displayValues.value ?? [];
      if (values.length === 2 && name === 'Crosstalk Enabled') {
        const input = document.createElement('input'); input.type = 'checkbox'; input.disabled = disabled;
        const paint = () => { input.checked = control.normalized.value >= .5; };
        input.onchange = safe(() => control.normalized.set(input.checked ? 1 : 0));
        stripBindings.on(control.normalized, paint); paint(); row.append(input);
      } else if (values.length > 0 && values.length <= 128) {
        const select = document.createElement('select'); select.disabled = disabled; select.setAttribute('aria-label', name);
        values.forEach((v, i) => choice(select, labels[i] ?? String(v), String(i)));
        const paint = () => { select.value = String(Math.round((control.normalized.value ?? 0) * (values.length - 1))); };
        select.onchange = safe(() => control.real.set(values[Number(select.value)]));
        stripBindings.on(control.normalized, paint); paint(); row.append(select);
      } else if (['Console Seed', 'Console Group'].includes(name)) {
        const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.max = '65535'; input.step = '1'; input.style.width = '90px'; input.disabled = disabled || (name === 'Console Seed' && actionRunning); input.setAttribute('aria-label', name);
        const paint = () => { if (document.activeElement !== input) input.value = String(control.real.value ?? 1); };
        input.onchange = safe(async () => { if (name === 'Console Seed' && actionRunning) { paint(); return; } const v = Number(input.value); if (!Number.isInteger(v) || v < 1 || v > 65535) { paint(); throw new Error(`${name} must be an integer from 1 to 65535.`); } await EConsoleAnalog.independently(session, () => EConsoleAnalog.setIdentity(control, v)); });
        stripBindings.on(control.real, paint); paint(); row.append(input);
      } else {
        const steps = Number(control.numSteps.value);
        if (Number.isInteger(steps) && steps >= 2 && steps <= 128) {
          const select = document.createElement('select'); select.disabled = disabled; select.setAttribute('aria-label', name);
          for (let i = 0; i < steps; i++) choice(select, labels[i] ?? `Step ${i + 1}`, String(i));
          const paint = () => { select.value = String(Math.round((control.normalized.value ?? 0) * (steps - 1))); };
          select.onchange = safe(() => control.normalized.set(Number(select.value) / (steps - 1)));
          stripBindings.on(control.normalized, paint); paint(); row.append(select);
        } else {
          const value = text('span', control.display.value ?? 'Open plugin', 'parameter-value');
          stripBindings.on(control.display, () => { value.textContent = control.display.value ?? 'Open plugin'; });
          row.append(value); row.title = 'This control does not expose its choices. Use the native plugin window.';
        }
      }
      parent.append(row);
    } else knob(parent, control, name, tint);
  }
  function section(parent, title, rows, tint) {
    if (!rows.length) return;
    const details = text('details', '', 'parameter-section'); details.open = true;
    details.append(text('summary', title.toUpperCase())); const grid = text('div', '', 'parameter-grid'); details.append(grid);
    for (const p of rows) {
      const n = String(p.name?.value ?? p.name ?? p.control?.name.value ?? '').toLowerCase();
      const color = tint ?? (/\bhmf\b|high.mid/.test(n) ? 'eq-hmf' : /\blmf\b|low.mid/.test(n) ? 'eq-lmf' : /\bhf\b|high frequency/.test(n) ? 'eq-hf' : /\blf\b|low frequency/.test(n) ? 'eq-lf' : '');
      parameter(grid, p, color);
    }
    parent.append(details);
  }
  function paintOutput(ch) {
    $('output-controls').replaceChildren();
    if (!ch) return;
    knob($('output-controls'), ch.gain, 'FADER');
    const pan = ch.main.pans[0]; if (pan) knob($('output-controls'), pan, ch.main.pans.length > 1 ? 'PAN LEFT' : 'PAN');
    if (ch.main.pans.length > 1) knob($('output-controls'), ch.main.pans[1], 'PAN RIGHT');
    const solo = ch.solo ?? ch.controls.byId('solo');
    $('solo').disabled = !solo; $('mute').disabled = false;
    const paint = () => { $('mute').classList.toggle('active', ch.mute.on); $('mute').setAttribute('aria-pressed', String(ch.mute.on)); $('solo').classList.toggle('active', !!solo?.on); $('solo').setAttribute('aria-pressed', String(!!solo?.on)); };
    stripBindings.on(ch.mute.real, paint); if (solo) stripBindings.on(solo.real, paint); paint();
    $('mute').onclick = safe(() => ch.mute.toggle()); $('solo').onclick = safe(() => solo?.toggle());
  }
  function paintSSL(ch, role) {
    const candidates = EConsoleLogic.pluginCandidates(luna, role);
    const select = $('ssl-plugin'); select.replaceChildren();
    for (const p of candidates) choice(select, EConsoleLogic.pluginLabel(p), p.id);
    if (!candidates.length) choice(select, 'No compatible UA SSL plugin found', '');
    if (candidates.some((p) => p.id === settings.pluginIds?.[role])) select.value = settings.pluginIds[role];
    if (ssl) select.value = ssl.pluginId.value;
    $('ssl-type').textContent = role === 'master' ? 'G SERIES' : 'E SERIES';
    $('ssl-title').textContent = role === 'master' ? 'Master bus compressor' : 'Channel strip';
    $('load-ssl').textContent = ssl ? 'Loaded' : role === 'master' ? 'Load comp' : 'Load strip';
    $('load-ssl').disabled = !!ssl || !candidates.length || !ch;
    select.disabled = !!ssl || !ch;
    $('selected-ssl').disabled = role === 'master' || !candidates.length || !EConsoleLogic.channels(session, 'selected').length;
    $('open-ssl').disabled = !ssl; $('ssl-in').disabled = !ssl || ssl.in.value === undefined;
    $('ssl-parameters').replaceChildren(); $('no-ssl').hidden = !!ssl;
    if (!ssl) { $('ssl-info').textContent = candidates.length ? `${candidates.length} SSL option(s) found. Loads into an empty insert.` : 'No available SSL match in LUNA’s catalog. Enable the plugin format in LUNA’s Plug-In Manager, then Refresh plugins.'; return; }
    const paintIn = () => { $('ssl-in').classList.toggle('active', ssl?.in.value === true); $('ssl-in').setAttribute('aria-pressed', String(ssl?.in.value === true)); };
    stripBindings.on(ssl.in, paintIn); paintIn();
    $('ssl-info').textContent = `${candidates.find((p) => p.id === ssl.pluginId.value)?.name.value ?? ssl.pluginName.value ?? 'SSL plugin'} · ${ssl.id.replace('effect_', 'Insert ').replace(/Insert (\d+)/, (_, n) => `Insert ${Number(n) + 1}`)}`;
    const overrides = settings.parameterOverrides?.[ssl.pluginId.value] ?? {};
    const rows = EConsoleLogic.parameters(ssl, overrides);
    for (const group of EConsoleLogic.PARAMETER_GROUPS) section($('ssl-parameters'), group.label, rows.filter((p) => p.group === group.id), group.id === 'dynamics' ? 'dynamics' : undefined);
    if (!rows.length) $('ssl-parameters').append(text('p', 'The plugin is loaded, but LUNA has not exposed its parameters. Use Open plugin to control it.', 'empty-note'));
  }
  function paintAnalog(ch) {
    $('analog-parameters').replaceChildren(); $('analog-footnote').hidden = !analog; $('open-analog').hidden = !analog;
    $('load-analog').hidden = !!analog; $('load-analog').disabled = !ch || !ssl;
    $('analog-state').textContent = analog ? 'NATIVE DSP' : 'NOT LOADED';
    if (!analog) { $('analog-info').textContent = EConsoleAnalog.candidates(luna).length ? 'Adds a separate audio effect after the SSL plugin.' : 'Install the included E Console Analog.component, restart LUNA, and rescan plugins.'; return; }
    const controls = EConsoleAnalog.controls(analog); const kind = EConsoleLogic.channelKind(ch);
    $('analog-info').textContent = kind === 'track' ? 'Peer leakage is optional. Only enabled tracks in the same group exchange audio.' : 'Receive-only crosstalk. Buses and the master hear track peers in the same group without returning audio upstream.';
    section($('analog-parameters'), 'Harmonics', ['Variation', 'Drive', 'Output Trim'].map((n) => controls[n]).filter(Boolean), 'analog');
    section($('analog-parameters'), 'Strip identity', ['Console Seed', 'Console Group'].map((n) => controls[n]).filter(Boolean), 'analog');
    section($('analog-parameters'), 'Crosstalk', ['Crosstalk Enabled', 'Crosstalk'].map((n) => controls[n]).filter(Boolean), 'analog');
    $('analog-footnote').textContent = '4096-sample latency · compensate in LUNA. Use a different Console Group for independent sessions; choose a new Console Seed for another harmonic fingerprint. Native host playback and offline bounce still need verification.';
  }
  async function renderChannel() {
    const target = selected, s = session, ticket = ++channelGeneration;
    if (!s) return;
    if (!target) { stripBindings.clear(); ssl = analog = undefined; $('ssl-parameters').replaceChildren(); $('analog-parameters').replaceChildren(); $('output-controls').replaceChildren(); $('ssl-plugin').replaceChildren(); choice($('ssl-plugin'), 'No channel in this view', ''); for (const id of ['load-ssl','load-analog','mute','solo','ssl-in','open-ssl','selected-ssl']) $(id).disabled = true; $('open-analog').hidden = true; $('analog-footnote').hidden = true; $('ssl-info').textContent = 'Choose another channel scope.'; $('analog-info').textContent = 'No channel selected.'; return; }
    await Promise.all([target.loadStrip(), target.controls.load(), target.effects.load()]);
    if (ticket !== channelGeneration || s !== session) return;
    const role = EConsoleLogic.roleForChannel(target);
    const nextSSL = EConsoleLogic.matchingEffects(target, luna, role)[0]; const nextAnalog = EConsoleAnalog.find(luna, target);
    await Promise.all([nextSSL?.controls.load(), nextAnalog?.controls.load()]);
    if (ticket !== channelGeneration || s !== session) return;
    if (stripBindings.busy) { void stripBindings.whenIdle(renderChannel).catch(report); return; }
    stripBindings.clear(); ssl = nextSSL; analog = nextAnalog;
    paintChannelPicker(); paintSSL(target, role); paintAnalog(target); paintOutput(target);
    stripBindings.add(target.effects.onChange(() => void stripBindings.whenIdle(renderChannel).catch(report)));
    for (const slot of target.effectSlots) { stripBindings.on(slot.pluginId, () => void stripBindings.whenIdle(renderChannel).catch(report)); stripBindings.on(slot.loaded, () => void stripBindings.whenIdle(renderChannel).catch(report)); }
    for (const slot of [ssl, analog].filter(Boolean)) stripBindings.add(slot.controls.onChange(() => void stripBindings.whenIdle(renderChannel).catch(report)));
  }
  async function refreshChannels() { if (!session) return; paintChannelPicker(); await stripBindings.whenIdle(renderChannel); }
  async function bindSession() {
    const ticket = ++generation; ++channelGeneration;
    sessionBindings.clear(); stripBindings.clear(); session = undefined; selected = ssl = analog = undefined; syncSessionActions();
    const s = luna.sessions.current();
    if (!s) { $('console').hidden = true; $('welcome').hidden = false; connection(preview ? 'PREVIEW' : 'LIVE', 'No session open'); return; }
    await s.ready(); if (ticket !== generation) return;
    const saved = await EConsoleLogic.loadSettings(s); if (ticket !== generation) return;
    session = s; settings = saved; $('follow').checked = !!settings.followSelection;
    syncSessionActions(); sessionBindings.on(s.readOnly, syncSessionActions);
    selected = EConsoleLogic.channels(s).find((ch) => ch.id === settings.selectedChannelId);
    $('welcome').hidden = true; $('console').hidden = false; connection(preview ? 'PREVIEW' : 'LIVE', s.name.value ?? 'Untitled session');
    sessionBindings.on(s.name, () => connection(preview ? 'PREVIEW' : 'LIVE', s.name.value ?? 'Untitled session'));
    sessionBindings.add(s.tracks.onChange(safe(refreshChannels))); sessionBindings.add(s.buses.onChange(safe(refreshChannels)));
    for (const ch of EConsoleLogic.channels(s)) sessionBindings.on(ch.name, paintChannelPicker);
    const follow = safe(async () => {
      if (!settings.followSelection) return;
      const ids = s.context.selectionTracks.value ?? []; const channels = EConsoleLogic.channels(s);
      const ch = channels.find((item) => ids.includes(item.id));
      if (!ch || ch.id === selected?.id) return;
      selected = ch; settings.scope = 'all'; paintChannelPicker(); await stripBindings.whenIdle(renderChannel);
    });
    sessionBindings.on(s.context.selectionTracks, follow);
    await refreshChannels();
    if (preview) notice('Interactive preview · simulated controls only. No audio is processed and no LUNA session is changed.'); else notice('');
  }
  async function connect(usePreview = false) {
    if (connecting || actionRunning) return; connecting = true;
    $('reconnect').disabled = $('connect-welcome').disabled = true;
    try {
      appBindings.clear(); sessionBindings.clear(); stripBindings.clear();
      if (luna) await luna.close();
      preview = usePreview; connection('CONNECTING', usePreview ? 'Preparing demo session…' : 'Connecting to LUNA…');
      luna = usePreview ? await EConsoleDemo.connect() : await Luna.connect();
      appBindings.add(Luna.bindShortcuts(luna)); await luna.sessions.ready(); await luna.plugins.load();
      appBindings.on(luna.sessions.focused, safe(bindSession)); appBindings.add(luna.sessions.items.onChange(safe(bindSession)));
      appBindings.on(luna.status, () => { if (luna.status.value === 'disconnected') { connection('OFFLINE', 'Connection lost · LUNA will reconnect'); notice('Connection lost. Wait for LUNA to reconnect before editing.'); } syncSessionActions(); });
      await bindSession();
    } catch (e) { $('console').hidden = true; $('welcome').hidden = false; connection('OFFLINE', 'Open LUNA and a session, then connect'); if (!(e instanceof Luna.NotRunning)) report(e); }
    finally { connecting = false; $('reconnect').disabled = $('connect-welcome').disabled = false; }
  }
  async function action(fn, { requiresChannel = true } = {}) {
    if (actionRunning || !session || session.readOnly.value === true || (requiresChannel && !selected) || luna?.status.value === 'disconnected') return;
    actionRunning = true;
    syncSessionActions();
    for (const input of document.querySelectorAll('[aria-label="Console Seed"]')) input.disabled = true;
    try { await fn(); await stripBindings.whenIdle(renderChannel); }
    catch (e) { report(e); }
    finally { actionRunning = false; syncSessionActions(); $('randomize-seeds').textContent = 'Randomize all seeds'; for (const input of document.querySelectorAll('[aria-label="Console Seed"]')) input.disabled = session?.readOnly.value === true; }
  }
  $('reconnect').onclick = $('connect-welcome').onclick = () => void connect(false);
  $('preview').onclick = () => void connect(true);
  $('channel').onchange = safe(async () => { const ch = currentChannels().find((c) => c.id === $('channel').value); if (!ch) return; selected = ch; await remember({ selectedChannelId: ch.id }); paintChannelPicker(); await stripBindings.whenIdle(renderChannel); });
  function stepChannel(delta) { const channels = currentChannels(); if (!channels.length) return; selected = channels[(channels.indexOf(selected) + delta + channels.length) % channels.length]; paintChannelPicker(); void remember({ selectedChannelId: selected.id }).catch(report); void stripBindings.whenIdle(renderChannel).catch(report); }
  $('previous').onclick = () => stepChannel(-1); $('next').onclick = () => stepChannel(1);
  for (const b of document.querySelectorAll('[data-scope]')) b.onclick = safe(async () => { await remember({ scope: b.dataset.scope }); paintChannelPicker(); await stripBindings.whenIdle(renderChannel); });
  $('follow').onchange = safe(() => remember({ followSelection: $('follow').checked }));
  $('refresh-plugins').onclick = safe(async () => {
    if (!luna || !session || actionRunning) return;
    $('refresh-plugins').disabled = true;
    try {
      await luna.plugins.reload();
      await stripBindings.whenIdle(renderChannel);
      const strips = EConsoleLogic.pluginCandidates(luna, 'strip').length;
      const masters = EConsoleLogic.pluginCandidates(luna, 'master').length;
      notice(`LUNA catalog refreshed: ${strips} SSL E strip option(s), ${masters} SSL G compressor option(s).`, strips + masters ? 'success' : '');
    } finally { $('refresh-plugins').disabled = false; }
  });
  $('ssl-plugin').onchange = safe(() => remember({ pluginIds: { ...settings.pluginIds, [EConsoleLogic.roleForChannel(selected)]: $('ssl-plugin').value } }));
  $('load-ssl').onclick = () => action(async () => { const ch = selected, s = session; const slot = await EConsoleLogic.ensurePlugin(luna, s, ch, EConsoleLogic.roleForChannel(ch), $('ssl-plugin').value); if (preview) await EConsoleDemo.populate(slot, EConsoleLogic.roleForChannel(ch)); notice(`Loaded SSL plugin on ${ch.name.value}.`, 'success'); });
  $('selected-ssl').onclick = () => action(async () => { const s = session; const ids = EConsoleLogic.channels(s, 'selected').filter((c) => EConsoleLogic.roleForChannel(c) === 'strip'); const pluginId = $('ssl-plugin').value; let count = 0; const errors = []; for (const ch of ids) { try { const slot = await EConsoleLogic.ensurePlugin(luna, s, ch, 'strip', pluginId); if (preview) await EConsoleDemo.populate(slot, 'strip'); ++count; } catch (e) { errors.push(`${ch.name.value}: ${e.message}`); } } notice(`${count} channel(s) ready.${errors.length ? ` ${errors.join(' · ')}` : ''}`, errors.length ? 'error' : 'success'); });
  $('ssl-in').onclick = () => action(() => ssl?.setIn(ssl.in.value !== true));
  async function openEditor(slot) { if (!slot) return; if (!(await luna.gui.available())) throw new Error('The native plugin window is available inside a running LUNA session.'); await slot.openEditor(); }
  $('open-ssl').onclick = safe(() => openEditor(ssl)); $('open-analog').onclick = safe(() => openEditor(analog));
  $('load-analog').onclick = () => action(async () => { await EConsoleAnalog.ensure(luna, session, selected, ssl, preview ? (slot) => EConsoleDemo.populate(slot, 'analog') : undefined); notice('Analog companion ready. Use Crosstalk all on to connect your loaded companions.', 'success'); });
  $('randomize-seeds').onclick = () => action(async () => {
    const target = session;
    $('randomize-seeds').textContent = 'Randomizing…';
    await stripBindings.whenIdle(() => {});
    if (target !== session) return;
    const result = await EConsoleAnalog.randomizeSeeds(luna, target);
    if (target !== session) return;
    notice(result.count ? `${result.count} ${result.count === 1 ? 'strip seed' : 'strip seeds'} randomized. Each has a different identity. Variation and crosstalk settings are unchanged.` : 'No analog companions are loaded. Add the analog companion to your channels first.', result.count ? 'success' : '');
  }, { requiresChannel: false });
  for (const [id, enabled] of [['crosstalk-all-on', true], ['crosstalk-all-off', false]]) $(id).onclick = () => action(async () => {
    const target = session, client = luna;
    await stripBindings.whenIdle(() => {});
    if (target !== session || client !== luna) return;
    const result = await EConsoleAnalog.linkCompanions(client, target, { enabled });
    if (target !== session) return;
    notice(result.count ? `Crosstalk ${enabled ? 'on' : 'off'} for all ${result.count} loaded companions.${enabled ? ` They share console group ${result.group}, including buses and the master.` : ''}` : 'No analog companions are loaded. Add the analog companion to your channels first.', result.count ? 'success' : '');
  }, { requiresChannel: false });
  window.addEventListener('beforeunload', () => { appBindings.dispose(); sessionBindings.dispose(); stripBindings.dispose(); luna?.close(); });
  void connect(new URLSearchParams(location.search).get('demo') === '1');
})();
