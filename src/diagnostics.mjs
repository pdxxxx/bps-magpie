import {execFile} from "node:child_process";
import {stat,readFile} from "node:fs/promises";
import {binaryPath} from "./bridge.mjs";
import {proxyOption} from "./network.mjs";
import {bridgeInstallError} from "./platforms.mjs";

export async function bridgeInfo(binary=binaryPath){
  try{
    if(!(await stat(binary)).isFile())throw new Error();
    const text=await new Promise((resolve,reject)=>execFile(binary,["--version"],{windowsHide:true,timeout:3000,maxBuffer:4096},(error,stdout)=>error?reject(error):resolve(stdout)));
    const info=JSON.parse(text);
    if(info.protocol!==3||typeof info.version!=="string")throw new Error();
    return {available:true,protocol:info.protocol,version:info.version};
  }catch{return {available:false,message:bridgeInstallError("is missing, incompatible or cannot run").message};}
}
export async function diagnose(options={},state){
  const pkg=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8"));
  const proxy=proxyOption(options);
  const bridge=await bridgeInfo();
  return {version:pkg.version,platform:process.platform,architecture:process.arch,runtime:globalThis.Bun?"Bun":"Node",bridge,
    buildMatches:bridge.available&&bridge.version===pkg.version,
    proxyMode:proxy===undefined?"inherit":proxy===""?"direct":"explicit-http-proxy",
    configuredModels:Array.isArray(options.models)?options.models.length:1,
    continuation:state?.diagnostics(),liveNetworkChecked:false};
}
