import { beginLogin, createCredentialManager } from "./src/auth.mjs";
import { makeFetch } from "./src/provider.mjs";
import { fetchModelCatalog } from "./src/models.mjs";
import { PROVIDER, BASE_URL, REFRESH_LEAD } from "./src/constants.mjs";
import { queryQuota } from "./src/quota.mjs";
import { managementTools } from "./src/management.mjs";
import { createFetch } from "./src/network.mjs";
import {createConversationStore} from "./src/state.mjs";
import {diagnose} from "./src/diagnostics.mjs";

// Export only the plugin; Magpie treats every exported function as a plugin.
export const BPSPlugin=async ({client,directory},options={})=>{
  if(options.continuationCache!==undefined&&typeof options.continuationCache!=="boolean")throw new Error("continuationCache must be a boolean");
  const network={fetchImpl:createFetch(options),state:createConversationStore({enabled:options.continuationCache!==false})};
  network.diagnose=()=>diagnose(options,network.state);
  const credentials=createCredentialManager(client,network);
  return {
    config:async cfg=>{
      cfg.provider??={};
      cfg.provider[PROVIDER]??={name:"BPS",npm:"@ai-sdk/openai",api:BASE_URL,models:{}};
    },
    auth:{provider:PROVIDER,maxConcurrency:4,refreshLead:REFRESH_LEAD,
      methods:[{type:"oauth",label:"ChatGPT Excel / BPS 登录",authorize:(inputs,context)=>beginLogin(inputs,context,network)}],
      refresh:auth=>credentials.refresh(auth),
      async usage(getAuth){
        try{return await queryQuota(await credentials.current(getAuth),network);}
        catch(error){return {windows:[],error:error.message,signIn:error.signIn==="expired"?"expired":"kept"};}
      },
      async loader(getAuth){return {baseURL:BASE_URL,apiKey:"magpie-bps-managed",fetch:makeFetch(getAuth,credentials,options,network)};}
    },
    tool:managementTools({directory,deps:network}),
    provider:{id:PROVIDER,async models(_provider,{auth}={}){return auth?.type==="oauth"?fetchModelCatalog(auth,network):{};}},
    "chat.headers":async(input,output)=>{
      if(input.model?.providerID===PROVIDER && input.sessionID){output.headers??={};output.headers["x-bps-session"]=input.sessionID;}
    }
  };
};
