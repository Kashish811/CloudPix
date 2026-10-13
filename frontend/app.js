/* =========================================================
   CLOUDPIX — SERVERLESS IMAGE STUDIO
   Complete frontend application
========================================================= */

"use strict";


/* =========================================================
   CONFIGURATION
========================================================= */

const API_STORAGE_KEY = "cloudpix_api_base";
const THEME_STORAGE_KEY = "cloudpix_theme";
const VIEW_STORAGE_KEY = "cloudpix_history_view";

const MAX_BYTES = 10 * 1024 * 1024;

const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png"
];

const ALLOWED_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png"
];

const TERMINAL_STATUSES = [
  "Completed",
  "Failed"
];

const POLL_INTERVAL_MS = 2500;
const MAX_POLL_ATTEMPTS = 30;

const $ = (id) => document.getElementById(id);


/* =========================================================
   APPLICATION STATE
========================================================= */

let uploadQueue = [];
let allHistoryItems = [];

let latestImageId = null;
let currentDetailImageId = null;

let historySearch = "";
let historyStatus = "All";
let historySort = "newest";
let historyView = "table";

let isUploading = false;

let pollTimers = new Map();

let toastTimer = null;
let refreshInProgress = false;


/* =========================================================
   API CONFIGURATION
========================================================= */

function apiBase() {
  try {
    return (localStorage.getItem(API_STORAGE_KEY) || "")
      .trim()
      .replace(/\/+$/, "");
  } catch (_) {
    return "";
  }
}


function isValidApiBase(value) {
  if (!value) {
    return true;
  }

  try {
    const url = new URL(value);

    const isLocal =
      (
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1"
      ) &&
      url.protocol === "http:" &&
      url.port === "3000";

    const isApiGateway =
      url.protocol === "https:" &&
      /^[a-z0-9-]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/i
        .test(url.hostname);

    return isLocal || isApiGateway;

  } catch (_) {
    return false;
  }
}


async function setApiBase() {
  const current = apiBase();

  const value = window.prompt(
    [
      "Enter your CloudPix API Gateway base URL.",
      "",
      "Example:",
      "https://your-api-id.execute-api.ap-south-1.amazonaws.com/prod",
      "",
      "Use the actual URL supplied by your backend deployment."
    ].join("\n"),
    current
  );

  if (value === null) {
    return;
  }

  const cleaned = value.trim().replace(/\/+$/, "");

  if (!isValidApiBase(cleaned)) {
    notify(
      "Enter a valid AWS API Gateway HTTPS URL or localhost:3000.",
      true
    );

    return;
  }

  try {
    localStorage.setItem(API_STORAGE_KEY, cleaned);
  } catch (_) {
    notify(
      "Could not save the API endpoint in this browser.",
      true
    );

    return;
  }

  if (!cleaned) {
    allHistoryItems = [];

    renderHistory();
    updateStatistics();

    notify("API endpoint cleared.");

    return;
  }

  notify("API endpoint saved. Checking connection…");

  await refreshAll();
}


/* Make API requests */

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
    // The response may not contain JSON.
  }

  if (!response.ok) {
    throw new Error(
      data.error ||
      data.message ||
      `Request failed with status ${response.status}.`
    );
  }

  return data;
}


/* =========================================================
   NOTIFICATIONS
========================================================= */

function notify(message, isError = false) {
  const toast = $("toast");

  if (!toast) {
    console[isError ? "error" : "log"](message);
    return;
  }

  toast.textContent = String(message);

  toast.className =
    "toast show" + (isError ? " error" : "");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    toast.className = "toast";
  }, 4000);
}


/* =========================================================
   FORMATTING HELPERS
========================================================= */

function formatBytes(bytes) {
  const value = Number(bytes);

  if (!Number.isFinite(value) || value < 0) {
    return "—";
  }

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}


function formatDate(value) {
  if (!value) {
    return "—";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}


function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]
  );
}


/* =========================================================
   URL SAFETY
========================================================= */

function safeUrl(value) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(
      String(value),
      window.location.href
    );

    const isHttps = url.protocol === "https:";

    const isLocalHttp =
      url.protocol === "http:" &&
      (
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1"
      );

    if (!isHttps && !isLocalHttp) {
      return "";
    }

    return url.href;

  } catch (_) {
    return "";
  }
}


function safeLink(rawUrl, label, className = "") {
  const url = safeUrl(rawUrl);

  if (!url) {
    return "";
  }

  return `
    <a
      class="${escapeHtml(className)}"
      href="${escapeHtml(url)}"
      target="_blank"
      rel="noopener noreferrer"
    >
      ${escapeHtml(label)}
    </a>
  `;
}


/* =========================================================
   FILE VALIDATION
========================================================= */

function validateFile(file) {
  if (!file) {
    return "Choose an image first.";
  }

  const extension = file.name
    .split(".")
    .pop()
    .toLowerCase();

  if (
    !ALLOWED_TYPES.includes(file.type) ||
    !ALLOWED_EXTENSIONS.includes(extension)
  ) {
    return "Only JPG, JPEG and PNG images are supported.";
  }

  if (file.size < 1) {
    return "The selected image is empty.";
  }

  if (file.size > MAX_BYTES) {
    return "Each image must be 10 MB or smaller.";
  }

  return "";
}


