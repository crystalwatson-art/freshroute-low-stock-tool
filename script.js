"use strict";

const DATA_FILE = "dairy_goods_sales_cleaned.csv";
const PAGE_SIZE = 10;
const CRITICAL_EXPIRY_DAYS = 3;
const REQUESTS_STORAGE_KEY = "freshroute-restock-requests";
const REMOVALS_STORAGE_KEY = "freshroute-removal-flags";
const THEME_STORAGE_KEY = "freshroute-theme";
const BACK_TO_TOP_THRESHOLD = 350;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_ROWS = 50000;
const RECEIVING_STORAGE_KEY = "freshroute-receiving-records";
const MAX_DAMAGE_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_SAVED_RECEIVING_RECORDS = 25;

const {
  FIELD_DEFINITIONS,
  parseCSV,
  parsedRecordsToObjects,
  suggestColumnMappings,
  validateMappedRows,
  aggregateLatestInventory,
  classifyStock,
  getDisplayStatus,
  isExpired,
  isExpiringSoon,
  sortByPriority,
  getLocalTodayISO
} = FreshRouteCore;

const {
  calculateReceivingItem,
  summarizeReceiving,
  validateDeliveryDetails
} = FreshRouteReceiving;

let inventoryData = [];
let baseInventoryData = [];
let filteredInventoryData = [];
let currentPage = 1;
let rawRecordCount = 0;
let dataMode = "demo";
let customerRows = [];
let customerFileName = "";
let customerSourceKey = "";
let pendingUpload = null;
let sentRequests = loadSentRequests();
let removalFlags = loadRemovalFlags();
let receivingItems = [];
let damagePhoto = null;
let receivingRecords = loadReceivingRecords();
let reconciliationController = null;

const statusFilter = document.getElementById("status-filter");
const productSearch = document.getElementById("product-search");
const refreshButton = document.getElementById("refresh-data");
const themeToggle = document.getElementById("theme-toggle");
const backToTopButton = document.getElementById("back-to-top");
const tableBody = document.getElementById("inventory-table-body");
const inventoryFileInput = document.getElementById("inventory-file");
const useDemoButton = document.getElementById("use-demo-data");
const mappingPanel = document.getElementById("column-mapping-panel");
const mappingFields = document.getElementById("column-mapping-fields");
const uploadSuccess = document.getElementById("upload-success");
const uploadError = document.getElementById("upload-error");
const paginationContainers = [
  document.getElementById("pagination-top"),
  document.getElementById("pagination-bottom")
];
const summaryCards = [...document.querySelectorAll(".summary-card[data-status-filter]")];
const toolNavigation = document.querySelector(".dashboard-navigation");
const toolButtons = [...document.querySelectorAll(".nav-tool-button[data-tool-panel]")];
const toolPanels = [...document.querySelectorAll(".tool-panel")];
const receivingForm = document.getElementById("receiving-form");
const receivingTableBody = document.getElementById("receiving-table-body");
const receivingFeedback = document.getElementById("receiving-feedback");
const damagePhotoInput = document.getElementById("damage-photo");

document.addEventListener("DOMContentLoaded", () => {
  applySavedTheme();
  statusFilter.addEventListener("change", handleStatusFilterChange);
  productSearch.addEventListener("input", applyFilters);
  refreshButton.addEventListener("click", refreshCurrentData);
  themeToggle.addEventListener("click", toggleTheme);
  toolNavigation.addEventListener("click", handleToolNavigationClick);
  toolNavigation.addEventListener("keydown", handleToolNavigationKeydown);
  toolPanels.forEach((panel) => panel.addEventListener("keydown", handleToolPanelKeydown));
  receivingForm.addEventListener("input", handleReceivingInput);
  receivingForm.addEventListener("submit", addReceivingItem);
  receivingTableBody.addEventListener("click", removeReceivingItem);
  damagePhotoInput.addEventListener("change", handleDamagePhoto);
  document.getElementById("remove-damage-photo").addEventListener("click", clearDamagePhoto);
  document.getElementById("save-receiving-record").addEventListener("click", saveReceivingRecord);
  document.getElementById("clear-receiving-draft").addEventListener("click", () => resetReceivingDraft());
  backToTopButton.addEventListener("click", scrollToTop);
  window.addEventListener("scroll", updateBackToTopVisibility, { passive: true });
  tableBody.addEventListener("click", handleTableAction);
  inventoryFileInput.addEventListener("change", handleInventoryFile);
  useDemoButton.addEventListener("click", () => loadDemoData({ announce: true }));
  mappingPanel.addEventListener("submit", importMappedInventory);
  document.getElementById("cancel-upload").addEventListener("click", cancelPendingUpload);
  summaryCards.forEach((card) => {
    card.addEventListener("click", activateSummaryCard);
    card.addEventListener("keydown", handleSummaryCardKeydown);
  });
  paginationContainers.forEach((container) => {
    container.addEventListener("click", handlePaginationClick);
    container.addEventListener("submit", handlePageJump);
  });
  reconciliationController = FreshRouteReconciliationUI.createController({
    getRecords: () => receivingRecords,
    getInventory: () => inventoryData,
    getSourceKey: getCurrentSourceKey,
    getSourceLabel: getCurrentSourceLabel,
    onInventoryChanged: refreshInventoryAfterReconciliation
  });
  updateBackToTopVisibility();
  receivingForm.elements.deliveryDate.value = getLocalTodayISO();
  renderReceivingReview();
  renderSavedReceivingRecords();
  updateReceivingCalculation();
  loadDemoData();
});

