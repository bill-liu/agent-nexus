// This helper exposes NO native callbacks/objects to JavaScript. Candidate text
// exists only in a plain JavaScriptCore global context. Observations are produced
// by C API calls and Foundation, never candidate-visible JSON/Array intrinsics.
#import <Foundation/Foundation.h>
#import <JavaScriptCore/JavaScriptCore.h>
#include <sandbox.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <fcntl.h>
#include <unistd.h>
#include <math.h>

static JSValueRef property(JSContextRef ctx, JSObjectRef object, const char *name, JSValueRef *error) {
 JSStringRef key=JSStringCreateWithUTF8CString(name);
 JSValueRef value=JSObjectGetProperty(ctx,object,key,error);JSStringRelease(key);return value;
}
static JSValueRef evaluate(JSContextRef ctx, NSString *source, JSValueRef *error) {
 JSStringRef text=JSStringCreateWithCFString((__bridge CFStringRef)source);
 JSValueRef value=JSEvaluateScript(ctx,text,NULL,NULL,1,error);JSStringRelease(text);return value;
}
static JSValueRef fromJSON(JSContextRef ctx,id object) {
 NSData *data=[NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingFragmentsAllowed error:NULL];
 if(!data)return NULL;
 NSString *text=[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
 JSStringRef str=JSStringCreateWithCFString((__bridge CFStringRef)text);
 JSValueRef value=JSValueMakeFromJSONString(ctx,str);JSStringRelease(str);return value;
}
// The fixed oracle uses numeric/string/boolean arrays. Unknown objects, holes,
// symbols, cyclic values and overlong arrays are rejected rather than coercing
// them through candidate-defined toJSON/valueOf/JSON.stringify.
static id primitiveArray(JSContextRef ctx,JSValueRef value,int depth,BOOL *valid) {
 if(!value||depth>4){*valid=NO;return [NSNull null];}
 if(JSValueIsNull(ctx,value))return [NSNull null];
 if(JSValueIsBoolean(ctx,value))return @(JSValueToBoolean(ctx,value));
 if(JSValueIsNumber(ctx,value)){double n=JSValueToNumber(ctx,value,NULL);if(!isfinite(n)){*valid=NO;return [NSNull null];}return @(n);}
 if(JSValueIsString(ctx,value)){
  JSStringRef str=JSValueToStringCopy(ctx,value,NULL);CFStringRef cf=JSStringCopyCFString(kCFAllocatorDefault,str);JSStringRelease(str);
  NSString *result=CFBridgingRelease(cf);if([result length]>65536)*valid=NO;return result;
 }
 if(!JSValueIsArray(ctx,value)){*valid=NO;return [NSNull null];}
 JSValueRef error=NULL;JSObjectRef arr=JSValueToObject(ctx,value,&error);if(error){*valid=NO;return [NSNull null];}
 JSValueRef length=property(ctx,arr,"length",&error);
 if(error||!JSValueIsNumber(ctx,length)){*valid=NO;return [NSNull null];}
 double n=JSValueToNumber(ctx,length,NULL);if(n<0||n>10002||n!=floor(n)){*valid=NO;return [NSNull null];}
 NSMutableArray *result=[NSMutableArray arrayWithCapacity:(NSUInteger)n];
 for(unsigned i=0;i<(unsigned)n;i++){
  JSValueRef item=JSObjectGetPropertyAtIndex(ctx,arr,i,&error);if(error){*valid=NO;return [NSNull null];}
  [result addObject:primitiveArray(ctx,item,depth+1,valid)];if(!*valid)return [NSNull null];
 }
 return result;
}
static BOOL hasPrototype(JSContextRef ctx,JSValueRef value,JSValueRef expected) {
 for(int i=0;i<32&&value&&JSValueIsObject(ctx,value);i++){
  value=JSObjectGetPrototype(ctx,JSValueToObject(ctx,value,NULL));
  if(value&&JSValueIsStrictEqual(ctx,value,expected))return YES;
 }
 return NO;
}
static int blocked(const char *code){fprintf(stderr,"%s\n",code);return 70;}
int main(void) { @autoreleasepool {
 // Read a bounded native JSON request. No paths, environment, argv, descriptors,
 // output functions or oracle expectations are bridged into the JS global.
 NSMutableData *bytes=[NSMutableData data];char buffer[8192];ssize_t count;
 while((count=read(STDIN_FILENO,buffer,sizeof(buffer)))>0){[bytes appendBytes:buffer length:(NSUInteger)count];if([bytes length]>1048576)return blocked("BLOCKED_INPUT_LIMIT");}
 close(STDIN_FILENO);if(count<0)return blocked("BLOCKED_INPUT_READ");
 NSDictionary *request=[NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL];
 if(![request isKindOfClass:[NSDictionary class]]||![request[@"source"] isKindOfClass:[NSString class]]||![request[@"call"] isKindOfClass:[NSDictionary class]])return blocked("BLOCKED_REQUEST");
 NSDictionary *call=request[@"call"];
 JSGlobalContextRef ctx=JSGlobalContextCreate(NULL);if(!ctx)return blocked("BLOCKED_JS_CONTEXT");
 JSValueRef error=NULL;
 // Some JavaScriptCore builds install a native console object even in a plain
 // C-API context. Remove and seal every host-facing name before candidate code.
 JSObjectRef global=JSContextGetGlobalObject(ctx);
 const char *hostNames[]={"console","print","process","require","fetch","readFile","ObjC","$"};
 for(unsigned i=0;i<sizeof(hostNames)/sizeof(hostNames[0]);i++){
  JSStringRef key=JSStringCreateWithUTF8CString(hostNames[i]);
  if(!JSObjectDeleteProperty(ctx,global,key,&error)||error)return blocked("BLOCKED_HOST_GLOBAL_REMOVAL");
  JSObjectSetProperty(ctx,global,key,JSValueMakeUndefined(ctx),kJSPropertyAttributeReadOnly|kJSPropertyAttributeDontDelete,&error);
  JSValueRef value=JSObjectGetProperty(ctx,global,key,&error);JSStringRelease(key);
  if(error||!JSValueIsUndefined(ctx,value))return blocked("BLOCKED_HOST_GLOBAL_REMOVAL");
 }
 JSValueRef typePrototype=evaluate(ctx,@"TypeError.prototype",&error);JSValueProtect(ctx,typePrototype);
 JSValueRef freeze=evaluate(ctx,@"Object.freeze",&error);JSValueProtect(ctx,freeze);
 JSValueRef rangePrototype=evaluate(ctx,@"RangeError.prototype",&error);JSValueProtect(ctx,rangePrototype);
 // Prime Foundation serialization before applying the pure-computation sandbox.
 (void)[NSJSONSerialization dataWithJSONObject:@{} options:0 error:NULL];
 char *sandboxError=NULL;
 #pragma clang diagnostic push
 #pragma clang diagnostic ignored "-Wdeprecated-declarations"
 int sandboxResult=sandbox_init(kSBXProfilePureComputation,SANDBOX_NAMED,&sandboxError);
 if(sandboxResult!=0){if(sandboxError)sandbox_free_error(sandboxError);return blocked("BLOCKED_OS_SANDBOX");}
 #pragma clang diagnostic pop
 // PureComputation alone permits socket creation on some versions; make new
 // descriptors/processes impossible too. Only existing stdout/stderr survive.
 for(int fd=3;fd<1024;fd++)close(fd);
 // Darwin rejects RLIMIT_AS here (and aliases it to RSS); it cannot establish
 // a hard address-space/physical-memory bound. Do not claim such a capability.
 // CPU + supervisor elapsed/output limits remain enforced and tested.
 struct rlimit zero={0,0},cpu={2,2};
 if(setrlimit(RLIMIT_NOFILE,&zero))return blocked("BLOCKED_RESOURCE_NOFILE");
 if(setrlimit(RLIMIT_NPROC,&zero))return blocked("BLOCKED_RESOURCE_NPROC");
 if(setrlimit(RLIMIT_FSIZE,&zero))return blocked("BLOCKED_RESOURCE_FSIZE");
 if(setrlimit(RLIMIT_CPU,&cpu))return blocked("BLOCKED_RESOURCE_CPU");
 // Fail closed unless actual denial is observed before any candidate evaluation.
 int fd=open("/etc/passwd",O_RDONLY);if(fd>=0){close(fd);return blocked("BLOCKED_FILESYSTEM_PROOF");}
 fd=socket(AF_INET,SOCK_STREAM,0);if(fd>=0){close(fd);return blocked("BLOCKED_NETWORK_PROOF");}
 // Transformed ESM yields ONLY the function. The module wrapper contains plain
 // JS objects, no require implementation and no native object/host bridge.
 JSValueRef fn=evaluate(ctx,request[@"source"],&error);
 if(fn)JSValueProtect(ctx,fn);
 NSString *errorName=nil;
 JSValueRef records=fromJSON(ctx,call[@"records"]?:[NSNull null]);
 if([call[@"recordsKind"] isEqual:@"undefined"])records=JSValueMakeUndefined(ctx);
 JSValueRef maximum=fromJSON(ctx,call[@"maximum"]?:[NSNull null]);
 NSString *kind=call[@"maximumKind"];
 if([kind isEqual:@"undefined"])maximum=JSValueMakeUndefined(ctx);
 if([kind isEqual:@"NaN"])maximum=JSValueMakeNumber(ctx,NAN);
 if([kind isEqual:@"Infinity"])maximum=JSValueMakeNumber(ctx,INFINITY);
 if(records)JSValueProtect(ctx,records);if(maximum)JSValueProtect(ctx,maximum);
 if(JSValueIsArray(ctx,records)){JSValueRef arg[]={records};JSValueRef freezeError=NULL;JSObjectCallAsFunction(ctx,JSValueToObject(ctx,freeze,NULL),NULL,1,arg,&freezeError);if(freezeError)return blocked("BLOCKED_INPUT_FREEZE");}
 JSValueRef result=NULL;
 if(error||!fn||!JSValueIsObject(ctx,fn)||!JSObjectIsFunction(ctx,JSValueToObject(ctx,fn,NULL)))errorName=@"OtherError";
 else {JSValueRef args[]={records,maximum};result=JSObjectCallAsFunction(ctx,JSValueToObject(ctx,fn,NULL),NULL,[kind isEqual:@"omitted"]?1:2,args,&error);}
 if(error)errorName=hasPrototype(ctx,error,typePrototype)?@"TypeError":hasPrototype(ctx,error,rangePrototype)?@"RangeError":@"OtherError";
 BOOL valid=YES;
 id output=errorName?[NSNull null]:primitiveArray(ctx,result,0,&valid);
 BOOL afterValid=YES;
 id after=JSValueIsArray(ctx,records)?primitiveArray(ctx,records,0,&afterValid):[NSNull null];
 if(!valid||!afterValid)errorName=@"OtherError";
 NSData *beforeBytes=[NSJSONSerialization dataWithJSONObject:call[@"records"]?:[NSNull null] options:NSJSONWritingFragmentsAllowed error:NULL];
 NSData *afterBytes=[NSJSONSerialization dataWithJSONObject:after options:NSJSONWritingFragmentsAllowed error:NULL];
 BOOL unchanged=JSValueIsArray(ctx,records)&&beforeBytes&&[beforeBytes isEqualToData:afterBytes];
 NSDictionary *observation=@{@"value":output,@"isArray":[NSNumber numberWithBool:result&&JSValueIsArray(ctx,result)],@"sameArray":[NSNumber numberWithBool:result&&JSValueIsStrictEqual(ctx,result,records)],@"inputUnchanged":[NSNumber numberWithBool:unchanged],@"errorName":errorName?:[NSNull null],@"sandbox":@"pure-computation-no-fds-v1"};
 NSData *json=[NSJSONSerialization dataWithJSONObject:observation options:NSJSONWritingSortedKeys error:NULL];
 if(!json||[json length]>65536)return blocked("BLOCKED_OUTPUT_LIMIT");
 const char *out=[json bytes];size_t left=[json length];while(left){ssize_t n=write(STDOUT_FILENO,out,left);if(n<=0)return 71;out+=n;left-=(size_t)n;}
 // Do not run candidate-controlled finalizers or pump promise jobs after report.
 _exit(0);
 } }
