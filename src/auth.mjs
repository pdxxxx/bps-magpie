import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { CLIENT_ID, AUTHORIZE_URL, TOKEN_URL, REDIRECT_URI, REFRESH_LEAD, PROVIDER } from "./constants.mjs";
import { readJSON } from "./network.mjs";

function expired(message) { return Object.assign(new Error(message), {signIn:"expired"}); }
function claims(token) {
  if (typeof token!=="string" || token.length>65536 || token.split(".").length!==3) throw expired("Invalid Excel OAuth JWT");
  try { const value=JSON.parse(Buffer.from(token.split(".")[1],"base64url").toString()); if(!value || typeof value!=="object" || Array.isArray(value)) throw 0; return value; }
  catch { throw expired("Invalid Excel OAuth JWT claims"); }
}

// These are consistency checks on a TLS-authenticated token exchange, not
// signature verification and not an authentication decision for incoming users.
export function normalizeTokens(tokens, previous, now=Date.now()) {
  const access=tokens.access_token;
  const at=claims(access);
  if ((at.client_id || at.azp)!==CLIENT_ID) throw expired("This is not an Excel/BPS grant; authorize the Excel client again");
  const account=at["https://api.openai.com/auth"]?.chatgpt_account_id;
  if(typeof account!=="string" || !account || !Number.isFinite(at.exp) || at.exp*1000<=now) throw expired("Excel access token has no valid workspace or expiry");
  if (previous?.workspaceId && account!==previous.workspaceId) throw expired("Excel refresh changed workspace identity");
  const refresh=tokens.refresh_token || previous?.refresh;
  if(typeof refresh!=="string" || !refresh) throw expired("Excel refresh token is missing");
  let id;
  if(tokens.id_token) {
    id=claims(tokens.id_token);
    const aud=Array.isArray(id.aud)?id.aud:[id.aud];
    if(!aud.includes(CLIENT_ID)) throw expired("Excel identity token client mismatch");
    if(previous?.subject && id.sub && previous.subject!==id.sub) throw expired("Excel refresh changed account identity");
  } else if(!previous) throw expired("Excel identity token is missing");
  const plan=at["https://api.openai.com/auth"]?.chatgpt_plan_type;
  if(typeof plan==="string" && plan.trim().toLowerCase()==="free") throw expired("BPS requires an eligible paid ChatGPT account");
  return {...previous,type:"oauth",access,refresh,expires:Math.min(at.exp*1000,Number.isFinite(tokens.expires_in)&&tokens.expires_in>0?now+tokens.expires_in*1000:Infinity),
    clientId:CLIENT_ID,workspaceId:account,subject:id?.sub || previous?.subject,
    accountId:id?.email || previous?.accountId || account,uid:`${id?.sub || previous?.subject || at.sub || ""}:${account}`,
    idToken:tokens.id_token || previous?.idToken,plan:plan || previous?.plan};
}

async function tokenRequest(body,{fetchImpl=globalThis.fetch,signal}={}) {
  const timeout=AbortSignal.timeout(45000);
  const res=await fetchImpl(TOKEN_URL,{method:"POST",redirect:"error",headers:{"content-type":"application/json","accept":"application/json"},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,timeout]):timeout});
  if(!res.ok) {
    // Do not surface provider bodies: they may contain tokens, codes or PII.
    let code; try { const data=await readJSON(res,128*1024,"OAuth"); code=typeof data.error==="string"?data.error:data.error?.code; } catch {}
    if(res.status===401 || code==="invalid_grant" || code==="refresh_token_reused" || code==="refresh_token_expired") throw expired(`Excel OAuth authorization expired (HTTP ${res.status}); sign in again`);
    throw new Error(`Excel OAuth token endpoint failed (HTTP ${res.status})`);
  }
  return readJSON(res,128*1024,"Excel OAuth token");
}