/* =========================================================
   UPLOAD QUEUE
========================================================= */

function createQueueItem(file) {
  return {
    id: createLocalId(),
    file,
    previewUrl: URL.createObjectURL(file),
    status: "Ready",
    progress: 0,
    imageId: null,
    error: ""
  };
}


function createLocalId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2)
  );
}


function revokeQueuePreview(item) {
  if (item && item.previewUrl) {
    URL.revokeObjectURL(item.previewUrl);
    item.previewUrl = null;
  }
}


function addFiles(fileList) {
  const files = Array.from(fileList || []);

  if (!files.length) {
    return;
  }

  let added = 0;
  let rejected = 0;

  for (const file of files) {
    const problem = validateFile(file);

    if (problem) {
      rejected++;

      notify(
        `${file.name}: ${problem}`,
        true
      );

      continue;
    }

    const duplicate = uploadQueue.some(
      (item) =>
        item.file.name === file.name &&
        item.file.size === file.size &&
        item.file.lastModified === file.lastModified
    );

    if (duplicate) {
      continue;
    }

    uploadQueue.push(createQueueItem(file));
    added++;
  }

  renderUploadQueue();

  if (added > 0) {
    notify(
      `Added ${added} image${added === 1 ? "" : "s"} to the upload queue.`
    );
  } else if (rejected === 0) {
    notify("No new images were added.", true);
  }
}


function removeQueueItem(localId) {
  if (isUploading) {
    notify(
      "Please wait until the current upload batch finishes.",
      true
    );

    return;
  }

  const item = uploadQueue.find(
    (entry) => entry.id === localId
  );

  if (!item) {
    return;
  }

  revokeQueuePreview(item);

  uploadQueue = uploadQueue.filter(
    (entry) => entry.id !== localId
  );

  renderUploadQueue();
}


function clearQueue() {
  if (isUploading) {
    notify(
      "The upload queue cannot be cleared while uploads are running.",
      true
    );

    return;
  }

  uploadQueue.forEach(revokeQueuePreview);

  uploadQueue = [];

  $("file-input").value = "";

  renderUploadQueue();

  notify("Upload queue cleared.");
}


/* =========================================================
   UPLOAD QUEUE RENDERING
========================================================= */

function renderUploadQueue() {
  const queueContainer = $("upload-queue");
  const queueList = $("upload-queue-list");
  const dropzone = $("dropzone");
  const selectedFilePanel = $("selected-file");

  if (
    !queueContainer ||
    !queueList ||
    !dropzone ||
    !selectedFilePanel
  ) {
    return;
  }

  const hasItems = uploadQueue.length > 0;

  queueContainer.hidden = !hasItems;

  /*
   * The redesigned interface uses the multi-image queue.
   * The older single-file preview remains in the HTML for
   * compatibility but is hidden by the new application.
   */

  selectedFilePanel.hidden = true;

  dropzone.hidden = isUploading && hasItems;

  const queueSummary = $("queue-summary");

  if (queueSummary) {
    queueSummary.textContent =
      `${uploadQueue.length} selected image` +
      `${uploadQueue.length === 1 ? "" : "s"} · ` +
      `${formatBytes(
        uploadQueue.reduce(
          (total, item) => total + item.file.size,
          0
        )
      )} total`;
  }

  queueList.innerHTML = uploadQueue.map((item) => {
    let statusText = item.status;

    if (item.status === "Uploading") {
      statusText = `${item.progress}%`;
    }

    const statusClass =
      item.status === "Completed"
        ? "success"
        : item.status === "Failed"
          ? "error"
          : "";

    return `
      <article class="queue-item">

        <div class="queue-item-preview">
          <img
            src="${escapeHtml(item.previewUrl || "")}"
            alt=""
          >
        </div>

        <div class="queue-item-copy">
          <strong title="${escapeHtml(item.file.name)}">
            ${escapeHtml(item.file.name)}
          </strong>

          <span>
            ${escapeHtml(formatBytes(item.file.size))}
            ${item.error
              ? ` · ${escapeHtml(item.error)}`
              : ""}
          </span>
        </div>

        <span class="queue-item-status ${statusClass}">
          ${escapeHtml(statusText)}
        </span>

        ${
          !isUploading && item.status === "Ready"
            ? `
              <button
                class="queue-item-remove"
                type="button"
                data-remove-queue="${escapeHtml(item.id)}"
                aria-label="Remove ${escapeHtml(item.file.name)}"
                title="Remove image"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12"/>
                  <path d="M18 6L6 18"/>
                </svg>
              </button>
            `
            : ""
        }

      </article>
    `;
  }).join("");

  const uploadButton = $("upload-btn");

  uploadButton.disabled =
    isUploading ||
    !uploadQueue.some((item) => item.status === "Ready");

  $("upload-btn-label").textContent =
    isUploading
      ? "Uploading images…"
      : uploadQueue.some((item) => item.status === "Ready")
        ? `Process ${uploadQueue.filter(
            (item) => item.status === "Ready"
          ).length} image${uploadQueue.filter(
            (item) => item.status === "Ready"
          ).length === 1 ? "" : "s"}`
        : "Start processing";

  $("clear-queue-btn").disabled = isUploading;
}


