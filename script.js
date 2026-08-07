"use strict";

const DATA_FILE = "dairy_goods_sales_cleaned.csv";
const PAGE_SIZE = 10;
const EXPIRY_WARNING_DAYS = 14;
const CRITICAL_EXPIRY_DAYS = 3;
const REQUESTS_STORAGE_KEY = "freshroute-restock-requests";
const REMOVALS_STORAGE_KEY = "freshroute-removal-flags";
const THEME_STORAGE_KEY = "freshroute-theme";

let inventoryData = [];
let filteredInventoryData = [];
let currentPage = 1;
let rawRecordCount = 0;
let sentRequests = loadSentRequests();
let removalFlags = loadRemovalFlags();

const statusFilter = document.getElementById("status-filter");
const productSearch = document.getElementById("product-search");
const refreshButton = document.getElementById("refresh-data");
const themeToggle = document.getElementById("theme-toggle");
const tableBody = document.getElementById("inventory-table-body");
const paginationContainers = [
  document.getElementById("pagination-top"),
  document.getElementById("pagination-bottom")
];

document.addEventListener("DOMContentLoaded", () => {
  applySavedTheme();
  statusFilter.addEventListener("change", applyFilters);
  productSearch.addEventListener("input", applyFilters);
  refreshButton.addEventListener("click", loadInventoryData);
  themeToggle.addEventListener("click", toggleTheme);
  tableBody.addEventListener("click", handleTableAction);
  paginationContainers.forEach((container) => {
    container.addEventListener("click", handlePaginationClick);
    container.addEventListener("submit", handlePageJump);
  });
  loadInventoryData();
});

