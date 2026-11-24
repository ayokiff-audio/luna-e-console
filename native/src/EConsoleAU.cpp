#include <AudioToolbox/AudioToolbox.h>
#include <CoreFoundation/CoreFoundation.h>
#include <array>
#include <atomic>
#include <cmath>
#include <cstring>
#include <new>
#include <vector>
#include "ConsoleDSP.hpp"

using namespace econsole;
namespace {
constexpr OSType kSubtype = 'ECA1', kManufacturer = 'ECns';
constexpr unsigned kNotifySlots = 16;
struct Notify {
    std::atomic<uint64_t> version{0};
    std::atomic<AURenderCallback> callback{nullptr};
    std::atomic<void*> context{nullptr};
};
struct PropertyListener { AudioUnitPropertyID id; AudioUnitPropertyListenerProc proc; void* context; };
AudioStreamBasicDescription format(double rate = 48000, unsigned channels = 2) {
    AudioStreamBasicDescription f{};
    f.mSampleRate = rate; f.mFormatID = kAudioFormatLinearPCM;
    f.mFormatFlags = kAudioFormatFlagsNativeFloatPacked | kAudioFormatFlagIsNonInterleaved;
    f.mBytesPerPacket = f.mBytesPerFrame = 4; f.mFramesPerPacket = 1; f.mChannelsPerFrame = channels; f.mBitsPerChannel = 32;
    return f;
}
bool validFormat(const AudioStreamBasicDescription& f) {
    const bool planar = f.mFormatFlags & kAudioFormatFlagIsNonInterleaved;
    return f.mFormatID == kAudioFormatLinearPCM && (f.mFormatFlags & kAudioFormatFlagIsFloat) &&
        !(f.mFormatFlags & kAudioFormatFlagIsBigEndian) && (f.mFormatFlags & kAudioFormatFlagIsPacked) &&
        f.mSampleRate >= 8000 && f.mSampleRate <= 384000 && f.mBitsPerChannel == 32 &&
        f.mFramesPerPacket == 1 && f.mChannelsPerFrame >= 1 && f.mChannelsPerFrame <= 2 &&
        f.mBytesPerFrame == 4 * (planar ? 1 : f.mChannelsPerFrame) && f.mBytesPerPacket == f.mBytesPerFrame;
}
struct BufferList2 { UInt32 count; AudioBuffer buffers[2]; };
static_assert(offsetof(BufferList2, buffers) == offsetof(AudioBufferList, mBuffers));

struct Scheduled {
    UInt32 id = 0, offset = 0; float value = 0; uint64_t era = 0, order = 0;
};
// Bounded MPSC queue. No allocation or waiting in the render thread or parameter calls.
class ParameterQueue {
    static constexpr uint64_t capacity = 128;
    struct Cell { std::atomic<uint64_t> sequence{0}; Scheduled event{}; };
    std::array<Cell, capacity> cells_{};
    std::atomic<uint64_t> write_{0};
    uint64_t read_ = 0;
public:
    ParameterQueue() { for (uint64_t i = 0; i < capacity; ++i) cells_[i].sequence.store(i); }
    bool push(Scheduled event) noexcept {
        uint64_t pos = write_.load(std::memory_order_relaxed);
        for (unsigned attempts = 0; attempts < 128; ++attempts) {
            auto& cell = cells_[pos % capacity];
            const auto seq = cell.sequence.load(std::memory_order_acquire);
            const auto diff = int64_t(seq) - int64_t(pos);
            if (diff == 0) {
                if (write_.compare_exchange_weak(pos, pos + 1, std::memory_order_relaxed)) {
                    event.order = pos; cell.event = event; cell.sequence.store(pos + 1, std::memory_order_release); return true;
                }
            } else if (diff < 0) return false;
            else pos = write_.load(std::memory_order_relaxed);
        }
        return false;
    }
    bool pop(Scheduled& event) noexcept {
        auto& cell = cells_[read_ % capacity];
        if (cell.sequence.load(std::memory_order_acquire) != read_ + 1) return false;
        event = cell.event; cell.sequence.store(read_ + capacity, std::memory_order_release); ++read_; return true;
    }
};
float makeInitialSeed() noexcept {
    // Distinct generated defaults in a host process until the 16-bit seed space wraps.
    // The DSP hashes the seed into coefficient variation, so sequential identities do not
    // produce a monotonic audible progression.
    static std::atomic<unsigned> serial{0};
    return float(1u + serial.fetch_add(1, std::memory_order_relaxed) % 65535u);
}
struct Plugin {
    const float initialSeed = makeInitialSeed();
    AudioUnit instance = nullptr;
    std::array<std::atomic<float>, ParamCount> params{};
    std::atomic<bool> bypass{false};
    std::atomic<OSStatus> lastError{noErr};
    AudioStreamBasicDescription inputFormat = format(), outputFormat = format();
    AURenderCallbackStruct inputCallback{};
    AudioUnitConnection connection{};
    HostCallbackInfo hostCallbacks{};
    std::array<Notify, kNotifySlots> notifies{};
    std::vector<PropertyListener> listeners;
    bool initialized = false, allocateInputBuffers = true, allocateOutputBuffers = true;
    UInt32 maximumFrames = kMaxFrames, renderQuality = 64;
    std::array<std::vector<float>, 2> inputStorage, outputStorage, planarInput, planarOutput;
    Processor processor;
    ParameterQueue queue;
    std::atomic<uint64_t> scheduleEra{1};
    std::array<Scheduled, 128> pending{};
    unsigned pendingCount = 0;
    std::array<std::vector<float>, 2> cache;
    int64_t syntheticTime = 0;
    double lastSampleTime = -1;
    UInt32 lastFrames = 0;
    explicit Plugin();
    Parameters snapshot() const noexcept {
        Parameters p; for (unsigned i = 0; i < ParamCount; ++i) p.values[i] = params[i].load(std::memory_order_relaxed); return p;
    }
    void changed(AudioUnitPropertyID id, AudioUnitScope scope, AudioUnitElement element) {
        // A listener may unsubscribe itself. Notifications run only on the control path.
        std::vector<PropertyListener> callbacks;
        try { callbacks = listeners; } catch (...) { return; }
        for (auto l : callbacks) if (l.id == id) l.proc(l.context, instance, id, scope, element);
    }
    OSStatus prepareBuffers(AudioBufferList* b, std::array<std::vector<float>, 2>& storage,
                            const AudioStreamBasicDescription& fmt, UInt32 count, bool mayAllocate) noexcept {
        const bool planar = fmt.mFormatFlags & kAudioFormatFlagIsNonInterleaved;
        const unsigned numBuffers = planar ? fmt.mChannelsPerFrame : 1;
        if (!b || b->mNumberBuffers != numBuffers) return kAudioUnitErr_InvalidPropertyValue;
        for (unsigned c = 0; c < numBuffers; ++c) {
            const auto bytes = count * 4u * (planar ? 1u : fmt.mChannelsPerFrame);
            if (!b->mBuffers[c].mData) {
                if (!mayAllocate) return kAudioUnitErr_InvalidPropertyValue;
                b->mBuffers[c].mData = storage[c].data();
                b->mBuffers[c].mDataByteSize = bytes;
            } else if (b->mBuffers[c].mDataByteSize < bytes) return kAudioUnitErr_InvalidPropertyValue;
            b->mBuffers[c].mNumberChannels = planar ? 1u : fmt.mChannelsPerFrame;
            b->mBuffers[c].mDataByteSize = bytes;
        }
        return noErr;
    }
    OSStatus dsp(const AudioBufferList* in, AudioBufferList* out, UInt32 count, const AudioTimeStamp* stamp) noexcept {
        const unsigned channels = outputFormat.mChannelsPerFrame;
        const bool inPlanar = inputFormat.mFormatFlags & kAudioFormatFlagIsNonInterleaved;
        const bool outPlanar = outputFormat.mFormatFlags & kAudioFormatFlagIsNonInterleaved;
        const float* l = nullptr; const float* r = nullptr;
        if (inPlanar) {
            if (in->mNumberBuffers != channels) return kAudioUnitErr_FormatNotSupported;
            l = static_cast<const float*>(in->mBuffers[0].mData);
            if (channels == 2) r = static_cast<const float*>(in->mBuffers[1].mData);
            for (unsigned c = 0; c < channels; ++c)
                if (!in->mBuffers[c].mData || in->mBuffers[c].mDataByteSize < count * 4u) return kAudioUnitErr_InvalidPropertyValue;
        } else {
            if (in->mNumberBuffers != 1 || !in->mBuffers[0].mData || in->mBuffers[0].mDataByteSize < count * channels * 4u) return kAudioUnitErr_InvalidPropertyValue;
            const auto* interleaved = static_cast<const float*>(in->mBuffers[0].mData);
            for (UInt32 f = 0; f < count; ++f) for (unsigned c = 0; c < channels; ++c) planarInput[c][f] = interleaved[f * channels + c];
            l = planarInput[0].data(); r = channels == 2 ? planarInput[1].data() : nullptr;
        }
        float* ol = outPlanar ? static_cast<float*>(out->mBuffers[0].mData) : planarOutput[0].data();
        float* oright = channels == 2 ? (outPlanar ? static_cast<float*>(out->mBuffers[1].mData) : planarOutput[1].data()) : nullptr;
        int64_t time = syntheticTime;
        if (stamp && (stamp->mFlags & kAudioTimeStampSampleTimeValid)) {
            if (!std::isfinite(stamp->mSampleTime) || std::abs(stamp->mSampleTime) > 9.e15) return kAudioUnitErr_InvalidPropertyValue;
            time = int64_t(std::llround(stamp->mSampleTime));
        }
        const bool validTime = stamp && (stamp->mFlags & kAudioTimeStampSampleTimeValid);
        if (validTime && stamp->mSampleTime == lastSampleTime && count == lastFrames) {
            std::copy_n(cache[0].data(), count, ol);
            if (oright) std::copy_n(cache[1].data(), count, oright);
        } else {
            const uint64_t currentEra = scheduleEra.load(std::memory_order_acquire);
            unsigned kept = 0;
            for (unsigned i = 0; i < pendingCount; ++i) if (pending[i].era == currentEra) pending[kept++] = pending[i];
            pendingCount = kept;
            Scheduled event;
            while (pendingCount < pending.size() && queue.pop(event)) if (event.era == currentEra) pending[pendingCount++] = event;
            std::sort(pending.begin(), pending.begin() + pendingCount, [](const auto& a, const auto& b) { return a.offset < b.offset || (a.offset == b.offset && a.order < b.order); });
            unsigned begin = 0, used = 0;
            auto segment = [&](unsigned end) {
                if (end == begin) return;
                auto parameters = snapshot();
                if (!validTime) parameters.values[CrosstalkEnabled] = 0;
                processor.process(l + begin, r ? r + begin : nullptr, ol + begin, oright ? oright + begin : nullptr,
                    end - begin, time + begin, parameters, bypass.load(std::memory_order_relaxed));
                begin = end;
            };
            while (used < pendingCount && pending[used].offset < count) {
                segment(pending[used].offset);
                params[pending[used].id].store(pending[used].value, std::memory_order_relaxed); ++used;
            }
            segment(count);
            kept = 0;
            for (unsigned i = used; i < pendingCount; ++i) { pending[kept] = pending[i]; pending[kept++].offset -= count; }
            pendingCount = kept;
            std::copy_n(ol, count, cache[0].data()); if (oright) std::copy_n(oright, count, cache[1].data());
            lastSampleTime = validTime ? stamp->mSampleTime : -1; lastFrames = validTime ? count : 0;
        }
        if (!outPlanar) {
            auto* interleaved = static_cast<float*>(out->mBuffers[0].mData);
            for (UInt32 f = 0; f < count; ++f) for (unsigned c = 0; c < channels; ++c) interleaved[f * channels + c] = planarOutput[c][f];
        }
        syntheticTime = time + count;
        return noErr;
    }
};
struct Instance { AudioComponentPlugInInterface interface; Plugin* implementation; };
static_assert(std::is_standard_layout<Instance>::value);
Plugin& plugin(void* self) { return *static_cast<Instance*>(self)->implementation; }

OSStatus initialize(void* self) {
    auto& p = plugin(self);
    if (p.initialized) return noErr;
    if (!validFormat(p.inputFormat) || !validFormat(p.outputFormat) ||
        p.inputFormat.mChannelsPerFrame != p.outputFormat.mChannelsPerFrame ||
        p.inputFormat.mSampleRate != p.outputFormat.mSampleRate) return kAudioUnitErr_FormatNotSupported;
    try {
        for (unsigned c = 0; c < 2; ++c) {
            p.inputStorage[c].assign(p.maximumFrames * 2u, 0.f);
            p.outputStorage[c].assign(p.maximumFrames * 2u, 0.f);
            p.planarInput[c].assign(p.maximumFrames, 0.f);
            p.planarOutput[c].assign(p.maximumFrames, 0.f);
            p.cache[c].assign(p.maximumFrames, 0.f);
        }
    } catch (...) { return kAudioUnitErr_FailedInitialization; }
    p.processor.activate(p.outputFormat.mSampleRate);
    p.processor.reset(); p.syntheticTime = 0; p.lastFrames = 0; p.lastSampleTime = -1;
    p.initialized = true; return noErr;
}
OSStatus uninitialize(void* self) {
    auto& p = plugin(self); p.initialized = false; p.processor.deactivate(); return noErr;
}
OSStatus reset(void* self, AudioUnitScope scope, AudioUnitElement element) {
    if (element != 0) return kAudioUnitErr_InvalidElement;
    if (scope != kAudioUnitScope_Global && scope != kAudioUnitScope_Input && scope != kAudioUnitScope_Output) return kAudioUnitErr_InvalidScope;
    auto& p = plugin(self); p.scheduleEra.fetch_add(1); p.pendingCount = 0; p.processor.reset(); p.syntheticTime = 0; p.lastFrames = 0; p.lastSampleTime = -1;
    return noErr;
}
OSStatus parameterInfo(const Plugin& plugin, unsigned id, AudioUnitParameterInfo& info) {
    if (id >= ParamCount) return kAudioUnitErr_InvalidParameter;
    const auto& s = kParams[id]; std::memset(&info, 0, sizeof(info)); std::strncpy(info.name, s.name, sizeof(info.name) - 1);
    info.cfNameString = CFStringCreateWithCString(nullptr, s.name, kCFStringEncodingUTF8);
    info.flags = kAudioUnitParameterFlag_IsReadable | kAudioUnitParameterFlag_IsWritable |
        kAudioUnitParameterFlag_HasCFNameString | kAudioUnitParameterFlag_CFNameRelease;
    info.minValue = s.minimum; info.maxValue = s.maximum; info.defaultValue = id == Seed ? plugin.initialSeed : s.defaultValue;
    info.unit = s.integer ? kAudioUnitParameterUnit_Indexed : kAudioUnitParameterUnit_Generic;
    if (id == Variation) info.unit = kAudioUnitParameterUnit_Percent;
    if (id == Crosstalk || id == Drive || id == OutputTrim) info.unit = kAudioUnitParameterUnit_Decibels;
    if (id == CrosstalkEnabled) info.unit = kAudioUnitParameterUnit_Boolean;
    return noErr;
}
OSStatus propertyInfo(void*, AudioUnitPropertyID id, AudioUnitScope scope, AudioUnitElement element,
                      UInt32* size, Boolean* writable) {
    UInt32 n = 0; Boolean w = false;
    if (id != kAudioUnitProperty_ParameterInfo && id != kAudioUnitProperty_ParameterValueStrings && element != 0) return kAudioUnitErr_InvalidElement;
    switch (id) {
    case kAudioUnitProperty_StreamFormat:
        if (scope != kAudioUnitScope_Input && scope != kAudioUnitScope_Output) return kAudioUnitErr_InvalidScope;
        n = sizeof(AudioStreamBasicDescription); w = true; break;
    case kAudioUnitProperty_SampleRate:
        if (scope != kAudioUnitScope_Input && scope != kAudioUnitScope_Output && scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidScope;
        n = sizeof(Float64); w = true; break;
    case kAudioUnitProperty_ElementCount:
        if (scope != kAudioUnitScope_Input && scope != kAudioUnitScope_Output && scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidScope;
        n = sizeof(UInt32); break;
    case kAudioUnitProperty_ParameterList:
        if (scope != kAudioUnitScope_Global) { n = 0; break; }
        n = sizeof(AudioUnitParameterID) * ParamCount; break;
    case kAudioUnitProperty_ParameterInfo:
        if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidScope;
        if (element >= ParamCount) return kAudioUnitErr_InvalidParameter;
        n = sizeof(AudioUnitParameterInfo); break;
    case kAudioUnitProperty_ParameterValueStrings:
        if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidScope;
        if (element != Role) return kAudioUnitErr_InvalidProperty;
        n = sizeof(CFArrayRef); break;
    case kAudioUnitProperty_SupportedNumChannels: n = 2 * sizeof(AUChannelInfo); break;
    case kAudioUnitProperty_Latency:
    case kAudioUnitProperty_TailTime: n = sizeof(Float64); break;
    case kAudioUnitProperty_MaximumFramesPerSlice:
    case kAudioUnitProperty_BypassEffect:
    case kAudioUnitProperty_RenderQuality:
    case kAudioUnitProperty_InPlaceProcessing:
        n = sizeof(UInt32); w = true; break;
    case kAudioUnitProperty_ShouldAllocateBuffer:
        if (scope != kAudioUnitScope_Input && scope != kAudioUnitScope_Output) return kAudioUnitErr_InvalidScope;
        n = sizeof(UInt32); w = true; break;
    case kAudioUnitProperty_LastRenderError: n = sizeof(OSStatus); break;
    case kAudioUnitProperty_SetRenderCallback: n = sizeof(AURenderCallbackStruct); w = true; break;
    case kAudioUnitProperty_MakeConnection: n = sizeof(AudioUnitConnection); w = true; break;
    case kAudioUnitProperty_HostCallbacks: n = sizeof(HostCallbackInfo); w = true; break;
    case kAudioUnitProperty_ElementName: n = sizeof(CFStringRef); break;
    case kAudioUnitProperty_ClassInfo:
    case kAudioUnitProperty_ClassInfoFromDocument: n = sizeof(CFPropertyListRef); w = true; break;
    case kAudioUnitProperty_FactoryPresets: n = sizeof(CFArrayRef); break;
    case kAudioUnitProperty_PresentPreset:
    case kAudioUnitProperty_CurrentPreset: n = sizeof(AUPreset); w = true; break;
    default: return kAudioUnitErr_InvalidProperty;
    }
    if (size) *size = n; if (writable) *writable = w; return noErr;
}
template<class T> OSStatus copyOut(void* out, UInt32* size, const T& value) {
    if (!size || !out || *size < sizeof(T)) return kAudioUnitErr_InvalidPropertyValue;
    std::memcpy(out, &value, sizeof(T)); *size = sizeof(T); return noErr;
}
struct PresetData { uint32_t version; float params[ParamCount]; };
CFDictionaryRef saveState(const Plugin& p) {
    PresetData data{}; data.version = 1;
    for (unsigned i = 0; i < ParamCount; ++i) data.params[i] = p.params[i].load(std::memory_order_relaxed);
    auto result = CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    auto addNumber = [&](CFStringRef key, SInt32 value) { auto n = CFNumberCreate(nullptr, kCFNumberSInt32Type, &value); CFDictionarySetValue(result, key, n); CFRelease(n); };
    addNumber(CFSTR("version"), 0); addNumber(CFSTR("type"), kAudioUnitType_Effect);
    addNumber(CFSTR("subtype"), kSubtype); addNumber(CFSTR("manufacturer"), kManufacturer);
    auto bytes = CFDataCreate(nullptr, reinterpret_cast<const UInt8*>(&data), sizeof(data));
    CFDictionarySetValue(result, CFSTR("data"), bytes); CFRelease(bytes);
    CFDictionarySetValue(result, CFSTR("name"), CFSTR("E Console Analog")); return result;
}
OSStatus getProperty(void* self, AudioUnitPropertyID id, AudioUnitScope scope, AudioUnitElement element, void* out, UInt32* size) {
    auto& p = plugin(self); UInt32 required; Boolean w;
    auto status = propertyInfo(self, id, scope, element, &required, &w); if (status) return status;
    if (!size || !out || *size < required) return kAudioUnitErr_InvalidPropertyValue;
    switch (id) {
    case kAudioUnitProperty_StreamFormat: return copyOut(out, size, scope == kAudioUnitScope_Input ? p.inputFormat : p.outputFormat);
    case kAudioUnitProperty_SampleRate: return copyOut(out, size, scope == kAudioUnitScope_Input ? p.inputFormat.mSampleRate : p.outputFormat.mSampleRate);
    case kAudioUnitProperty_ElementCount: { const UInt32 v = scope == kAudioUnitScope_Global ? 1 : 1; return copyOut(out, size, v); }
    case kAudioUnitProperty_ParameterList: {
        if (scope == kAudioUnitScope_Global) { auto* ids = static_cast<AudioUnitParameterID*>(out); for (unsigned i = 0; i < ParamCount; ++i) ids[i] = i; }
        *size = required; return noErr;
    }
    case kAudioUnitProperty_ParameterInfo: { AudioUnitParameterInfo info{}; status = parameterInfo(p, element, info); return status ? status : copyOut(out, size, info); }
    case kAudioUnitProperty_ParameterValueStrings: { const void* values[] = { CFSTR("Track"), CFSTR("Bus - receive only"), CFSTR("Master - receive only") }; CFArrayRef a = CFArrayCreate(nullptr, values, 3, &kCFTypeArrayCallBacks); return copyOut(out, size, a); }
    case kAudioUnitProperty_SupportedNumChannels: { const AUChannelInfo channels[2]{{1,1},{2,2}}; std::memcpy(out, channels, sizeof(channels)); *size = sizeof(channels); return noErr; }
    case kAudioUnitProperty_Latency: { const Float64 v = double(kLatency) / p.outputFormat.mSampleRate; return copyOut(out, size, v); }
    case kAudioUnitProperty_TailTime: { const Float64 v = double(kLatency) / p.outputFormat.mSampleRate + .5; return copyOut(out, size, v); }
    case kAudioUnitProperty_MaximumFramesPerSlice: return copyOut(out, size, p.maximumFrames);
    case kAudioUnitProperty_BypassEffect: { const UInt32 v = p.bypass.load() ? 1 : 0; return copyOut(out, size, v); }
    case kAudioUnitProperty_RenderQuality: return copyOut(out, size, p.renderQuality);
    case kAudioUnitProperty_InPlaceProcessing: { const UInt32 v = 1; return copyOut(out, size, v); }
    case kAudioUnitProperty_ShouldAllocateBuffer: { const UInt32 v = (scope == kAudioUnitScope_Input ? p.allocateInputBuffers : p.allocateOutputBuffers) ? 1 : 0; return copyOut(out, size, v); }
    case kAudioUnitProperty_LastRenderError: { const OSStatus v = p.lastError.exchange(noErr); return copyOut(out, size, v); }
    case kAudioUnitProperty_SetRenderCallback: return copyOut(out, size, p.inputCallback);
    case kAudioUnitProperty_MakeConnection: return copyOut(out, size, p.connection);
    case kAudioUnitProperty_HostCallbacks: return copyOut(out, size, p.hostCallbacks);
    case kAudioUnitProperty_ElementName: { CFStringRef name = scope == kAudioUnitScope_Input ? CFSTR("Input") : CFSTR("Output"); CFRetain(name); return copyOut(out, size, name); }
    case kAudioUnitProperty_ClassInfo:
    case kAudioUnitProperty_ClassInfoFromDocument: { const auto state = saveState(p); return copyOut(out, size, state); }
    case kAudioUnitProperty_FactoryPresets: { auto array = CFArrayCreate(nullptr, nullptr, 0, &kCFTypeArrayCallBacks); return copyOut(out, size, array); }
    case kAudioUnitProperty_PresentPreset:
    case kAudioUnitProperty_CurrentPreset: { AUPreset preset{-1, CFSTR("Custom")}; CFRetain(preset.presetName); return copyOut(out, size, preset); }
    default: return kAudioUnitErr_InvalidProperty;
    }
}
OSStatus setProperty(void* self, AudioUnitPropertyID id, AudioUnitScope scope, AudioUnitElement element, const void* data, UInt32 size) {
    auto& p = plugin(self); UInt32 expected; Boolean writable;
    auto status = propertyInfo(self, id, scope, element, &expected, &writable); if (status) return status;
    if (!writable) return kAudioUnitErr_PropertyNotWritable;
    if (!data || size != expected) return kAudioUnitErr_InvalidPropertyValue;
    switch (id) {
    case kAudioUnitProperty_StreamFormat: {
        if (p.initialized) return kAudioUnitErr_Initialized;
        auto f = *static_cast<const AudioStreamBasicDescription*>(data); if (!validFormat(f)) return kAudioUnitErr_FormatNotSupported;
        (scope == kAudioUnitScope_Input ? p.inputFormat : p.outputFormat) = f; break;
    }
    case kAudioUnitProperty_SampleRate: {
        if (p.initialized) return kAudioUnitErr_Initialized;
        const auto rate = *static_cast<const Float64*>(data); if (!std::isfinite(rate) || rate < 8000 || rate > 384000) return kAudioUnitErr_FormatNotSupported;
        if (scope != kAudioUnitScope_Output) p.inputFormat.mSampleRate = rate;
        if (scope != kAudioUnitScope_Input) p.outputFormat.mSampleRate = rate; break;
    }
    case kAudioUnitProperty_MaximumFramesPerSlice: {
        if (p.initialized) return kAudioUnitErr_Initialized;
        auto n = *static_cast<const UInt32*>(data); if (!n || n > kMaxFrames) return kAudioUnitErr_InvalidPropertyValue; p.maximumFrames = n; break;
    }
    case kAudioUnitProperty_BypassEffect: p.bypass.store(*static_cast<const UInt32*>(data) != 0); break;
    case kAudioUnitProperty_RenderQuality: p.renderQuality = *static_cast<const UInt32*>(data); break;
    case kAudioUnitProperty_InPlaceProcessing: if (*static_cast<const UInt32*>(data) != 1) return kAudioUnitErr_InvalidPropertyValue; break;
    case kAudioUnitProperty_ShouldAllocateBuffer:
        if (p.initialized) return kAudioUnitErr_Initialized;
        (scope == kAudioUnitScope_Input ? p.allocateInputBuffers : p.allocateOutputBuffers) = *static_cast<const UInt32*>(data) != 0; break;
    case kAudioUnitProperty_SetRenderCallback:
        if (scope != kAudioUnitScope_Input) return kAudioUnitErr_InvalidScope;
        if (p.initialized) return kAudioUnitErr_Initialized;
        p.inputCallback = *static_cast<const AURenderCallbackStruct*>(data); p.connection = {}; break;
    case kAudioUnitProperty_MakeConnection:
        if (scope != kAudioUnitScope_Input) return kAudioUnitErr_InvalidScope;
        if (p.initialized) return kAudioUnitErr_Initialized;
        p.connection = *static_cast<const AudioUnitConnection*>(data); p.inputCallback = {}; break;
    case kAudioUnitProperty_HostCallbacks:
        if (p.initialized) return kAudioUnitErr_Initialized;
        p.hostCallbacks = *static_cast<const HostCallbackInfo*>(data); break;
    case kAudioUnitProperty_ClassInfo:
    case kAudioUnitProperty_ClassInfoFromDocument: {
        auto state = *static_cast<const CFPropertyListRef*>(data);
        if (!state || CFGetTypeID(state) != CFDictionaryGetTypeID()) return kAudioUnitErr_InvalidPropertyValue;
        auto bytes = static_cast<CFDataRef>(CFDictionaryGetValue(static_cast<CFDictionaryRef>(state), CFSTR("data")));
        if (!bytes || CFGetTypeID(bytes) != CFDataGetTypeID() || CFDataGetLength(bytes) != sizeof(PresetData)) return kAudioUnitErr_InvalidPropertyValue;
        PresetData saved; std::memcpy(&saved, CFDataGetBytePtr(bytes), sizeof(saved));
        if (saved.version != 1) return kAudioUnitErr_InvalidPropertyValue;
        for (unsigned i = 0; i < ParamCount; ++i) if (!std::isfinite(saved.params[i])) return kAudioUnitErr_InvalidPropertyValue;
        p.scheduleEra.fetch_add(1);
        for (unsigned i = 0; i < ParamCount; ++i) p.params[i].store(clampParam(i, saved.params[i])); break;
    }
    case kAudioUnitProperty_PresentPreset:
    case kAudioUnitProperty_CurrentPreset: return kAudioUnitErr_InvalidPropertyValue; // No factory presets.
    default: return kAudioUnitErr_InvalidProperty;
    }
    p.changed(id, scope, element); return noErr;
}
OSStatus getParameter(void* self, AudioUnitParameterID id, AudioUnitScope scope, AudioUnitElement element, AudioUnitParameterValue* value) {
    if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidScope;
    if (element) return kAudioUnitErr_InvalidElement;
    if (id >= ParamCount || !value) return kAudioUnitErr_InvalidParameter;
    *value = plugin(self).params[id].load(std::memory_order_relaxed); return noErr;
}
OSStatus setParameter(void* self, AudioUnitParameterID id, AudioUnitScope scope, AudioUnitElement element, AudioUnitParameterValue value, UInt32 offset) {
    if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidScope;
    if (element) return kAudioUnitErr_InvalidElement;
    if (id >= ParamCount || !std::isfinite(value)) return kAudioUnitErr_InvalidParameter;
    auto& p = plugin(self);
    if (offset) {
        if (offset >= p.maximumFrames) return kAudioUnitErr_InvalidParameter;
        if (!p.queue.push({id, offset, clampParam(id, value), p.scheduleEra.load(), 0})) return kAudioUnitErr_CannotDoInCurrentContext;
    } else p.params[id].store(clampParam(id, value), std::memory_order_relaxed);
    return noErr;
}
OSStatus schedule(void* self, const AudioUnitParameterEvent* events, UInt32 count) {
    if (!events && count) return kAudioUnitErr_InvalidParameter;
    for (UInt32 i = 0; i < count; ++i) {
        if (events[i].eventType != kParameterEvent_Immediate) return kAudioUnitErr_InvalidParameter;
        const auto status = setParameter(self, events[i].parameter, events[i].scope, events[i].element, events[i].eventValues.immediate.value, events[i].eventValues.immediate.bufferOffset);
        if (status) return status;
    }
    return noErr;
}
OSStatus addPropertyListener(void* self, AudioUnitPropertyID id, AudioUnitPropertyListenerProc proc, void* ref) {
    if (!proc) return kAudioUnitErr_InvalidParameter;
    auto& p = plugin(self); try { p.listeners.push_back({id, proc, ref}); } catch (...) { return kAudioUnitErr_FailedInitialization; } return noErr;
}
OSStatus removePropertyListenerWithData(void* self, AudioUnitPropertyID id, AudioUnitPropertyListenerProc proc, void* ref) {
    auto& list = plugin(self).listeners;
    list.erase(std::remove_if(list.begin(), list.end(), [&](auto l) { return l.id == id && l.proc == proc && l.context == ref; }), list.end()); return noErr;
}
OSStatus removePropertyListener(void* self, AudioUnitPropertyID id, AudioUnitPropertyListenerProc proc) {
    auto& list = plugin(self).listeners;
    list.erase(std::remove_if(list.begin(), list.end(), [&](auto l) { return l.id == id && l.proc == proc; }), list.end()); return noErr;
}
bool notifySnapshot(const Notify& n, AURenderCallback& callback, void*& context) noexcept {
    const auto before = n.version.load(std::memory_order_seq_cst);
    if (before & 1u) return false;
    callback = n.callback.load(std::memory_order_seq_cst); context = n.context.load(std::memory_order_seq_cst);
    return callback && n.version.load(std::memory_order_seq_cst) == before;
}
OSStatus addRenderNotify(void* self, AURenderCallback proc, void* ref) {
    if (!proc) return kAudioUnitErr_InvalidParameter;
    auto& p = plugin(self);
    for (auto& n : p.notifies) if (n.callback.load() == proc && n.context.load() == ref) return noErr;
    for (auto& n : p.notifies) if (!n.callback.load()) {
        auto version = n.version.load();
        if ((version & 1u) || !n.version.compare_exchange_strong(version, version + 1)) continue;
        if (n.callback.load()) { n.version.store(version + 2); continue; }
        n.context.store(ref); n.callback.store(proc); n.version.store(version + 2); return noErr;
    }
    return kAudioUnitErr_CannotDoInCurrentContext;
}
OSStatus removeRenderNotify(void* self, AURenderCallback proc, void* ref) {
    auto& p = plugin(self);
    for (auto& n : p.notifies) if (n.callback.load() == proc && n.context.load() == ref) {
        auto version = n.version.load();
        if ((version & 1u) || !n.version.compare_exchange_strong(version, version + 1)) return kAudioUnitErr_CannotDoInCurrentContext;
        if (n.callback.load() == proc && n.context.load() == ref) n.callback.store(nullptr);
        n.version.store(version + 2);
    }
    return noErr;
}
OSStatus render(void* self, AudioUnitRenderActionFlags* action, const AudioTimeStamp* time, UInt32 bus, UInt32 count, AudioBufferList* out) {
    auto& p = plugin(self);
    if (!p.initialized) return kAudioUnitErr_Uninitialized;
    if (bus) return kAudioUnitErr_InvalidElement;
    if (count > p.maximumFrames) return kAudioUnitErr_TooManyFramesToProcess;
    if (!count) return noErr;
    auto status = p.prepareBuffers(out, p.outputStorage, p.outputFormat, count, p.allocateOutputBuffers);
    if (status) return status;
    AudioUnitRenderActionFlags local = action ? *action : 0;
    for (auto& n : p.notifies) { AURenderCallback f; void* ref; if (notifySnapshot(n, f, ref)) { auto flags = local | kAudioUnitRenderAction_PreRender; f(ref, &flags, time, 0, count, out); } }
    BufferList2 input{};
    const bool planar = p.inputFormat.mFormatFlags & kAudioFormatFlagIsNonInterleaved;
    input.count = planar ? p.inputFormat.mChannelsPerFrame : 1;
    auto* in = reinterpret_cast<AudioBufferList*>(&input);
    for (unsigned c = 0; c < input.count; ++c) {
        input.buffers[c].mData = p.allocateInputBuffers ? p.inputStorage[c].data() : nullptr; input.buffers[c].mDataByteSize = count * 4u * (planar ? 1 : p.inputFormat.mChannelsPerFrame);
        input.buffers[c].mNumberChannels = planar ? 1 : p.inputFormat.mChannelsPerFrame;
    }
    if (p.inputCallback.inputProc) status = p.inputCallback.inputProc(p.inputCallback.inputProcRefCon, &local, time, 0, count, in);
    else if (p.connection.sourceAudioUnit) status = AudioUnitRender(p.connection.sourceAudioUnit, &local, time, p.connection.sourceOutputNumber, count, in);
    else { for (unsigned c = 0; c < input.count; ++c) { input.buffers[c].mData = p.inputStorage[c].data(); std::memset(input.buffers[c].mData, 0, input.buffers[c].mDataByteSize); } }
    if (!status && (local & kAudioUnitRenderAction_OutputIsSilence)) {
        for (unsigned c = 0; c < input.count; ++c) {
            input.buffers[c].mData = p.inputStorage[c].data();
            input.buffers[c].mDataByteSize = count * 4u * (planar ? 1u : p.inputFormat.mChannelsPerFrame);
            std::memset(input.buffers[c].mData, 0, input.buffers[c].mDataByteSize);
        }
    }
    if (!status) status = p.dsp(in, out, count, time);
    local &= ~kAudioUnitRenderAction_OutputIsSilence; // Our latency/crosstalk can produce signal from silent input.
    if (status) { p.lastError.store(status); local |= kAudioUnitRenderAction_PostRenderError; }
    if (action) *action = local;
    for (auto& n : p.notifies) { AURenderCallback f; void* ref; if (notifySnapshot(n, f, ref)) { auto flags = local | kAudioUnitRenderAction_PostRender; f(ref, &flags, time, 0, count, out); } }
    return status;
}
OSStatus process(void* self, AudioUnitRenderActionFlags* action, const AudioTimeStamp* time, UInt32 count, AudioBufferList* data) {
    auto& p = plugin(self);
    if (!p.initialized) return kAudioUnitErr_Uninitialized;
    if (count > p.maximumFrames) return kAudioUnitErr_TooManyFramesToProcess;
    if (p.inputFormat.mFormatFlags != p.outputFormat.mFormatFlags) return kAudioUnitErr_FormatNotSupported;
    auto status = p.prepareBuffers(data, p.outputStorage, p.outputFormat, count, false);
    if (!status && action && (*action & kAudioUnitRenderAction_OutputIsSilence))
        for (unsigned c = 0; c < data->mNumberBuffers; ++c) std::memset(data->mBuffers[c].mData, 0, data->mBuffers[c].mDataByteSize);
    if (!status) status = p.dsp(data, data, count, time);
    if (action) *action &= ~kAudioUnitRenderAction_OutputIsSilence;
    p.lastError.store(status); return status;
}
OSStatus open(void* self, AudioComponentInstance instance) { plugin(self).instance = instance; return noErr; }
OSStatus close(void* self) { auto* shell = static_cast<Instance*>(self); delete shell->implementation; delete shell; return noErr; }
AudioComponentMethod lookup(SInt16 selector) {
#define METHOD(key, function) case key: return reinterpret_cast<AudioComponentMethod>(function)
    switch (selector) {
        METHOD(kAudioUnitInitializeSelect, initialize); METHOD(kAudioUnitUninitializeSelect, uninitialize);
        METHOD(kAudioUnitResetSelect, reset); METHOD(kAudioUnitGetPropertyInfoSelect, propertyInfo);
        METHOD(kAudioUnitGetPropertySelect, getProperty); METHOD(kAudioUnitSetPropertySelect, setProperty);
        METHOD(kAudioUnitGetParameterSelect, getParameter); METHOD(kAudioUnitSetParameterSelect, setParameter);
        METHOD(kAudioUnitScheduleParametersSelect, schedule); METHOD(kAudioUnitRenderSelect, render);
        METHOD(kAudioUnitProcessSelect, process); METHOD(kAudioUnitAddPropertyListenerSelect, addPropertyListener);
        METHOD(kAudioUnitRemovePropertyListenerSelect, removePropertyListener);
        METHOD(kAudioUnitRemovePropertyListenerWithUserDataSelect, removePropertyListenerWithData);
        METHOD(kAudioUnitAddRenderNotifySelect, addRenderNotify); METHOD(kAudioUnitRemoveRenderNotifySelect, removeRenderNotify);
        default: return nullptr;
    }
#undef METHOD
}
Plugin::Plugin() {
    for (unsigned i = 0; i < ParamCount; ++i) params[i].store(kParams[i].defaultValue);
    params[Seed].store(initialSeed);
}
} // namespace
extern "C" __attribute__((visibility("default"))) AudioComponentPlugInInterface* EConsoleFactory(const AudioComponentDescription* desc) {
    if (!desc || desc->componentType != kAudioUnitType_Effect || desc->componentSubType != kSubtype || desc->componentManufacturer != kManufacturer) return nullptr;
    try {
        auto* shell = new Instance{{open, close, lookup, nullptr}, nullptr};
        try { shell->implementation = new Plugin; } catch (...) { delete shell; throw; }
        return &shell->interface;
    } catch (...) { return nullptr; }
}