/* =========================================================
   UPLOAD PROGRESS
========================================================= */

function setUploadProgress(percent, label = "Uploading images") {
  const safePercent = Math.max(
    0,
    Math.min(100, Math.round(percent))
  );

  const progress = $("upload-progress");
  const percentLabel = $("upload-progress-percent");
  const progressLabel = $("upload-progress-label");
  const track = $("upload-progress-track");
  const section = $("upload-progress-section");

  section.hidden = false;

  progress.style.width = `${safePercent}%`;

  percentLabel.textContent = `${safePercent}%`;
  progressLabel.textContent = label;

  track.setAttribute("aria-valuenow", String(safePercent));
}


function hideUploadProgress() {
  $("upload-progress-section").hidden = true;

  $("upload-progress").style.width = "0%";

  $("upload-progress-track").setAttribute(
    "aria-valuenow",
    "0"
  );
}


/* =========================================================
   S3 UPLOAD
========================================================= */

function uploadFileToS3(file, uploadUrl, onProgress) {
  return new Promise((resolve, reject) => {
    const url = safeUrl(uploadUrl);

    if (!url) {
      reject(
        new Error("The API returned an invalid S3 upload URL.")
      );

      return;
    }

    const xhr = new XMLHttpRequest();

    xhr.open("PUT", url);

    xhr.setRequestHeader(
      "Content-Type",
      file.type
    );

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        const percent = Math.round(
          (event.loaded / event.total) * 100
        );

        onProgress(percent);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(
          new Error(
            `S3 upload failed with status ${xhr.status}. ` +
            "Check the upload URL, expiry and S3 CORS configuration."
          )
        );
      }
    };

    xhr.onerror = () => {
      reject(
        new Error(
          "Network error during S3 upload. Check the connection and S3 CORS configuration."
        )
      );
    };

    xhr.onabort = () => {
      reject(new Error("The upload was cancelled."));
    };

    xhr.send(file);
  });
}


/* =========================================================
   PROCESSING STATUS
========================================================= */

function normalizeStatus(status) {
  const knownStatuses = [
    "Pending",
    "Processing",
    "Completed",
    "Failed"
  ];

  const found = knownStatuses.find(
    (value) =>
      String(status || "").toLowerCase() === value.toLowerCase()
  );

  return found || "Pending";
}


function statusPill(status) {
  const normalized = normalizeStatus(status);

  return `
    <span class="pill ${normalized.toLowerCase()}">
      ${escapeHtml(normalized)}
    </span>
  `;
}


/* =========================================================
   UPLOAD BATCH
========================================================= */

async function uploadSelected() {
  if (isUploading) {
    return;
  }

  const readyItems = uploadQueue.filter(
    (item) => item.status === "Ready"
  );

  if (!readyItems.length) {
    notify("Add at least one valid image first.", true);
    return;
  }

  if (!apiBase()) {
    notify(
      "Configure your API endpoint before uploading.",
      true
    );

    await setApiBase();

    if (!apiBase()) {
      return;
    }
  }

  isUploading = true;

  $("upload-btn").disabled = true;
  $("choose-btn").disabled = true;
  $("file-input").disabled = true;

  $("dropzone").setAttribute("aria-disabled", "true");

  setUploadProgress(
    0,
    `Preparing ${readyItems.length} image${readyItems.length === 1 ? "" : "s"}`
  );

  renderUploadQueue();

  let completedUploads = 0;
  let failedUploads = 0;

  try {
    for (let index = 0; index < readyItems.length; index++) {
      const queueItem = readyItems[index];
      const file = queueItem.file;

      queueItem.status = "Uploading";
      queueItem.progress = 0;
      queueItem.error = "";

      renderUploadQueue();

      try {
        /*
         * Step 1:
         * Ask the backend for an upload record and
         * presigned S3 URL.
         *
         * Existing API contract:
         * POST /uploads
         * {
         *   filename,
         *   content_type,
         *   size
         * }
         */

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
          throw new Error(
            "The API did not return image_id and upload_url."
          );
        }

        queueItem.imageId = record.image_id;

        latestImageId = record.image_id;

        /*
         * Step 2:
         * Upload the actual image to S3.
         */

        await uploadFileToS3(
          file,
          record.upload_url,
          (fileProgress) => {
            queueItem.progress = fileProgress;

            const overallProgress = Math.round(
              (
                (index + fileProgress / 100) /
                readyItems.length
              ) * 100
            );

            setUploadProgress(
              overallProgress,
              `Uploading ${index + 1} of ${readyItems.length}: ${file.name}`
            );

            renderUploadQueue();
          }
        );

        queueItem.status = "Uploaded";
        queueItem.progress = 100;

        completedUploads++;

        /*
         * Start polling the image after the S3 upload
         * completes. Processing is asynchronous.
         */

        startPolling(record.image_id);

      } catch (error) {
        queueItem.status = "Failed";
        queueItem.error = error.message;

        failedUploads++;

        notify(
          `${file.name}: ${error.message}`,
          true
        );
      }

      renderUploadQueue();

      setUploadProgress(
        Math.round(
          ((index + 1) / readyItems.length) * 100
        ),
        `Processed upload ${index + 1} of ${readyItems.length}`
      );
    }

    await refreshAll();

    const successfulCount = completedUploads;

    if (failedUploads === 0) {
      notify(
        `Successfully uploaded ${successfulCount} image${successfulCount === 1 ? "" : "s"}. Processing is running in the background.`
      );
    } else {
      notify(
        `${successfulCount} uploaded and ${failedUploads} failed. Review the queue for details.`,
        true
      );
    }

  } catch (error) {
    notify(error.message, true);

  } finally {
    isUploading = false;

    $("choose-btn").disabled = false;
    $("file-input").disabled = false;

    $("dropzone").removeAttribute("aria-disabled");

    renderUploadQueue();

    if (
      uploadQueue.every(
        (item) =>
          item.status === "Uploaded" ||
          item.status === "Completed" ||
          item.status === "Failed"
      )
    ) {
      setTimeout(hideUploadProgress, 1200);
    }
  }
}


