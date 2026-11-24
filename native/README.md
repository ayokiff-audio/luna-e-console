# E Console Analog — macOS Audio Unit companion

E Console Analog is an original audio effect that adds subtle console-inspired harmonic color, repeatable per-strip variation, and optional real audio leakage between track instances. Use it after the separately licensed UADx SSL 4000 E Channel Strip; put a receive-only Master instance after the UADx SSL G Bus Compressor on the master to join the same console group.

This is a development build. Its DSP is original and is **not a measured SSL 4000 E circuit model**. It contains no Universal Audio/SSL code or plug-in binary, does not host or wrap UADx, and does not create a native LUNA Extension slot. The LUNA Add On controls ordinary inserts.

## Installable artifact

The built plug-in, version 0.1.1, is `build/E Console Analog.component`, a universal macOS AUv2 bundle for Apple Silicon and Intel, macOS 11 or newer. It is locally ad hoc signed. It is not notarized. No software was installed into a user or system Audio Units folder during this task.

The complete source and build script are included. Run `./build.sh` on a Mac with Apple's command line developer tools to rebuild the component and run its tests. The script signs in a temporary build directory, then copies the signed component here, avoiding Finder/File Provider attributes that can prevent signing within Documents.

Install the component into `~/Library/Audio/Plug-Ins/Components/` using the supplied installer in the parent E Console package, then restart or rescan the audio host. Look for **E Console: E Console Analog** in Audio Units. The plug-in uses the host's generic parameter editor. Component codes: type `aufx`, subtype `ECA1`, manufacturer `ECns`; bundle identifier `com.econsole.analog.au`. LUNA assigns its own format-specific catalog ID; the Add On discovers the real ID by name.

## Controls

| ID | Control | Range | Default | Behavior |
|---|---|---|---|---|
| 0 | Console Seed | Integer 1–65535 | Automatically assigned per new instance | Stable seed for the left/right nonlinearity coefficients; saved with AU state. The Add On assigns a repeatable strip seed. |
| 1 | Variation | 0–100% | 20% | Amount of seeded slope/asymmetry differences. At 0%, all seeds use the same color. |
| 2 | Crosstalk | −100 to −40 dB | −70 dB | Leakage level, relative to the average of the selected peers. |
| 3 | Crosstalk Enabled | Off / On | Off | Enables Track publishing/receiving and Bus/Master receive-only linking in the same group. |
| 4 | Console Group | Integer 1–65535 | 1 | All enabled roles in the same group and sample rate receive eligible track publishers. |
| 5 | Channel Role | 0 Track / 1 Bus / 2 Master | Track | Track publishes/receives; Bus and Master receive only and never publish downstream audio back into tracks. |
| 6 | Drive | 0–18 dB | 0 dB | Increases the original nonlinear coloration. |
| 7 | Output Trim | −12 to +12 dB | 0 dB | Output level after coloration and leakage. |

The actual seed is included in the AU class-info state, so reopening a saved session preserves its sound. Each new instance exposes its own immutable initial seed as its parameter metadata default, so host default initialization preserves the intended distinct seed. Manual edits do not change that reset default. Existing saved seed values are restored unchanged; the Add On can explicitly write new strip seeds. Variation, Drive, Output Trim, and leakage gains use approximately 10 ms smoothing. Parameters support ordinary host automation and bounded sample-offset immediate events; parameter ramps are not advertised.

The color stage uses gain-normalized asymmetric soft saturation and a 6 Hz DC blocker. Seeded slope/bias changes create measurable second- and third-harmonic differences. It has **no anti-alias oversampling**; this experimental coloration may alias at high drive or with high-frequency input. Compare at matched levels before using it in a final mix.

## Crosstalk and latency

**Every instance adds exactly 4096 samples of latency**, including when bypassed. At 48 kHz this is about 85.3 ms. The Audio Unit reports this latency so a host can compensate it. Host latency compensation was not verified in LUNA. Render blocks must be at most 2048 frames; use 512 frames for initial testing.

Enabled Track instances publish their colored input before receiving leakage. All enabled Track, Bus, and Master roles receive the two nearest enabled track seeds in their group; equal-distance ties use the registry's stable slot order. Contributions are averaged, keeping the leakage gain bounded as peers are added. An instance never reads itself. Received leakage is never republished by its own instance. Bus and Master instances never publish any input or output, which prevents their downstream audio from returning into upstream tracks through this shared network. Set the correct Bus/Master role before enabling crosstalk; the Add On does this from the channel type. Stereo channels exchange left/right samples; mono receivers use their average.

