import {readFileSync,statSync} from "node:fs";
import {createHash} from "node:crypto";
import {fileURLToPath,pathToFileURL} from "node:url";
import path from "node:path";
import {bridgeTargets,bridgeName} from "../src/platforms.mjs";

export function verifyBinaries(root){
  const pkg=JSON.parse(readFileSync(path.join(root,"package.json"),"utf8"));
  const manifest=JSON.parse(readFileSync(path.join(root,"bin/manifest.json"),"utf8"));
  if(manifest.version!==pkg.version||manifest.protocol!==3)throw new Error("Bridge manifest version mismatch; run npm run build:all");
  for(const target of bridgeTargets){
    const [platform,arch]=target.split("-");
    const name=bridgeName(platform,arch),file=path.join(root,"bin",name);
    const data=readFileSync(file),entry=manifest.binaries[name];
    if(!entry||entry.bytes!==data.length||entry.sha256!==createHash("sha256").update(data).digest("hex"))throw new Error(`Bridge checksum mismatch: ${name}`);
    let valid=false;
    if(platform==="win32"){
      const offset=data.readUInt32LE(0x3c);
      valid=data.subarray(0,2).toString()==="MZ"&&data.readUInt32LE(offset)===0x4550&&data.readUInt16LE(offset+4)===(arch==="x64"?0x8664:0xaa64);
    }else if(platform==="linux"){
      valid=data.readUInt32LE(0)===0x464c457f&&data[4]===2&&data[5]===1&&data.readUInt16LE(18)===(arch==="x64"?62:183);
    }else{
      valid=data.readUInt32LE(0)===0xfeedfacf&&data.readUInt32LE(4)===(arch==="x64"?0x1000007:0x100000c);
    }
    if(!valid)throw new Error(`Bridge architecture mismatch: ${name}`);
    if(platform!=="win32"&&process.platform!=="win32"&&!(statSync(file).mode&0o111))throw new Error(`Bridge is not executable: ${name}`);
  }
  return {version:pkg.version,targets:bridgeTargets.length};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  console.log(JSON.stringify(verifyBinaries(process.argv[2]||fileURLToPath(new URL("../",import.meta.url)))));
}