/* =========================================================
   POLLING
========================================================= */

function startPolling(imageId) {
  if (!imageId) {
    return;
  }

  stopPolling(imageId);

  let attempts = 0;

  const timer = setInterval(async () => {
    attempts++;

    try {
      const item = await api(
        `/images/${encodeURIComponent(imageId)}`
      );

      if (item && item.image_id) {
        mergeHistoryItem(item);
      }

      if (imageId === latestImageId) {
        renderLatest(item);
      }

      renderHistory();
      updateStatistics();

      const queueItem = uploadQueue.find(
        (entry) => entry.imageId === imageId
      );

      if (queueItem) {
        queueItem.status = normalizeStatus(item.status);

        if (queueItem.status === "Completed") {
          queueItem.error = "";
        }

        if (queueItem.status === "Failed") {
          queueItem.error =
            item.error_message || "Processing failed.";
        }

        renderUploadQueue();
      }

      if (TERMINAL_STATUSES.includes(normalizeStatus(item.status))) {
        stopPolling(imageId);

        if (item.status === "Completed") {
          if (imageId === latestImageId) {
            notify("Image processing completed successfully.");
          }
        } else {
          notify(
            item.error_message || "Image processing failed.",
            true
          );
        }

        await refreshAll();
      }

    } catch (error) {
      if (attempts >= MAX_POLL_ATTEMPTS) {
        stopPolling(imageId);

        notify(
          "Could not retrieve the latest processing status. Refresh history to try again.",
          true
        );
      }
    }

    if (attempts >= MAX_POLL_ATTEMPTS) {
      stopPolling(imageId);
    }

  }, POLL_INTERVAL_MS);

  pollTimers.set(imageId, timer);
}


function stopPolling(imageId) {
  const timer = pollTimers.get(imageId);

  if (timer) {
    clearInterval(timer);
    pollTimers.delete(imageId);
  }
}


/* =========================================================
   HISTORY DATA MANAGEMENT
========================================================= */

function mergeHistoryItem(item) {
  if (!item || !item.image_id) {
    return;
  }

  const index = allHistoryItems.findIndex(
    (entry) => entry.image_id === item.image_id
  );

  if (index >= 0) {
    allHistoryItems[index] = {
      ...allHistoryItems[index],
      ...item
    };
  } else {
    allHistoryItems.unshift(item);
  }
}


function updateStatistics() {
  $("total-count").textContent =
    apiBase() ? allHistoryItems.length : "—";

  $("pending-count").textContent =
    apiBase()
      ? allHistoryItems.filter(
          (item) =>
            ["Pending", "Processing"].includes(
              normalizeStatus(item.status)
            )
        ).length
      : "—";

  $("completed-count").textContent =
    apiBase()
      ? allHistoryItems.filter(
          (item) =>
            normalizeStatus(item.status) === "Completed"
        ).length
      : "—";

  $("failed-count").textContent =
    apiBase()
      ? allHistoryItems.filter(
          (item) =>
            normalizeStatus(item.status) === "Failed"
        ).length
      : "—";
}


/* =========================================================
   HISTORY SEARCH, FILTERING AND SORTING
========================================================= */

