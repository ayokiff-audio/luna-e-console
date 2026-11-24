#include <AudioToolbox/AudioToolbox.h>
#include <CoreFoundation/CoreFoundation.h>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <vector>
#include <array>
#include <limits.h>
#include "../src/ConsoleDSP.hpp"
using namespace econsole;
// A registrar may be inaccessible under an execution sandbox. These helpers use the
// same public selector signatures to exercise the actual loaded bundle without installing it.
static AudioComponentPlugInInterface* direct = nullptr;
static OSStatus hostGetPropertyInfo(AudioUnit u, AudioUnitPropertyID id, AudioUnitScope scope, AudioUnitElement element, UInt32* n, Boolean* w) {
    if (direct) return reinterpret_cast<AudioUnitGetPropertyInfoProc>(direct->Lookup(kAudioUnitGetPropertyInfoSelect))(direct,id,scope,element,n,w);
    return AudioUnitGetPropertyInfo(u,id,scope,element,n,w);
}
static OSStatus hostGetProperty(AudioUnit u,AudioUnitPropertyID id,AudioUnitScope scope,AudioUnitElement element,void* data,UInt32* n) {
    if(direct)return reinterpret_cast<AudioUnitGetPropertyProc>(direct->Lookup(kAudioUnitGetPropertySelect))(direct,id,scope,element,data,n);return AudioUnitGetProperty(u,id,scope,element,data,n);
}
static OSStatus hostSetProperty(AudioUnit u,AudioUnitPropertyID id,AudioUnitScope scope,AudioUnitElement element,const void* data,UInt32 n) {
    if(direct)return reinterpret_cast<AudioUnitSetPropertyProc>(direct->Lookup(kAudioUnitSetPropertySelect))(direct,id,scope,element,data,n);return AudioUnitSetProperty(u,id,scope,element,data,n);
}
static OSStatus hostGetParameter(AudioUnit u,AudioUnitParameterID id,AudioUnitScope scope,AudioUnitElement element,AudioUnitParameterValue* value) {
    if(direct)return reinterpret_cast<AudioUnitGetParameterProc>(direct->Lookup(kAudioUnitGetParameterSelect))(direct,id,scope,element,value);return AudioUnitGetParameter(u,id,scope,element,value);
}
static OSStatus hostSetParameter(AudioUnit u,AudioUnitParameterID id,AudioUnitScope scope,AudioUnitElement element,AudioUnitParameterValue value,UInt32 offset) {
    if(direct)return reinterpret_cast<AudioUnitSetParameterProc>(direct->Lookup(kAudioUnitSetParameterSelect))(direct,id,scope,element,value,offset);return AudioUnitSetParameter(u,id,scope,element,value,offset);
}
static OSStatus hostInitialize(AudioUnit u) {if(direct)return reinterpret_cast<AudioUnitInitializeProc>(direct->Lookup(kAudioUnitInitializeSelect))(direct);return AudioUnitInitialize(u);}
static OSStatus hostUninitialize(AudioUnit u) {if(direct)return reinterpret_cast<AudioUnitUninitializeProc>(direct->Lookup(kAudioUnitUninitializeSelect))(direct);return AudioUnitUninitialize(u);}
static OSStatus hostReset(AudioUnit u,AudioUnitScope scope,AudioUnitElement element) {if(direct)return reinterpret_cast<AudioUnitResetProc>(direct->Lookup(kAudioUnitResetSelect))(direct,scope,element);return AudioUnitReset(u,scope,element);}
static OSStatus hostRender(AudioUnit u,AudioUnitRenderActionFlags* flags,const AudioTimeStamp* time,UInt32 bus,UInt32 frames,AudioBufferList* data) {
    if(direct)return reinterpret_cast<AudioUnitRenderProc>(direct->Lookup(kAudioUnitRenderSelect))(direct,flags,time,bus,frames,data);return AudioUnitRender(u,flags,time,bus,frames,data);
}
static OSStatus hostProcess(AudioUnit u,AudioUnitRenderActionFlags* flags,const AudioTimeStamp* time,UInt32 frames,AudioBufferList* data) {
    if(direct)return reinterpret_cast<AudioUnitProcessProc>(direct->Lookup(kAudioUnitProcessSelect))(direct,flags,time,frames,data);return AudioUnitProcess(u,flags,time,frames,data);
}
#define AudioUnitGetPropertyInfo hostGetPropertyInfo
#define AudioUnitGetProperty hostGetProperty
#define AudioUnitSetProperty hostSetProperty
#define AudioUnitGetParameter hostGetParameter
#define AudioUnitSetParameter hostSetParameter
#define AudioUnitInitialize hostInitialize
#define AudioUnitUninitialize hostUninitialize
#define AudioUnitReset hostReset
#define AudioUnitRender hostRender
namespace {
unsigned checks=0;
void require(bool ok,const char* text){++checks;if(!ok){std::cerr<<"FAIL: "<<text<<'\n';std::exit(1);}}
void status(OSStatus s,const char* text){if(s){std::cerr<<text<<": OSStatus "<<s<<'\n';std::exit(1);}++checks;}
struct Buffers { UInt32 count; AudioBuffer channels[2]; };
OSStatus input(void*,AudioUnitRenderActionFlags*,const AudioTimeStamp* time,UInt32,UInt32 frames,AudioBufferList* list){
    for(unsigned c=0;c<list->mNumberBuffers;++c){auto* samples=static_cast<float*>(list->mBuffers[c].mData);for(unsigned f=0;f<frames;++f)for(unsigned channel=0;channel<list->mBuffers[c].mNumberChannels;++channel)samples[f*list->mBuffers[c].mNumberChannels+channel]=.25f*std::sin(float(2*3.14159265358979323846*1000*(time->mSampleTime+f)/48000));}return noErr;
}

struct NativeStimulus { float gain; };
OSStatus nativeInput(void* context,AudioUnitRenderActionFlags*,const AudioTimeStamp* time,UInt32,UInt32 frames,AudioBufferList* list){
    const float gain=static_cast<NativeStimulus*>(context)->gain;
    for(unsigned c=0;c<list->mNumberBuffers;++c){auto* samples=static_cast<float*>(list->mBuffers[c].mData);
        for(unsigned f=0;f<frames;++f)for(unsigned channel=0;channel<list->mBuffers[c].mNumberChannels;++channel)
            samples[f*list->mBuffers[c].mNumberChannels+channel]=gain*std::sin(float(2*3.14159265358979323846*1000*(time->mSampleTime+f)/48000));
    }return noErr;
}
struct NativeUnit {
    AudioComponentPlugInInterface* au;
    NativeStimulus stimulus;
    NativeUnit(AudioComponentFactoryFunction factory,const AudioComponentDescription& description,float gain):au(factory(&description)),stimulus{gain}{
        require(au,"create additional built native instance");status(au->Open(au,reinterpret_cast<AudioComponentInstance>(au)),"open additional native instance");
        AURenderCallbackStruct callback{nativeInput,&stimulus};
        status(reinterpret_cast<AudioUnitSetPropertyProc>(au->Lookup(kAudioUnitSetPropertySelect))(au,kAudioUnitProperty_SetRenderCallback,kAudioUnitScope_Input,0,&callback,sizeof(callback)),"native instance signal connection");
        status(reinterpret_cast<AudioUnitInitializeProc>(au->Lookup(kAudioUnitInitializeSelect))(au),"initialize additional native instance");
    }
    ~NativeUnit(){reinterpret_cast<AudioUnitUninitializeProc>(au->Lookup(kAudioUnitUninitializeSelect))(au);au->Close(au);}
    void set(unsigned id,float value){status(reinterpret_cast<AudioUnitSetParameterProc>(au->Lookup(kAudioUnitSetParameterSelect))(au,id,kAudioUnitScope_Global,0,value,0),"write real native AU parameter");}
    float defaultSeed(){AudioUnitParameterInfo info{};UInt32 bytes=sizeof(info);status(reinterpret_cast<AudioUnitGetPropertyProc>(au->Lookup(kAudioUnitGetPropertySelect))(au,kAudioUnitProperty_ParameterInfo,kAudioUnitScope_Global,Seed,&info,&bytes),"read immutable per-instance native seed default");const float value=info.defaultValue;if(info.flags&kAudioUnitParameterFlag_CFNameRelease)CFRelease(info.cfNameString);return value;}
    float get(unsigned id){float value=0;status(reinterpret_cast<AudioUnitGetParameterProc>(au->Lookup(kAudioUnitGetParameterSelect))(au,id,kAudioUnitScope_Global,0,&value),"read real native AU parameter");return value;}
    void reset(){status(reinterpret_cast<AudioUnitResetProc>(au->Lookup(kAudioUnitResetSelect))(au,kAudioUnitScope_Global,0),"reset native capture state");}
    std::array<float,512> render(unsigned time){std::array<float,512> left{},right{};Buffers data{2,{{1,2048,left.data()},{1,2048,right.data()}}};AudioTimeStamp stamp{};stamp.mSampleTime=time;stamp.mFlags=kAudioTimeStampSampleTimeValid;AudioUnitRenderActionFlags flags=0;
        status(reinterpret_cast<AudioUnitRenderProc>(au->Lookup(kAudioUnitRenderSelect))(au,&flags,&stamp,0,512,reinterpret_cast<AudioBufferList*>(&data)),"render actual native instance");return left;}
};
double nativeRms(const std::vector<float>& values,unsigned first=8192){double energy=0;for(unsigned i=first;i<values.size();++i)energy+=double(values[i])*values[i];return std::sqrt(energy/std::max<size_t>(1,values.size()-first));}
std::vector<float> nativeCapture(NativeUnit& unit){std::vector<float> result;unit.reset();for(unsigned t=0;t<16384;t+=512){const auto block=unit.render(t);result.insert(result.end(),block.begin(),block.end());}return result;}
void nativeIntegration(AudioComponentFactoryFunction factory,const AudioComponentDescription& description){
    {
        NativeUnit first(factory,description,0),second(factory,description,0);
        const auto firstDefault=first.defaultSeed(),secondDefault=second.defaultSeed();
        require(firstDefault!=secondDefault,"new instances expose distinct default seed identities");
        require(first.get(Seed)==firstDefault&&second.get(Seed)==secondDefault,"native seed values match instance parameter metadata defaults");
        first.set(Seed,1234);require(first.defaultSeed()==firstDefault,"seed default identity is immutable after manual parameter edits");
        first.set(Seed,firstDefault);second.set(Seed,secondDefault);
        require(first.get(Seed)!=second.get(Seed),"host default initialization preserves distinct actual native seeds");
    }
    {
        NativeUnit unit(factory,description,.5f);unit.set(Variation,100);unit.set(Seed,1001);require(unit.get(Seed)==1001,"seed readback reaches native binary");
        const auto first=nativeCapture(unit);unit.set(Seed,1002);require(unit.get(Seed)==1002,"new seed readback reaches native binary");const auto changed=nativeCapture(unit);
        double difference=0;for(unsigned i=8192;i<first.size();++i)difference+=std::abs(first[i]-changed[i]);require(difference>.1,"native seed parameter changes rendered audio, not just stored metadata");
        unit.set(Seed,1001);require(nativeCapture(unit)==first,"restoring native seed restores exact rendered color");
    }
    for(unsigned role=1;role<=2;++role){
        for(bool downstreamIsSource:{false,true}){
            NativeUnit source(factory,description,.5f),receiver(factory,description,0);
            source.set(Group,61337);receiver.set(Group,61337);source.set(Seed,101);receiver.set(Seed,102);
            source.set(CrosstalkEnabled,1);receiver.set(CrosstalkEnabled,1);source.set(Crosstalk,-40);receiver.set(Crosstalk,-40);
            source.set(Role,downstreamIsSource?float(role):0);receiver.set(Role,downstreamIsSource?0:float(role));
            std::vector<float> result;for(unsigned t=0;t<16384;t+=512){source.render(t);const auto block=receiver.render(t);result.insert(result.end(),block.begin(),block.end());}
            if(downstreamIsSource)require(nativeRms(result)==0,"actual bus/master native input cannot leak back to upstream track");
            else require(nativeRms(result)>.002&&nativeRms(result)<.004,"actual native bus/master receives bounded track audio through shared group");
            if(!downstreamIsSource){
                receiver.reset();std::vector<float> stopped;
                for(unsigned t=0;t<16384;t+=512){const auto block=receiver.render(t);stopped.insert(stopped.end(),block.begin(),block.end());}
                require(nativeRms(stopped)==0,"actual receive-only native reset cannot replay a stopped track's old history");
            }
            receiver.set(CrosstalkEnabled,0);receiver.reset();result.clear();
            for(unsigned t=0;t<16384;t+=512){source.render(t);const auto block=receiver.render(t);result.insert(result.end(),block.begin(),block.end());}
            require(nativeRms(result)==0,"native disable immediately prevents optional bus/master reception after reset");
        }
    }
}
}
int main(int argc,char**argv){
    require(argc==2,"bundle path argument");char absolute[PATH_MAX];require(realpath(argv[1],absolute),"resolve bundle path");
    auto url=CFURLCreateFromFileSystemRepresentation(nullptr,reinterpret_cast<const UInt8*>(absolute),std::strlen(absolute),true);
    auto bundle=CFBundleCreate(nullptr,url);CFRelease(url);require(bundle,"create native bundle");
    require(CFBundleLoadExecutable(bundle),"load native bundle executable");
    auto factory=reinterpret_cast<AudioComponentFactoryFunction>(CFBundleGetFunctionPointerForName(bundle,CFSTR("EConsoleFactory")));require(factory,"factory symbol exists");
    AudioComponentDescription desc{kAudioUnitType_Effect,'ECA1','ECns',kAudioComponentFlag_SandboxSafe,0};
    auto component=AudioComponentRegister(&desc,CFSTR("E Console: E Console Analog"),0x00000101,factory);
    AudioUnit unit=nullptr;
    if(component) status(AudioComponentInstanceNew(component,&unit),"instantiate through Apple AudioComponent host");
    else {
        std::cout<<"AudioComponent registrar unavailable; exercising loaded AU through public factory/selector ABI.\n";
        direct=factory(&desc);require(direct,"instantiate factory directly");status(direct->Open(direct,reinterpret_cast<AudioComponentInstance>(direct)),"open native factory");
    }
    UInt32 bytes=0;Boolean writable=false;status(AudioUnitGetPropertyInfo(unit,kAudioUnitProperty_ParameterList,kAudioUnitScope_Global,0,&bytes,&writable),"parameter list metadata");
    require(bytes==ParamCount*sizeof(AudioUnitParameterID),"eight declared parameters");
    std::array<AudioUnitParameterID,ParamCount> ids{};status(AudioUnitGetProperty(unit,kAudioUnitProperty_ParameterList,kAudioUnitScope_Global,0,ids.data(),&bytes),"parameter list");
    for(unsigned i=0;i<ParamCount;++i){AudioUnitParameterInfo info{};bytes=sizeof(info);status(AudioUnitGetProperty(unit,kAudioUnitProperty_ParameterInfo,kAudioUnitScope_Global,i,&info,&bytes),"parameter information");require(std::strcmp(info.name,kParams[i].name)==0,"control name exact");if(info.flags&kAudioUnitParameterFlag_CFNameRelease)CFRelease(info.cfNameString);}
    status(AudioUnitSetParameter(unit,Seed,kAudioUnitScope_Global,0,1234,0),"set stable seed");
    status(AudioUnitSetParameter(unit,Variation,kAudioUnitScope_Global,0,37,0),"automatable physical parameter");
    CFPropertyListRef saved=nullptr;bytes=sizeof(saved);status(AudioUnitGetProperty(unit,kAudioUnitProperty_ClassInfo,kAudioUnitScope_Global,0,&saved,&bytes),"serialize AU class info");
    status(AudioUnitSetParameter(unit,Seed,kAudioUnitScope_Global,0,9999,0),"change seed");
    status(AudioUnitSetProperty(unit,kAudioUnitProperty_ClassInfo,kAudioUnitScope_Global,0,&saved,sizeof(saved)),"restore saved state");CFRelease(saved);
    AudioUnitParameterValue seed=0;status(AudioUnitGetParameter(unit,Seed,kAudioUnitScope_Global,0,&seed),"read restored seed");require(seed==1234,"seed survives state round trip");
    AURenderCallbackStruct callback{input,nullptr};status(AudioUnitSetProperty(unit,kAudioUnitProperty_SetRenderCallback,kAudioUnitScope_Input,0,&callback,sizeof(callback)),"connect host render callback");
    status(AudioUnitInitialize(unit),"initialize AU");
    Float64 latency=0;bytes=sizeof(latency);status(AudioUnitGetProperty(unit,kAudioUnitProperty_Latency,kAudioUnitScope_Global,0,&latency,&bytes),"reported latency");require(std::abs(latency-double(kLatency)/48000)<1.e-12,"latency accurate");
    std::array<float,512> left{},right{};double energy=0;
    for(unsigned t=0;t<12288;t+=512){Buffers buffers{2,{{1,512*4,left.data()},{1,512*4,right.data()}}};AudioTimeStamp stamp{};stamp.mSampleTime=t;stamp.mFlags=kAudioTimeStampSampleTimeValid;AudioUnitRenderActionFlags flags=0;
        status(AudioUnitRender(unit,&flags,&stamp,0,512,reinterpret_cast<AudioBufferList*>(&buffers)),"native host renders audio");
        for(auto x:left){require(std::isfinite(x),"native output finite");if(t>=8192)energy+=x*x;}
    }require(energy>1,"rendered nonzero colored audio");
    status(AudioUnitReset(unit,kAudioUnitScope_Global,0),"host reset");
    AudioTimeStamp stamp{};stamp.mFlags=kAudioTimeStampSampleTimeValid;Buffers buffers{2,{{1,512*4,left.data()},{1,512*4,right.data()}}};AudioUnitRenderActionFlags flags=0;
    status(AudioUnitRender(unit,&flags,&stamp,0,512,reinterpret_cast<AudioBufferList*>(&buffers)),"render after reset");for(auto x:left)require(x==0,"reset starts empty latency buffer");
    UInt32 allocate=0;
    require(AudioUnitSetProperty(unit,kAudioUnitProperty_ShouldAllocateBuffer,kAudioUnitScope_Output,0,&allocate,sizeof(allocate))==kAudioUnitErr_Initialized,"buffer allocation cannot mutate during render");
    status(AudioUnitReset(unit,kAudioUnitScope_Global,0),"reset before in-place silence test");
    for(unsigned t=0;t<8192;t+=512){left.fill(12345.f);right.fill(-12345.f);stamp.mSampleTime=t;flags=kAudioUnitRenderAction_OutputIsSilence;
        status(hostProcess(unit,&flags,&stamp,512,reinterpret_cast<AudioBufferList*>(&buffers)),"in-place process accepts host-declared silence");
        for(float x:left)require(x==0,"undefined host-silent buffers cannot leak garbage");
    }
    status(AudioUnitReset(unit,kAudioUnitScope_Global,0),"reset before automation test");
    status(AudioUnitSetParameter(unit,OutputTrim,kAudioUnitScope_Global,0,-12,256),"queue sample-offset automation without allocating");
    stamp.mSampleTime=512;
    status(AudioUnitRender(unit,&flags,&stamp,0,512,reinterpret_cast<AudioBufferList*>(&buffers)),"render scheduled parameter change");
    AudioUnitParameterValue trim=0;status(AudioUnitGetParameter(unit,OutputTrim,kAudioUnitScope_Global,0,&trim),"read scheduled value");require(trim==-12,"scheduled value applies at the next block offset");
    status(AudioUnitUninitialize(unit),"uninitialize");
    for(unsigned configuration=0;configuration<3;++configuration){
        AudioStreamBasicDescription fmt{};fmt.mSampleRate=configuration==2?44100:48000;fmt.mFormatID=kAudioFormatLinearPCM;
        fmt.mFormatFlags=kAudioFormatFlagsNativeFloatPacked|(configuration==1?0:kAudioFormatFlagIsNonInterleaved);
        fmt.mChannelsPerFrame=configuration==0?1:2;fmt.mBitsPerChannel=32;fmt.mFramesPerPacket=1;
        fmt.mBytesPerFrame=fmt.mBytesPerPacket=4*(configuration==1?2:1);
        status(AudioUnitSetProperty(unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Input,0,&fmt,sizeof(fmt)),"set mono/stereo/interleaved input format");
        status(AudioUnitSetProperty(unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Output,0,&fmt,sizeof(fmt)),"set matching output format");
        status(AudioUnitInitialize(unit),"initialize alternate format");
        std::array<float,1024> a{},b{};
        Buffers audio{configuration==2?2u:1u,{{configuration==1?2u:1u,configuration==1?4096u:2048u,a.data()},{1,2048,b.data()}}};
        stamp.mSampleTime=0;
        status(AudioUnitRender(unit,&flags,&stamp,0,512,reinterpret_cast<AudioBufferList*>(&audio)),"render alternate format");
        for(unsigned j=0;j<(configuration==1?1024:512);++j)require(a[j]==0,"alternate format starts with empty fixed delay");
        status(AudioUnitUninitialize(unit),"uninitialize alternate format");
    }
    {
        AudioStreamBasicDescription planar{};planar.mSampleRate=48000;planar.mFormatID=kAudioFormatLinearPCM;planar.mFormatFlags=kAudioFormatFlagsNativeFloatPacked|kAudioFormatFlagIsNonInterleaved;
        planar.mChannelsPerFrame=2;planar.mBitsPerChannel=32;planar.mFramesPerPacket=1;planar.mBytesPerFrame=planar.mBytesPerPacket=4;
        auto packed=planar;packed.mFormatFlags=kAudioFormatFlagsNativeFloatPacked;packed.mBytesPerFrame=packed.mBytesPerPacket=8;
        status(AudioUnitSetProperty(unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Input,0,&planar,sizeof(planar)),"set planar input conversion");
        status(AudioUnitSetProperty(unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Output,0,&packed,sizeof(packed)),"set packed output conversion");
        status(AudioUnitInitialize(unit),"initialize mixed-layout pull renderer");
        require(hostProcess(unit,&flags,&stamp,512,reinterpret_cast<AudioBufferList*>(&buffers))==kAudioUnitErr_FormatNotSupported,"in-place Process rejects contradictory input/output layouts");
        status(AudioUnitUninitialize(unit),"uninitialize conversion test");
    }
    if(direct){status(direct->Close(direct),"dispose factory");direct=nullptr;}else status(AudioComponentInstanceDispose(unit),"dispose");
    nativeIntegration(factory,desc);
    std::cout<<"Native AU factory/dispatch checks passed ("<<checks<<" assertions): load, AUv2 factory dispatch, eight controls, state, latency, planar/interleaved/mono rendering, automation offsets, native seed audio, track-to-bus/master sharing without upstream return, reset/disposal.\n";
    // Keep the registered factory image mapped until process exit.
    return 0;
}
