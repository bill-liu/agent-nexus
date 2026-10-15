import {constants,openSync,closeSync,fstatSync,readFileSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export interface PodmanContextPins {version:1;imageVersion:string;sourceRevision:string;baseImage:string;nodeVersion:'24.19.0';codexVersion:'0.159.2';codexPath:string;codexSHA256:string;bundleSHA256:string;}
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function read(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const before=fstatSync(fd);if(!before.isFile()||before.size>256*1024*1024)throw Error('PUBLIC_INPUT_INVALID');const bytes=readFileSync(fd),after=fstatSync(fd),current=lstatSync(path);if(before.dev!==current.dev||before.ino!==current.ino||before.size!==bytes.length||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('PUBLIC_INPUT_CHANGED');return bytes;}finally{closeSync(fd);}}
/** Stages only reviewed public inputs. No download, engine, image build, credential access or recursive copy. */
export function preparePodmanContext(root:string,pins:PodmanContextPins,output:string){
 const keys=['version','imageVersion','sourceRevision','baseImage','nodeVersion','codexVersion','codexPath','codexSHA256','bundleSHA256'];
 if(!pins||Object.keys(pins).length!==keys.length||keys.some(k=>!Object.hasOwn(pins,k))||pins.version!==1||pins.nodeVersion!=='24.19.0'||pins.codexVersion!=='0.159.2'||!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(pins.imageVersion)||!/^([a-f0-9]{40})$/.test(pins.sourceRevision)||!/^docker\.io\/library\/node@sha256:[a-f0-9]{64}$/.test(pins.baseImage)||![pins.codexSHA256,pins.bundleSHA256].every(v=>/^([a-f0-9]{64})$/.test(v))||!isAbsolute(pins.codexPath)||!isAbsolute(output)||resolve(output)!==output)throw Error('OCI_PINS_REQUIRED');
 const binary=read(pins.codexPath),bundle=read(join(root,'build/podman-entry.cjs'));
 if(hash(binary)!==pins.codexSHA256||hash(bundle)!==pins.bundleSHA256)throw Error('OCI_INPUT_DIGEST_MISMATCH');
 if(binary.length<64||binary.subarray(0,6).compare(Buffer.from([0x7f,69,76,70,2,1]))!==0||binary.readUInt16LE(18)!==183)throw Error('LINUX_ARM64_CODEX_REQUIRED');
 const files:Record<string,Buffer>={'Containerfile':read(join(root,'runtime/podman/Containerfile')),'.containerignore':read(join(root,'runtime/podman/.containerignore')),'podman-entry.cjs':bundle,codex:binary,'runtime.json':Buffer.from(JSON.stringify({version:pins.codexVersion,sha256:pins.codexSHA256})+'\n')};
 const manifest={version:1,state:'NOT_BUILT' as const,imageDigest:null,downloadBytes:null,imageVersion:pins.imageVersion,sourceRevision:pins.sourceRevision,baseImage:pins.baseImage,nodeVersion:pins.nodeVersion,codexVersion:pins.codexVersion,architecture:'linux/arm64',inputHashes:Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,hash(bytes)])),contextInputBytes:Object.values(files).reduce((n,b)=>n+b.length,0)};
 // Exclusive directory creation leaves existing user files untouched. No cleanup/prune on failure.
 mkdirSync(output,{mode:0o700});for(const [name,bytes] of Object.entries(files))writeFileSync(join(output,name),bytes,{flag:'wx',mode:name==='codex'?0o555:0o444});writeFileSync(join(output,'input-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o444});return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==4)throw 0;const root=fileURLToPath(new URL('../../../',import.meta.url));const pins=JSON.parse(readFileSync(process.argv[2],'utf8'));const result=preparePodmanContext(root,pins,process.argv[3]);process.stdout.write(JSON.stringify(result,null,2)+'\n');}catch{process.stderr.write('OCI_CONTEXT_BLOCKED: reviewed pins and a new private output directory are required.\n');process.exitCode=1;}
}
