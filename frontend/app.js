/* CloudPix — Serverless Image Studio */

const API_STORAGE_KEY = "cloudpix_api_base";
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png"];

const $ = (id) => document.getElementById(id);

let selectedFile = null;
let selectedPreviewUrl = null;
let latestImageId = null;
let pollTimer = null;
let toastTimer = null;

let allHistoryItems = [];
let historySearch = "";
let historyStatus = "All";
let historySort = "newest";

/* API configuration */

function apiBase() {
  return (localStorage.getItem(API_STORAGE_KEY) || "")
    .trim()
    .replace(/\/+$/, "");
}

function setApiBase() {
  const current = apiBase();

  const value = window.prompt(
    "Enter the CloudPix API base URL from the SAM deployment output (ends in /prod):",
    current
  );

  if (value === null) return;

  const cleaned = value.trim().replace(/\/+$/, "");

  if (
    cleaned &&
    !(
      /^https:\/\/[a-z0-9-]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com/i.test(cleaned) ||
      /^http:\/\/(127\.0\.0\.1|localhost):3000$/i.test(cleaned)
    )
  ) {
    notify("Enter the HTTPS API Gateway URL from the deployment output.", true);
    return;
  }

  localStorage.setItem(API_STORAGE_KEY, cleaned);
  refreshAll();
}

async function api(path, options = {}) {
  const base = apiBase();

  if (!base) {
    throw new Error(
      "API endpoint is not configured. Click the AWS serverless badge to set it."
    );
  }

  const response = await fetch(base + path, options);

  let data = {};

  try {
    data = await response.json();
  } catch (_) {
    // Some responses may not contain JSON.
  }

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return data;
}

/* Notifications */

function notify(message, isError = false) {
  const toast = $("toast");

  toast.textContent = message;
  toast.className = "toast show" + (isError ? " error" : "");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    toast.className = "toast";
  }, 3600);
}