function handleToolNavigationClick(event) {
  const button = event.target.closest(".nav-tool-button[data-tool-panel]");
  if (!button) return;
  toggleToolPanel(button);
}

function handleToolNavigationKeydown(event) {
  const button = event.target.closest(".nav-tool-button[data-tool-panel]");
  if (!button) return;

  const currentIndex = toolButtons.indexOf(button);
  const keyActions = {
    ArrowRight: (currentIndex + 1) % toolButtons.length,
    ArrowDown: (currentIndex + 1) % toolButtons.length,
    ArrowLeft: (currentIndex - 1 + toolButtons.length) % toolButtons.length,
    ArrowUp: (currentIndex - 1 + toolButtons.length) % toolButtons.length,
    Home: 0,
    End: toolButtons.length - 1
  };

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    toggleToolPanel(button);
  } else if (Object.hasOwn(keyActions, event.key)) {
    event.preventDefault();
    toolButtons[keyActions[event.key]].focus();
  } else if (event.key === "Escape") {
    closeToolPanels();
    button.focus();
  }
}

function handleToolPanelKeydown(event) {
  if (event.key !== "Escape") return;
  const panel = event.currentTarget;
  const button = toolButtons.find((item) => item.dataset.toolPanel === panel.id);
  closeToolPanels();
  button?.focus();
}

function toggleToolPanel(button) {
  const shouldOpen = button.getAttribute("aria-expanded") !== "true";
  const panel = document.getElementById(button.dataset.toolPanel);
  closeToolPanels();

  if (shouldOpen && panel) {
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    button.classList.add("is-active");
  }
}

function closeToolPanels() {
  toolButtons.forEach((button) => {
    button.setAttribute("aria-expanded", "false");
    button.classList.remove("is-active");
  });
  toolPanels.forEach((panel) => {
    panel.hidden = true;
  });
}

function handleReceivingInput() {
  updateReceivingCalculation();
  renderReceivingReview();
}

function getReceivingItemInput() {
  return {
    sku: receivingForm.elements.sku.value,
    productName: receivingForm.elements.productName.value,
    brand: receivingForm.elements.brand.value,
    boxesPerRow: receivingForm.elements.boxesPerRow.value,
    layers: receivingForm.elements.layers.value,
    unitsPerBox: receivingForm.elements.unitsPerBox.value,
    damagedBoxes: receivingForm.elements.damagedBoxes.value,
    damagedUnits: receivingForm.elements.damagedUnits.value
  };
}

function getReceivingDeliveryDetails() {
  return {
    deliveryDate: receivingForm.elements.deliveryDate.value,
    supplier: receivingForm.elements.supplier.value,
    notes: receivingForm.elements.notes.value
  };
}

function updateReceivingCalculation() {
  const input = getReceivingItemInput();
  const preview = calculateReceivingItem({
    ...input,
    sku: input.sku || "Preview",
    productName: input.productName || "Preview"
  });
  const values = preview.valid ? {
    "preview-total-boxes": preview.item.totalBoxes,
    "preview-total-units": preview.item.totalUnits,
    "preview-damaged-units": preview.item.totalDamagedUnits,
    "preview-usable-units": preview.item.usableUnits
  } : {
    "preview-total-boxes": "—",
    "preview-total-units": "—",
    "preview-damaged-units": "—",
    "preview-usable-units": "—"
  };

  Object.entries(values).forEach(([id, value]) => {
    document.getElementById(id).textContent =
      typeof value === "number" ? value.toLocaleString() : value;
  });
}

function addReceivingItem(event) {
  event.preventDefault();
  const result = calculateReceivingItem(getReceivingItemInput());

  if (!result.valid) {
    showReceivingFeedback("Fix this product count before adding it.", "error", result.errors);
    return;
  }

  receivingItems.push({
    ...result.item,
    id: typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `receiving-${Date.now()}-${receivingItems.length}`
  });
  clearReceivingProductFields();
  renderReceivingReview();
  showReceivingFeedback(
    `${result.item.productName} was added to the receiving summary.`,
    "success"
  );
  receivingForm.elements.sku.focus();
}

function clearReceivingProductFields() {
  ["sku", "productName", "brand", "boxesPerRow", "layers", "unitsPerBox"].forEach((name) => {
    receivingForm.elements[name].value = "";
  });
  receivingForm.elements.damagedBoxes.value = "0";
  receivingForm.elements.damagedUnits.value = "0";
  updateReceivingCalculation();
}

function removeReceivingItem(event) {
  const button = event.target.closest("[data-receiving-remove]");
  if (!button) return;
  receivingItems = receivingItems.filter((item) => item.id !== button.dataset.receivingRemove);
  renderReceivingReview();
  showReceivingFeedback("The product count was removed from this draft.", "success");
}