function getVisibleHistory() {
  let items = [...allHistoryItems];

  const query = historySearch.toLocaleLowerCase();

  if (query) {
    items = items.filter((item) => {
      const text = [
        item.filename,
        item.image_id,
        item.status
      ].join(" ").toLocaleLowerCase();

      return text.includes(query);
    });
  }

  if (historyStatus !== "All") {
    items = items.filter(
      (item) =>
        normalizeStatus(item.status) === historyStatus
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


/* =========================================================
   HISTORY OUTPUT LINKS
========================================================= */

function outputs(item) {
  const links = [];

  const original = safeUrl(item.original_url);
  const resized = safeUrl(item.resized_url);
  const thumbnail = safeUrl(item.thumbnail_url);

  if (original) {
    links.push(
      safeLink(original, "Original ↗")
    );
  }

  if (resized) {
    links.push(
      safeLink(resized, "Resized ↗")
    );
  }

  if (thumbnail) {
    links.push(
      safeLink(thumbnail, "Thumbnail ↗")
    );
  }

  return links.length
    ? links.join("")
    : "—";
}


/* =========================================================
   HISTORY TABLE
========================================================= */

function renderHistoryTable(items) {
  const body = $("history-body");

  if (!items.length) {
    body.innerHTML = `
      <tr>
        <td colspan="4" class="table-empty">
          ${
            allHistoryItems.length
              ? "No images match your search or filter."
              : "No image records are available yet."
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
                ? `
                  <img
                    class="mini-thumb"
                    src="${escapeHtml(thumbnail)}"
                    alt=""
                    loading="lazy"
                    data-preview-url="${escapeHtml(thumbnail)}"
                    data-preview-title="${escapeHtml(item.filename || "Image")}"
                  >
                `
                : `
                  <span
                    class="mini-thumb"
                    style="display:grid;place-items:center"
                  >▧</span>
                `
            }

            <div>
              <strong
                title="${escapeHtml(item.filename || "Untitled image")}"
              >
                ${escapeHtml(item.filename || "Untitled image")}
              </strong>

              <small>
                ${escapeHtml(item.image_id || "")}
              </small>
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
              ? `
                <div
                  title="${escapeHtml(item.error_message)}"
                  style="color:var(--red);font-size:9px;margin-top:5px"
                >
                  Processing error
                </div>
              `
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


/* =========================================================
   HISTORY GRID
========================================================= */

function renderHistoryGrid(items) {
  const grid = $("history-grid");

  if (!items.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <strong>No images found</strong>
        <p>Try changing your search or status filter.</p>
      </div>
    `;

    return;
  }

  grid.innerHTML = items.map((item) => {
    const thumbnail = safeUrl(
      item.thumbnail_url || item.resized_url || item.original_url
    );

    return `
      <article class="history-grid-card">

        <div class="history-grid-image">

          ${
            thumbnail
              ? `
                <img
                  src="${escapeHtml(thumbnail)}"
                  alt="${escapeHtml(item.filename || "Image")}"
                  loading="lazy"
                  data-preview-url="${escapeHtml(thumbnail)}"
                  data-preview-title="${escapeHtml(item.filename || "Image")}"
                >
              `
              : `
                <span class="grid-no-image">
                  ${normalizeStatus(item.status) === "Failed"
                    ? "Image unavailable"
                    : "Processing image…"}
                </span>
              `
          }

        </div>

        <div class="history-grid-card-body">

          <span
            class="history-grid-title"
            title="${escapeHtml(item.filename || "Untitled image")}"
          >
            ${escapeHtml(item.filename || "Untitled image")}
          </span>

          <span class="history-grid-id">
            ${escapeHtml(item.image_id || "")}
          </span>

          <div class="history-grid-meta">

            ${statusPill(item.status)}

            <span class="history-grid-date">
              ${escapeHtml(formatDate(item.uploaded_at))}
            </span>

          </div>

          <div class="history-grid-outputs">
            ${outputs(item)}
          </div>

          <button
            class="history-grid-details-btn"
            type="button"
            data-details-id="${escapeHtml(item.image_id || "")}"
          >
            View details
          </button>

        </div>

      </article>
    `;
  }).join("");
}


/* =========================================================
   HISTORY RENDERING
========================================================= */

function renderHistory() {
  const items = getVisibleHistory();

  const summary = $("history-summary");

  if (summary) {
    summary.textContent =
      `Showing ${items.length} of ${allHistoryItems.length} image` +
      `${allHistoryItems.length === 1 ? "" : "s"}`;
  }

  renderHistoryTable(items);
  renderHistoryGrid(items);

  $("history-table-view").hidden =
    historyView !== "table";

  $("history-grid-view").hidden =
    historyView !== "grid";

  $("view-table-btn").classList.toggle(
    "active",
    historyView === "table"
  );

  $("view-grid-btn").classList.toggle(
    "active",
    historyView === "grid"
  );

  $("view-table-btn").setAttribute(
    "aria-pressed",
    String(historyView === "table")
  );

  $("view-grid-btn").setAttribute(
    "aria-pressed",
    String(historyView === "grid")
  );
}


/* =========================================================
   HISTORY VIEW PREFERENCE
========================================================= */

function setHistoryView(view) {
  if (!["table", "grid"].includes(view)) {
    return;
  }

  historyView = view;

  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch (_) {
    // Continue without persisting the preference.
  }

  renderHistory();
}


/* =========================================================
   LATEST PROCESSING RESULTS
========================================================= */

function renderLatest(item) {
  const box = $("latest-result");

  if (!item) {
    box.className = "empty-state";

    box.innerHTML = `
      <div class="empty-state-illustration">
        <svg viewBox="0 0 100 82" fill="none" aria-hidden="true">
          <rect
            x="12"
            y="8"
            width="76"
            height="62"
            rx="8"
            fill="currentColor"
            fill-opacity="0.06"
            stroke="currentColor"
            stroke-opacity="0.18"
            stroke-width="1.5"
          />
          <circle
            cx="65"
            cy="26"
            r="7"
            fill="currentColor"
            fill-opacity="0.2"
          />
          <path
            d="M17 59L37 37L51 51L62 42L83 62V65H17V59Z"
            fill="currentColor"
            fill-opacity="0.18"
          />
        </svg>
      </div>

      <strong>No image selected yet</strong>

      <p>
        Upload an image to see its original, resized image,
        and thumbnail here.
      </p>
    `;

    return;
  }

  box.className = "latest-result";

  const cards = [
    {
      title: "Original image",
      subtitle: "Original upload",
      url: item.original_url
    },
    {
      title: "Resized image",
      subtitle: "Maximum 800 × 800",
      url: item.resized_url
    },
    {
      title: "Thumbnail",
      subtitle: "Maximum 200 × 200",
      url: item.thumbnail_url
    }
  ];

  box.innerHTML = `
    <div class="latest-item-heading">

      <strong>
        ${escapeHtml(item.filename || "Untitled image")}
      </strong>

      ${statusPill(item.status)}

      ${
        item.error_message
          ? `
            <div class="latest-item-error">
              ${escapeHtml(item.error_message)}
            </div>
          `
          : ""
      }

    </div>

    <div class="result-grid">

      ${cards.map((card) => {
        const url = safeUrl(card.url);

        return `
          <article class="result-card">

            <div class="result-card-header">
              <strong>${escapeHtml(card.title)}</strong>
              <span>${escapeHtml(card.subtitle)}</span>
            </div>

            <div class="result-image">

              ${
                url
                  ? `
                    <img
                      src="${escapeHtml(url)}"
                      alt="${escapeHtml(card.title)}"
                      loading="lazy"
                      data-preview-url="${escapeHtml(url)}"
                      data-preview-title="${escapeHtml(card.title)}"
                    >
                  `
                  : `
                    <span>
                      ${
                        normalizeStatus(item.status) === "Failed"
                          ? "Output unavailable"
                          : "Waiting for processing…"
                      }
                    </span>
                  `
              }

            </div>

            <div class="result-copy">

              <strong>${escapeHtml(card.title)}</strong>

              <span>
                ${url ? "Output available" : "Not generated yet"}
              </span>

              ${
                url
                  ? `
                    <a
                      class="download-link"
                      href="${escapeHtml(url)}"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open / download ↗
                    </a>
                  `
                  : ""
              }

            </div>

          </article>
        `;
      }).join("")}

    </div>
  `;
}


/* =========================================================
   IMAGE DETAILS PANEL
========================================================= */

async function showImageDetails(imageId) {
  if (!imageId) {
    return;
  }

  currentDetailImageId = imageId;

  const panel = $("image-details-panel");
  const content = $("image-details-content");

  panel.hidden = false;

  content.innerHTML = `
    <div class="empty-state">
      <strong>Loading image details…</strong>
      <p>Retrieving the latest record from CloudPix.</p>
    </div>
  `;

  panel.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });

  try {
    /*
     * This uses the existing image-detail endpoint.
     * It does not require a new backend route.
     */

    const item = await api(
      `/images/${encodeURIComponent(imageId)}`
    );

    if (currentDetailImageId !== imageId) {
      return;
    }

    renderImageDetails(item);

  } catch (error) {
    if (currentDetailImageId !== imageId) {
      return;
    }

    content.innerHTML = `
      <div class="empty-state">
        <strong>Could not load image details</strong>
        <p>${escapeHtml(error.message)}</p>
      </div>
    `;
  }
}


function renderImageDetails(item) {
  const content = $("image-details-content");

  const original = safeUrl(item.original_url);
  const resized = safeUrl(item.resized_url);
  const thumbnail = safeUrl(item.thumbnail_url);

  const uploadedAt = formatDate(item.uploaded_at);

  const metadata = [
    {
      label: "Processing status",
      value: normalizeStatus(item.status)
    },
    {
      label: "Uploaded",
      value: uploadedAt
    },
    {
      label: "Image ID",
      value: item.image_id || "—"
    },
    {
      label: "Filename",
      value: item.filename || "—"
    },
    {
      label: "Original object",
      value: item.original_key || "Stored in S3"
    },
    {
      label: "Resized output",
      value: item.resized_key || (resized ? "Available" : "Not available")
    }
  ];

  const outputItems = [
    {
      title: "Original image",
      url: original,
      description: "The image uploaded by the user."
    },
    {
      title: "Resized image",
      url: resized,
      description: "The optimized image generated by CloudPix."
    },
    {
      title: "Thumbnail",
      url: thumbnail,
      description: "The smaller preview generated by CloudPix."
    }
  ];

  content.innerHTML = `
    <div class="details-header">

      <div>
        <h4>${escapeHtml(item.filename || "Untitled image")}</h4>

        <p>
          Image ID:
          ${escapeHtml(item.image_id || "—")}
        </p>
      </div>

      ${statusPill(item.status)}

    </div>

    <div class="details-metadata">

      ${metadata.map((entry) => `
        <div class="details-metadata-item">

          <span>${escapeHtml(entry.label)}</span>

          <strong>
            ${escapeHtml(entry.value)}
          </strong>

        </div>
      `).join("")}

    </div>

    ${
      item.error_message
        ? `
          <div class="latest-item-error" style="margin-bottom:16px">
            Processing error:
            ${escapeHtml(item.error_message)}
          </div>
        `
        : ""
    }

    <h4 style="margin:0 0 12px;font-size:12px">
      Available outputs
    </h4>

    <div class="details-output-list">

      ${outputItems.map((entry) => `
        <div class="details-output-item">

          <div>
            <strong>${escapeHtml(entry.title)}</strong>
            <p>${escapeHtml(entry.description)}</p>
          </div>

          ${
            entry.url
              ? `
                <a
                  href="${escapeHtml(entry.url)}"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open ↗
                </a>
              `
              : `
                <span style="color:var(--muted);font-size:9px">
                  Not available
                </span>
              `
          }

        </div>
      `).join("")}

    </div>
  `;
}


/* =========================================================
   IMAGE PREVIEW DIALOG
========================================================= */

function openImagePreview(url, title = "Image preview") {
  const safe = safeUrl(url);

  if (!safe) {
    notify("This image does not have a valid preview URL.", true);
    return;
  }

  const dialog = $("image-preview-dialog");

  $("image-preview-title").textContent = title;
  $("image-preview-full").src = safe;
  $("image-preview-full").alt = title;

  $("image-preview-caption").textContent = title;

  $("image-preview-download").href = safe;

  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    window.open(
      safe,
      "_blank",
      "noopener,noreferrer"
    );
  }
}


