import "./build-ui.mjs";
import { mkdirSync,readFileSync,writeFileSync,chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {createHash} from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {bridgeTargets,bridgeName} from "../src/platforms.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const version=JSON.parse(readFileSync(path.join(root,"package.json"),"utf8")).version;
if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))throw new Error("Invalid package version");
const targets=process.argv.includes("--all")?bridgeTargets:[`${process.env.TARGET_OS||process.platform}-${process.env.TARGET_ARCH||process.arch}`];
const manifestPath=path.join(root,"bin","manifest.json");
let manifest={version,protocol:3,binaries:{}};
try{const prior=JSON.parse(readFileSync(manifestPath,"utf8"));if(prior.version===version&&prior.protocol===3)manifest=prior;}catch{}
mkdirSync(path.join(root,"bin"),{recursive:true});
for(const item of targets){
const [platform,arch]=item.split("-");
const goos = {win32: "windows", linux: "linux", darwin: "darwin"}[platform];
const goarch = {x64: "amd64", arm64: "arm64"}[arch];
if (!goos || !goarch) throw new Error(`Unsupported target: ${platform}/${arch}`);
const name=bridgeName(platform,arch);
const target=path.join(root,"bin",name);
const result = spawnSync("go", ["build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w -X main.version="+version, "-o", target, "./cmd/bps-bridge"], {cwd:path.join(root,"bridge"),env:{...process.env,CGO_ENABLED:"0",GOOS:goos,GOARCH:goarch},stdio:"inherit",windowsHide:true});
if (result.error) throw result.error;
if (result.status) process.exit(result.status);
console.log(`Built ${target}`);
chmodSync(target,0o755);
const bytes=readFileSync(target);
manifest.binaries[name]={bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
}
writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n");
