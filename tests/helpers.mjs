import { CLIENT_ID } from "../src/constants.mjs";
import { normalizeTokens } from "../src/auth.mjs";
export const jwt=value=>`test.${Buffer.from(JSON.stringify(value)).toString("base64url")}.unsigned-test-fixture`;
export function tokens(patch={}) {return {access_token:jwt({client_id:CLIENT_ID,sub:"auth-sub",exp:Math.floor(Date.now()/1000)+3600,"https://api.openai.com/auth":{chatgpt_account_id:"workspace-a",chatgpt_user_id:"user-a",chatgpt_plan_type:"plus"}}),refresh_token:"test-refresh",id_token:jwt({aud:CLIENT_ID,sub:"subject-a",email:"example@example.invalid"}),expires_in:3600,...patch};}
export const auth=()=>normalizeTokens(tokens());
export const event=value=>`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
export const message=(text="pong")=>({id:"msg_test",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text,annotations:[]}]});
export const completed=(output=[message()])=>({type:"response.completed",response:{id:"resp_test",object:"response",model:"gpt-6-astra",status:"completed",output,usage:{input_tokens:10,output_tokens:3,total_tokens:13}}});
export const sse=(events=[completed()])=>new Response(events.map(event).join(""),{headers:{"content-type":"text/event-stream"}});
export const tool=(name="echo",args={text:"ping"})=>({id:"fc_native",call_id:"call_native",type:"function_call",name:"run_officejs",arguments:JSON.stringify({summary:"Call tool",extended_summary:"Call the declared tool",code:JSON.stringify({name,arguments:args}),destructive:false,references:[]}),status:"completed"});
export const toolDeclaration={type:"function",name:"echo",parameters:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false}};