function closeImagePreview() {
  const dialog = $("image-preview-dialog");

  if (dialog.open) {
    dialog.close();
  }

  $("image-preview-full").removeAttribute("src");
}


/* =========================================================
   CSV EXPORT
========================================================= */

function csvCell(value) {
  let text = String(value ?? "");

  /*
   * Reduce the risk of spreadsheet formula injection.
   */

  if (/^\s*[=+\-@]/.test(text)) {
    text = "'" + text;
  }

  return `"${text.replace(/"/g, '""')}"`;
}


function exportHistoryCsv() {
  const items = getVisibleHistory();

  if (!items.length) {
    notify(
      "There are no matching records to export.",
      true
    );

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
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");

  const blob = new Blob(
    ["\uFEFF", csv],
    {
      type: "text/csv;charset=utf-8;"
    }
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


/* =========================================================
   REFRESH DASHBOARD
========================================================= */

async function refreshAll() {
  if (refreshInProgress) {
    return;
  }

  if (!apiBase()) {
    allHistoryItems = [];

    updateStatistics();
    renderHistory();
    renderLatest(null);

    $("history-summary").textContent =
      "API endpoint not configured";

    $("history-body").innerHTML = `
      <tr>
        <td colspan="4" class="table-empty">
          Click “AWS serverless” above to configure your deployed API endpoint.
        </td>
      </tr>
    `;

    return;
  }

  refreshInProgress = true;

  $("refresh-btn").disabled = true;

  try {
    const result = await api("/history");

    allHistoryItems = Array.isArray(result.items)
      ? result.items
      : [];

    updateStatistics();
    renderHistory();

    if (latestImageId) {
      const latest = allHistoryItems.find(
        (item) => item.image_id === latestImageId
      );

      if (latest) {
        renderLatest(latest);
      }
    }

    /*
     * If the details panel is open, refresh its record too.
     */

    if (currentDetailImageId) {
      const updatedDetail = allHistoryItems.find(
        (item) => item.image_id === currentDetailImageId
      );

      if (updatedDetail) {
        renderImageDetails(updatedDetail);
      }
    }

  } catch (error) {
    $("history-body").innerHTML = `
      <tr>
        <td colspan="4" class="table-empty">
          ${escapeHtml(error.message)}
        </td>
      </tr>
    `;

    $("history-summary").textContent =
      "Could not load history";

    notify(error.message, true);

  } finally {
    refreshInProgress = false;

    $("refresh-btn").disabled = false;
  }
}


/* =========================================================
   DARK MODE
========================================================= */

function setTheme(theme) {
  const normalized =
    theme === "dark" ? "dark" : "light";

  document.documentElement.dataset.theme = normalized;

  const button = $("theme-toggle");

  button.setAttribute(
    "aria-label",
    normalized === "dark"
      ? "Switch to light theme"
      : "Switch to dark theme"
  );

  button.title =
    normalized === "dark"
      ? "Switch to light theme"
      : "Switch to dark theme";

  try {
    localStorage.setItem(
      THEME_STORAGE_KEY,
      normalized
    );
  } catch (_) {
    // Theme still works for the current session.
  }
}


function toggleTheme() {
  const current =
    document.documentElement.dataset.theme || "light";

  setTheme(
    current === "dark" ? "light" : "dark"
  );
}


function initializeTheme() {
  let savedTheme = "light";

  try {
    savedTheme =
      localStorage.getItem(THEME_STORAGE_KEY) || "light";
  } catch (_) {
    // Use the default theme.
  }

  setTheme(savedTheme);
}


/* =========================================================
   NAVIGATION
========================================================= */

function initializeNavigation() {
  const links = document.querySelectorAll("[data-nav]");

  links.forEach((link) => {
    link.addEventListener("click", () => {
      links.forEach((entry) => {
        entry.classList.remove("active");
      });

      link.classList.add("active");

      const label = link.querySelector("span:nth-child(2)");

      if (label) {
        $("breadcrumb-current").textContent =
          label.textContent.trim();
      }
    });
  });
}


/* =========================================================
   KEYBOARD SHORTCUTS
========================================================= */

function initializeKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    const target = event.target;

    const isTyping =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable;

    /*
     * Press "/" to focus history search.
     */

    if (
      event.key === "/" &&
      !isTyping &&
      !$("image-preview-dialog").open
    ) {
      event.preventDefault();
      $("history-search").focus();
    }

    /*
     * Escape closes the image preview dialog.
     */

    if (
      event.key === "Escape" &&
      $("image-preview-dialog").open
    ) {
      closeImagePreview();
    }
  });
}


