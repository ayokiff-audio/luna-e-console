#pragma once
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>

namespace econsole {
constexpr unsigned kLatency = 4096;
constexpr unsigned kMaxFrames = 2048;
constexpr unsigned kRing = 16384;
constexpr unsigned kSlots = 64;
constexpr unsigned kNeighbors = 2;
constexpr int64_t kInvalidStamp = std::numeric_limits<int64_t>::min();
static_assert((kRing & (kRing - 1)) == 0);
static_assert(std::atomic<uint64_t>::is_always_lock_free, "Real-time registry needs lock-free 64-bit atomics");
static_assert(std::atomic<float>::is_always_lock_free, "Real-time parameters need lock-free floats");

enum Param : unsigned { Seed, Variation, Crosstalk, CrosstalkEnabled, Group, Role, Drive, OutputTrim, ParamCount };
struct ParamSpec { const char* name; float minimum, maximum, defaultValue; bool integer; };
inline constexpr ParamSpec kParams[ParamCount] = {
    {"Console Seed", 1, 65535, 1, true}, {"Variation", 0, 100, 20, false},
    {"Crosstalk", -100, -40, -70, false}, {"Crosstalk Enabled", 0, 1, 0, true},
    {"Console Group", 1, 65535, 1, true}, {"Channel Role", 0, 2, 0, true},
    {"Drive", 0, 18, 0, false}, {"Output Trim", -12, 12, 0, false}
};
struct Parameters {
    std::array<float, ParamCount> values{};
    Parameters() { for (unsigned i = 0; i < ParamCount; ++i) values[i] = kParams[i].defaultValue; }
    float operator[](unsigned i) const { return values[i]; }
};
inline float clampParam(unsigned id, float value) {
    if (!std::isfinite(value)) return kParams[id].defaultValue;
    value = std::clamp(value, kParams[id].minimum, kParams[id].maximum);
    return kParams[id].integer ? std::round(value) : value;
}
inline uint32_t hash(uint32_t x) {
    x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; return x ^ (x >> 16);
}
inline float bipolar(uint32_t x) { return float(hash(x) & 0xffffffu) / 8388607.5f - 1.f; }
inline uint64_t pack(float left, float right) {
    uint32_t l, r; std::memcpy(&l, &left, 4); std::memcpy(&r, &right, 4);
    return uint64_t(l) | (uint64_t(r) << 32);
}
inline void unpack(uint64_t data, float& left, float& right) {
    uint32_t l = uint32_t(data), r = uint32_t(data >> 32); std::memcpy(&left, &l, 4); std::memcpy(&right, &r, 4);
}
struct AtomicFrame {
    std::atomic<int64_t> stamp{kInvalidStamp};
    std::atomic<uint64_t> epoch{0};
    std::atomic<uint64_t> audio{0};
    void write(int64_t time, uint64_t era, float l, float r) noexcept {
        stamp.store(kInvalidStamp, std::memory_order_seq_cst);
        audio.store(pack(l, r), std::memory_order_seq_cst);
        epoch.store(era, std::memory_order_seq_cst);
        stamp.store(time, std::memory_order_seq_cst);
    }
    bool read(int64_t time, uint64_t era, float& l, float& r) const noexcept {
        const auto a = stamp.load(std::memory_order_seq_cst);
        if (a != time || epoch.load(std::memory_order_seq_cst) != era) return false;
        const auto bits = audio.load(std::memory_order_seq_cst);
        if (stamp.load(std::memory_order_seq_cst) != time || epoch.load(std::memory_order_seq_cst) != era) return false;
        unpack(bits, l, r); return true;
    }
};
struct SharedSlot {
    std::atomic<uint64_t> owner{0};
    std::atomic<unsigned> group{0}, rate{0}, seed{1};
    std::atomic<uint64_t> token{0}, groupEra{0};
    std::atomic<bool> enabled{false};
    std::array<AtomicFrame, kRing> frames{};
};
class Registry {
public:
    std::array<SharedSlot, kSlots> slots{};
    std::array<std::atomic<uint64_t>, 65536> eras{};
    std::atomic<uint64_t> nextOwner{1}, nextToken{1};
    int claim(uint64_t& owner) noexcept {
        owner = nextOwner.fetch_add(1, std::memory_order_relaxed);
        if (!owner) owner = nextOwner.fetch_add(1, std::memory_order_relaxed);
        for (unsigned i = 0; i < kSlots; ++i) {
            uint64_t empty = 0;
            if (slots[i].owner.compare_exchange_strong(empty, owner, std::memory_order_acq_rel)) {
                slots[i].enabled.store(false, std::memory_order_release); return int(i);
            }
        }
        return -1;
    }
    void release(int index) noexcept {
        if (index < 0) return;
        auto& s = slots[unsigned(index)];
        s.enabled.store(false, std::memory_order_release);
        s.owner.store(0, std::memory_order_release);
    }
    uint64_t era(unsigned group) const noexcept { return eras[group].load(std::memory_order_seq_cst); }
    void invalidate(unsigned group) noexcept { eras[group].fetch_add(1, std::memory_order_seq_cst); }
};
inline Registry& sharedRegistry() { static Registry registry; return registry; }

// Original console-inspired DSP. No UA/SSL code, model data, or plug-in hosting is used.
// The fixed latency gives ordinarily scheduled peer instances time to publish their dry
// colored input. Published samples never contain received leakage, preventing a feedback loop.
struct LocalFrame {
    int64_t stamp = kInvalidStamp; uint64_t era = 0; float l = 0, r = 0;
    void write(int64_t time, uint64_t e, float left, float right) noexcept { stamp = time; era = e; l = left; r = right; }
    bool read(int64_t time, uint64_t e, float& left, float& right) const noexcept { if (stamp != time || era != e) return false; left = l; right = r; return true; }
};
class Processor {
    Registry& registry_;
    int slot_ = -1;
    uint64_t owner_ = 0, era_ = 0, publishToken_ = 0;
    unsigned group_ = 1, role_ = 0;
    double rate_ = 48000;
    int64_t expected_ = kInvalidStamp;
    uint64_t localEra_ = 1;
    std::array<LocalFrame, kRing> delay_{};
    float previousX_[2]{}, previousY_[2]{};
    float smVariation_ = .2f, smDrive_ = 1.f, smTrim_ = 1.f, smCross_ = 0.f;
    float smoothing_ = .001f;
    bool wasPublishing_ = false, wasReceiving_ = false, smoothingReady_ = false;
    void clearLocal() noexcept {
        smoothingReady_ = false;
        ++localEra_; previousX_[0] = previousX_[1] = previousY_[0] = previousY_[1] = 0;
    }
public:
    explicit Processor(Registry& registry = sharedRegistry()) : registry_(registry) {}
    ~Processor() { deactivate(); }
    Processor(const Processor&) = delete;
    Processor& operator=(const Processor&) = delete;
    bool activate(double sampleRate) noexcept {
        deactivate(); rate_ = sampleRate;
        smoothing_ = 1.f - std::exp(-1.f / float(.01 * rate_));
        slot_ = registry_.claim(owner_); expected_ = kInvalidStamp; clearLocal();
        // A saturated registry affects crosstalk only; this instance's color/delay still work.
        return slot_ >= 0;
    }
    void deactivate() noexcept { registry_.release(slot_); slot_ = -1; expected_ = kInvalidStamp; wasPublishing_ = wasReceiving_ = false; }
    int registrySlot() const noexcept { return slot_; }
    void reset() noexcept {
        if (expected_ != kInvalidStamp && wasReceiving_) registry_.invalidate(group_);
        era_ = registry_.era(group_); expected_ = kInvalidStamp; clearLocal();
        if (slot_ >= 0) registry_.slots[unsigned(slot_)].enabled.store(false, std::memory_order_release);
        wasPublishing_ = wasReceiving_ = false; smCross_ = 0.f; publishToken_ = 0;
    }
    void process(const float* left, const float* right, float* outLeft, float* outRight,
                 unsigned count, int64_t time, const Parameters& p, bool bypass = false) noexcept {
        const unsigned group = unsigned(clampParam(Group, p[Group]));
        const unsigned role = unsigned(clampParam(Role, p[Role]));
        const bool enabled = !bypass && p[CrosstalkEnabled] >= .5f;
        const bool wantsPublish = enabled && role == 0;
        const bool changed = group != group_ || role != role_;
        const bool discontinuity = expected_ != kInvalidStamp && time != expected_;
        if (discontinuity && wasReceiving_) registry_.invalidate(group_);
        if (discontinuity) clearLocal();
        if (changed || discontinuity) smCross_ = 0.f;
        group_ = group; role_ = role;
        const uint64_t era = registry_.era(group_);
        if (era != era_) { era_ = era; smCross_ = 0.f; }
        expected_ = time + int64_t(count);
        if (!wantsPublish && slot_ >= 0) { registry_.release(slot_); slot_ = -1; publishToken_ = 0; }
        if (wantsPublish && slot_ < 0) { slot_ = registry_.claim(owner_); publishToken_ = 0; }
        const bool publishing = wantsPublish && slot_ >= 0;
        // Buses/master receive track history without publishing their downstream input.
        // This keeps every role in one console group without returning bus/master audio
        // into upstream tracks. A track that exceeds publisher capacity stays isolated.
        const bool receiving = enabled && (role != 0 || publishing);
        if (changed || discontinuity || publishing != wasPublishing_ || !publishToken_ ||
            (slot_ >= 0 && registry_.slots[unsigned(slot_)].groupEra.load(std::memory_order_relaxed) != era_))
            publishToken_ = registry_.nextToken.fetch_add(1, std::memory_order_relaxed);
        const uint64_t token = publishToken_;
        SharedSlot* own = slot_ >= 0 ? &registry_.slots[unsigned(slot_)] : nullptr;
        if (own) {
            // Readers require both a matching group and this generation's frame token.
            if (changed || discontinuity || !publishing) own->enabled.store(false, std::memory_order_release);
            own->group.store(group_, std::memory_order_relaxed);
            own->rate.store(unsigned(std::llround(rate_)), std::memory_order_relaxed);
            own->seed.store(unsigned(clampParam(Seed, p[Seed])), std::memory_order_relaxed);
            own->token.store(token, std::memory_order_release);
            own->groupEra.store(era_, std::memory_order_release);
            own->enabled.store(publishing, std::memory_order_release);
        }
        std::array<unsigned, kNeighbors> peers{};
        std::array<uint64_t, kNeighbors> peerTokens{};
        std::array<uint64_t, kNeighbors> ranks{}; ranks.fill(std::numeric_limits<uint64_t>::max());
        unsigned peerCount = 0;
        if (receiving) for (unsigned i = 0; i < kSlots; ++i) {
            auto& peer = registry_.slots[i];
            const auto owner = peer.owner.load(std::memory_order_acquire);
            if (int(i) != slot_ && owner && peer.enabled.load(std::memory_order_acquire) &&
                peer.group.load(std::memory_order_relaxed) == group_ &&
                peer.rate.load(std::memory_order_relaxed) == unsigned(std::llround(rate_)) &&
                peer.groupEra.load(std::memory_order_acquire) == era_) {
                const unsigned seedDistance = unsigned(std::abs(int(peer.seed.load(std::memory_order_relaxed)) - int(clampParam(Seed, p[Seed]))));
                const uint64_t rank = (uint64_t(seedDistance) << 32) | i;
                for (unsigned n = 0; n < kNeighbors; ++n) if (rank < ranks[n]) {
                    for (unsigned j = kNeighbors - 1; j > n; --j) { ranks[j] = ranks[j-1]; peers[j] = peers[j-1]; peerTokens[j] = peerTokens[j-1]; }
                    ranks[n] = rank; peers[n] = i; peerTokens[n] = peer.token.load(std::memory_order_acquire);
                    peerCount = std::min(kNeighbors, peerCount + 1); break;
                }
            }
        }
        const float variationTarget = std::clamp(p[Variation] * .01f, 0.f, 1.f);
        const float driveTarget = std::pow(10.f, std::clamp(p[Drive], 0.f, 18.f) / 20.f);
        const float trimTarget = std::pow(10.f, std::clamp(p[OutputTrim], -12.f, 12.f) / 20.f);
        const float crossTarget = receiving ? std::pow(10.f, std::clamp(p[Crosstalk], -100.f, -40.f) / 20.f) : 0.f;
        if (!smoothingReady_) { smVariation_ = variationTarget; smDrive_ = driveTarget; smTrim_ = trimTarget; smCross_ = 0; smoothingReady_ = true; }
        const unsigned seed = unsigned(clampParam(Seed, p[Seed]));
        const float gainVariation[2] = {bipolar(seed * 7u + 1u), bipolar(seed * 7u + 2u)};
        const float biasVariation[2] = {bipolar(seed * 7u + 3u), bipolar(seed * 7u + 4u)};
        const float dcPole = std::exp(-2.f * 3.14159265358979323846f * 6.f / float(rate_));
        for (unsigned f = 0; f < count; ++f) {
            const int64_t now = time + int64_t(f), delayed = now - kLatency;
            const unsigned index = unsigned(uint64_t(now) & (kRing - 1));
            smVariation_ += smoothing_ * (variationTarget - smVariation_);
            smDrive_ += smoothing_ * (driveTarget - smDrive_);
            smTrim_ += smoothing_ * (trimTarget - smTrim_);
            smCross_ += smoothing_ * (crossTarget - smCross_);
            float colored[2]{};
            for (unsigned c = 0; c < 2; ++c) {
                float x = (c == 1 && right) ? right[f] : left[f];
                if (!std::isfinite(x)) x = 0.f;
                x = std::clamp(x, -32.f, 32.f);
                if (bypass) { colored[c] = x; continue; }
                const float slope = .48f * smDrive_ * (1.f + .18f * smVariation_ * gainVariation[c]);
                const float bias = .12f * smVariation_ * biasVariation[c];
                const float base = std::tanh(bias);
                const float shaped = (std::tanh(slope * x + bias) - base) / (slope * (1.f - base * base));
                // Low-level slope is unity. A 6 Hz blocker removes generated DC.
                const float dc = shaped - previousX_[c] + dcPole * previousY_[c];
                previousX_[c] = shaped;
                previousY_[c] = std::abs(dc) < 1.e-20f ? 0.f : dc;
                colored[c] = previousY_[c];
            }
            delay_[index].write(now, localEra_, colored[0], colored[1]);
            if (own && publishing) own->frames[index].write(now, token, colored[0], colored[1]);
            float l = 0.f, r = 0.f;
            delay_[unsigned(uint64_t(delayed) & (kRing - 1))].read(delayed, localEra_, l, r);
            if (receiving && peerCount && smCross_ > 0.f) {
                float bleedL = 0.f, bleedR = 0.f;
                for (unsigned n = 0; n < peerCount; ++n) {
                    auto& peer = registry_.slots[peers[n]];
                    // Recheck owner/group/enabled after the snapshot to avoid reuse races.
                    if (!peer.owner.load(std::memory_order_acquire) ||
                        peer.token.load(std::memory_order_acquire) != peerTokens[n] ||
                        peer.groupEra.load(std::memory_order_acquire) != era_ ||
                        !peer.enabled.load(std::memory_order_acquire) || peer.group.load(std::memory_order_relaxed) != group_) continue;
                    float pl = 0.f, pr = 0.f;
                    if (peer.frames[unsigned(uint64_t(delayed) & (kRing - 1))].read(delayed, peerTokens[n], pl, pr)) {
                        bleedL += pl; bleedR += pr;
                    }
                }
                l += smCross_ * bleedL / float(peerCount);
                r += smCross_ * bleedR / float(peerCount);
            }
            const float trim = bypass ? 1.f : smTrim_;
            if (outRight) { outLeft[f] = l * trim; outRight[f] = r * trim; }
            else outLeft[f] = .5f * (l + r) * trim;
        }
        wasPublishing_ = publishing; wasReceiving_ = receiving;
    }
};
} // namespace econsole
