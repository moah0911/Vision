import{n as e}from"./protocol-C2WP3Lm6.js";var t=`http://localhost:8000`;function n(e){if(typeof e!=`string`||e.trim()===``)return!1;try{let t=new URL(e);return t.protocol===`http:`||t.protocol===`https:`}catch{return!1}}function r(e){return n(e)?e.trim().replace(/\/+$/,``):t}async function i(){try{return r((await chrome.storage.local.get(`serverUrl`))?.serverUrl)}catch{return t}}var a=document.getElementById(`app`);a.innerHTML=`
  <div class="wrap">
    <header>
      <h1>Vision Privacy Agent</h1>
      <span class="badge">on-device • WebGPU</span>
    </header>
    <div id="serverBanner" class="hidden" style="background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:6px 8px;border-radius:8px;font-size:11px;"></div>

    <section class="card">
      <label>Task for agent (server sees only sanitized data)</label>
      <input id="task" placeholder="e.g., Click Submit, Scroll down, Summarize page" />
      <div class="row">
        <label class="check"><input type="checkbox" id="includeShot" checked /> include redacted screenshot</label>
        <label class="check"><input type="checkbox" id="showMasks" checked /> show local masks</label>
      </div>
      <div class="row">
        <button id="btnSanitize" class="primary">1. Scan & Redact Locally</button>
        <button id="btnClear" class="ghost">Clear masks</button>
      </div>
      <div id="metrics" class="metrics hidden"></div>
      <div id="progress" class="progress hidden"><div class="bar"></div><span class="pct">0%</span></div>
      <pre id="contextPreview" class="preview hidden"></pre>
    </section>

    <section class="card">
      <div class="row space">
        <strong>2. Send sanitized context to server</strong>
        <span id="latency" class="muted"></span>
      </div>
      <div class="row">
        <input id="serverUrl" placeholder="http://localhost:8000" />
        <button id="btnSaveServer" class="ghost">Save</button>
      </div>
      <div class="row">
        <button id="btnAgent" class="primary">Ask Agent (sanitized only)</button>
        <button id="btnExecute" class="ghost" disabled>Execute action</button>
      </div>
      <pre id="agentOut" class="preview hidden"></pre>
      <div id="confirmRow" class="row hidden">
        <span class="muted">Fill actions need confirm:</span>
        <button id="btnConfirm" class="danger">Confirm Fill</button>
      </div>
    </section>

    <section class="card muted-card">
      <div class="tiny">Local ML: <span id="deviceInfo">detecting…</span> • <span id="storageInfo">storage: …</span> • No raw PII leaves device</div>
      <div class="row">
        <button id="btnPreload" class="ghost">Preload models</button>
        <button id="btnDispose" class="ghost">Free memory</button>
        <button id="btnTestPage" class="ghost">Open PII test page</button>
      </div>
      <div class="row">
        <label class="check">Quant: <select id="quantSel"><option value="q8">q8 (balanced)</option><option value="q4">q4 (low-RAM)</option><option value="fp16">fp16 (GPU)</option></select></label>
        <span id="memInfo" class="tiny"></span>
      </div>
      <div id="toast" class="toast hidden"></div>
    </section>

    <footer>ISRO SIH • Privacy-preserving vision agent • <a href="#" id="viewLast">view lastContext</a></footer>
  </div>
`;var o=e=>document.querySelector(e),s=o(`#task`),c=o(`#includeShot`),l=o(`#showMasks`),u=o(`#btnSanitize`),d=o(`#btnClear`),f=o(`#metrics`),p=o(`#progress`),m=p.querySelector(`.bar`),h=p.querySelector(`.pct`),g=o(`#contextPreview`),_=o(`#serverUrl`),v=o(`#btnSaveServer`),y=o(`#btnAgent`),b=o(`#btnExecute`),x=o(`#agentOut`),S=o(`#latency`),C=o(`#deviceInfo`),w=o(`#btnPreload`),T=o(`#btnDispose`),E=o(`#btnTestPage`),D=o(`#confirmRow`),O=o(`#btnConfirm`),k=o(`#toast`),A=o(`#storageInfo`),j=o(`#quantSel`),M=o(`#memInfo`),N=o(`#serverBanner`),P=null,F=null;chrome.storage.local.get(`serverUrl`).then(e=>{_.value=e?.serverUrl||`http://localhost:8000`,I()});async function I(){let e=r(_.value||await i());try{let t=new AbortController,n=setTimeout(()=>t.abort(),1200),r=await fetch(`${e}/health`,{signal:t.signal});if(clearTimeout(n),!r.ok)throw Error(String(r.status));N.classList.add(`hidden`),N.textContent=``}catch{N.textContent=`Server not running at ${e} — Scan will still redact locally, but "Open PII test page" needs ${e}/test-pii.html . Start: python3 -m uvicorn server.app:app --port 8000`,N.classList.remove(`hidden`)}}setInterval(I,4e3),_.addEventListener(`change`,I),v.addEventListener(`click`,async()=>{await chrome.storage.local.set({serverUrl:_.value.trim()}),L(`Server URL saved`),I()});function L(e,t=2500){k.textContent=e,k.classList.remove(`hidden`),setTimeout(()=>k.classList.add(`hidden`),t)}async function R(){let[e]=await chrome.tabs.query({active:!0,currentWindow:!0});return e}function z(e,t){p.classList.remove(`hidden`),m.style.width=`${Math.max(2,Math.min(100,e))}%`,h.textContent=t?`${Math.round(e)}% ${t}`:`${Math.round(e)}%`,e>=100&&setTimeout(()=>p.classList.add(`hidden`),800)}chrome.storage.onChanged.addListener(e=>{if(e.mlProgress){let t=e.mlProgress.newValue;t?.progress==null?t?.status===`done`&&z(100,`ready`):z(t.progress,t.file||t.status)}});async function B(){let e=`wasm (fallback)`;try{navigator.gpu&&await navigator.gpu?.requestAdapter?.()&&(e=`webgpu (GPU)`)}catch{}let{mlProgress:t,quantMode:n}=await chrome.storage.local.get([`mlProgress`,`quantMode`]),r=n||`q8`;C.textContent=`${e} • ${r} • ${t?`model loading…`:`lazy`}`,j.value=r;try{let e=await navigator.storage?.estimate?.();if(e?.quota&&e?.usage!=null){let t=(e.usage/e.quota*100).toFixed(1);A.textContent=`storage ${(e.usage/1e6).toFixed(1)}MB / ${(e.quota/1e6).toFixed(0)}MB (${t}%)`}else A.textContent=`storage: n/a`}catch{A.textContent=`storage: n/a`}if(performance.memory){let e=performance.memory;M.textContent=`heap ${(e.usedJSHeapSize/1e6).toFixed(0)}MB / ${(e.jsHeapSizeLimit/1e6).toFixed(0)}MB`}else navigator.deviceMemory&&(M.textContent=`deviceMemory ${navigator.deviceMemory}GB`)}B(),setInterval(B,3e3),j.addEventListener(`change`,async()=>{let t=j.value,n=await e(`offscreenSetQuant`,{mode:t}).catch(()=>null);await chrome.storage.local.set({quantMode:t});let r=n?.effective;if(r){let e=C.textContent?.includes(`webgpu`)?`webgpu`:`wasm`;L(`Quant set to ${t} — loads as ${r[e]} on ${e}. Preload to apply.`,4e3)}else L(`Quant set to ${t} — next load will use it (preload to apply)`);B()});async function V(t,n){let r=e(`startScan`,{tabId:t,...n}),i=8,a=new Promise((e,t)=>{let n=Date.now(),r=setInterval(async()=>{let{scanState:a,scanError:o,lastContext:s}=await chrome.storage.local.get([`scanState`,`scanError`,`lastContext`]);a===`done`&&s?(clearInterval(r),e(s)):a===`error`?(clearInterval(r),t(Error(o||`Scan failed`))):Date.now()-n>8e3?(clearInterval(r),t(Error(`Scan timeout — reload page once after install, and open test page via http://localhost:8000/test-pii.html (extension pages have no content script).`))):(i=Math.min(85,i+2),z(i,`redacting…`))},200)});try{let e=await Promise.race([r,a]);if(e&&e.url)return e}catch{}return await a}u.addEventListener(`click`,async()=>{let t=await R();if(!t?.id)return L(`No active tab`);if(t.url?.startsWith(`chrome-extension://`)&&t.url.includes(`test-pii.html`)){let e=`${r(_.value||await i())}/test-pii.html`;L(`Extension test page cannot be scanned (no content script). Redirecting to http://localhost:8000/test-pii.html — needs server running.`,5e3);try{await chrome.tabs.update(t.id,{url:e}),L(`Redirected to http test page — retry Scan after page loads (2s).`,3e3)}catch{}u.disabled=!1,u.textContent=`1. Scan & Redact Locally`,z(100,`redirected`);return}u.disabled=!0,u.textContent=`Scanning…`,z(8,`extracting DOM`),await chrome.storage.local.set({scanState:`running`,scanError:null}).catch(()=>{});try{let n=performance.now(),r=null;try{let n=e(`getSanitizedContext`,{task:s.value.trim()||void 0,includeScreenshot:c.checked},t.id);r=await Promise.race([n,new Promise((e,t)=>setTimeout(()=>t(Error(`direct-timeout`)),3500))])}catch{r=await V(t.id,{task:s.value.trim()||void 0,includeScreenshot:c.checked})}if(!r||!r.url){let{lastContext:e}=await chrome.storage.local.get(`lastContext`);e&&(r=e)}if(!r||!r.url)throw Error(`No context returned — reload page once after install, then retry. For test page use http://localhost:8000/test-pii.html`);let i=Math.round(performance.now()-n);P=r;let a=r.metrics||{};f.classList.remove(`hidden`),f.innerHTML=`
      <span>extract ${a.extractionMs??`-`}ms</span> •
      <span>pii ${a.piiDetectionMs??`-`}ms</span> •
      <span>vision ${a.visionMs??`-`}ms</span> •
      <span>redact ${a.redactionMs??`-`}ms</span> •
      <span>total ${i}ms</span> •
      <span>${r.redacted_regions.length} regions</span> •
      <span>${r.ax_tree.length} nodes</span>
    `,g.classList.remove(`hidden`),g.textContent=JSON.stringify({url:r.url,title:r.title,ax_tree:r.ax_tree.slice(0,6),redacted_regions:r.redacted_regions,hasScreenshot:!!r.screenshot_redacted_b64,stored:!0},null,2),z(100,`redacted locally`),S.textContent=`local ${i}ms`,l.checked||await e(`clearMasks`,void 0,t.id).catch(()=>{}),L(`Redacted ${r.redacted_regions.length} regions — safe to switch window (stored).`)}catch(e){z(100,`failed`),L(`Scan failed: ${e?.message||e}`,4e3)}finally{u.disabled=!1,u.textContent=`1. Scan & Redact Locally`}}),d.addEventListener(`click`,async()=>{let t=await R();t?.id&&await e(`clearMasks`,void 0,t.id).catch(()=>{}),g.classList.add(`hidden`),f.classList.add(`hidden`),L(`Masks cleared`)}),y.addEventListener(`click`,async()=>{if(!P)return L(`Run Scan & Redact first`);y.disabled=!0,y.textContent=`Contacting server…`,x.classList.remove(`hidden`),x.textContent=`Sending ONLY sanitized context (no raw PII)...`;try{let t=performance.now(),n=r(_.value||await i());await R();let a;try{if(a=await e(`agentStep`,{context:P}),a?.error)throw Error(a.error)}catch{let e=await fetch(`${n.replace(/\/$/,``)}/api/agent/step`,{method:`POST`,headers:{"Content-Type":`application/json`},body:JSON.stringify(P)});if(!e.ok)throw Error(`${e.status} ${await e.text()}`);a=await e.json()}let o=Math.round(performance.now()-t);S.textContent=`server ${o}ms`,F=a.action||a,x.textContent=JSON.stringify(a,null,2),b.disabled=!1,F?.type===`fill`?D.classList.remove(`hidden`):D.classList.add(`hidden`),L(`Agent replied in ${o}ms`)}catch(e){x.textContent=`Error: ${e?.message||e}\n\nTip: start server with: npm run server:dev`}finally{y.disabled=!1,y.textContent=`Ask Agent (sanitized only)`}}),b.addEventListener(`click`,async()=>{if(!F)return;let t=await R();if(!t?.id)return;let n=await e(`executeAction`,{action:F},t.id);L(n?.ok?`Executed ${F.type}`:`Failed: ${n?.error}`)}),O.addEventListener(`click`,async()=>{D.classList.add(`hidden`),b.click()}),w.addEventListener(`click`,async()=>{w.disabled=!0,L(`Preloading models… ~30-60MB first time`);try{let t=await e(`offscreenPreload`,void 0);if(t?.error)throw Error(t.error);L(`Models ready`)}catch(e){L(`Preload: ${e?.message||`check console`}`)}finally{w.disabled=!1}}),T.addEventListener(`click`,async()=>{T.disabled=!0;try{L((await e(`offscreenDispose`,void 0))?.freed?`Memory freed (pipes disposed)`:`Memory freed`)}catch{L(`Memory freed`)}T.disabled=!1,B()}),E.addEventListener(`click`,async()=>{let e=`${r(_.value||await i())}/test-pii.html`;try{let t=new AbortController,n=setTimeout(()=>t.abort(),1500),r=await fetch(e,{method:`HEAD`,signal:t.signal});if(clearTimeout(n),!r.ok)throw Error(String(r.status))}catch{L(`Server not running — cannot open the test page at ${e}. Start it: python3 -m uvicorn server.app:app --port 8000`,5e3);return}await chrome.tabs.create({url:e})}),o(`#viewLast`)?.addEventListener(`click`,async e=>{e.preventDefault();let{lastContext:t}=await chrome.storage.local.get(`lastContext`);x.classList.remove(`hidden`),x.textContent=JSON.stringify(t||P||{},null,2)}),(async()=>{let{lastContext:e,scanState:t}=await chrome.storage.local.get([`lastContext`,`scanState`]);if(e&&t===`done`){P=e;let t=e.metrics||{};f.classList.remove(`hidden`),f.innerHTML=`
      <span>extract ${t.extractionMs??`-`}ms</span> •
      <span>pii ${t.piiDetectionMs??`-`}ms</span> •
      <span>vision ${t.visionMs??`-`}ms</span> •
      <span>redact ${t.redactionMs??`-`}ms</span> •
      <span>${e.redacted_regions?.length??0} regions</span> •
      <span>${e.ax_tree?.length??0} nodes</span> • <span class="tiny">restored after popup close</span>
    `,g.classList.remove(`hidden`),g.textContent=JSON.stringify({url:e.url,title:e.title,ax_tree:e.ax_tree?.slice(0,6),redacted_regions:e.redacted_regions,hasScreenshot:!!e.screenshot_redacted_b64},null,2),b.disabled=!0,D.classList.add(`hidden`)}})(),(async()=>{let t=await R();if(t?.id){if(t.url?.startsWith(`chrome-extension://`)){L(`Extension page: open http://localhost:8000/test-pii.html for full test (run server). Popup closes on blur — scan is stored via background.`,3500);return}try{await e(`ping`,void 0,t.id)}catch{L(`Reload page once after install to inject content script`)}}})(),chrome.storage.onChanged.addListener(e=>{if(e.scanState){let t=e.scanState.newValue;t===`running`?z(12,`background scan…`):t===`done`?z(100,`redacted (stored)`):t===`error`&&z(100,`failed`)}});