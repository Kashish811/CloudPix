/* CloudPix frontend. Set API_BASE after deployment, or use the configuration prompt. */
const API_STORAGE_KEY = "cloudpix_api_base";
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png"];
const $ = (id) => document.getElementById(id);
let selectedFile = null;
let latestImageId = null;
let pollTimer = null;
let toastTimer = null;

function apiBase() {
  return (localStorage.getItem(API_STORAGE_KEY) || "").trim().replace(/\/+$/, "");
}
function setApiBase() {
  const current = apiBase();
  const value = window.prompt("Enter the CloudPix API base URL from the SAM deployment output (ends in /prod):", current);
  if (value === null) return;
  const cleaned = value.trim().replace(/\/+$/, "");
  if (cleaned && !(/^https:\/\/[a-z0-9-]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com/i.test(cleaned) || /^http:\/\/(127\.0\.0\.1|localhost):3000$/i.test(cleaned))) {
    notify("Enter the HTTPS API Gateway URL from the deployment output.", true);
    return;
  }
  localStorage.setItem(API_STORAGE_KEY, cleaned);
  refreshAll();
}
function notify(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.className = "toast", 3600);
}
function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
async function api(path, options = {}) {
  const base = apiBase();
  if (!base) throw new Error("API endpoint is not configured. Click the AWS serverless badge to set it.");
  const res = await fetch(base + path, options);
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function validateFile(file) {
  if (!file) return "Choose an image first.";
  const ext = file.name.split(".").pop().toLowerCase();
  if (!ALLOWED_TYPES.includes(file.type) || !["jpg", "jpeg", "png"].includes(ext)) return "Only JPG, JPEG and PNG files are supported.";
  if (file.size < 1 || file.size > MAX_BYTES) return "Image must be between 1 byte and 10 MB.";
  return "";
}
function showSelected(file) {
  const problem = validateFile(file);
  if (problem) { notify(problem, true); return; }
  selectedFile = file;
  $("selected-file").hidden = false;
  $("selected-name").textContent = file.name;
  $("selected-size").textContent = formatBytes(file.size);
  $("upload-message").textContent = "Ready to upload";
  $("upload-progress").style.width = "0%";
  $("preview").src = URL.createObjectURL(file);
  $("upload-btn").disabled = false;
}
function clearSelected() {
  selectedFile = null;
  $("file-input").value = "";
  $("selected-file").hidden = true;
  $("preview").removeAttribute("src");
  $("upload-btn").disabled = true;
}
async function uploadSelected() {
  if (!selectedFile) return;
  const problem = validateFile(selectedFile);
  if (problem) return notify(problem, true);
  $("upload-btn").disabled = true;
  $("upload-message").textContent = "Preparing secure upload…";
  $("upload-progress").style.width = "8%";
  try {
    const record = await api("/uploads", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({filename: selectedFile.name, content_type: selectedFile.type, size: selectedFile.size})
    });
    latestImageId = record.image_id;
    $("upload-message").textContent = "Uploading to private S3 storage…";
    $("upload-progress").style.width = "25%";
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", record.upload_url);
      xhr.setRequestHeader("Content-Type", selectedFile.type);
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) $("upload-progress").style.width = `${25 + Math.round(e.loaded / e.total * 70)}%`;
      };
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`S3 upload failed (${xhr.status}). Check bucket CORS and URL expiry.`));
      xhr.onerror = () => reject(new Error("Network error while uploading to S3."));
      xhr.onabort = () => reject(new Error("Upload cancelled."));
      xhr.send(selectedFile);
    });
    $("upload-progress").style.width = "100%";
    $("upload-message").textContent = "Uploaded — waiting for automatic processing…";
    notify("Upload complete. Lambda processing has been triggered.");
    await refreshAll();
    startPolling(record.image_id);
  } catch (e) {
    $("upload-message").textContent = e.message;
    notify(e.message, true);
    $("upload-btn").disabled = false;
  }
}
function statusPill(status) {
  const normalized = ["Pending", "Processing", "Completed", "Failed"].includes(status) ? status : "Pending";
  return `<span class="pill ${normalized.toLowerCase()}">${normalized}</span>`;
}
function outputs(item) {
  const links = [];
  if (item.original_url) links.push(`<a href="${item.original_url}" target="_blank" rel="noopener">Original ↗</a>`);
  if (item.resized_url) links.push(`<a href="${item.resized_url}" target="_blank" rel="noopener">Resized ↗</a>`);
  if (item.thumbnail_url) links.push(`<a href="${item.thumbnail_url}" target="_blank" rel="noopener">Thumbnail ↗</a>`);
  return links.length ? links.join("") : "—";
}
function renderLatest(item) {
  const box = $("latest-result");
  if (!item) {
    box.className = "empty-state";
    box.innerHTML = `<div class="empty-art">▧</div><strong>No image selected yet</strong><p>Upload an image to see its processing results here.</p>`;
    return;
  }
  box.className = "";
  const cards = [
    ["Original image", item.original_url],
    ["Resized · max 800 × 800", item.resized_url],
    ["Thumbnail · max 200 × 200", item.thumbnail_url]
  ];
  box.innerHTML = `<div style="margin-bottom:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><strong>${escapeHtml(item.filename)}</strong>${statusPill(item.status)}<span style="color:#7b8098;font-size:11px">${escapeHtml(item.error_message || "")}</span></div><div class="result-grid">${cards.map(([title,url]) => `<article class="result-card"><div class="result-image">${url ? `<img src="${url}" alt="${escapeHtml(title)}" loading="lazy">` : `<span style="color:#a0a4b8;font-size:11px">${item.status === "Failed" ? "Not available" : "Processing…"}</span>`}</div><div class="result-copy"><strong>${title}</strong><span>${url ? "Ready to view" : "Waiting for output"}</span>${url ? `<a class="download-link" href="${url}" download>Open / download ↗</a>` : ""}</div></article>`).join("")}</div>`;
}
function renderHistory(items) {
  $("total-count").textContent = items.length;
  $("pending-count").textContent = items.filter(i => ["Pending", "Processing"].includes(i.status)).length;
  $("completed-count").textContent = items.filter(i => i.status === "Completed").length;
  $("failed-count").textContent = items.filter(i => i.status === "Failed").length;
  const body = $("history-body");
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="4" class="table-empty">No uploads yet. Your history will appear here.</td></tr>`;
    return;
  }
  body.innerHTML = items.map(item => `<tr><td><div class="file-cell">${item.thumbnail_url ? `<img class="mini-thumb" src="${item.thumbnail_url}" alt="">` : `<span class="mini-thumb" style="display:grid;place-items:center">▧</span>`}<div><strong title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</strong><small>${escapeHtml(item.image_id)}</small></div></div></td><td>${escapeHtml(formatDate(item.uploaded_at))}</td><td>${statusPill(item.status)}${item.error_message ? `<div title="${escapeHtml(item.error_message)}" style="color:#c94e59;font-size:9px;margin-top:5px">Processing error</div>` : ""}</td><td class="output-links">${outputs(item)}</td></tr>`).join("");
}
async function refreshAll() {
  if (!apiBase()) {
    $("history-body").innerHTML = `<tr><td colspan="4" class="table-empty">Click “AWS serverless” above to configure your deployed API endpoint.</td></tr>`;
    ["total-count", "pending-count", "completed-count", "failed-count"].forEach(id => $(id).textContent = "—");
    return;
  }
  $("refresh-btn").disabled = true;
  try {
    const result = await api("/history");
    const items = result.items || [];
    renderHistory(items);
    if (latestImageId) {
      const latest = items.find(i => i.image_id === latestImageId) || await api(`/images/${encodeURIComponent(latestImageId)}`).catch(() => null);
      renderLatest(latest);
    }
  } catch (e) {
    notify(e.message, true);
    $("history-body").innerHTML = `<tr><td colspan="4" class="table-empty">${escapeHtml(e.message)}</td></tr>`;
  } finally { $("refresh-btn").disabled = false; }
}
function startPolling(imageId) {
  clearInterval(pollTimer);
  let tries = 0;
  pollTimer = setInterval(async () => {
    tries++;
    try {
      const item = await api(`/images/${encodeURIComponent(imageId)}`);
      renderLatest(item);
      await refreshAll();
      if (["Completed", "Failed"].includes(item.status) || tries >= 30) {
        clearInterval(pollTimer);
        if (item.status === "Completed") notify("Image processing completed successfully.");
        if (item.status === "Failed") notify(item.error_message || "Image processing failed.", true);
      }
    } catch (e) {
      if (tries >= 30) clearInterval(pollTimer);
    }
  }, 2500);
}
$("choose-btn").addEventListener("click", e => { e.stopPropagation(); $("file-input").click(); });
$("dropzone").addEventListener("click", e => { if (e.target.id !== "choose-btn") $("file-input").click(); });
$("dropzone").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file-input").click(); } });
$("file-input").addEventListener("change", e => showSelected(e.target.files[0]));
$("dropzone").addEventListener("dragover", e => { e.preventDefault(); $("dropzone").classList.add("dragover"); });
$("dropzone").addEventListener("dragleave", () => $("dropzone").classList.remove("dragover"));
$("dropzone").addEventListener("drop", e => { e.preventDefault(); $("dropzone").classList.remove("dragover"); showSelected(e.dataTransfer.files[0]); });
$("remove-btn").addEventListener("click", clearSelected);
$("upload-btn").addEventListener("click", uploadSelected);
$("refresh-btn").addEventListener("click", refreshAll);
$("history").addEventListener("click", e => { if (e.target.matches(".output-links a")) return; });
document.querySelector(".cloud-badge").addEventListener("click", setApiBase);
refreshAll();