function renderReceivingReview() {
  const details = getReceivingDeliveryDetails();
  document.getElementById("review-delivery-date").textContent =
    details.deliveryDate || "Not entered";
  document.getElementById("review-supplier").textContent =
    details.supplier.trim() || "Not entered";
  document.getElementById("review-notes").textContent =
    details.notes.trim() || "No notes entered";
  document.getElementById("review-photo").textContent =
    damagePhoto?.name || "None attached";

  const summary = summarizeReceiving(receivingItems);
  const totals = {
    "summary-line-items": summary.lineItems,
    "summary-total-boxes": summary.totalBoxes,
    "summary-total-units": summary.totalUnits,
    "summary-damaged-boxes": summary.damagedBoxes,
    "summary-damaged-units": summary.damagedIndividualUnits,
    "summary-usable-units": summary.usableUnits
  };
  Object.entries(totals).forEach(([id, value]) => {
    document.getElementById(id).textContent = value.toLocaleString();
  });

  const hasItems = receivingItems.length > 0;
  document.getElementById("receiving-empty-message").hidden = hasItems;
  document.getElementById("receiving-table-wrapper").hidden = !hasItems;
  document.getElementById("save-receiving-record").disabled = !hasItems;
  document.getElementById("clear-receiving-draft").disabled =
    !hasItems && !details.supplier.trim() && !details.notes.trim() && !damagePhoto;

  receivingTableBody.innerHTML = receivingItems.map((item) => `
    <tr>
      <td><strong class="product-name">${escapeHTML(item.productName)}</strong><small>SKU ${escapeHTML(item.sku)} · ${escapeHTML(item.brand)}</small></td>
      <td>${item.boxesPerRow.toLocaleString()} × ${item.layers.toLocaleString()} = ${item.totalBoxes.toLocaleString()} boxes</td>
      <td>${item.unitsPerBox.toLocaleString()} × ${item.totalBoxes.toLocaleString()} = ${item.totalUnits.toLocaleString()}</td>
      <td>${item.damagedBoxes.toLocaleString()} boxes + ${item.damagedUnits.toLocaleString()} units<small>${item.totalDamagedUnits.toLocaleString()} total damaged units</small></td>
      <td><strong class="usable-unit-count">${item.usableUnits.toLocaleString()}</strong></td>
      <td><button class="text-button" type="button" data-receiving-remove="${escapeHTML(item.id)}" aria-label="Remove ${escapeHTML(item.productName)} from receiving summary">Remove</button></td>
    </tr>
  `).join("");
}

function handleDamagePhoto(event) {
  const file = event.target.files[0];
  if (!file) {
    clearDamagePhoto();
    return;
  }
  if (!file.type.startsWith("image/")) {
    damagePhotoInput.value = "";
    showReceivingFeedback("Choose an image file for the damage photo.", "error");
    return;
  }
  if (file.size > MAX_DAMAGE_PHOTO_BYTES) {
    damagePhotoInput.value = "";
    showReceivingFeedback("The damage photo must be 5 MB or smaller.", "error");
    return;
  }

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    damagePhoto = {
      name: file.name,
      type: file.type,
      size: file.size,
      dataUrl: reader.result
    };
    document.getElementById("damage-photo-image").src = damagePhoto.dataUrl;
    document.getElementById("damage-photo-name").textContent = damagePhoto.name;
    document.getElementById("damage-photo-preview").hidden = false;
    renderReceivingReview();
    showReceivingFeedback("Damage photo attached locally to this draft.", "success");
  });
  reader.addEventListener("error", () => {
    damagePhotoInput.value = "";
    showReceivingFeedback("FreshRoute could not preview this image.", "error");
  });
  reader.readAsDataURL(file);
}

function clearDamagePhoto() {
  damagePhoto = null;
  damagePhotoInput.value = "";
  document.getElementById("damage-photo-image").removeAttribute("src");
  document.getElementById("damage-photo-name").textContent = "";
  document.getElementById("damage-photo-preview").hidden = true;
  renderReceivingReview();
}

function saveReceivingRecord() {
  const detailsResult = validateDeliveryDetails(getReceivingDeliveryDetails());
  const errors = [...detailsResult.errors];
  if (receivingItems.length === 0) errors.push("Add at least one product count.");

  if (errors.length > 0) {
    showReceivingFeedback("Complete the receiving record before saving it.", "error", errors);
    return;
  }

  const totals = summarizeReceiving(receivingItems);
  const record = {
    id: typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `record-${Date.now()}`,
    ...detailsResult.details,
    photoName: damagePhoto?.name || "",
    sourceKey: getCurrentSourceKey(),
    sourceLabel: getCurrentSourceLabel(),
    items: receivingItems.map(({ id, ...item }) => item),
    totals,
    savedAt: new Date().toISOString()
  };
  const nextRecords = [record, ...receivingRecords].slice(0, MAX_SAVED_RECEIVING_RECORDS);

  try {
    localStorage.setItem(RECEIVING_STORAGE_KEY, JSON.stringify(nextRecords));
    receivingRecords = nextRecords;
  } catch (error) {
    console.warn("Receiving record could not be saved.", error);
    showReceivingFeedback(
      "This receiving record could not be saved in the browser. Copy the summary before leaving this page.",
      "error"
    );
    return;
  }

  resetReceivingDraft({ keepFeedback: true });
  renderSavedReceivingRecords();
  showReceivingFeedback(
    `Receiving record for ${record.supplier} was saved locally. Nothing was sent to the supplier.`,
    "success"
  );
}

