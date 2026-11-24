/* Full mixing window. The SDK controls LUNA; audio remains in the native plugins. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const appBindings = new Luna.Bindings(), sessionBindings = new Luna.Bindings(), bankBindings = new Luna.Bindings();
  let luna, session, preview = false, connecting = false, busy = false, scope = 'all', selectedId;
  let generation = 0, renderGeneration = 0, stripFormat = '', masterFormat = '';
  const normalize = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const make = (tag, className, content) => { const el = document.createElement(tag); if (className) el.className = className; if (content !== undefined) el.textContent = content; return el; };
  const safe = (fn) => (...args) => Promise.resolve().then(() => fn(...args)).catch(report);
  const editable = () => !!session && session.readOnly.value !== true && luna?.status.value !== 'disconnected' && !busy;
  function notice(message, kind = '') { $('notice').textContent = message; $('notice').className = `notice ${kind}`; $('notice').hidden = !message; }
  function report(error) { notice(error?.message ?? String(error), 'error'); }
  function status(mode, name) {
    $('connection').textContent = mode; $('connection').className = `connection ${mode.toLowerCase()}`;
    $('session-name').textContent = name;
    $('version').textContent = preview ? '0.2.1 · PREVIEW · NO AUDIO' : 'E CONSOLE 0.2.1 · FULL MIXER';
  }
  function syncActions() {
    for (const id of ['randomize-seeds', 'link-companions', 'unlink-companions', 'console-group']) $(id).disabled = !editable();
    $('mixer').inert = busy || !session || session.readOnly.value === true || luna?.status.value === 'disconnected';
    $('read-only').hidden = session?.readOnly.value !== true;
  }
  function selectChannel(ch) {
    selectedId = ch.id;
    document.querySelectorAll('.strip').forEach((el) => el.classList.toggle('selected', el.dataset.channelId === ch.id));
    $('selected-channel').textContent = `${EConsoleLogic.channelKind(ch).toUpperCase()} · ${ch.name.value ?? ch.id}`;
  }
  function option(select, name, value) { const opt = make('option', '', name); opt.value = value; select.append(opt); }
  function paintFormats() {
    for (const [role, id] of [['strip', 'strip-format'], ['master', 'master-format']]) {
      const candidates = EConsoleLogic.pluginCandidates(luna, role), select = $(id);
      const prior = role === 'strip' ? stripFormat : masterFormat;
      select.replaceChildren();
      candidates.forEach((p) => option(select, EConsoleLogic.pluginLabel(p), p.id));
      if (!candidates.length) option(select, 'No available SSL plugin', '');
      const chosen = candidates.find((p) => p.id === prior) ?? candidates.find((p) => EConsoleLogic.pluginFormat(p) === 'LUNA native') ?? candidates[0];
      select.value = chosen?.id ?? '';
      if (role === 'strip') stripFormat = select.value; else masterFormat = select.value;
    }
  }
  async function action(fn) {
    if (busy || !session || session.readOnly.value === true || luna?.status.value === 'disconnected') return;
    const target = session, client = luna;
    busy = true;
    for (const id of ['randomize-seeds', 'link-companions', 'unlink-companions', 'connect', 'preview']) $(id).disabled = true;
    try {
      await bankBindings.whenIdle(() => {});
      if (target !== session || client !== luna) return;
      syncActions();
      await fn(target, client);
      if (target === session) await bankBindings.whenIdle(renderBank);
    } catch (error) { report(error); }
    finally {
      busy = false; $('connect').disabled = $('preview').disabled = false; syncActions();
    }
  }
  function display(control, el) {
    const paint = () => {
      const host = control?.display.value;
      if (host !== undefined && host !== null && String(host).trim()) { el.textContent = host; return; }
      const name = control?.name.value;
      if (EConsoleAnalog.names.includes(name) && Number.isFinite(control.real.value)) {
        const units = name === 'Variation' ? '%' : ['Drive', 'Output Trim', 'Crosstalk'].includes(name) ? ' dB' : '';
        el.textContent = `${Number(control.real.value.toFixed(2))}${units}`;
      } else el.textContent = '—';
    };
    if (control) { bankBindings.on(control.display, paint); bankBindings.on(control.real, paint); }
    paint();
  }
  function knob(parent, control, label, tint = '') {
    if (control?.discrete.value === true) return enumControl(parent, control, label, true);
    const wrap = make('div', `knob-control ${tint}${control ? '' : ' unavailable'}`);
    const caption = make('span', 'knob-name', label), scale = make('div', 'knob-scale'), face = make('div', 'knob-face');
    const value = make('span', 'knob-value'); scale.append(face); wrap.append(caption, scale, value); parent.append(wrap);
    if (!control) { value.textContent = '—'; wrap.title = `${label} is not exposed by the loaded plugin`; return; }
    wrap.title = control.name.value ?? label;
    display(control, value);
    if (session.readOnly.value !== true) Luna.bindDrag(face, control, { bindings: bankBindings, label: `${control.name.value ?? label}`, pixelsPerUnit: 180, onError: report,
      render: (n) => face.style.setProperty('--turn', `${(n - .5) * 280}deg`) });
    else { face.setAttribute('aria-disabled', 'true'); face.style.setProperty('--turn', `${((control.normalized.value ?? .5) - .5) * 280}deg`); }
  }
  function enumControl(parent, control, label, compact = false) {
    const wrap = make('label', compact ? 'compact-select' : 'select-control'); wrap.append(make('span', '', label));
    const select = make('select'); select.setAttribute('aria-label', control?.name.value ?? label);
    const values = control?.realValues.value ?? [], labels = control?.displayValues.value ?? [];
    const steps = values.length || Number(control?.numSteps.value ?? 0);
    if (Number.isInteger(steps) && steps >= 2 && steps <= 128) {
      for (let i = 0; i < steps; i++) option(select, labels[i] ?? `Step ${i + 1}`, String(i));
      const paint = () => { select.value = String(Math.max(0, Math.min(steps - 1, Math.round((control.normalized.value ?? 0) * (steps - 1))))); select.title = control.display.value ?? ''; };
      bankBindings.on(control.normalized, paint); bankBindings.on(control.display, paint); paint();
      select.onchange = safe(async () => { if (!editable()) { paint(); return; } const i = Number(select.value); if (values.length) await control.real.set(values[i]); else await control.normalized.set(i / (steps - 1)); });
    } else { option(select, control?.display.value ?? '—', ''); select.disabled = true; }
    if (session.readOnly.value === true) select.disabled = true;
    wrap.append(select);
    if (control) { const current = make('span', 'enum-value'); display(control, current); wrap.append(current); }
    parent.append(wrap); return wrap;
  }
  function toggle(parent, control, label) {
    const button = make('button', 'switch', label); button.type = 'button'; button.title = control?.name.value ?? `${label} is not exposed`; parent.append(button);
    if (!control) { button.disabled = true; return button; }
    const paint = () => {
      const on = (control.normalized.value ?? 0) >= .5;
      button.classList.toggle('active', on); button.setAttribute('aria-pressed', String(on));
      button.title = `${control.name.value ?? label}: ${control.display.value ?? ''}`;
    };
    bankBindings.on(control.normalized, paint); bankBindings.on(control.display, paint); paint();
    button.disabled = session.readOnly.value === true;
    button.onclick = safe(async () => { if (editable()) await control.normalized.set((control.normalized.value ?? 0) >= .5 ? 0 : 1); });
    return button;
  }
  function numberField(parent, control, label) {
    const wrap = make('label', '', label), input = make('input'); input.type = 'number'; input.min = '1'; input.max = '65535'; input.step = '1';
    input.setAttribute('aria-label', control?.name.value ?? label); input.disabled = !control || session.readOnly.value === true;
    const paint = () => { if (document.activeElement !== input) input.value = control ? String(control.real.value ?? '') : ''; };
    if (control) bankBindings.on(control.real, paint); paint();
    input.onchange = safe(async () => {
      if (!editable()) { input.value = String(control?.real.value ?? ''); return; }
      const n = Number(input.value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) { input.value = String(control.real.value); throw new Error(`${label} must be an integer from 1 to 65535.`); }
      await EConsoleAnalog.independently(session, () => EConsoleAnalog.setIdentity(control, n));
    });
    wrap.append(input); parent.append(wrap);
  }
  function section(strip, label, className, note = '') {
    const el = make('section', `strip-section ${className}`), heading = make('h3', 'section-label', label);
    if (note) heading.append(make('span', '', note)); el.append(heading); strip.append(el); return el;
  }
  function row(parent) { const el = make('div', 'knob-row'); parent.append(el); return el; }
  function switches(parent) { const el = make('div', 'switches'); parent.append(el); return el; }
  function lookup(slot) {
    const params = slot?.params ?? [], map = slot ? EConsoleLogic.parameterMap(slot) : {};
    return (...keys) => {
      for (const key of keys) {
        const exact = params.find((p) => p.id === key); if (exact) return exact;
        if (map[key]) return map[key];
        const matches = params.filter((p) => normalize(p.name.value) === normalize(key));
        if (matches.length === 1) return matches[0];
      }
      return undefined;
    };
  }
  async function openEditor(slot) {
    if (!slot) return;
    if (!(await luna.gui.available())) throw new Error('Native plugin windows open from a running LUNA session. Preview controls remain interactive here.');
    await slot.openEditor();
  }
  async function setupChannel(s, client, ch) {
    const role = EConsoleLogic.roleForChannel(ch), pluginId = role === 'master' ? masterFormat : stripFormat;
    const ssl = await EConsoleLogic.ensurePlugin(client, s, ch, role, pluginId || undefined);
    if (preview) await EConsoleDemo.populate(ssl, role);
    try {
      await EConsoleAnalog.ensure(client, s, ch, ssl, preview ? (slot) => EConsoleDemo.populate(slot, 'analog') : undefined);
      notice(`${ch.name.value ?? ch.id} is ready: SSL and analog companion.`, 'success');
    } catch (error) { notice(`SSL is ready on ${ch.name.value ?? ch.id}. ${error.message}`, 'error'); }
  }
  function header(strip, ch, ssl, analog, index, master = false) {
    strip.dataset.channelId = ch.id; strip.classList.toggle('selected', selectedId === ch.id);
    const head = make('header', 'strip-head'), name = make('button', 'channel-name', master ? 'MASTER' : ch.name.value ?? ch.id);
    name.title = 'Select channel'; name.onclick = () => selectChannel(ch); head.append(name);
    const kind = make('div', 'channel-kind'), seed = make('span', 'header-seed');
    kind.append(make('span', '', master ? 'STEREO MIX BUS' : `${String(index + 1).padStart(2, '0')} / ${EConsoleLogic.channelKind(ch).toUpperCase()}`), seed); head.append(kind);
    const seedControl = analog && EConsoleAnalog.controls(analog)['Console Seed'];
    const paintSeed = () => { const value = Number(seedControl?.real.value); seed.textContent = seedControl && Number.isFinite(value) ? `SEED ${Math.round(value)}` : 'SEED —'; };
    if (seedControl) bankBindings.on(seedControl.real, paintSeed); paintSeed();
    const tools = make('div', 'strip-tools'), setup = make('button', '', !ssl ? 'SETUP' : analog ? 'ANALOG' : '+ ANALOG'), editor = make('button', '', 'EDITOR'), power = make('button', 'power', 'IN');
    setup.title = ssl && analog ? 'Open analog companion editor' : 'Add SSL and analog companion using empty inserts';
    setup.onclick = ssl && analog ? safe(() => openEditor(analog)) : () => action((s, client) => setupChannel(s, client, ch));
    editor.disabled = !ssl; editor.onclick = safe(() => openEditor(ssl)); power.disabled = !ssl || ssl.in.value === undefined;
    if (ssl) {
      const paint = () => { power.classList.toggle('active', ssl.in.value === true); power.setAttribute('aria-pressed', String(ssl.in.value === true)); };
      bankBindings.on(ssl.in, paint); paint(); power.onclick = safe(() => { if (editable()) return ssl.setIn(ssl.in.value !== true); });
    }
    tools.append(setup, editor, power); head.append(tools); strip.append(head);
    bankBindings.on(ch.name, () => { if (!master) name.textContent = ch.name.value ?? ch.id; if (selectedId === ch.id) selectChannel(ch); });
  }
  function channelModules(strip, ssl) {
    const get = lookup(ssl), input = section(strip, 'INPUT', 'input-section', 'E SERIES');
    const inputRow = row(input);
    knob(inputRow, get('line_gain', 'lineGain', 'inputGain'), 'LINE'); knob(inputRow, get('mic_gain', 'micGain'), 'MIC');
    const inputSwitches = switches(input);
    enumControl(inputSwitches, get('input_select', 'Input Select'), 'SOURCE');
    toggle(inputSwitches, get('pad'), 'PAD'); toggle(inputSwitches, get('phase'), 'Ø'); toggle(inputSwitches, get('transformer'), 'XFR');
    const filters = section(strip, 'FILTERS', 'filters-section'); const filterRow = row(filters);
    knob(filterRow, get('hp_freq', 'hpf'), 'HIGH PASS'); knob(filterRow, get('lp_freq', 'lpf'), 'LOW PASS');
    const filterSwitches = switches(filters); toggle(filterSwitches, get('filt_dyn_sc', 'Filt Dyn SC'), 'DYN S/C'); toggle(filterSwitches, get('filt_pre_dyn', 'Filt Pre Dyn'), 'PRE DYN');
    const eq = section(strip, 'EQUALISER', 'eq-section', 'FOUR BAND');
    for (const [id, title, color, keys] of [
      ['hf', 'HF', 'hf', ['hf_gain', 'hfGain', 'hf_freq', 'hfFrequency']],
      ['hmf', 'HMF', 'hmf', ['hmf_gain', 'hmfGain', 'hmf_freq', 'hmfFrequency']],
      ['lmf', 'LMF', 'lmf', ['lmf_gain', 'lmfGain', 'lmf_freq', 'lmfFrequency']],
      ['lf', 'LF', 'lf', ['lf_gain', 'lfGain', 'lf_freq', 'lfFrequency']],
    ]) {
      const band = make('div', `eq-band ${color}`); band.append(make('span', 'band-label', title)); eq.append(band);
      knob(band, get(keys[0], keys[1]), 'GAIN', color); knob(band, get(keys[2], keys[3]), 'FREQ', color);
      if (id === 'hmf' || id === 'lmf') knob(band, get(`${id}_q`, `${id}Q`), 'Q', color);
      else enumControl(band, get(`${id}_bell`, `${title} Bell`), 'SHAPE', true);
    }
    const eqSwitches = switches(eq); toggle(eqSwitches, get('eq_in', 'EQ In'), 'EQ IN'); toggle(eqSwitches, get('eq_dyn_sc', 'EQ Dyn SC'), 'S/C'); toggle(eqSwitches, get('eq_pre_dyn', 'EQ Pre Dyn'), 'PRE'); toggle(eqSwitches, get('eq_type', 'EQ Type'), 'BRN');
    const dyn = section(strip, 'DYNAMICS', 'dynamics-section');
    dyn.append(make('div', 'sub-label', 'COMPRESSOR'));
    let line = row(dyn); knob(line, get('comp_ratio', 'ratio'), 'RATIO', 'dynamics'); knob(line, get('comp_thresh', 'threshold'), 'THRESH', 'dynamics'); knob(line, get('comp_release', 'release'), 'RELEASE', 'dynamics'); knob(line, get('comp_attack', 'attack'), 'ATTACK', 'dynamics');
    let buttons = switches(dyn); toggle(buttons, get('comp_in', 'COMP In'), 'COMP IN'); toggle(buttons, get('stereo_link', 'Stereo Link'), 'LINK');
    dyn.append(make('div', 'sub-label', 'EXPANDER / GATE'));
    line = row(dyn); knob(line, get('exp_range', 'EXP Range'), 'RANGE', 'dynamics'); knob(line, get('exp_thresh', 'EXP Thresh'), 'THRESH', 'dynamics'); knob(line, get('exp_release', 'EXP Release'), 'RELEASE', 'dynamics'); knob(line, get('exp_attack', 'EXP Attack'), 'ATTACK', 'dynamics');
    buttons = switches(dyn); enumControl(buttons, get('exp_select', 'EXP Select'), 'MODE'); toggle(buttons, get('exp_in', 'EXP In'), 'IN'); toggle(buttons, get('dyn_in', 'DYN In'), 'DYN');
  }
  function analogModule(strip, ch, analog) {
    const sectionEl = section(strip, 'ANALOG CHARACTER', 'analog-section', analog ? 'NATIVE DSP' : 'NOT LOADED');
    if (!analog) { const empty = make('div', 'module-empty'); empty.append(make('p', '', 'Individual harmonics and console interaction. Add with Setup.')); sectionEl.append(empty); return; }
    const p = EConsoleAnalog.controls(analog), identity = make('div', 'seed-row');
    numberField(identity, p['Console Seed'], 'SEED'); numberField(identity, p['Console Group'], 'GROUP'); sectionEl.append(identity);
    const pots = row(sectionEl); knob(pots, p.Variation, 'VARIATION', 'analog'); knob(pots, p.Drive, 'DRIVE', 'analog'); knob(pots, p['Output Trim'], 'TRIM', 'analog');
    const bottom = switches(sectionEl); toggle(bottom, p['Crosstalk Enabled'], 'CROSSTALK');
    const leakage = p.Crosstalk;
    if (leakage) { const wrap = make('div', 'leakage-control'), input = make('input'); input.type = 'range'; input.min = '0'; input.max = '1000'; input.setAttribute('aria-label', 'Crosstalk level');
      const value = make('span', 'knob-value'); display(leakage, value); wrap.append(input, value); bottom.append(wrap);
      if (session.readOnly.value !== true) Luna.bindRange(input, leakage, { bindings: bankBindings, onError: report }); else input.disabled = true;
    }
    const kind = EConsoleLogic.channelKind(ch); sectionEl.append(make('div', 'analog-role', kind === 'track' ? 'TRACK · PUBLISH + RECEIVE' : `${kind.toUpperCase()} · RECEIVE ONLY`));
  }
  function outputModule(strip, ch, ssl) {
    const out = make('section', 'output-section'), head = make('div', 'output-head', 'CHANNEL OUTPUT'), buttons = make('div', 'output-buttons');
    const mute = make('button', 'mute', 'M'), solo = make('button', 'solo', 'S'); buttons.append(mute, solo); head.append(buttons); out.append(head);
    const soloControl = ch.solo ?? ch.controls.byId('solo');
    const paint = () => { mute.classList.toggle('active', ch.mute.on); mute.setAttribute('aria-pressed', String(ch.mute.on)); solo.classList.toggle('active', !!soloControl?.on); solo.setAttribute('aria-pressed', String(!!soloControl?.on)); };
    bankBindings.on(ch.mute.real, paint); if (soloControl) bankBindings.on(soloControl.real, paint); paint(); solo.disabled = !soloControl;
    mute.title = 'Mute'; solo.title = 'Solo'; mute.onclick = safe(() => { if (editable()) return ch.mute.toggle(); }); solo.onclick = safe(() => { if (editable()) return soloControl?.toggle(); });
    const pans = make('div', 'pan-row'); ch.main.pans.forEach((control, i) => knob(pans, control, ch.main.pans.length > 1 ? `PAN ${i ? 'R' : 'L'}` : 'PAN')); out.append(pans);
    const lane = make('div', 'fader-row'), fader = make('div', 'fader'), track = make('div', 'fader-track'), thumb = make('div', 'fader-thumb');
    fader.append(track, thumb); const taper = ch.gain.taper.value;
    if (taper) for (const db of taper.marks({ compact: true })) { const mark = make('span', 'fader-mark', db <= -100 ? '∞' : String(db)); const n = taper.toNormalized(db); mark.style.top = `calc(${(1 - n) * 100}% + ${(n * 2 - 1) * 17}px)`; fader.append(mark); }
    if (session.readOnly.value !== true) Luna.bindDrag(fader, ch.gain, { bindings: bankBindings, label: `${ch.name.value ?? ch.id} fader`, pixelsPerUnit: 190, onError: report,
      render: (n) => fader.style.setProperty('--fader-position', String(1 - n)) });
    else fader.style.setProperty('--fader-position', String(1 - (ch.gain.normalized.value ?? 0)));
    const pair = make('div', 'meter-pair'), fills = [];
    for (let i = 0; i < 2; i++) { const meter = make('div', 'meter-lane'), fill = make('div', 'meter-fill'); meter.append(fill); pair.append(meter); fills.push(fill); }
    pair.setAttribute('aria-label', preview ? 'Preview: no audio meter signal' : 'Live LUNA output level');
    const meterPaint = () => { const values = ch.meter.level.value ?? []; fills.forEach((fill, i) => { const v = preview ? 0 : Number(values[i] ?? values[0] ?? 0); fill.style.transform = `scaleY(${Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))})`; }); };
    bankBindings.add(ch.meter.onChange(meterPaint)); meterPaint();
    lane.append(fader, pair); out.append(lane);
    const faderValue = make('span', 'fader-display'); display(ch.gain, faderValue); out.append(faderValue);
    const extra = switches(out), get = lookup(ssl);
    for (const [id, label] of [['hold', 'HOLD']]) { const p = get(id); if (p) toggle(extra, p, label); }
    const level = get('level'); if (level) { const label = make('label', 'select-control'); label.append(make('span', '', 'SSL LEVEL')); const input = make('input'); input.type = 'range'; input.min = '0'; input.max = '1000'; input.setAttribute('aria-label', 'SSL Level'); const value = make('span', 'knob-value'); display(level, value); label.append(input, value); extra.append(label); Luna.bindRange(input, level, { bindings: bankBindings, onError: report }); }
    const output = get('output', 'outputGain'); if (output) { const label = make('label', 'select-control'); label.append(make('span', '', 'SSL OUT')); const input = make('input'); input.type = 'range'; input.min = '0'; input.max = '1000'; input.setAttribute('aria-label', 'SSL Output'); const value = make('span', 'knob-value'); display(output, value); label.append(input, value); extra.append(label); Luna.bindRange(input, output, { bindings: bankBindings, onError: report }); }
    const scribble = make('div', 'scribble', ch.name.value ?? ch.id); out.append(scribble); bankBindings.on(ch.name, () => { scribble.textContent = ch.name.value ?? ch.id; }); strip.append(out);
  }
  function masterModule(strip, ssl) {
    const module = make('section', 'master-module'), title = make('div', 'master-title'); title.append(make('h2', '', 'Bus Compressor'), make('p', '', 'G SERIES / STEREO MASTER')); module.append(title); strip.append(module);
    const get = lookup(ssl);
    let line = row(module); knob(line, get('thresh', 'threshold'), 'THRESHOLD'); knob(line, get('make_up', 'makeup'), 'MAKE UP');
    line = row(module); enumControl(line, get('ratio'), 'RATIO', true); enumControl(line, get('attack'), 'ATTACK', true);
    line = row(module); enumControl(line, get('release'), 'RELEASE', true); knob(line, get('sc_filter', 'SC Filter'), 'S/C FILTER');
    line = row(module); knob(line, get('mix'), 'MIX'); enumControl(line, get('headroom'), 'HEADROOM', true);
    line = row(module); knob(line, get('fade_rate', 'Fade Rate'), 'FADE RATE'); const fades = switches(line); toggle(fades, get('fade'), 'FADE');
    const signature = make('div', 'master-signature'); signature.append(make('strong', '', 'E'), make('span', '', 'CONSOLE MIX BUS'), make('br'), make('span', '', 'LUNA CONTROLS · NATIVE AUDIO')); module.append(signature);
  }
  function watchStructure(ch) {
    const rebuild = () => { void bankBindings.whenIdle(renderBank).catch(report); };
    bankBindings.add(ch.effects.onChange(rebuild));
    for (const slot of ch.effectSlots) { bankBindings.on(slot.pluginId, rebuild); bankBindings.on(slot.loaded, rebuild); }
  }
  async function renderBank() {
    const s = session, client = luna, ticket = ++renderGeneration;
    if (!s || !client) return;
    const all = EConsoleLogic.channels(s);
    await Promise.all(all.map((ch) => Promise.all([ch.loadStrip(), ch.controls.load(), ch.effects.load()])));
    if (s !== session || client !== luna || ticket !== renderGeneration) return;
    const catalog = all.map((ch) => ({ ch, ssl: EConsoleLogic.matchingEffects(ch, client)[0], analog: EConsoleAnalog.find(client, ch) }));
    await Promise.all(catalog.flatMap(({ ssl, analog }) => [ssl?.controls.load(), analog?.controls.load()]));
    if (s !== session || client !== luna || ticket !== renderGeneration) return;
    if (bankBindings.busy) { void bankBindings.whenIdle(renderBank).catch(report); return; }
    bankBindings.clear(); paintFormats();
    const query = $('search').value.trim().toLowerCase(), visible = new Set(EConsoleLogic.channels(s, scope).map((ch) => ch.id));
    const bank = document.createDocumentFragment(); let count = 0;
    for (const entry of catalog) {
      if (EConsoleLogic.channelKind(entry.ch) === 'master') continue;
      watchStructure(entry.ch);
      if (!visible.has(entry.ch.id) || (query && !(entry.ch.name.value ?? entry.ch.id).toLowerCase().includes(query))) continue;
      const strip = make('article', 'strip'); header(strip, entry.ch, entry.ssl, entry.analog, count++); channelModules(strip, entry.ssl); analogModule(strip, entry.ch, entry.analog); outputModule(strip, entry.ch, entry.ssl); bank.append(strip);
      for (const slot of [entry.ssl, entry.analog].filter(Boolean)) bankBindings.add(slot.controls.onChange(() => void bankBindings.whenIdle(renderBank).catch(report)));
    }
    if (!count) { const empty = make('div', 'bank-empty'); empty.append(make('h2', '', 'No channels in this view'), make('p', '', 'Choose another scope or clear the channel search. The master stays within reach.')); bank.append(empty); }
    $('channels').replaceChildren(bank); $('master').replaceChildren();
    const master = catalog.find(({ ch }) => EConsoleLogic.channelKind(ch) === 'master');
    if (master) { const strip = make('article', 'strip master-strip'); header(strip, master.ch, master.ssl, master.analog, 0, true); masterModule(strip, master.ssl); analogModule(strip, master.ch, master.analog); outputModule(strip, master.ch, master.ssl); $('master').append(strip); watchStructure(master.ch); for (const slot of [master.ssl, master.analog].filter(Boolean)) bankBindings.add(slot.controls.onChange(() => void bankBindings.whenIdle(renderBank).catch(report))); }
    $('channel-count').textContent = `${count} ${count === 1 ? 'CHANNEL' : 'CHANNELS'}`;
    $('welcome').hidden = true; $('mixer').hidden = false;
    if (!selectedId || !all.some((ch) => ch.id === selectedId)) selectedId = all.find((ch) => EConsoleLogic.channelKind(ch) !== 'master')?.id ?? master?.ch.id;
    const selected = all.find((ch) => ch.id === selectedId); if (selected) selectChannel(selected);
    syncActions();
  }
  async function bindSession() {
    const client = luna, ticket = ++generation; ++renderGeneration;
    sessionBindings.clear(); bankBindings.clear(); session = undefined; selectedId = undefined; syncActions();
    const s = client.sessions.current();
    if (!s) { $('mixer').hidden = true; $('welcome').hidden = false; status(preview ? 'PREVIEW' : 'LIVE', 'No session open · Open a session in LUNA'); return; }
    await s.ready(); if (ticket !== generation || client !== luna) return;
    session = s; $('console-group').value = String(EConsoleAnalog.hash(s.uid) % 65535 + 1);
    status(preview ? 'PREVIEW' : 'LIVE', s.name.value ?? 'Untitled session');
    sessionBindings.on(s.name, () => status(preview ? 'PREVIEW' : 'LIVE', s.name.value ?? 'Untitled session'));
    sessionBindings.on(s.readOnly, syncActions);
    for (const collection of [s.tracks, s.buses]) sessionBindings.add(collection.onChange(() => void bankBindings.whenIdle(renderBank).catch(report)));
    sessionBindings.on(s.context.selectionTracks, () => { if (scope === 'selected') void bankBindings.whenIdle(renderBank).catch(report); });
    await bankBindings.whenIdle(renderBank);
    if (preview) notice('Interactive preview · simulated controls only. No audio and no changes to your LUNA session.'); else notice('');
  }
  async function preparePreview(client) {
    const s = await client.session();
    for (const ch of EConsoleLogic.channels(s)) {
      const role = EConsoleLogic.roleForChannel(ch), ssl = await EConsoleLogic.ensurePlugin(client, s, ch, role, EConsoleDemo.IDS[role]);
      await EConsoleDemo.populate(ssl, role);
      await EConsoleAnalog.ensure(client, s, ch, ssl, (slot) => EConsoleDemo.populate(slot, 'analog'));
    }
  }
  async function connect(usePreview) {
    if (connecting || busy) return;
    connecting = true; ++generation; ++renderGeneration;
    $('connect').disabled = $('preview').disabled = true;
    try {
      appBindings.clear(); sessionBindings.clear(); bankBindings.clear(); session = undefined; syncActions();
      if (luna) await luna.close();
      preview = usePreview; status('CONNECTING', usePreview ? 'Preparing the preview console…' : 'Connecting to LUNA…');
      luna = usePreview ? await EConsoleDemo.connect() : await Luna.connect();
      await luna.sessions.ready(); await luna.plugins.load(); if (preview) await preparePreview(luna);
      appBindings.add(Luna.bindShortcuts(luna)); appBindings.on(luna.sessions.focused, safe(bindSession)); appBindings.add(luna.sessions.items.onChange(safe(bindSession)));
      appBindings.on(luna.status, () => { if (luna.status.value === 'disconnected') { status('OFFLINE', 'Connection lost · waiting for LUNA'); syncActions(); } else if (session) { status(preview ? 'PREVIEW' : 'LIVE', session.name.value ?? 'Untitled session'); syncActions(); } });
      await bindSession();
    } catch (error) { status('OFFLINE', 'Open LUNA and a session, then connect'); $('mixer').hidden = true; $('welcome').hidden = false; if (!(error instanceof Luna.NotRunning)) report(error); }
    finally { connecting = false; $('connect').disabled = $('preview').disabled = false; syncActions(); }
  }
  $('connect').onclick = $('welcome-connect').onclick = () => void connect(false);
  $('preview').onclick = $('welcome-preview').onclick = () => void connect(true);
  $('help').onclick = () => { $('help-panel').hidden = !$('help-panel').hidden; $('help').setAttribute('aria-expanded', String(!$('help-panel').hidden)); };
  $('mix-view').onclick = () => { const enabled = document.body.classList.toggle('mix-view'); $('mix-view').setAttribute('aria-pressed', String(enabled)); $('mix-view').textContent = enabled ? 'Full SSL view' : 'Mix view'; };
  for (const button of document.querySelectorAll('[data-scope]')) button.onclick = () => { scope = button.dataset.scope; document.querySelectorAll('[data-scope]').forEach((b) => b.classList.toggle('active', b === button)); void bankBindings.whenIdle(renderBank).catch(report); };
  $('search').oninput = () => void bankBindings.whenIdle(renderBank).catch(report);
  $('strip-format').onchange = () => { stripFormat = $('strip-format').value; };
  $('master-format').onchange = () => { masterFormat = $('master-format').value; };
  $('refresh').onclick = safe(async () => { if (!luna || busy) return; await luna.plugins.reload(); await bankBindings.whenIdle(renderBank); notice('Plugin catalog refreshed.', 'success'); });
  $('randomize-seeds').onclick = () => action(async (s, client) => { const result = await EConsoleAnalog.randomizeSeeds(client, s); notice(result.count ? `${result.count} companion ${result.count === 1 ? 'seed' : 'seeds'} randomized. Each identity is different.` : 'No analog companions loaded. Use Setup on a channel first.', result.count ? 'success' : ''); });
  $('link-companions').onclick = () => action(async (s, client) => {
    const group = Number($('console-group').value);
    if (!Number.isInteger(group) || group < 1 || group > 65535) throw new Error('Shared console group must be an integer from 1 to 65535.');
    const result = await EConsoleAnalog.linkCompanions(client, s, { group, enabled: true });
    notice(result.count ? `Crosstalk on for all ${result.count} loaded companions in group ${result.group}, including buses and the master.` : 'No analog companions loaded. Use Setup on a channel first.', result.count ? 'success' : '');
  });
  $('unlink-companions').onclick = () => action(async (s, client) => {
    const result = await EConsoleAnalog.linkCompanions(client, s, { enabled: false });
    notice(result.count ? `Crosstalk off for all ${result.count} loaded companions.` : 'No analog companions loaded. Use Setup on a channel first.', result.count ? 'success' : '');
  });
  window.addEventListener('beforeunload', () => { appBindings.dispose(); sessionBindings.dispose(); bankBindings.dispose(); luna?.close(); });
  void connect(new URLSearchParams(location.search).get('demo') === '1');
})();
