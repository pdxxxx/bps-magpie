import {readFileSync} from "node:fs";

export const bridgeTargets=Object.freeze([
  "win32-x64","win32-arm64","linux-x64","linux-arm64","darwin-x64","darwin-arm64"
]);
export const packageVersion=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")).version;
export function bridgeName(platform=process.platform,arch=process.arch){
  return `bps-bridge-${platform}-${arch}${platform==="win32"?".exe":""}`;
}
export function bridgeInstallError(reason="missing",platform=process.platform,arch=process.arch){
  const target=`${platform}-${arch}`;
  const supported=bridgeTargets.includes(target);
  const message=supported
    ? `BPS bridge ${reason} (${target}; bin/${bridgeName(platform,arch)}). Update the GitHub plugin to v${packageVersion} or reinstall the complete release package: https://github.com/pdxxxx/bps-magpie/releases/tag/v${packageVersion} . No Go installation is required; retrying the request cannot repair an incomplete installation.`
    : `BPS does not support ${target}. Supported platforms: ${bridgeTargets.join(", ")}.`;
  return Object.assign(new Error(message),{status:500,code:"basispoints_bridge_unavailable"});
}