function resetReceivingDraft({ keepFeedback = false } = {}) {
  receivingItems = [];
  damagePhoto = null;
  receivingForm.reset();
  receivingForm.elements.deliveryDate.value = getLocalTodayISO();
  receivingForm.elements.damagedBoxes.value = "0";
  receivingForm.elements.damagedUnits.value = "0";
  document.getElementById("damage-photo-image").removeAttribute("src");
  document.getElementById("damage-photo-name").textContent = "";
  document.getElementById("damage-photo-preview").hidden = true;
  if (!keepFeedback) {
    receivingFeedback.hidden = true;
    receivingFeedback.textContent = "";
  }
  updateReceivingCalculation();
  renderReceivingReview();
}

function loadReceivingRecords() {
  try {
    const saved = JSON.parse(localStorage.getItem(RECEIVING_STORAGE_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved.filter((record) =>
      record &&
      typeof record.supplier === "string" &&
      typeof record.deliveryDate === "string" &&
      Array.isArray(record.items) &&
      record.totals &&
      Number.isFinite(record.totals.lineItems) &&
      Number.isFinite(record.totals.totalUnits) &&
      Number.isFinite(record.totals.totalDamagedUnits) &&
      Number.isFinite(record.totals.usableUnits)
    ).map((record) => ({
      ...record,
      sourceKey: typeof record.sourceKey === "string" ? record.sourceKey : "demo",
      sourceLabel: typeof record.sourceLabel === "string" ? record.sourceLabel : "Demo inventory"
    })).slice(0, MAX_SAVED_RECEIVING_RECORDS);
  } catch (error) {
    console.warn("Saved receiving records could not be read.", error);
    return [];
  }
}

function renderSavedReceivingRecords() {
  reconciliationController?.render();
}

function showReceivingFeedback(message, type, details = []) {
  receivingFeedback.replaceChildren();
  receivingFeedback.className =
    `upload-feedback ${type === "error" ? "error-message" : "success-message"}`;
  receivingFeedback.setAttribute("role", type === "error" ? "alert" : "status");

  const summary = document.createElement("strong");
  summary.textContent = message;
  receivingFeedback.appendChild(summary);

  if (details.length > 0) {
    const list = document.createElement("ul");
    details.forEach((detail) => {
      const item = document.createElement("li");
      item.textContent = detail;
      list.appendChild(item);
    });
    receivingFeedback.appendChild(list);
  }
  receivingFeedback.hidden = false;
}

function updateBackToTopVisibility() {
  backToTopButton.hidden = window.scrollY < BACK_TO_TOP_THRESHOLD;
}

function scrollToTop() {
  window.scrollTo({
    top: 0,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
  });
}

async function refreshCurrentData() {
  if (dataMode === "customer") {
    setInventoryData(customerRows, {
      mode: "customer",
      rawCount: customerRows.length,
      fileName: customerFileName
    });
    showUploadSuccess(
      `Customer inventory recalculated locally using today’s date (${getLocalTodayISO()}).`
    );
    return;
  }

  await loadDemoData({ announce: true });
}

async function loadDemoData({ announce = false } = {}) {
  const loadingMessage = document.getElementById("loading-message");
  const errorMessage = document.getElementById("error-message");

  loadingMessage.textContent = "Loading FreshRoute demo data…";
  loadingMessage.hidden = false;
  errorMessage.hidden = true;
  refreshButton.disabled = true;
  tableBody.innerHTML = "";

  try {
    const response = await fetch(`${DATA_FILE}?refresh=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Unable to load data. Status: ${response.status}`);

    const parsed = parseCSV(await response.text());
    if (parsed.errors.length > 0) throw new Error(parsed.errors[0]);

    dataMode = "demo";
    customerRows = [];
    customerFileName = "";
    customerSourceKey = "";
    sentRequests = loadSentRequests();
    removalFlags = loadRemovalFlags();
    setInventoryData(parsedRecordsToObjects(parsed), {
      mode: "demo",
      rawCount: parsed.records.length
    });
    loadingMessage.hidden = true;
    if (announce) showUploadSuccess("Demo mode restored with the original classroom dataset.");
  } catch (error) {
    loadingMessage.hidden = true;
    errorMessage.hidden = false;
    errorMessage.textContent =
      "FreshRoute could not load the demo inventory file. Run the dashboard from a local web server, then try again.";
    console.error(error);
  } finally {
    refreshButton.disabled = false;
  }
}

function setInventoryData(rows, { mode, rawCount, fileName = "" }) {
  dataMode = mode;
  rawRecordCount = rawCount;
  if (mode === "customer") customerFileName = fileName;

  baseInventoryData = aggregateLatestInventory(rows, {
    mode,
    currentDate: getLocalTodayISO()
  });
  rebuildInventoryFromBase();
  pruneActionState();
  resetFilters();
  updateDataSourceDisplay();
  updateDashboardSummary();
  renderCriticalAlert();
  applyFilters();
  renderSavedReceivingRecords();
}

function rebuildInventoryFromBase() {
  const adjustedInventory = reconciliationController
    ? reconciliationController.applyToInventory(baseInventoryData)
    : baseInventoryData;
  inventoryData = adjustedInventory.map((item) => {
    const stockStatus = classifyStock(item.currentStock, item.restockAt);
    return {
      ...item,
      stockStatus,
      status: getDisplayStatus(stockStatus, item.daysToExpiry)
    };
  });
}

function refreshInventoryAfterReconciliation() {
  rebuildInventoryFromBase();
  pruneActionState();
  updateDashboardSummary();
  renderCriticalAlert();
  applyFilters();
}

function getCurrentSourceKey() {
  return dataMode === "customer" ? customerSourceKey : "demo";
}

function getCurrentSourceLabel() {
  return dataMode === "customer"
    ? `Customer inventory · ${customerFileName || "local CSV"}`
    : "Demo inventory";
}

function pruneActionState() {
  sentRequests = new Set(
    [...sentRequests].filter((requestKey) =>
      inventoryData.some((item) =>
        item.requestKey === requestKey && ["low-stock", "reorder-soon"].includes(item.status)
      )
    )
  );
  removalFlags = new Set(
    [...removalFlags].filter((requestKey) =>
      inventoryData.some((item) => item.requestKey === requestKey && item.status === "expired")
    )
  );

  if (dataMode === "demo") {
    saveSentRequests();
    saveRemovalFlags();
  }
}

function resetFilters() {
  statusFilter.value = "all";
  productSearch.value = "";
  currentPage = 1;
  updateActiveSummaryCard("all");
}

function updateDataSourceDisplay() {
  const badge = document.getElementById("data-mode-badge");
  const description = document.getElementById("data-mode-description");
  const subtitle = document.querySelector(".subtitle");

  if (dataMode === "customer") {
    badge.textContent = "Customer inventory";
    badge.classList.add("customer-mode");
    description.textContent =
      `${customerFileName} is loaded only in this tab. Expiration is calculated from today (${getLocalTodayISO()}).`;
    subtitle.textContent = "Operational inventory signals from your locally loaded CSV.";
    useDemoButton.disabled = false;
  } else {
    badge.textContent = "Demo mode";
    badge.classList.remove("customer-mode");
    description.textContent =
      "Using the original 4,325-record classroom dataset with historical snapshot dates.";
    subtitle.textContent = "Latest inventory signals for every unique dairy SKU.";
    useDemoButton.disabled = true;
  }
}

async function handleInventoryFile(event) {
  const file = event.target.files[0];
  clearUploadFeedback();
  mappingPanel.hidden = true;
  pendingUpload = null;

  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".csv")) {
    showUploadError("Choose a file with a .csv extension.");
    inventoryFileInput.value = "";
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    showUploadError("This CSV is larger than 5 MB. Split it into a smaller inventory file and try again.");
    inventoryFileInput.value = "";
    return;
  }

  try {
    const fileText = await file.text();
    const parsed = parseCSV(fileText);
    if (parsed.records.length > MAX_UPLOAD_ROWS) {
      showUploadError(`This CSV contains more than ${MAX_UPLOAD_ROWS.toLocaleString()} rows.`);
      return;
    }
    if (parsed.errors.length > 0) {
      showUploadError("FreshRoute could not read this CSV.", parsed.errors);
      return;
    }

    pendingUpload = {
      fileName: file.name,
      parsed,
      sourceKey: await createCustomerSourceKey(fileText)
    };
    renderColumnMappings(parsed, file.name);
    showUploadSuccess(
      `Read ${parsed.records.length.toLocaleString()} rows locally. Review the column matches before importing.`
    );
  } catch (error) {
    console.error(error);
    showUploadError("FreshRoute could not read this file. Confirm it is a valid text CSV and try again.");
  } finally {
    inventoryFileInput.value = "";
  }
}