export async function beginLogin(_inputs,context={},deps={}) {
  const verifier=randomBytes(32).toString("base64url");
  const state=randomBytes(32).toString("base64url");
  const issued=Date.now();
  let used=false;
  const url=new URL(AUTHORIZE_URL);
  url.search=new URLSearchParams({client_id:CLIENT_ID,response_type:"code",redirect_uri:REDIRECT_URI,scope:"openid offline_access email profile organization.read",state,code_challenge_method:"S256",code_challenge:createHash("sha256").update(verifier).digest("base64url"),audience:"https://api.openai.com/v1",platform:"PC"}).toString();
  return {url:url.href,method:"code",instructions:"使用 ChatGPT 账号完成 Excel/BPS 授权，然后粘贴浏览器地址栏的完整回调 URL（包含 code 和 state）。不要只粘贴授权码；回调页即使报错也可复制 URL。",
    async callback(value,{signal}={}) {
      try {
        if(used) throw new Error("This authorization attempt has already been used");
        if(Date.now()-issued>15*60*1000) throw new Error("Authorization expired; start again");
        context.signal?.throwIfAborted(); signal?.throwIfAborted();
        let callback; try { callback=new URL(String(value).trim()); } catch { throw new Error("Paste the complete callback URL, including code and state"); }
        const expected=new URL(REDIRECT_URI);
        if(callback.origin!==expected.origin || callback.pathname!==expected.pathname || callback.username || callback.password || callback.hash) throw new Error("Unexpected Excel OAuth callback address");
        if(callback.searchParams.getAll("state").length!==1) throw new Error("OAuth state is missing or ambiguous");
        const received=Buffer.from(callback.searchParams.get("state") || ""); const wanted=Buffer.from(state);
        if(received.length!==wanted.length || !timingSafeEqual(received,wanted)) throw new Error("OAuth state mismatch; use this login attempt’s callback URL");
        if(callback.searchParams.has("error")) throw new Error("Excel OAuth authorization was declined");
        const code=callback.searchParams.get("code");
        if(!code || code.length>8192 || callback.searchParams.getAll("code").length!==1) throw new Error("OAuth callback has no unique authorization code");
        used=true;
        const combined=[context.signal,signal].filter(Boolean);
        const tokens=await tokenRequest({grant_type:"authorization_code",client_id:CLIENT_ID,redirect_uri:REDIRECT_URI,code_verifier:verifier,code},{...deps,signal:combined.length?AbortSignal.any(combined):undefined});
        return {...normalizeTokens(tokens),type:"success"};
      } catch(error) { return {type:"failed",error:error?.message || "Excel authorization failed"}; }
    }};
}

export async function refreshTokens(auth,deps={}) {
  if(auth?.type!=="oauth" || auth.clientId!==CLIENT_ID || !auth.refresh) throw expired("Sign in with an independent Excel/BPS grant first");
  const tokens=await tokenRequest({grant_type:"refresh_token",client_id:CLIENT_ID,refresh_token:auth.refresh,scope:"openid profile email"},deps);
  return normalizeTokens(tokens,auth);
}

export function createCredentialManager(client,deps={}) {
  const flights=new Map();
  const fresh=new Map();
  async function refresh(auth) {
    const key=createHash("sha256").update(auth.refresh || "").digest("hex");
    const binding=JSON.stringify([auth.clientId,auth.workspaceId,auth.subject]);
    const prior=fresh.get(key);const flight=flights.get(key);
    if((prior&&prior.binding!==binding)||(flight&&flight.binding!==binding))throw expired("Refresh token is already bound to another account identity");
    if(prior && prior.auth.expires>Date.now()+REFRESH_LEAD)return prior.auth;
    if(flight)return flight.promise;
    const work=refreshTokens(auth,deps).then(next=>{
      if(fresh.size>=64) fresh.delete(fresh.keys().next().value);
      fresh.set(key,{binding,auth:next}); return next;
    }).finally(()=>flights.delete(key));
    flights.set(key,{binding,promise:work}); return work;
  }
  async function current(getAuth,signal,authKey=PROVIDER) {
    signal?.throwIfAborted();
    let auth=await getAuth();
    if(auth?.type!=="oauth" || auth.clientId!==CLIENT_ID || !auth.access || !auth.workspaceId) throw expired("Please sign in to BPS first");
    if(!Number.isFinite(auth.expires) || auth.expires<=Date.now()+REFRESH_LEAD) {
      if(typeof client?.auth?.set!=="function")throw new Error("Host cannot persist refreshed Excel credentials");
      const old=auth; auth=await refresh(old);
      // OpenCode/older Magpie fallback. Refresh can rotate a token, so persist
      // even when the caller cancelled while token exchange was in progress.
      const latest=await getAuth();
      if(!latest || latest.type!==old.type || latest.clientId!==old.clientId || latest.workspaceId!==old.workspaceId || latest.subject!==old.subject)throw expired("Account changed while Excel credentials were refreshing");
      if(latest.refresh!==old.refresh) {
        if(latest.refresh===auth.refresh){signal?.throwIfAborted();return latest;}
        throw expired("Account changed while Excel credentials were refreshing");
      }
      await client.auth.set({path:{id:authKey},body:auth});
    }
    signal?.throwIfAborted();
    return auth;
  }
  return {refresh,current};
}
