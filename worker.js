// WhatsApp Business Profile Manager (Cloudflare Worker)
// - UI served as HTML string (never runs in Worker runtime)
// - Require "Load Profile" first
// - Save shows confirm modal with diffs; user can cancel
// - Only non-empty, changed fields are POSTed (no blank overwrites)
// - Optional photo upload via resumable upload (requires env.APP_ID)

const GRAPH_VERSION = "v23.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    // Serve UI
    if (request.method === "GET" && pathname === "/") {
      const photoEnabled = !!(env.APP_ID && String(env.APP_ID).trim());
      return new Response(htmlPage(photoEnabled), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // ===== API: Get current profile (explicit fields + normalize) =====
    if (pathname === "/api/profile" && request.method === "GET") {
      const token = request.headers.get("x-wa-access-token");
      const phoneId = request.headers.get("x-wa-phone-number-id");
      if (!token || !phoneId) {
        return cors(json({ error: "Missing x-wa-access-token or x-wa-phone-number-id" }, 400));
      }

      const fields = [
        "about",
        "address",
        "description",
        "email",
        "websites",
        "vertical",
        "profile_picture_url"
      ].join(",");

      const resp = await fetch(
        `${GRAPH}/${encodeURIComponent(phoneId)}/whatsapp_business_profile?fields=${encodeURIComponent(fields)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const raw = await safeJson(resp);

      // Normalize: {data:[{...}]}, {data:{...}}, or {...}
      let data = raw;
      if (raw && typeof raw === "object" && "data" in raw) data = raw.data;
      if (Array.isArray(data)) data = data[0] || {};

      return cors(json({ status: resp.status, data, raw }, resp.ok ? 200 : resp.status));
    }

    // ===== API: Update profile (only non-empty keys) =====
    if (pathname === "/api/profile" && request.method === "POST") {
      const token = request.headers.get("x-wa-access-token");
      const phoneId = request.headers.get("x-wa-phone-number-id");
      if (!token || !phoneId) {
        return cors(json({ error: "Missing x-wa-access-token or x-wa-phone-number-id" }, 400));
      }

      const bodyIn = await safeBody(request);

      // include only non-empty keys to avoid blank overwrites
      const includeIfValue = (v) => {
        if (v === null || v === undefined) return false;
        if (Array.isArray(v)) return v.length > 0;
        if (typeof v === "string") return v.trim().length > 0;
        return true;
      };

      const payload = { messaging_product: "whatsapp" };
      for (const key of ["about", "description", "address", "email", "vertical", "profile_picture_handle"]) {
        if (includeIfValue(bodyIn[key])) payload[key] = bodyIn[key];
      }
      if (Array.isArray(bodyIn.websites) && bodyIn.websites.length > 0) {
        payload.websites = bodyIn.websites.slice(0, 2); // Meta limit
      }

      if (Object.keys(payload).length === 1) {
        return cors(json({ status: 400, error: "No non-empty fields to update." }, 400));
      }

      const resp = await fetch(`${GRAPH}/${encodeURIComponent(phoneId)}/whatsapp_business_profile`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const data = await safeJson(resp);
      return cors(json({ status: resp.status, data }, resp.ok ? 200 : resp.status));
    }

    // ===== API: Upload & apply profile photo (requires env.APP_ID) =====
    if (pathname === "/api/photo" && request.method === "POST") {
      const token = request.headers.get("x-wa-access-token");
      const phoneId = request.headers.get("x-wa-phone-number-id");
      if (!token || !phoneId) return cors(json({ error: "Missing x-wa-access-token or x-wa-phone-number-id" }, 400));
      if (!env.APP_ID) return cors(json({ error: "APP_ID not configured in worker env" }, 400));

      const ct = request.headers.get("content-type") || "";
      let fileBytes, mime = "image/jpeg", fileLength;

      if (ct.includes("multipart/form-data")) {
        const form = await request.formData();
        const file = form.get("file");
        if (!file || typeof file === "string") {
          return cors(json({ error: "multipart/form-data must include a 'file' field" }, 400));
        }
        mime = file.type || "image/jpeg";
        fileBytes = new Uint8Array(await file.arrayBuffer());
        fileLength = fileBytes.length;
      } else {
        const body = await safeBody(request);
        if (!body || !body.image_url) {
          return cors(json({ error: "Send multipart 'file' OR JSON {image_url}" }, 400));
        }
        const fileResp = await fetch(body.image_url);
        if (!fileResp.ok) {
          return cors(json({ error: `Failed to fetch image_url: ${fileResp.status}` }, 400));
        }
        mime = fileResp.headers.get("content-type") || "image/jpeg";
        fileBytes = new Uint8Array(await fileResp.arrayBuffer());
        fileLength = fileBytes.length;
      }

      // Create upload session
      const createUpload = await fetch(
        `${GRAPH}/${encodeURIComponent(env.APP_ID)}/uploads?file_length=${fileLength}&file_type=${encodeURIComponent(mime)}`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } }
      );
      const createJson = await safeJson(createUpload);
      if (!createUpload.ok) {
        return cors(json({ step: "create_upload", error: createJson }, createUpload.status));
      }
      const uploadId = createJson.id;

      // Upload bytes
      const uploadBytes = await fetch(`${GRAPH}/${encodeURIComponent(uploadId)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "file_offset": "0",
          "Content-Type": "application/octet-stream",
        },
        body: fileBytes,
      });
      const uploadJson = await safeJson(uploadBytes);
      if (!uploadBytes.ok) {
        return cors(json({ step: "upload_bytes", error: uploadJson }, uploadBytes.status));
      }

      const handle = uploadJson.h || uploadJson.handle || (uploadJson.data && uploadJson.data[0] && uploadJson.data[0].h);
      if (!handle) {
        return cors(json({ step: "upload_bytes", error: "No handle returned" }, 502));
      }

      // Apply to profile
      const applyResp = await fetch(`${GRAPH}/${encodeURIComponent(phoneId)}/whatsapp_business_profile`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messaging_product: "whatsapp", profile_picture_handle: handle }),
      });
      const applyJson = await safeJson(applyResp);

      return cors(json({
        status: applyResp.status,
        upload_id: uploadId,
        handle,
        apply: applyJson,
      }, applyResp.ok ? 200 : applyResp.status));
    }

    return cors(json({ error: "Not Found" }, 404));
  }
};