function renderColumnMappings(parsed, fileName) {
  const suggestions = suggestColumnMappings(parsed.headers);
  const summary = document.getElementById("mapping-file-summary");
  summary.textContent =
    `${fileName} · ${parsed.headers.length} columns · ${parsed.records.length.toLocaleString()} rows`;
  mappingFields.innerHTML = "";

  FIELD_DEFINITIONS.forEach((field) => {
    const group = document.createElement("div");
    group.className = "mapping-field";
    const label = document.createElement("label");
    const select = document.createElement("select");
    const selectId = `mapping-${field.key}`;

    label.htmlFor = selectId;
    label.textContent = field.required ? `${field.label} *` : `${field.label} (optional)`;
    select.id = selectId;
    select.name = field.key;

    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = field.required ? "Choose a column" : "Not included";
    select.appendChild(emptyOption);

    parsed.headers.forEach((header, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = header || `Column ${index + 1}`;
      option.selected = suggestions[field.key] === index;
      select.appendChild(option);
    });

    group.append(label, select);
    mappingFields.appendChild(group);
  });

  mappingPanel.hidden = false;
  mappingPanel.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "nearest"
  });
}

function importMappedInventory(event) {
  event.preventDefault();
  if (!pendingUpload) {
    showUploadError("Choose a CSV file before importing inventory.");
    return;
  }

  const mappings = Object.fromEntries(
    FIELD_DEFINITIONS.map((field) => [field.key, mappingPanel.elements[field.key].value])
  );
  const validation = validateMappedRows(pendingUpload.parsed, mappings);

  if (validation.errors.length > 0) {
    showUploadError(
      `FreshRoute found ${validation.errors.length.toLocaleString()} issue${validation.errors.length === 1 ? "" : "s"}. No rows were imported.`,
      validation.errors
    );
    return;
  }

  customerRows = validation.rows;
  customerFileName = pendingUpload.fileName;
  customerSourceKey = pendingUpload.sourceKey;
  sentRequests = new Set();
  removalFlags = new Set();
  setInventoryData(customerRows, {
    mode: "customer",
    rawCount: pendingUpload.parsed.records.length,
    fileName: customerFileName
  });
  mappingPanel.hidden = true;
  pendingUpload = null;
  showUploadSuccess(
    `Loaded ${customerRows.length.toLocaleString()} valid rows from ${customerFileName}. The file remains local to this tab.`
  );
}