/* Formatting */

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes))) return "—";

  const value = Number(bytes);

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(0)} KB`;
  }

  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function formatDate(value) {
  if (!value) return "—";

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

/*
 * Presigned S3 URLs and API URLs should be HTTPS in production.
 * This rejects unexpected URL schemes before URLs are inserted
 * into image and link attributes.
 */
function safeUrl(value) {
  if (!value) return "";

  try {
    const url = new URL(String(value), window.location.href);

    if (url.protocol !== "https:" && url.hostname !== "localhost" &&
        url.hostname !== "127.0.0.1") {
      return "";
    }

    return url.href;
  } catch (_) {
    return "";
  }
}

/* File validation */

function validateFile(file) {
  if (!file) return "Choose an image first.";

  const extension = file.name.split(".").pop().toLowerCase();

  if (
    !ALLOWED_TYPES.includes(file.type) ||
    !["jpg", "jpeg", "png"].includes(extension)
  ) {
    return "Only JPG, JPEG and PNG files are supported.";
  }

  if (file.size < 1 || file.size > MAX_BYTES) {
    return "Image must be between 1 byte and 10 MB.";
  }

  return "";
}

function showSelected(file) {
  if (!file) return;

  const problem = validateFile(file);

  if (problem) {
    notify(problem, true);
    return;
  }

  selectedFile = file;

  if (selectedPreviewUrl) {
    URL.revokeObjectURL(selectedPreviewUrl);
  }

  selectedPreviewUrl = URL.createObjectURL(file);

  $("selected-file").hidden = false;
  $("selected-name").textContent = file.name;
  $("selected-size").textContent = formatBytes(file.size);
  $("upload-message").textContent = "Ready to upload";
  $("upload-progress").style.width = "0%";
  $("preview").src = selectedPreviewUrl;

  $("upload-btn").disabled = false;
}

function clearSelected() {
  selectedFile = null;

  if (selectedPreviewUrl) {
    URL.revokeObjectURL(selectedPreviewUrl);
    selectedPreviewUrl = null;
  }

  $("file-input").value = "";
  $("selected-file").hidden = true;
  $("preview").removeAttribute("src");
  $("upload-btn").disabled = true;
}

/* Image upload */

async function uploadSelected() {
  if (!selectedFile) return;

  const problem = validateFile(selectedFile);

  if (problem) {
    notify(problem, true);
    return;
  }

  const file = selectedFile;

  $("upload-btn").disabled = true;
  $("remove-btn").disabled = true;
  $("upload-message").textContent = "Preparing secure upload…";
  $("upload-progress").style.width = "8%";

  try {
    const record = await api("/uploads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        filename: file.name,
        content_type: file.type,
        size: file.size
      })
    });

    if (!record.image_id || !record.upload_url) {
      throw new Error("The API did not return the expected upload details.");
    }

    latestImageId = record.image_id;

    $("upload-message").textContent =
      "Uploading to private S3 storage…";

    $("upload-progress").style.width = "25%";

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.open("PUT", record.upload_url);
      xhr.setRequestHeader("Content-Type", file.type);

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const progress =
            25 + Math.round((event.loaded / event.total) * 70);

          $("upload-progress").style.width = `${progress}%`;
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(
            new Error(
              `S3 upload failed (${xhr.status}). Check bucket CORS and URL expiry.`
            )
          );
        }
      };

      xhr.onerror = () => {
        reject(new Error("Network error while uploading to S3."));
      };

      xhr.onabort = () => {
        reject(new Error("Upload cancelled."));
      };

      xhr.send(file);
    });

    $("upload-progress").style.width = "100%";
    $("upload-message").textContent =
      "Uploaded — waiting for automatic processing…";

    notify("Upload complete. Lambda processing has been triggered.");

    clearSelected();

    await refreshAll();
    startPolling(record.image_id);

  } catch (error) {
    $("upload-message").textContent = error.message;
    notify(error.message, true);
  } finally {
    $("remove-btn").disabled = false;
    $("upload-btn").disabled = !selectedFile;
  }
}

/* Status and output rendering */

function statusPill(status) {
  const normalized = [
    "Pending",
    "Processing",
    "Completed",
    "Failed"
  ].includes(status) ? status : "Pending";

  return `
    <span class="pill ${normalized.toLowerCase()}">
      ${normalized}
    </span>
  `;
}

function outputs(item) {
  const links = [];

  const original = safeUrl(item.original_url);
  const resized = safeUrl(item.resized_url);
  const thumbnail = safeUrl(item.thumbnail_url);

  if (original) {
    links.push(
      `<a href="${escapeHtml(original)}"
          target="_blank"
          rel="noopener noreferrer">Original ↗</a>`
    );
  }

  if (resized) {
    links.push(
      `<a href="${escapeHtml(resized)}"
          target="_blank"
          rel="noopener noreferrer">Resized ↗</a>`
    );
  }

  if (thumbnail) {
    links.push(
      `<a href="${escapeHtml(thumbnail)}"
          target="_blank"
          rel="noopener noreferrer">Thumbnail ↗</a>`
    );
  }

  return links.length ? links.join("") : "—";
}

function renderLatest(item) {
  const box = $("latest-result");

  if (!item) {
    box.className = "empty-state";

    box.innerHTML = `
      <div class="empty-art">▧</div>
      <strong>No image selected yet</strong>
      <p>Upload an image to see its processing results here.</p>
    `;

    return;
  }

  box.className = "";

  const cards = [
    ["Original image", item.original_url],
    ["Resized · max 800 × 800", item.resized_url],
    ["Thumbnail · max 200 × 200", item.thumbnail_url]
  ];

  box.innerHTML = `
    <div style="margin-bottom:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <strong>${escapeHtml(item.filename)}</strong>
      ${statusPill(item.status)}

      <span style="color:#7b8098;font-size:11px">
        ${escapeHtml(item.error_message || "")}
      </span>
    </div>

    <div class="result-grid">
      ${cards.map(([title, rawUrl]) => {
        const url = safeUrl(rawUrl);

        return `
          <article class="result-card">
            <div class="result-image">
              ${
                url
                  ? `<img
                      src="${escapeHtml(url)}"
                      alt="${escapeHtml(title)}"
                      loading="lazy"
                    >`
                  : `<span style="color:#a0a4b8;font-size:11px">
                      ${
                        item.status === "Failed"
                          ? "Not available"
                          : "Processing…"
                      }
                    </span>`
              }
            </div>

            <div class="result-copy">
              <strong>${escapeHtml(title)}</strong>

              <span>
                ${url ? "Ready to view" : "Waiting for output"}
              </span>

              ${
                url
                  ? `<a
                      class="download-link"
                      href="${escapeHtml(url)}"
                      target="_blank"
                      rel="noopener noreferrer"
                    >Open / download ↗</a>`
                  : ""
              }
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

/* Search, filtering and sorting */

function getVisibleHistory() {
  let items = [...allHistoryItems];

  const query = historySearch.toLocaleLowerCase();

  if (query) {
    items = items.filter((item) => {
      const searchableText =
        `${item.filename || ""} ${item.image_id || ""}`;

      return searchableText.toLocaleLowerCase().includes(query);
    });
  }

  if (historyStatus !== "All") {
    items = items.filter(
      (item) => item.status === historyStatus
    );
  }

  items.sort((a, b) => {
    if (historySort === "name-asc") {
      return String(a.filename || "").localeCompare(
        String(b.filename || "")
      );
    }

    if (historySort === "name-desc") {
      return String(b.filename || "").localeCompare(
        String(a.filename || "")
      );
    }

    const dateA = Date.parse(a.uploaded_at || "") || 0;
    const dateB = Date.parse(b.uploaded_at || "") || 0;

    return historySort === "oldest"
      ? dateA - dateB
      : dateB - dateA;
  });

  return items;
}

function renderHistory() {
  const body = $("history-body");

  if (!body) return;

  const items = getVisibleHistory();
  const summary = $("history-summary");

  if (summary) {
    summary.textContent =
      `Showing ${items.length} of ${allHistoryItems.length} image` +
      `${allHistoryItems.length === 1 ? "" : "s"}`;
  }

  if (!items.length) {
    body.innerHTML = `
      <tr>
        <td colspan="4" class="table-empty">
          ${
            allHistoryItems.length
              ? "No images match your search or selected filter."
              : "No uploads yet. Your history will appear here."
          }
        </td>
      </tr>
    `;

    return;
  }

  body.innerHTML = items.map((item) => {
    const thumbnail = safeUrl(item.thumbnail_url);

    return `
      <tr>
        <td>
          <div class="file-cell">

            ${
              thumbnail
                ? `<img
                    class="mini-thumb"
                    src="${escapeHtml(thumbnail)}"
                    alt=""
                    loading="lazy"
                  >`
                : `<span
                    class="mini-thumb"
                    style="display:grid;place-items:center"
                  >▧</span>`
            }

            <div>
              <strong title="${escapeHtml(item.filename)}">
                ${escapeHtml(item.filename)}
              </strong>

              <small>${escapeHtml(item.image_id)}</small>
            </div>

          </div>
        </td>

        <td>
          ${escapeHtml(formatDate(item.uploaded_at))}
        </td>

        <td>
          ${statusPill(item.status)}

          ${
            item.error_message
              ? `<div
                  title="${escapeHtml(item.error_message)}"
                  style="color:#c94e59;font-size:9px;margin-top:5px"
                >Processing error</div>`
              : ""
          }
        </td>

        <td class="output-links">
          ${outputs(item)}
        </td>
      </tr>
    `;
  }).join("");
}

/* CSV export */

function csvCell(value) {
  let text = String(value ?? "");

  // Reduce spreadsheet formula-injection risk for exported values.
  if (/^\s*[=+\-@]/.test(text)) {
    text = "'" + text;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

function exportHistoryCsv() {
  const items = getVisibleHistory();

  if (!items.length) {
    notify("There are no matching records to export.", true);
    return;
  }

  const headers = [
    "Image ID",
    "Filename",
    "Upload Date",
    "Status",
    "Original URL",
    "Resized URL",
    "Thumbnail URL",
    "Error"
  ];

  const rows = items.map((item) => [
    item.image_id,
    item.filename,
    item.uploaded_at,
    item.status,
    item.original_url,
    item.resized_url,
    item.thumbnail_url,
    item.error_message
  ]);

  const csv = [
    headers,
    ...rows
  ].map((row) => row.map(csvCell).join(",")).join("\r\n");

  const blob = new Blob(
    ["\uFEFF", csv],
    { type: "text/csv;charset=utf-8;" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;

  link.download =
    `cloudpix-history-${new Date().toISOString().slice(0, 10)}.csv`;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);

  notify(
    `Exported ${items.length} image record${items.length === 1 ? "" : "s"}.`
  );
}

/* Refresh dashboard */

async function refreshAll() {
  if (!apiBase()) {
    $("history-body").innerHTML = `
      <tr>
        <td colspan="4" class="table-empty">
          Click “AWS serverless” above to configure your deployed API endpoint.
        </td>
      </tr>
    `;

    $("history-summary").textContent = "API endpoint not configured";

    [
      "total-count",
      "pending-count",
      "completed-count",
      "failed-count"
    ].forEach((id) => {
      $(id).textContent = "—";
    });

    return;
  }

  $("refresh-btn").disabled = true;

  try {
    const result = await api("/history");

    allHistoryItems = Array.isArray(result.items)
      ? result.items
      : [];

    $("total-count").textContent = allHistoryItems.length;

    $("pending-count").textContent =
      allHistoryItems.filter(
        (item) => ["Pending", "Processing"].includes(item.status)
      ).length;

    $("completed-count").textContent =
      allHistoryItems.filter(
        (item) => item.status === "Completed"
      ).length;

    $("failed-count").textContent =
      allHistoryItems.filter(
        (item) => item.status === "Failed"
      ).length;

    renderHistory();

    if (latestImageId) {
      const latest =
        allHistoryItems.find(
          (item) => item.image_id === latestImageId
        ) ||
        await api(
          `/images/${encodeURIComponent(latestImageId)}`
        ).catch(() => null);

      renderLatest(latest);
    }

  } catch (error) {
    notify(error.message, true);

    $("history-body").innerHTML = `
      <tr>
        <td colspan="4" class="table-empty">
          ${escapeHtml(error.message)}
        </td>
      </tr>
    `;

    $("history-summary").textContent = "Could not load history";

  } finally {
    $("refresh-btn").disabled = false;
  }
}

/* Processing status polling */

function startPolling(imageId) {
  clearInterval(pollTimer);

  let tries = 0;

  pollTimer = setInterval(async () => {
    tries++;

    try {
      const item = await api(
        `/images/${encodeURIComponent(imageId)}`
      );

      renderLatest(item);

      await refreshAll();

      if (
        ["Completed", "Failed"].includes(item.status) ||
        tries >= 30
      ) {
        clearInterval(pollTimer);

        if (item.status === "Completed") {
          notify("Image processing completed successfully.");
        }

        if (item.status === "Failed") {
          notify(
            item.error_message || "Image processing failed.",
            true
          );
        }

        if (
          tries >= 30 &&
          !["Completed", "Failed"].includes(item.status)
        ) {
          notify(
            "Processing is taking longer than expected. Refresh history to check again."
          );
        }
      }

    } catch (_) {
      if (tries >= 30) {
        clearInterval(pollTimer);
      }
    }
  }, 2500);
}

/* Event listeners */

$("choose-btn").addEventListener("click", (event) => {
  event.stopPropagation();
  $("file-input").click();
});

$("dropzone").addEventListener("click", (event) => {
  if (event.target.id !== "choose-btn") {
    $("file-input").click();
  }
});

$("dropzone").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    $("file-input").click();
  }
});

$("file-input").addEventListener("change", (event) => {
  showSelected(event.target.files[0]);
});

$("dropzone").addEventListener("dragover", (event) => {
  event.preventDefault();
  $("dropzone").classList.add("dragover");
});

$("dropzone").addEventListener("dragleave", () => {
  $("dropzone").classList.remove("dragover");
});

$("dropzone").addEventListener("drop", (event) => {
  event.preventDefault();

  $("dropzone").classList.remove("dragover");

  showSelected(event.dataTransfer.files[0]);
});

$("remove-btn").addEventListener("click", clearSelected);

$("upload-btn").addEventListener("click", uploadSelected);

$("refresh-btn").addEventListener("click", refreshAll);

$("history-search").addEventListener("input", (event) => {
  historySearch = event.target.value.trim();
  renderHistory();
});

$("history-filter").addEventListener("change", (event) => {
  historyStatus = event.target.value;
  renderHistory();
});

$("history-sort").addEventListener("change", (event) => {
  historySort = event.target.value;
  renderHistory();
});

$("export-btn").addEventListener("click", exportHistoryCsv);

document.querySelector(".cloud-badge")
  .addEventListener("click", setApiBase);

/* Initial load */

refreshAll();
