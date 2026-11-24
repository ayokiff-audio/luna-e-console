#include "../src/ConsoleDSP.hpp"
#include <cstdlib>
#include <chrono>
#include <iostream>
#include <memory>
#include <thread>
#include <vector>
using namespace econsole;
namespace {
unsigned checks = 0;
void require(bool condition, const char* message) { ++checks; if (!condition) { std::cerr << "FAIL: " << message << '\n'; std::exit(1); } }
double rms(const std::vector<float>& values, unsigned first = 0) { double n = 0; for (unsigned i = first; i < values.size(); ++i) n += double(values[i]) * values[i]; return std::sqrt(n / std::max<size_t>(1, values.size() - first)); }
double harmonic(const std::vector<float>& values, unsigned multiple) {
    double real=0,imaginary=0;const unsigned first=8192,length=4800;
    for(unsigned i=0;i<length;++i){const double phase=2*3.14159265358979323846*1000*multiple*i/48000;real+=values[first+i]*std::cos(phase);imaginary-=values[first+i]*std::sin(phase);}
    return 2*std::sqrt(real*real+imaginary*imaginary)/length;
}
std::vector<float> run(Processor& dsp, const Parameters& p, unsigned count = 16000, bool sine = true, bool bypass = false, int64_t start = 0) {
    std::vector<float> output(count), in(512), out(512);
    for (unsigned f = 0; f < count; f += 512) {
        const unsigned n = std::min(512u, count - f);
        for (unsigned j = 0; j < n; ++j) in[j] = sine ? .5f * std::sin(float(2 * 3.14159265358979323846 * 1000 * (f + j) / 48000)) : 0.f;
        dsp.process(in.data(), nullptr, out.data(), nullptr, n, start + f, p, bypass);
        std::copy_n(out.data(), n, output.data() + f);
    } return output;
}
void paired(Registry& registry, const Parameters& sourceP, const Parameters& receiverP, std::vector<float>& received, bool reverse = false) {
    auto source = std::make_unique<Processor>(registry), receiver = std::make_unique<Processor>(registry);
    source->activate(48000); receiver->activate(48000);
    std::array<float, 512> in{}, zero{}, discard{}, out{};
    received.clear();
    for (unsigned f = 0; f < 16384; f += 512) {
        for (unsigned j = 0; j < 512; ++j) in[j] = .5f * std::sin(float(2 * 3.14159265358979323846 * 1000 * (f + j) / 48000));
        if (reverse) receiver->process(zero.data(), nullptr, out.data(), nullptr, 512, f, receiverP);
        source->process(in.data(), nullptr, discard.data(), nullptr, 512, f, sourceP);
        if (!reverse) receiver->process(zero.data(), nullptr, out.data(), nullptr, 512, f, receiverP);
        received.insert(received.end(), out.begin(), out.end());
    }
}
}
int main() {
    auto registry = std::make_unique<Registry>();
    Parameters p; p.values[Seed] = 900; p.values[Variation] = 20;
    {
        auto d = std::make_unique<Processor>(*registry); d->activate(48000);
        std::vector<float> input(8192), output(8192); input[0] = .25f;
        for (unsigned f = 0; f < input.size(); f += 512) d->process(input.data()+f, nullptr, output.data()+f, nullptr, 512, f, p, true);
        require(output[kLatency] == .25f, "dry bypass has exactly reported 4096 sample latency");
        output[kLatency] = 0; require(rms(output) == 0, "bypass impulse has no extra output");
    }
    {
        auto a = std::make_unique<Processor>(*registry), b = std::make_unique<Processor>(*registry);
        a->activate(48000); b->activate(48000);
        const auto one = run(*a, p), two = run(*b, p);
        require(one == two, "same seed and state produce identical signal");
        for (unsigned i = 0; i < kLatency; ++i) require(one[i] == 0, "startup contains no stale samples");
        require(rms(one, 8192) > .30 && rms(one,8192) < .36, "default color remains near unity at -6 dBFS");
        a->reset(); b->reset(); Parameters different=p; different.values[Seed]=901;
        const auto three=run(*a,p), four=run(*b,different);
        double delta=0; for(unsigned i=8192;i<three.size();++i) delta += std::abs(three[i]-four[i]);
        require(delta > .1, "different seeds produce different harmonic waveforms");
        require(harmonic(three,3)>1.e-5,"console saturation generates a measurable third harmonic");
        require(std::abs(harmonic(three,2)-harmonic(four,2))>1.e-6,"seed changes measured second harmonic amplitude");
        a->reset(); const auto silence=run(*a,p,8192,false);
        require(rms(silence)==0,"reset clears delay, filters, and stale audio");
    }
    Parameters cross=p; cross.values[CrosstalkEnabled]=1; cross.values[Crosstalk]=-40; cross.values[Group]=31415;
    std::vector<float> bleed, reverse;
    paired(*registry,cross,cross,bleed);
    paired(*registry,cross,cross,reverse,true);
    require(rms(bleed,8192)>.002 && rms(bleed,8192)<.004,"actual cross-instance audio is audible at requested -40 dB");
    require(bleed==reverse,"ordinary block ordering does not change delayed crosstalk");
    Parameters other=cross; other.values[Group]=31416;
    paired(*registry,cross,other,bleed); require(rms(bleed)==0,"different console groups never interact");
    other=cross; other.values[CrosstalkEnabled]=0;
    paired(*registry,cross,other,bleed); require(rms(bleed)==0,"disabled receiver is silent");
    paired(*registry,other,cross,bleed); require(rms(bleed)==0,"disabled sender publishes nothing");
    for(unsigned role=1;role<=2;++role) {
        other=cross;other.values[Role]=float(role);
        paired(*registry,cross,other,bleed); require(rms(bleed,8192)>.002 && rms(bleed,8192)<.004,"bus/master receives bounded track leakage");
        paired(*registry,cross,other,reverse,true);require(bleed==reverse,"receive-only bus/master is independent of normal render order");
        auto disabled=other;disabled.values[CrosstalkEnabled]=0;
        paired(*registry,cross,disabled,bleed);require(rms(bleed)==0,"bus/master reception is off unless explicitly enabled");
        auto separate=other;separate.values[Group]=31416;
        paired(*registry,cross,separate,bleed);require(rms(bleed)==0,"receive-only bus/master obeys console group isolation");
        paired(*registry,other,cross,bleed); require(rms(bleed)==0,"bus/master roles never publish leakage");
    }
    {
        auto d=std::make_unique<Processor>(*registry);d->activate(48000);
        require(rms(run(*d,cross,8192,false))==0,"one instance never leaks to itself");
    }
    {
        auto source=std::make_unique<Processor>(*registry),receiver=std::make_unique<Processor>(*registry);
        source->activate(48000);receiver->activate(48000);
        run(*source,cross,8192,true);run(*receiver,cross,8192,false);
        receiver->reset();
        require(rms(run(*receiver,cross,8192,false))==0,"reset invalidates stopped sender's earlier audio");
    }
    for(unsigned role=1;role<=2;++role){
        for(bool resetInsteadOfSeek:{true,false}){
            auto source=std::make_unique<Processor>(*registry),receiver=std::make_unique<Processor>(*registry);
            source->activate(48000);receiver->activate(48000);auto bus=cross;bus.values[Role]=float(role);
            run(*source,cross,8192,true);
            require(rms(run(*receiver,bus,8192,false),4096)>.001,"receive-only receiver has live track history before reset/seek test");
            if(resetInsteadOfSeek)receiver->reset();
            require(rms(run(*receiver,bus,8192,false))==0,resetInsteadOfSeek?"receive-only bus/master reset cannot replay stopped publisher history":"receive-only bus/master backward seek invalidates stopped publisher history");
        }
    }
    {
        auto d=std::make_unique<Processor>(*registry);d->activate(48000);
        Parameters extreme=p;extreme.values[Drive]=18;extreme.values[OutputTrim]=12;extreme.values[Variation]=100;
        std::vector<float> in(512,32.f),out(512);in[4]=std::numeric_limits<float>::quiet_NaN();in[5]=std::numeric_limits<float>::infinity();
        for(unsigned f=0;f<8192;f+=512){d->process(in.data(),nullptr,out.data(),nullptr,512,f,extreme);for(auto x:out)require(std::isfinite(x)&&std::abs(x)<100,"extreme and invalid input stays finite and bounded");}
    }
    {
        auto warm=std::make_unique<Processor>(*registry),fresh=std::make_unique<Processor>(*registry);
        warm->activate(48000);fresh->activate(48000);auto driven=p;driven.values[Drive]=18;driven.values[OutputTrim]=12;
        run(*warm,driven,8192,true);warm->reset();
        require(run(*warm,p)==run(*fresh,p),"reset removes old smoothing history for deterministic fresh renders");
    }
    {
        auto source=std::make_unique<Processor>(*registry),receiver=std::make_unique<Processor>(*registry),reference=std::make_unique<Processor>(*registry);
        source->activate(48000);receiver->activate(48000);reference->activate(48000);
        run(*source,cross,8192,false);run(*receiver,cross,8192,true);run(*reference,p,8192,true);
        source->reset();
        require(run(*receiver,cross,8192,true,false,8192)==run(*reference,p,8192,true,false,8192),"peer reset never clears this track's dry audio delay");
        auto isolated=std::make_unique<Processor>(*registry);isolated->activate(48000);run(*isolated,p,8192,false);
        const auto era=registry->era(unsigned(p[Group]));isolated->reset();
        require(registry->era(unsigned(p[Group]))==era,"harmonic-only reset does not invalidate peer group history");
    }
    {
        // Concurrent read/write exercises atomic frame publication with a producer/receiver
        // deliberately running out of alignment. Missing history must be silence, never torn audio.
        auto a=std::make_unique<Processor>(*registry),b=std::make_unique<Processor>(*registry);a->activate(48000);b->activate(48000);
        auto work=[&](Processor& d,const Parameters& settings){std::array<float,128> in{},out{};in.fill(.1f);for(int t=0;t<128000;t+=128){d.process(in.data(),nullptr,out.data(),nullptr,128,t,settings);for(float x:out)if(!std::isfinite(x))std::abort();}};
        std::thread t1([&]{work(*a,cross);}),t2([&]{work(*b,cross);});t1.join();t2.join();require(true,"concurrent peer render stays finite without locks");
        a->reset();b->reset();auto receiveOnly=cross;receiveOnly.values[Role]=1;
        std::thread t3([&]{work(*a,cross);}),t4([&]{work(*b,receiveOnly);});t3.join();t4.join();require(true,"concurrent track publishing and bus receiving stay finite without locks");
    }
    {
        std::vector<std::unique_ptr<Processor>> channels;
        std::vector<Parameters> parameters;
        for (unsigned i=0;i<kSlots+1;++i) {
            channels.push_back(std::make_unique<Processor>(*registry));
            const bool registered=channels.back()->activate(48000);
            require(registered == (i<kSlots), "64 participating slots, additional color-only instance is explicit");
            auto settings=cross;settings.values[Seed]=float(1+i*997);parameters.push_back(settings);
        }
        std::array<float,512> in{},out{};in.fill(.2f);
        const auto start=std::chrono::steady_clock::now();
        for(unsigned t=0;t<48000;t+=512) {
            const unsigned frames=std::min(512u,48000u-t);
            for(unsigned j=0;j<frames;++j)in[j]=.2f*std::sin(float(2*3.14159265358979323846*1000*(t+j)/48000));
            for(unsigned i=0;i<kSlots;++i)channels[i]->process(in.data(),nullptr,out.data(),nullptr,frames,t,parameters[i]);
        }
        const double seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
        auto receiveOnly=std::make_unique<Processor>(*registry);require(!receiveOnly->activate(48000),"publisher registry is full before bus receiver joins");
        auto bus=cross;bus.values[Role]=1;
        const auto busSignal=run(*receiveOnly,bus,8192,false,false,39808);
        require(receiveOnly->registrySlot()==-1,"bus receiver never consumes a publisher slot");
        require(rms(busSignal,4096)>1.e-5,"bus still receives track audio when all 64 publisher slots are occupied");
        std::cout<<"64-track benchmark: "<<seconds<<" wall seconds for 1 second at 48 kHz / 512 frames, leakage on, two nearest peers.\n";
    }
    std::cout<<"DSP checks passed ("<<checks<<" assertions): fixed latency, deterministic seeded color, real leakage, render order, group/receive-only-role/off isolation, reset, finite bounds, concurrent publication.\n";
}