async function loadInventoryData() {
  const loadingMessage = document.getElementById("loading-message");
  const errorMessage = document.getElementById("error-message");

  loadingMessage.hidden = false;
  errorMessage.hidden = true;
  refreshButton.disabled = true;
  tableBody.innerHTML = "";

  try {
    const response = await fetch(`${DATA_FILE}?refresh=${Date.now()}`, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Unable to load data. Status: ${response.status}`);
    }

    const rows = parseCSV(await response.text());
    rawRecordCount = rows.length;
    inventoryData = aggregateLatestInventory(rows);
    sentRequests = new Set(
      [...sentRequests].filter((requestKey) =>
        inventoryData.some((item) =>
          item.requestKey === requestKey &&
          ["low-stock", "reorder-soon"].includes(item.status)
        )
      )
    );
    removalFlags = new Set(
      [...removalFlags].filter((requestKey) =>
        inventoryData.some((item) =>
          item.requestKey === requestKey && item.status === "expired"
        )
      )
    );
    saveSentRequests();
    saveRemovalFlags();

    updateDashboardSummary();
    renderCriticalAlert();
    applyFilters();
    loadingMessage.hidden = true;
  } catch (error) {
    loadingMessage.hidden = true;
    errorMessage.hidden = false;
    errorMessage.textContent =
      "FreshRoute could not load the inventory file. Run the dashboard from a local web server, then try again.";
    console.error(error);
  } finally {
    refreshButton.disabled = false;
  }
}

function parseCSV(csvText) {
  const lines = csvText
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");

  if (lines.length < 2) {
    return [];
  }

  const headers = parseCSVLine(lines[0]).map((header) => header.trim());

  return lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    return Object.fromEntries(
      headers.map((header, index) => [header, (values[index] || "").trim()])
    );
  });
}

function parseCSVLine(line) {
  const values = [];
  let currentValue = "";
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"' && insideQuotes && nextCharacter === '"') {
      currentValue += '"';
      index += 1;
    } else if (character === '"') {
      insideQuotes = !insideQuotes;
    } else if (character === "," && !insideQuotes) {
      values.push(currentValue);
      currentValue = "";
    } else {
      currentValue += character;
    }
  }

  values.push(currentValue);
  return values;
}

function aggregateLatestInventory(rows) {
  const latestBySku = new Map();

  rows.forEach((row, sourceIndex) => {
    const productId = cleanText(row.product_id, "Unknown ID");
    const brand = cleanText(row.brand, "Unknown brand");
    const requestKey = JSON.stringify([productId, brand]);
    const snapshotTime = parseDate(row.date)?.getTime() ?? Number.NEGATIVE_INFINITY;
    const existing = latestBySku.get(requestKey);

    if (
      !existing ||
      snapshotTime > existing.snapshotTime ||
      (snapshotTime === existing.snapshotTime && sourceIndex > existing.sourceIndex)
    ) {
      latestBySku.set(requestKey, {
        row,
        requestKey,
        snapshotTime,
        sourceIndex
      });
    }
  });

  return [...latestBySku.values()]
    .map(({ row, requestKey }) => cleanInventoryRow(row, requestKey))
    .sort(sortByPriority);
}

function cleanInventoryRow(row, requestKey) {
  const currentStock = toNumber(row.quantity_in_stock_literskg);
  const rawMinimumLevel = toNumber(row.minimum_stock_threshold_literskg);
  const restockAt = rawMinimumLevel === null ? null : Math.ceil(rawMinimumLevel);
  const reorderQuantity = toNumber(row.reorder_quantity_literskg);
  const daysToExpiry = calculateDaysToExpiry(row.date, row.expiration_date);
  const stockStatus = classifyStock(currentStock, restockAt);

  return {
    requestKey,
    productId: cleanText(row.product_id, "Unknown ID"),
    productName: cleanText(row.product_name, "Unknown product"),
    brand: cleanText(row.brand, "Unknown brand"),
    snapshotDate: cleanText(row.date, "Unknown date"),
    currentStock,
    restockAt,
    reorderQuantity,
    daysToExpiry,
    stockStatus,
    status: getDisplayStatus(stockStatus, daysToExpiry)
  };
}

function classifyStock(currentStock, restockAt) {
  if (currentStock === null || restockAt === null) {
    return "needs-review";
  }

  if (currentStock <= restockAt) {
    return "low-stock";
  }

  if (currentStock <= restockAt * 1.2) {
    return "reorder-soon";
  }

  return "adequate-stock";
}

function getDisplayStatus(stockStatus, daysToExpiry) {
  if (isExpired(daysToExpiry)) {
    return "expired";
  }

  if (daysToExpiry === 0) {
    return "expires-today";
  }

  if (isExpiringSoon(daysToExpiry)) {
    return "expiring-soon";
  }

  if (stockStatus === "low-stock" || stockStatus === "reorder-soon") {
    return stockStatus;
  }

  return stockStatus === "needs-review" ? "needs-review" : "healthy-stock";
}

function isExpired(daysToExpiry) {
  return daysToExpiry !== null && daysToExpiry < 0;
}

function isExpiringSoon(daysToExpiry) {
  return daysToExpiry !== null &&
    daysToExpiry >= 1 &&
    daysToExpiry <= EXPIRY_WARNING_DAYS;
}

function calculateDaysToExpiry(snapshotDate, expirationDate) {
  const start = parseDate(snapshotDate);
  const end = parseDate(expirationDate);

  if (!start || !end) {
    return null;
  }

  return Math.round((end - start) / 86400000);
}

function parseDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function updateDashboardSummary() {
  const needsRestock = inventoryData.filter((item) =>
    ["low-stock", "reorder-soon"].includes(item.status)
  ).length;
  const expiringSoon = inventoryData.filter((item) =>
    item.daysToExpiry === 0 || isExpiringSoon(item.daysToExpiry)
  ).length;
  const expired = inventoryData.filter((item) => item.status === "expired").length;
  const healthyStock = inventoryData.filter(
    (item) => item.status === "healthy-stock"
  ).length;

  document.getElementById("unique-sku-count").textContent = inventoryData.length;
  document.getElementById("needs-restock-count").textContent = needsRestock;
  document.getElementById("expiring-soon-count").textContent = expiringSoon;
  document.getElementById("expired-count").textContent = expired;
  document.getElementById("healthy-stock-count").textContent = healthyStock;
  document.getElementById("requests-sent-count").textContent = sentRequests.size;
  document.getElementById("source-data-note").textContent =
    `${rawRecordCount.toLocaleString()} raw source records · ${inventoryData.length} latest unique SKUs`;
}

function renderCriticalAlert() {
  const alert = document.getElementById("critical-alert");
  const summary = document.getElementById("critical-alert-summary");
  const productList = document.getElementById("critical-products");
  const criticalItems = inventoryData
    .filter((item) =>
      item.daysToExpiry !== null && item.daysToExpiry <= CRITICAL_EXPIRY_DAYS
    )
    .sort((firstItem, secondItem) =>
      firstItem.daysToExpiry - secondItem.daysToExpiry
    );

  alert.hidden = criticalItems.length === 0;
  productList.innerHTML = "";

  if (criticalItems.length === 0) {
    return;
  }

  summary.textContent = `${criticalItems.length} SKUs are expired or due within 72 hours of their latest inventory date.`;
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
      const searchableText =
        `${item.productName} ${item.brand} ${item.productId}`.toLowerCase();
      return matchesStatus && searchableText.includes(searchText);
    })
    .sort(sortByPriority);

  currentPage = 1;
  renderInventoryTable();
}

function matchesStatusFilter(item, selectedStatus) {
  if (selectedStatus === "all") return true;
  if (selectedStatus === "expired") return isExpired(item.daysToExpiry);
  if (selectedStatus === "expiring-soon") return isExpiringSoon(item.daysToExpiry);
  return item.status === selectedStatus;
}

function sortByPriority(firstItem, secondItem) {
  const priorityOrder = {
    "expired": 1,
    "expires-today": 2,
    "low-stock": 3,
    "reorder-soon": 4,
    "expiring-soon": 5,
    "healthy-stock": 6,
    "needs-review": 7
  };
  const priorityDifference =
    (priorityOrder[firstItem.status] || 7) -
    (priorityOrder[secondItem.status] || 7);

  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  const expiryDifference =
    (firstItem.daysToExpiry ?? Number.MAX_SAFE_INTEGER) -
    (secondItem.daysToExpiry ?? Number.MAX_SAFE_INTEGER);

  if (expiryDifference !== 0) {
    return expiryDifference;
  }

  return firstItem.productName.localeCompare(secondItem.productName);
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
  const requestSent = sentRequests.has(item.requestKey);
  const removalFlagged = removalFlags.has(item.requestKey);
  const actionMarkup = isExpiredItem
    ? `<button class="removal-button${removalFlagged ? " is-flagged" : ""}" type="button" data-removal-key="${escapeHTML(item.requestKey)}" ${removalFlagged ? "disabled" : ""}>${removalFlagged ? "Removal Flagged ✓" : "Flag for Removal"}</button>`
    : canRequestRestock
    ? `<button class="request-button${requestSent ? " is-sent" : ""}" type="button" data-request-key="${escapeHTML(item.requestKey)}" ${requestSent ? "disabled" : ""}>${requestSent ? "Request Sent ✓" : "Send Restock Request"}</button>`
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
      renderInventoryTable();
    }
    return;
  }

  const button = event.target.closest("[data-request-key]");

  if (!button || button.disabled) {
    return;
  }

  const matchingItem = inventoryData.find(
    (item) => item.requestKey === button.dataset.requestKey
  );

  if (!matchingItem || !["low-stock", "reorder-soon"].includes(matchingItem.status)) {
    return;
  }

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
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const start = Math.min(Math.max(activePage - 2, 1), totalPages - 4);
  return Array.from({ length: 5 }, (_, index) => start + index);
}

function handlePaginationClick(event) {
  const button = event.target.closest("[data-page]");

  if (!button || button.disabled) {
    return;
  }

  goToPage(Number(button.dataset.page));
}

function handlePageJump(event) {
  if (!event.target.matches(".jump-form")) {
    return;
  }

  event.preventDefault();
  const input = event.target.elements.page;
  goToPage(Number(input.value));
}

function goToPage(page) {
  const totalPages = Math.max(1, Math.ceil(filteredInventoryData.length / PAGE_SIZE));

  if (!Number.isInteger(page) || page < 1 || page > totalPages) {
    return;
  }

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
  if (days <= 0) return "critical-expiry";
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

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value, fallback) {
  const cleanedValue = String(value || "").trim();
  return cleanedValue || fallback;
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