/* =========================================================
   EVENT LISTENERS
========================================================= */

function initializeEventListeners() {

  /* API endpoint */

  document.querySelector(".cloud-badge")
    .addEventListener("click", setApiBase);


  /* File selection */

  $("choose-btn").addEventListener("click", (event) => {
    event.stopPropagation();

    if (!isUploading) {
      $("file-input").click();
    }
  });


  $("dropzone").addEventListener("click", (event) => {
    if (
      event.target.closest("#choose-btn") ||
      event.target.closest("#file-input")
    ) {
      return;
    }

    if (!isUploading) {
      $("file-input").click();
    }
  });


  $("dropzone").addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();

      if (!isUploading) {
        $("file-input").click();
      }
    }
  });


  $("file-input").addEventListener("change", (event) => {
    addFiles(event.target.files);

    /*
     * Clear the native input so the same file can be selected again.
     */

    event.target.value = "";
  });


  /* Drag and drop */

  $("dropzone").addEventListener("dragover", (event) => {
    event.preventDefault();

    if (!isUploading) {
      $("dropzone").classList.add("dragover");
    }
  });


  $("dropzone").addEventListener("dragleave", (event) => {
    if (
      !event.relatedTarget ||
      !$("dropzone").contains(event.relatedTarget)
    ) {
      $("dropzone").classList.remove("dragover");
    }
  });


  $("dropzone").addEventListener("drop", (event) => {
    event.preventDefault();

    $("dropzone").classList.remove("dragover");

    if (!isUploading) {
      addFiles(event.dataTransfer.files);
    }
  });


  /* Queue */

  $("upload-queue-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-queue]");

    if (!button) {
      return;
    }

    removeQueueItem(
      button.dataset.removeQueue
    );
  });


  $("clear-queue-btn").addEventListener("click", clearQueue);


  /* Upload */

  $("upload-btn").addEventListener("click", uploadSelected);


  /* Refresh history */

  $("refresh-btn").addEventListener("click", refreshAll);


  /* History search */

  $("history-search").addEventListener("input", (event) => {
    historySearch = event.target.value.trim();

    renderHistory();
  });


  /* Status filter */

  $("history-filter").addEventListener("change", (event) => {
    historyStatus = event.target.value;

    renderHistory();
  });


  /* Sorting */

  $("history-sort").addEventListener("change", (event) => {
    historySort = event.target.value;

    renderHistory();
  });


  /* CSV export */

  $("export-btn").addEventListener("click", exportHistoryCsv);


  /* Table and grid views */

  $("view-table-btn").addEventListener("click", () => {
    setHistoryView("table");
  });


  $("view-grid-btn").addEventListener("click", () => {
    setHistoryView("grid");
  });


  /* Dark mode */

  $("theme-toggle").addEventListener("click", toggleTheme);


  /* Close image details */

  $("close-details-btn").addEventListener("click", () => {
    currentDetailImageId = null;

    $("image-details-panel").hidden = true;
  });


  /* Image preview dialog */

  $("close-image-preview-btn").addEventListener(
    "click",
    closeImagePreview
  );


  $("image-preview-dialog").addEventListener("click", (event) => {
    if (event.target === $("image-preview-dialog")) {
      closeImagePreview();
    }
  });


  /*
   * Delegated event handling for dynamically generated content:
   * previews and history detail buttons.
   */

  document.addEventListener("click", (event) => {

    const previewImage = event.target.closest(
      "[data-preview-url]"
    );

    if (previewImage) {
      openImagePreview(
        previewImage.dataset.previewUrl,
        previewImage.dataset.previewTitle || "Image preview"
      );

      return;
    }

    const detailsButton = event.target.closest(
      "[data-details-id]"
    );

    if (detailsButton) {
      showImageDetails(
        detailsButton.dataset.detailsId
      );
    }
  });
}


/* =========================================================
   APPLICATION INITIALIZATION
========================================================= */

function initializeApplication() {

  initializeTheme();

  initializeNavigation();

  initializeKeyboardShortcuts();

  initializeEventListeners();


  /* Restore table/grid preference */

  try {
    const savedView =
      localStorage.getItem(VIEW_STORAGE_KEY);

    if (
      savedView === "table" ||
      savedView === "grid"
    ) {
      historyView = savedView;
    }
  } catch (_) {
    // Default to table view.
  }


  /* Initial UI state */

  renderUploadQueue();

  renderHistory();

  renderLatest(null);

  updateStatistics();


  /* Load backend data when an endpoint is configured */

  refreshAll();
}


/* Start after the DOM is ready. */

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    initializeApplication
  );
} else {
  initializeApplication();
}