async function createCustomerSourceKey(fileText) {
  if (crypto.subtle && typeof TextEncoder !== "undefined") {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fileText));
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return `customer:${hash}`;
  }

  let hash = 2166136261;
  for (let index = 0; index < fileText.length; index += 1) {
    hash ^= fileText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `customer:${(hash >>> 0).toString(16)}:${fileText.length}`;
}

function cancelPendingUpload() {
  pendingUpload = null;
  mappingPanel.hidden = true;
  mappingFields.innerHTML = "";
  clearUploadFeedback();
}

function clearUploadFeedback() {
  uploadSuccess.hidden = true;
  uploadSuccess.textContent = "";
  uploadError.hidden = true;
  uploadError.textContent = "";
}

function showUploadSuccess(message) {
  uploadError.hidden = true;
  uploadSuccess.textContent = message;
  uploadSuccess.hidden = false;
}

function showUploadError(message, details = []) {
  uploadSuccess.hidden = true;
  uploadError.replaceChildren();
  const summary = document.createElement("strong");
  summary.textContent = message;
  uploadError.appendChild(summary);

  if (details.length > 0) {
    const list = document.createElement("ul");
    details.slice(0, 8).forEach((detail) => {
      const item = document.createElement("li");
      item.textContent = detail;
      list.appendChild(item);
    });
    if (details.length > 8) {
      const more = document.createElement("li");
      more.textContent = `Plus ${details.length - 8} more issue${details.length - 8 === 1 ? "" : "s"}.`;
      list.appendChild(more);
    }
    uploadError.appendChild(list);
  }

  uploadError.hidden = false;
}

function updateDashboardSummary() {
  const needsRestock = inventoryData.filter((item) =>
    matchesStatusFilter(item, "needs-restock")
  ).length;
  const expiringSoon = inventoryData.filter((item) =>
    matchesStatusFilter(item, "expiring-soon")
  ).length;
  const expired = inventoryData.filter((item) =>
    matchesStatusFilter(item, "expired")
  ).length;
  const healthyStock = inventoryData.filter(
    (item) => matchesStatusFilter(item, "healthy-stock")
  ).length;
  const requestsSaved = inventoryData.filter((item) =>
    matchesStatusFilter(item, "requests-sent")
  ).length;

  document.getElementById("unique-sku-count").textContent = inventoryData.length;
  document.getElementById("needs-restock-count").textContent = needsRestock;
  document.getElementById("expiring-soon-count").textContent = expiringSoon;
  document.getElementById("expired-count").textContent = expired;
  document.getElementById("healthy-stock-count").textContent = healthyStock;
  document.getElementById("requests-sent-count").textContent = requestsSaved;
  document.getElementById("source-data-note").textContent = dataMode === "customer"
    ? `${rawRecordCount.toLocaleString()} local rows · ${inventoryData.length} unique SKUs · Calculated ${getLocalTodayISO()}`
    : `${rawRecordCount.toLocaleString()} raw source records · ${inventoryData.length} latest unique SKUs`;
  updateActiveInventoryProgress();
}

function updateActiveInventoryProgress() {
  const totalSkuCount = inventoryData.length;
  const flaggedCount = inventoryData.filter((item) =>
    removalFlags.has(item.requestKey)
  ).length;
  const activeSkuCount = totalSkuCount - flaggedCount;
  const progressBar = document.getElementById("active-inventory-bar");

  document.getElementById("active-inventory-summary").textContent =
    `${activeSkuCount} of ${totalSkuCount} active SKUs remaining · ${flaggedCount} flagged for removal`;
  progressBar.max = Math.max(totalSkuCount, 1);
  progressBar.value = activeSkuCount;
}

function renderCriticalAlert() {
  const alert = document.getElementById("critical-alert");
  const summary = document.getElementById("critical-alert-summary");
  const productList = document.getElementById("critical-products");
  const criticalItems = inventoryData
    .filter((item) => item.daysToExpiry !== null && item.daysToExpiry <= CRITICAL_EXPIRY_DAYS)
    .sort((firstItem, secondItem) => firstItem.daysToExpiry - secondItem.daysToExpiry);

  alert.hidden = criticalItems.length === 0;
  productList.innerHTML = "";
  if (criticalItems.length === 0) return;

  summary.textContent = dataMode === "customer"
    ? `${criticalItems.length} SKUs are expired or due within 72 hours of today.`
    : `${criticalItems.length} SKUs are expired or due within 72 hours of their latest inventory date.`;
  criticalItems.slice(0, 3).forEach((item) => {
    const listItem = document.createElement("li");
    listItem.innerHTML = `<strong>${escapeHTML(item.productName)}</strong><span>${escapeHTML(item.brand)} · ${formatExpiry(item.daysToExpiry)}</span>`;
    productList.appendChild(listItem);
  });

  if (criticalItems.length > 3) {
    const moreItem = document.createElement("li");
    moreItem.className = "more-critical";
    moreItem.textContent = `+ ${criticalItems.length - 3} more`;
    productList.appendChild(moreItem);
  }
}

