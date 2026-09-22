import"./_virtual_wxt-html-plugins-P2Xu9kJm.js";var e=document.getElementById(`app`);e.innerHTML=`
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
`;var t=e=>document.querySelector(e),n=t(`#task`),r=t(`#includeShot`),i=t(`#showMasks`),a=t(`#btnSanitize`),o=t(`#btnClear`),s=t(`#metrics`),c=t(`#progress`),l=c.querySelector(`.bar`),u=c.querySelector(`.pct`),d=t(`#contextPreview`),f=t(`#serverUrl`),p=t(`#btnSaveServer`),m=t(`#btnAgent`),h=t(`#btnExecute`),g=t(`#agentOut`),_=t(`#latency`),v=t(`#deviceInfo`),y=t(`#btnPreload`),b=t(`#btnDispose`),x=t(`#btnTestPage`),S=t(`#confirmRow`),C=t(`#btnConfirm`),w=t(`#toast`),T=t(`#storageInfo`),E=t(`#quantSel`),D=t(`#memInfo`),O=t(`#serverBanner`),k=null,A=null;chrome.storage.local.get(`serverUrl`).then(e=>{f.value=e?.serverUrl||`http://localhost:8000`,j()});async function j(){let e=(f.value||`http://localhost:8000`).replace(/\/$/,``);try{let t=new AbortController;setTimeout(()=>t.abort(),1200);let n=await fetch(`${e}/health`,{signal:t.signal});if(!n.ok)throw Error(String(n.status));O.classList.add(`hidden`),O.textContent=``}catch{O.textContent=`Server not running at ${e} — Scan will still redact locally, but "Open PII test page" needs http://localhost:8000/test-pii.html . Start: python3 -m uvicorn server.app:app --port 8000`,O.classList.remove(`hidden`)}}setInterval(j,4e3),f.addEventListener(`change`,j),p.addEventListener(`click`,async()=>{await chrome.storage.local.set({serverUrl:f.value.trim()}),M(`Server URL saved`),j()});function M(e,t=2500){w.textContent=e,w.classList.remove(`hidden`),setTimeout(()=>w.classList.add(`hidden`),t)}async function N(){let[e]=await chrome.tabs.query({active:!0,currentWindow:!0});return e}function P(e,t){c.classList.remove(`hidden`),l.style.width=`${Math.max(2,Math.min(100,e))}%`,u.textContent=t?`${Math.round(e)}% ${t}`:`${Math.round(e)}%`,e>=100&&setTimeout(()=>c.classList.add(`hidden`),800)}chrome.storage.onChanged.addListener(e=>{if(e.mlProgress){let t=e.mlProgress.newValue;t?.progress==null?t?.status===`done`&&P(100,`ready`):P(t.progress,t.file||t.status)}});async function F(){let e=`wasm (fallback)`;try{navigator.gpu&&await navigator.gpu?.requestAdapter?.()&&(e=`webgpu (GPU)`)}catch{}let{mlProgress:t,quantMode:n}=await chrome.storage.local.get([`mlProgress`,`quantMode`]),r=n||`q8`;v.textContent=`${e} • ${r} • ${t?`model loading…`:`lazy`}`,E.value=r;try{let e=await navigator.storage?.estimate?.();if(e?.quota&&e?.usage!=null){let t=(e.usage/e.quota*100).toFixed(1);T.textContent=`storage ${(e.usage/1e6).toFixed(1)}MB / ${(e.quota/1e6).toFixed(0)}MB (${t}%)`}else T.textContent=`storage: n/a`}catch{T.textContent=`storage: n/a`}if(performance.memory){let e=performance.memory;D.textContent=`heap ${(e.usedJSHeapSize/1e6).toFixed(0)}MB / ${(e.jsHeapSizeLimit/1e6).toFixed(0)}MB`}else navigator.deviceMemory&&(D.textContent=`deviceMemory ${navigator.deviceMemory}GB`)}F(),setInterval(F,3e3),E.addEventListener(`change`,async()=>{let e=E.value;await chrome.runtime.sendMessage({type:`OFFSCREEN_SET_QUANT`,mode:e}).catch(()=>{}),await chrome.storage.local.set({quantMode:e}),M(`Quant set to ${e} — next load will use it (preload to apply)`),F()});async function I(e,t){let n=chrome.runtime.sendMessage({type:`START_SCAN`,tabId:e,...t}),r=8,i=new Promise((e,t)=>{let n=Date.now(),i=setInterval(async()=>{let{scanState:a,scanError:o,lastContext:s}=await chrome.storage.local.get([`scanState`,`scanError`,`lastContext`]);a===`done`&&s?(clearInterval(i),e(s)):a===`error`?(clearInterval(i),t(Error(o||`Scan failed`))):Date.now()-n>8e3?(clearInterval(i),t(Error(`Scan timeout — reload page once after install, and open test page via http://localhost:8000/test-pii.html (extension pages have no content script).`))):(r=Math.min(85,r+2),P(r,`redacting…`))},200)});try{let e=await Promise.race([n,i]);if(e&&e.url)return e}catch{}return await i}a.addEventListener(`click`,async()=>{let e=await N();if(!e?.id)return M(`No active tab`);if(e.url?.startsWith(`chrome-extension://`)&&e.url.includes(`test-pii.html`)){let{serverUrl:t}=await chrome.storage.local.get(`serverUrl`),n=`${(t||f.value||`http://localhost:8000`).replace(/\/$/,``)}/test-pii.html`;M(`Extension test page cannot be scanned (no content script). Redirecting to http://localhost:8000/test-pii.html — needs server running.`,5e3);try{await chrome.tabs.update(e.id,{url:n}),M(`Redirected to http test page — retry Scan after page loads (2s).`,3e3)}catch{}a.disabled=!1,a.textContent=`1. Scan & Redact Locally`,P(100,`redirected`);return}a.disabled=!0,a.textContent=`Scanning…`,P(8,`extracting DOM`),await chrome.storage.local.set({scanState:`running`,scanError:null}).catch(()=>{});try{let t=performance.now(),a=null;try{let t=chrome.tabs.sendMessage(e.id,{type:`GET_SANITIZED_CONTEXT`,task:n.value.trim()||void 0,includeScreenshot:r.checked});a=await Promise.race([t,new Promise((e,t)=>setTimeout(()=>t(Error(`direct-timeout`)),3500))])}catch{a=await I(e.id,{task:n.value.trim()||void 0,includeScreenshot:r.checked})}if(!a||!a.url){let{lastContext:e}=await chrome.storage.local.get(`lastContext`);e&&(a=e)}if(!a||!a.url)throw Error(`No context returned — reload page once after install, then retry. For test page use http://localhost:8000/test-pii.html`);let o=Math.round(performance.now()-t);k=a;let c=a.metrics||{};s.classList.remove(`hidden`),s.innerHTML=`
      <span>extract ${c.extractionMs??`-`}ms</span> •
      <span>pii ${c.piiDetectionMs??`-`}ms</span> •
      <span>vision ${c.visionMs??`-`}ms</span> •
      <span>redact ${c.redactionMs??`-`}ms</span> •
      <span>total ${o}ms</span> •
      <span>${a.redacted_regions.length} regions</span> •
      <span>${a.ax_tree.length} nodes</span>
    `,d.classList.remove(`hidden`),d.textContent=JSON.stringify({url:a.url,title:a.title,ax_tree:a.ax_tree.slice(0,6),redacted_regions:a.redacted_regions,hasScreenshot:!!a.screenshot_redacted_b64,stored:!0},null,2),P(100,`redacted locally`),_.textContent=`local ${o}ms`,i.checked||await chrome.tabs.sendMessage(e.id,{type:`CLEAR_MASKS`}).catch(()=>{}),M(`Redacted ${a.redacted_regions.length} regions — safe to switch window (stored).`)}catch(e){P(100,`failed`),M(`Scan failed: ${e?.message||e}`,4e3)}finally{a.disabled=!1,a.textContent=`1. Scan & Redact Locally`}}),o.addEventListener(`click`,async()=>{let e=await N();e?.id&&await chrome.tabs.sendMessage(e.id,{type:`CLEAR_MASKS`}).catch(()=>{}),d.classList.add(`hidden`),s.classList.add(`hidden`),M(`Masks cleared`)}),m.addEventListener(`click`,async()=>{if(!k)return M(`Run Scan & Redact first`);m.disabled=!0,m.textContent=`Contacting server…`,g.classList.remove(`hidden`),g.textContent=`Sending ONLY sanitized context (no raw PII)...`;try{let e=performance.now(),t=(await chrome.storage.local.get(`serverUrl`))?.serverUrl||f.value.trim()||`http://localhost:8000`;await N();let n;try{if(n=await chrome.runtime.sendMessage({type:`AGENT_STEP`,context:k}),n?.error)throw Error(n.error)}catch{let e=await fetch(`${t.replace(/\/$/,``)}/api/agent/step`,{method:`POST`,headers:{"Content-Type":`application/json`},body:JSON.stringify(k)});if(!e.ok)throw Error(`${e.status} ${await e.text()}`);n=await e.json()}let r=Math.round(performance.now()-e);_.textContent=`server ${r}ms`,A=n.action||n,g.textContent=JSON.stringify(n,null,2),h.disabled=!1,A?.type===`fill`?S.classList.remove(`hidden`):S.classList.add(`hidden`),M(`Agent replied in ${r}ms`)}catch(e){g.textContent=`Error: ${e?.message||e}\n\nTip: start server with: npm run server:dev`}finally{m.disabled=!1,m.textContent=`Ask Agent (sanitized only)`}}),h.addEventListener(`click`,async()=>{if(!A)return;let e=await N();if(!e?.id)return;let t=await chrome.tabs.sendMessage(e.id,{type:`EXECUTE_ACTION`,action:A});M(t?.ok?`Executed ${A.type}`:`Failed: ${t?.error}`)}),C.addEventListener(`click`,async()=>{S.classList.add(`hidden`),h.click()}),y.addEventListener(`click`,async()=>{y.disabled=!0,M(`Preloading models… ~30-60MB first time`);try{await chrome.runtime.sendMessage({type:`OFFSCREEN_PRELOAD`}).catch(()=>chrome.runtime.sendMessage({type:`ENSURE_OFFSCREEN`})),await chrome.runtime.sendMessage({type:`OFFSCREEN_PRELOAD`}),M(`Models ready`)}catch(e){M(`Preload: ${e?.message||`check console`}`)}finally{y.disabled=!1}}),b.addEventListener(`click`,async()=>{b.disabled=!0;try{M((await chrome.runtime.sendMessage({type:`OFFSCREEN_DISPOSE`}))?.freed?`Memory freed (pipes disposed)`:`Memory freed`)}catch{M(`Memory freed`)}b.disabled=!1,F()}),x.addEventListener(`click`,async()=>{let{serverUrl:e}=await chrome.storage.local.get(`serverUrl`),t=(e||f.value||`http://localhost:8000`).replace(/\/$/,``),n=`${t}/test-pii.html`;try{let e=new AbortController;setTimeout(()=>e.abort(),1500);let t=await fetch(n,{method:`HEAD`,signal:e.signal});if(!t.ok)throw Error(String(t.status))}catch{M(`Server not running — cannot open http test page. Start server first: python3 -m uvicorn server.app:app --port 8000  (then retry)`,5e3),n=`${t}/test-pii.html`}await chrome.tabs.create({url:n})}),t(`#viewLast`)?.addEventListener(`click`,async e=>{e.preventDefault();let{lastContext:t}=await chrome.storage.local.get(`lastContext`);g.classList.remove(`hidden`),g.textContent=JSON.stringify(t||k||{},null,2)}),(async()=>{let{lastContext:e,scanState:t}=await chrome.storage.local.get([`lastContext`,`scanState`]);if(e&&t===`done`){k=e;let t=e.metrics||{};s.classList.remove(`hidden`),s.innerHTML=`
      <span>extract ${t.extractionMs??`-`}ms</span> •
      <span>pii ${t.piiDetectionMs??`-`}ms</span> •
      <span>vision ${t.visionMs??`-`}ms</span> •
      <span>redact ${t.redactionMs??`-`}ms</span> •
      <span>${e.redacted_regions?.length??0} regions</span> •
      <span>${e.ax_tree?.length??0} nodes</span> • <span class="tiny">restored after popup close</span>
    `,d.classList.remove(`hidden`),d.textContent=JSON.stringify({url:e.url,title:e.title,ax_tree:e.ax_tree?.slice(0,6),redacted_regions:e.redacted_regions,hasScreenshot:!!e.screenshot_redacted_b64},null,2),h.disabled=!1}})(),(async()=>{let e=await N();if(e?.id){if(e.url?.startsWith(`chrome-extension://`)){M(`Extension page: open http://localhost:8000/test-pii.html for full test (run server). Popup closes on blur — scan is stored via background.`,3500);return}try{await chrome.tabs.sendMessage(e.id,{type:`PING`})}catch{M(`Reload page once after install to inject content script`)}}})(),chrome.storage.onChanged.addListener(e=>{if(e.scanState){let t=e.scanState.newValue;t===`running`?P(12,`background scan…`):t===`done`?P(100,`redacted (stored)`):t===`error`&&P(100,`failed`)}});