// ===== helpers =====
async function safeJson(resp) { try { return await resp.json(); } catch { return {}; } }
async function safeBody(req) { try { return await req.json(); } catch { return {}; } }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
function cors(resp) {
  const h = new Headers(resp.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, x-wa-access-token, x-wa-phone-number-id");
  return new Response(resp.body, { status: resp.status, headers: h });
}

// ===== UI (served as a string) =====
function htmlPage(photoEnabled) {
  return (
`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>WhatsApp Business Profile Manager</title>
  <style>
    :root { color-scheme: light; }
    body { margin:0; background:#f5f7fb; color:#0f172a; font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial; }
    .shell { max-width:980px; margin:32px auto; padding:0 16px; }
    .box { background:#fff; border:1px solid #e5e7eb; border-radius:14px; box-shadow:0 1px 2px rgba(0,0,0,.04); padding:18px; margin-bottom:16px; }
    h1 { font-size:20px; margin:0 0 12px; }
    h2 { font-size:16px; margin:6px 0 10px; }
    label { display:block; margin:8px 0 6px; font-weight:600; color:#111827; }
    input[type="text"], input[type="url"], input[type="email"], textarea {
      width:100%; padding:10px 12px; border-radius:10px; border:1px solid #d1d5db; background:#fff; color:#0f172a; outline:none;
    }
    input::placeholder, textarea::placeholder { color:#9ca3af; }
    textarea { min-height:96px; }
    input:focus, textarea:focus { border-color:#2563eb; box-shadow:0 0 0 3px rgba(37,99,235,.12); }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
    .btn { appearance:none; border:0; padding:10px 14px; border-radius:10px; cursor:pointer; font-weight:600; }
    .btn.primary { background:#2563eb; color:#fff; }
    .btn.soft { background:#eef2ff; color:#1e40af; }
    .muted { color:#6b7280; }
    .flex { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .pill { border:1px solid #d1d5db; padding:6px 10px; border-radius:999px; background:#f9fafb; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .hidden { display:none; }
    .hr { height:1px; background:#e5e7eb; margin:10px 0; }
    .thumb { width:72px; height:72px; border-radius:10px; object-fit:cover; border:1px solid #e5e7eb; background:#f3f4f6; }
    /* Modal */
    .overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,.45);
      display: none;             /* default closed to block BFCache popups */
      align-items: center; justify-content: center;
    }
    .overlay.open { display: flex; }
    .modal { background:#fff; color:#111827; width:min(520px, calc(100% - 32px)); border-radius:14px; border:1px solid #e5e7eb; box-shadow:0 10px 30px rgba(0,0,0,.2); }
    .modal header { padding:14px 16px; border-bottom:1px solid #e5e7eb; font-weight:700; }
    .modal .content { padding:14px 16px; max-height:60vh; overflow:auto; }
    .modal footer { padding:14px 16px; border-top:1px solid #e5e7eb; display:flex; gap:10px; justify-content:flex-end; }
    .kv { font-size:13px; border-bottom:1px dashed #e5e7eb; padding:6px 0; }
    .kv .k { font-weight:600; }
    .kv .v-old { color:#b91c1c; }
    .kv .v-new { color:#065f46; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="box">
      <h1>WhatsApp Business Profile Manager</h1>
      <div class="row">
        <div>
          <label>Phone Number ID</label>
          <input id="phoneId" type="text" placeholder="e.g. 123456789012345"/>
        </div>
        <div>
          <label>Access Token</label>
          <input id="token" type="text" placeholder="EAAG..."/>
        </div>
      </div>
      <div class="flex" style="margin-top:10px">
        <button id="btnLoad" class="btn soft">Load Profile</button>
        <span id="status" class="muted"></span>
      </div>
      <div class="muted" style="margin-top:6px">Nothing is stored. Token is used only on this page and proxied to Meta via this Worker.</div>
    </div>

    <div id="editor" class="box hidden">
      <h2>Profile</h2>
      <div class="row">
        <div>
          <label>About / Status</label>
          <input id="about" type="text" maxlength="139" placeholder="e.g. Usually replies in minutes" disabled/>
        </div>
        <div>
          <label>Vertical / Category</label>
          <input id="vertical" type="text" placeholder="e.g. COMMUNICATIONS_TECHNOLOGY" disabled/>
        </div>
      </div>

      <div class="row">
        <div>
          <label>Email</label>
          <input id="email" type="email" placeholder="hello@example.com" disabled/>
        </div>
        <div>
          <label>Address</label>
          <input id="address" type="text" placeholder="Company address" disabled/>
        </div>
      </div>

      <div style="margin-top:6px">
        <label>Description</label>
        <textarea id="description" placeholder="Short business description" disabled></textarea>
      </div>

      <div style="margin-top:6px">
        <label>Websites (max 2)</label>
        <div id="websites" class="flex"></div>
        <div class="flex">
          <input id="wsNew" type="url" placeholder="https://example.com" style="flex:1" disabled/>
          <button id="wsAdd" class="btn soft" type="button" disabled>Add</button>
        </div>
      </div>

      <div class="hr"></div>

      <div class="flex">
        <button id="btnSave" class="btn primary" disabled>Save Changes</button>
        <span id="saveMsg" class="muted"></span>
      </div>

      <details style="margin-top:14px">
        <summary>Debug: Raw GET response</summary>
        <code id="rawOut" class="mono" style="display:block;white-space:pre-wrap;background:#0b1220;color:#e5e7eb;padding:10px;border-radius:10px;border:1px solid #111827;"></code>
      </details>
    </div>

    <div id="photoCard" class="box ${photoEnabled ? "" : "hidden"}">
      <h2>Profile Photo</h2>
      <div class="flex">
        <img id="thumb" class="thumb" alt="Current" src="" onerror="this.style.visibility='hidden'"/>
        <div class="muted">JPEG works best. We'll create a resumable upload, get a handle, and apply it.</div>
      </div>
      <div class="flex" style="margin-top:10px">
        <input id="file" type="file" accept="image/jpeg,image/jpg,image/png" disabled/>
        <span class="muted">or</span>
        <input id="imgUrl" type="url" placeholder="https://.../logo.jpg" style="flex:1" disabled/>
      </div>
      <div class="flex" style="margin-top:10px">
        <button id="btnPhoto" class="btn soft" disabled>Upload & Apply</button>
        <span id="photoMsg" class="muted"></span>
      </div>
    </div>
  </div>

  <!-- Confirm modal -->
  <div id="overlay" class="overlay" style="display:none" aria-hidden="true">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="mTitle">
      <header id="mTitle">Confirm updates</header>
      <div class="content">
        <div id="diffList"></div>
      </div>
      <footer>
        <button id="mCancel" class="btn soft" type="button">Cancel</button>
        <button id="mConfirm" class="btn primary" type="button">Confirm & Update</button>
      </footer>
    </div>
  </div>

<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var state = { phoneId: "", token: "", websites: [], loaded: false, current: {} };

  // --- Modal state & helpers (overlay closed by default: display:none) ---
  var overlay = $("overlay");
  var diffList = $("diffList");
  var pendingPayload = null;

  function closeConfirm(){
    overlay.classList.remove("open");
    overlay.style.display = "none";
    overlay.setAttribute("aria-hidden","true");
    diffList.innerHTML = "";
    pendingPayload = null;
  }
  function openConfirm(list){
    overlay.classList.add("open");
    overlay.style.display = "flex";
    overlay.setAttribute("aria-hidden","false");
    diffList.innerHTML = list.map(function(i){
      return '<div class="kv">'
           +   '<div class="k">' + escapeHtml(i.key) + '</div>'
           +   '<div class="v-old mono">Old: ' + escapeHtml(i.old) + '</div>'
           +   '<div class="v-new mono">New: ' + escapeHtml(i.val) + '</div>'
           + '</div>';
    }).join("");
  }
  // Force close on load and BFCache restores; Esc closes
  closeConfirm();
  window.addEventListener("pageshow", function(e){ if (e.persisted) closeConfirm(); });
  document.addEventListener("keydown", function(e){ if (e.key === "Escape") closeConfirm(); });

  function toast(el, text, ok){
    if (ok === void 0) ok = true;
    el.textContent = text;
    el.style.color = ok ? "#065f46" : "#b91c1c";
    setTimeout(function(){ el.textContent=""; el.style.color="#6b7280"; }, 4000);
  }

  function enableEditing(on){
    ["about","vertical","email","address","description","wsNew","wsAdd","btnSave","file","imgUrl","btnPhoto"]
      .forEach(function(id){ var el=$(id); if(el) el.disabled = !on; });
  }

  function renderWebsites(){
    var container = $("websites");
    container.innerHTML = "";
    (state.websites || []).forEach(function(u, idx){
      var pill = document.createElement("span");
      pill.className = "pill mono";
      pill.textContent = u;
      pill.title = "Click to remove";
      pill.style.cursor = "pointer";
      pill.onclick = function(){ state.websites.splice(idx,1); renderWebsites(); };
      container.appendChild(pill);
    });
  }

  $("wsAdd").onclick = function(){
    var v = $("wsNew").value.trim();
    if (!v) return;
    try { new URL(v); } catch(e){ toast($("saveMsg"), "Invalid URL", false); return; }
    state.websites = state.websites || [];
    if (state.websites.length >= 2) { toast($("saveMsg"), "Max 2 websites", false); return; }
    if (state.websites.indexOf(v) === -1) state.websites.push(v);
    $("wsNew").value = "";
    renderWebsites();
  };

  $("btnLoad").onclick = function(){ return loadProfile(); };

  function loadProfile(){
    state.phoneId = $("phoneId").value.trim();
    state.token = $("token").value.trim();
    if (!state.phoneId || !state.token) { toast($("status"), "Enter both Phone Number ID and Access Token", false); return; }

    $("status").textContent = "Loading...";
    fetch("/api/profile", {
      method: "GET",
      headers: { "x-wa-phone-number-id": state.phoneId, "x-wa-access-token": state.token }
    })
    .then(function(resp){ return resp.json().then(function(out){ return {resp:resp, out:out}; }); })
    .then(function(pair){
      var resp = pair.resp, out = pair.out;
      $("rawOut").textContent = JSON.stringify(out, null, 2);

      if (!resp.ok) { toast($("status"), (out && out.error) ? out.error : "Failed to load profile", false); return; }

      var p = out && out.data ? out.data : out;
      state.current = {
        about: p.about || "",
        vertical: p.vertical || "",
        email: p.email || "",
        address: p.address || "",
        description: p.description || "",
        websites: Array.isArray(p.websites) ? p.websites.slice(0,2) : [],
        profile_picture_url: p.profile_picture_url || ""
      };

      $("about").value = state.current.about;
      $("description").value = state.current.description;
      $("address").value = state.current.address;
      $("email").value = state.current.email;
      $("vertical").value = state.current.vertical;
      state.websites = state.current.websites.slice(0);
      renderWebsites();

      if (state.current.profile_picture_url) {
        var img = $("thumb");
        img.style.visibility = "visible";
        img.src = state.current.profile_picture_url;
      }

      $("editor").classList.remove("hidden");
      enableEditing(true);
      state.loaded = true;

      $("status").textContent = "Loaded.";
      setTimeout(function(){ $("status").textContent=""; }, 1500);
    })
    .catch(function(e){
      toast($("status"), "Error: " + e.message, false);
    });
  }

  function includeIfValue(v){
    if (v === null || v === undefined) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "string") return v.trim().length > 0;
    return true;
  }

  function computeChanges(){
    if (!state.loaded) return { changes:{}, list:[] };

    var proposed = {
      about: $("about").value.trim(),
      description: $("description").value.trim(),
      address: $("address").value.trim(),
      email: $("email").value.trim(),
      vertical: $("vertical").value.trim(),
      websites: (state.websites || []).slice(0,2)
    };

    var changes = {};
    var list = [];

    ["about","description","address","email","vertical"].forEach(function(k){
      if (includeIfValue(proposed[k]) && proposed[k] !== (state.current[k] || "")) {
        changes[k] = proposed[k];
        list.push({ key:k, old: (state.current[k] || "(empty)"), val: proposed[k] });
      }
    });

    if (Array.isArray(proposed.websites) && proposed.websites.length > 0) {
      var oldWs = (state.current.websites || []).join(", ");
      var newWs = proposed.websites.join(", ");
      if (newWs !== oldWs) {
        changes.websites = proposed.websites;
        list.push({ key:"websites", old: oldWs || "(empty)", val: newWs });
      }
    }

    return { changes: changes, list: list };
  }

  // Save click -> show modal only when there are changes
  $("btnSave").onclick = function(){
    if (!state.loaded) { toast($("saveMsg"), "Load profile first", false); return; }
    var res = computeChanges();

    if (!res.list.length) {
      toast($("saveMsg"), "No changes to update.", false);
      return;
    }

    pendingPayload = res.changes;
    openConfirm(res.list);
  };

  // Confirm / Cancel wired once
  $("mCancel").onclick = function(){
    pendingPayload = null;
    closeConfirm();
  };

  $("mConfirm").onclick = function(){
    if (!pendingPayload) { closeConfirm(); return; }

    fetch("/api/profile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wa-phone-number-id": state.phoneId,
        "x-wa-access-token": state.token
      },
      body: JSON.stringify(pendingPayload)
    })
    .then(function(resp){ return resp.json().then(function(out){ return {resp:resp, out:out}; }); })
    .then(function(pair){
      closeConfirm();
      var resp = pair.resp, out = pair.out;
      if (!resp.ok) {
        var msg = (out && out.data && out.data.error && out.data.error.message) || (out && out.error) || "Update failed";
        toast($("saveMsg"), msg, false);
        return;
      }
      toast($("saveMsg"), "Updated ✓", true);
      Object.assign(state.current, pendingPayload);
      pendingPayload = null;
    })
    .catch(function(e){
      closeConfirm();
      toast($("saveMsg"), "Error: " + e.message, false);
    });
  };

  // Photo upload
  var btnPhoto = document.getElementById("btnPhoto");
  if (btnPhoto) {
    btnPhoto.addEventListener("click", function(){
      if (!state.loaded) { toast($("photoMsg"), "Load profile first", false); return; }
      var f = $("file").files[0];
      var url = $("imgUrl").value.trim();
      var req;

      if (f) {
        var form = new FormData();
        form.append("file", f);
        req = fetch("/api/photo", {
          method: "POST",
          headers: { "x-wa-phone-number-id": state.phoneId, "x-wa-access-token": state.token },
          body: form
        });
      } else if (url) {
        try { new URL(url); } catch(e) { toast($("photoMsg"), "Invalid image URL", false); return; }
        req = fetch("/api/photo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-wa-phone-number-id": state.phoneId,
            "x-wa-access-token": state.token
          },
          body: JSON.stringify({ image_url: url })
        });
      } else {
        toast($("photoMsg"), "Choose a file or paste an image URL", false);
        return;
      }

      req.then(function(resp){ return resp.json().then(function(out){ return {resp:resp, out:out}; }); })
        .then(function(pair){
          var resp = pair.resp, out = pair.out;
          if (!resp.ok) {
            var emsg = (out && out.error) ? (typeof out.error === "string" ? out.error : JSON.stringify(out.error)) : "Photo update failed";
            toast($("photoMsg"), emsg, false);
            return;
          }
          toast($("photoMsg"), "Photo updated ✓", true);
        })
        .catch(function(e){
          toast($("photoMsg"), "Error: " + e.message, false);
        });
    });
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>\"']/g, function(m){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]); });
  }
})();
</script>
</body>
</html>`
  );
}