function applyFilters() {
  const selectedStatus = statusFilter.value;
  const searchText = productSearch.value.trim().toLowerCase();

  filteredInventoryData = inventoryData
    .filter((item) => {
      const matchesStatus = matchesStatusFilter(item, selectedStatus);
      const searchableText = `${item.productName} ${item.brand} ${item.productId}`.toLowerCase();
      return matchesStatus && searchableText.includes(searchText);
    })
    .sort(sortByPriority);

  currentPage = 1;
  renderInventoryTable();
}

function handleStatusFilterChange() {
  updateActiveSummaryCard(statusFilter.value);
  applyFilters();
}

function activateSummaryCard(event) {
  const selectedCard = event.currentTarget;
  statusFilter.value = selectedCard.dataset.statusFilter;
  productSearch.value = "";
  currentPage = 1;
  updateActiveSummaryCard(statusFilter.value);
  applyFilters();
  document.getElementById("inventory-title").scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start"
  });
}

function handleSummaryCardKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  activateSummaryCard(event);
}

function updateActiveSummaryCard(selectedStatus) {
  summaryCards.forEach((card) => {
    const isActive = card.dataset.statusFilter === selectedStatus;
    card.classList.toggle("is-active", isActive);
    card.setAttribute("aria-pressed", String(isActive));
  });
}

function matchesStatusFilter(item, selectedStatus) {
  if (selectedStatus === "all") return true;
  if (selectedStatus === "needs-restock") {
    return ["low-stock", "reorder-soon"].includes(item.status);
  }
  if (selectedStatus === "requests-sent") return sentRequests.has(item.requestKey);
  if (selectedStatus === "expired") return isExpired(item.daysToExpiry);
  if (selectedStatus === "expiring-soon") return isExpiringSoon(item.daysToExpiry);
  return item.status === selectedStatus;
}