The registry supports **64 simultaneously enabled Track instances in one host process**. Disabled, Bus, and Master instances release their publisher registry slots when rendered. Bus/Master receivers can still listen when all 64 publisher slots are occupied. Additional enabled Track instances still process their own color but disable both sending and receiving until capacity becomes available. The capacity limit is not exposed as a separate host parameter.

Cross-instance audio requires the host to load instances into the same process and render them on a compatible shared sample timeline. Peers read exact timestamps 4096 samples in the past, rather than whichever block rendered most recently. Atomic timestamp/generation checks prevent torn audio and stale history. Missing samples, absent valid sample timestamps, different groups/rates, or unsupported scheduling produce no leakage. Offline bouncing or hosts that isolate instances may therefore omit crosstalk while retaining each instance's own color. Linking uses the shared sample timeline, without inspecting LUNA routing or delay-compensation state; phase alignment through multi-stage bus routes requires live host verification. A shared group number is an explicit routing boundary; assign different groups to unrelated sessions open in the same host process.

A reset/seek invalidates old leakage history; another instance's reset does not clear a track's own delayed dry audio. Own reset, seek, or reinitialization clears its local delay and filter state. A stopped sender's delayed history naturally ends after its published samples expire; a restarted timeline with a host reset cannot replay its earlier history. These behaviors are covered by numeric tests, not by a LUNA listening test.

## Verification and remaining host validation

Verified locally:

- Universal arm64/x86_64 compilation and an ad hoc code signature that passes strict verification after clean archive extraction. Documents File Provider can re-add FinderInfo metadata to the workspace copy; the install archive omits it.
- 12,394 DSP assertions: exact latency, bypass, repeatable seed/state, measured seed-dependent second harmonics and generated third harmonics, real leakage, render-order independence, group/off/self isolation, Bus/Master receive-only audio and no upstream publication, peer-reset dry continuity, stale history reset, smoothing reset, finite extreme-input behavior, concurrency, and registry capacity.
- 23,952 assertions against the built bundle's actual AUv2 factory/selector ABI: load/open/close, control names and metadata, state round trip, latency, planar/interleaved/mono rendering, buffer rules, silence handling, scheduled parameter offsets, native seed changes that alter audio, distinct immutable per-instance seed defaults under simulated host initialization, actual compiled-instance track-to-Bus/Master reception without upstream return, and reset.
- A ThreadSanitizer run of the DSP suite completed without a reported data race.
- A local 64-track workload at 48 kHz/512 frames with crosstalk on processed one second of audio in approximately 0.13 seconds of wall time. This standalone serial benchmark excludes the DAW, UADx, UI, and other session processing and is not a real-time host performance guarantee.

**Not verified:** LUNA loading/rendering, UADx interaction, host latency compensation, listening quality, cross-instance sharing in the target host, offline bounce behavior, and a complete Apple `auval` pass. This native test suite did not drive LUNA. The execution sandbox could not access Apple's component registrar: `auval -s aufx` listed no system effects and `AudioComponentRegister` returned no component. The test harness therefore loaded the built bundle and exercised its public AUv2 factory and selector signatures directly. It does not substitute for host certification.

After installation, run `auval -v aufx ECA1 ECns -strict` in a normal terminal and test in LUNA with two enabled Track instances in the same group, distinct seeds, one playing audio and one initially silent. Assign Bus and Master roles correctly, use the same Console Group across the desired session strips, and begin with Crosstalk −70 dB. Bus/Master reception is opt-in; their downstream audio is never shared back into tracks.

## Compatibility with version 0.1.0

Version 0.1.1 keeps the same AU component identity, eight parameter IDs, ranges, defaults other than the per-instance Seed metadata fix, and saved-state binary format. Existing saved parameters and seeds remain readable. Channel Role numeric values are unchanged: 0 Track, 1 Bus, 2 Master. The intentional behavior change is that enabled Bus/Master roles now receive track leakage in their console group; they remain unable to publish downstream audio. Existing Bus/Master instances whose Crosstalk Enabled setting is off remain off.
