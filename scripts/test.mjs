import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
const root = fileURLToPath(new URL("../", import.meta.url));
for (const [command,args,cwd] of [[process.execPath,["scripts/build.mjs"],root],["go",["test","./..."],root+"bridge"],[process.execPath,["--test",...readdirSync(root+"tests").filter(f=>f.endsWith(".test.mjs")).map(f=>"tests/"+f)],root]]) {
  const r=spawnSync(command,args,{cwd,stdio:"inherit",windowsHide:true});
  if(r.error) throw r.error;
  if(r.status) process.exit(r.status);
}