function renderInventoryTable() {
  const itemCount = filteredInventoryData.length;
  const totalPages = Math.max(1, Math.ceil(itemCount / PAGE_SIZE));
  currentPage = Math.min(Math.max(currentPage, 1), totalPages);
  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const endIndex = Math.min(startIndex + PAGE_SIZE, itemCount);
  const visibleItems = filteredInventoryData.slice(startIndex, endIndex);
  const resultsSummary = document.getElementById("results-summary");

  resultsSummary.textContent = itemCount === 0
    ? "No SKUs match the current search and filter."
    : `Showing ${startIndex + 1}–${endIndex} of ${itemCount} matching SKUs`;
  tableBody.innerHTML = "";

  if (itemCount === 0) {
    tableBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="7">No SKUs match this search. Try another term or status.</td>
      </tr>
    `;
  } else {
    visibleItems.forEach((item) => tableBody.appendChild(createInventoryRow(item)));
  }

  renderPagination(totalPages, itemCount);
}

function createInventoryRow(item) {
  const row = document.createElement("tr");
  const isExpiredItem = item.status === "expired";
  const canRequestRestock = ["low-stock", "reorder-soon"].includes(item.status);
  const requestSaved = sentRequests.has(item.requestKey);
  const removalFlagged = removalFlags.has(item.requestKey);
  const actionMarkup = isExpiredItem
    ? `<button class="removal-button${removalFlagged ? " is-flagged" : ""}" type="button" data-removal-key="${escapeHTML(item.requestKey)}" ${removalFlagged ? "disabled" : ""}>${removalFlagged ? "Removal Flagged ✓" : "Flag for Removal"}</button>`
    : canRequestRestock
    ? `<button class="request-button${requestSaved ? " is-sent" : ""}" type="button" data-request-key="${escapeHTML(item.requestKey)}" ${requestSaved ? "disabled" : ""}>${requestSaved ? "Request Saved ✓" : "Save Local Request"}</button>`
    : '<span class="no-action">No action needed</span>';

  row.innerHTML = `
    <td><span class="status-badge ${item.status}"><span aria-hidden="true"></span>${getStatusLabel(item.status)}</span></td>
    <td><strong class="product-name">${escapeHTML(item.productName)}</strong><small>Product ID ${escapeHTML(item.productId)} · ${escapeHTML(item.snapshotDate)}</small></td>
    <td>${escapeHTML(item.brand)}</td>
    <td>${formatWholeNumber(item.currentStock)}</td>
    <td>${formatWholeNumber(item.restockAt)}</td>
    <td class="expiry-value ${getExpiryClass(item.daysToExpiry)}">${formatExpiry(item.daysToExpiry)}</td>
    <td>${actionMarkup}</td>
  `;
  return row;
}

function handleTableAction(event) {
  const removalButton = event.target.closest("[data-removal-key]");
  if (removalButton && !removalButton.disabled) {
    const matchingItem = inventoryData.find(
      (item) => item.requestKey === removalButton.dataset.removalKey
    );
    if (matchingItem?.status === "expired") {
      removalFlags.add(matchingItem.requestKey);
      saveRemovalFlags();
      updateDashboardSummary();
      renderInventoryTable();
    }
    return;
  }

  const button = event.target.closest("[data-request-key]");
  if (!button || button.disabled) return;
  const matchingItem = inventoryData.find(
    (item) => item.requestKey === button.dataset.requestKey
  );
  if (!matchingItem || !["low-stock", "reorder-soon"].includes(matchingItem.status)) return;

  sentRequests.add(matchingItem.requestKey);
  saveSentRequests();
  updateDashboardSummary();
  renderInventoryTable();
}

function renderPagination(totalPages, itemCount) {
  const pageNumbers = getVisiblePageNumbers(totalPages, currentPage);
  paginationContainers.forEach((container) => {
    const label = container.id === "pagination-top" ? "above table" : "below table";
    container.innerHTML = `
      <div class="page-buttons">
        ${paginationButton("First", 1, currentPage === 1)}
        ${paginationButton("Previous", currentPage - 1, currentPage === 1)}
        <span class="numbered-pages" aria-label="Page choices">
          ${pageNumbers.map((page) =>
            paginationButton(String(page), page, false, page === currentPage)
          ).join("")}
        </span>
        ${paginationButton("Next", currentPage + 1, currentPage === totalPages || itemCount === 0)}
        ${paginationButton("Last", totalPages, currentPage === totalPages || itemCount === 0)}
      </div>
      <div class="page-meta">
        <span class="page-indicator">Page ${currentPage} of ${totalPages}</span>
        <form class="jump-form">
          <label for="jump-${label.replace(" ", "-")}">Jump to page</label>
          <input id="jump-${label.replace(" ", "-")}" name="page" type="number" min="1" max="${totalPages}" value="${currentPage}" inputmode="numeric" ${itemCount === 0 ? "disabled" : ""}>
          <button type="submit" ${itemCount === 0 ? "disabled" : ""}>Go</button>
        </form>
      </div>
    `;
  });
}

function paginationButton(label, page, disabled, isCurrent = false) {
  return `<button type="button" data-page="${page}" ${disabled ? "disabled" : ""} ${isCurrent ? 'aria-current="page"' : ""} aria-label="${/^\d+$/.test(label) ? `Page ${label}` : label}">${label}</button>`;
}

function getVisiblePageNumbers(totalPages, activePage) {
  if (totalPages <= 5) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const start = Math.min(Math.max(activePage - 2, 1), totalPages - 4);
  return Array.from({ length: 5 }, (_, index) => start + index);
}

function handlePaginationClick(event) {
  const button = event.target.closest("[data-page]");
  if (!button || button.disabled) return;
  goToPage(Number(button.dataset.page));
}

function handlePageJump(event) {
  if (!event.target.matches(".jump-form")) return;
  event.preventDefault();
  goToPage(Number(event.target.elements.page.value));
}

function goToPage(page) {
  const totalPages = Math.max(1, Math.ceil(filteredInventoryData.length / PAGE_SIZE));
  if (!Number.isInteger(page) || page < 1 || page > totalPages) return;
  currentPage = page;
  renderInventoryTable();
  document.getElementById("inventory-title").scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start"
  });
}

function getStatusLabel(status) {
  const labels = {
    "low-stock": "Low Stock",
    "reorder-soon": "Reorder Soon",
    "expired": "Expired",
    "expires-today": "Expires Today",
    "expiring-soon": "Expiring Soon",
    "healthy-stock": "Healthy Stock",
    "needs-review": "Needs Review"
  };
  return labels[status] || "Needs Review";
}

function getExpiryClass(days) {
  if (days === null) return "";
  if (days <= CRITICAL_EXPIRY_DAYS) return "critical-expiry";
  if (isExpiringSoon(days)) return "warning-expiry";
  return "";
}

function formatExpiry(days) {
  if (days === null) return "No date";
  if (days < 0) return `Expired ${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ago`;
  if (days === 0) return "Expires today";
  if (days === 1) return "Expires in 1 day";
  return `Expires in ${days} days`;
}

function formatWholeNumber(value) {
  if (value === null) return "Missing";
  return Math.round(value).toLocaleString();
}

function loadSentRequests() {
  try {
    const savedRequests = JSON.parse(localStorage.getItem(REQUESTS_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(savedRequests) ? savedRequests : []);
  } catch (error) {
    console.warn("Saved restock requests could not be read.", error);
    return new Set();
  }
}

function saveSentRequests() {
  if (dataMode !== "demo") return;
  try {
    localStorage.setItem(REQUESTS_STORAGE_KEY, JSON.stringify([...sentRequests]));
  } catch (error) {
    console.warn("Restock request state could not be saved.", error);
  }
}

function loadRemovalFlags() {
  try {
    const savedFlags = JSON.parse(localStorage.getItem(REMOVALS_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(savedFlags) ? savedFlags : []);
  } catch (error) {
    console.warn("Saved removal flags could not be read.", error);
    return new Set();
  }
}

function saveRemovalFlags() {
  if (dataMode !== "demo") return;
  try {
    localStorage.setItem(REMOVALS_STORAGE_KEY, JSON.stringify([...removalFlags]));
  } catch (error) {
    console.warn("Removal flag state could not be saved.", error);
  }
}

function applySavedTheme() {
  let savedTheme = "dark";
  try {
    savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || "dark";
  } catch (error) {
    console.warn("Theme preference could not be read.", error);
  }
  setTheme(savedTheme === "light" ? "light" : "dark");
}

function toggleTheme() {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  setTheme(nextTheme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  } catch (error) {
    console.warn("Theme preference could not be saved.", error);
  }
}

function setTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.dataset.theme = theme;
  themeToggle.setAttribute("aria-pressed", String(!isDark));
  themeToggle.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} mode`);
  document.getElementById("theme-icon").textContent = isDark ? "☀" : "☾";
  document.getElementById("theme-label").textContent = isDark ? "Light mode" : "Dark mode";
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
