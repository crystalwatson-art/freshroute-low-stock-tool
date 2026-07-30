const DATA_FILE = "dairy_goods_sales_cleaned.csv";

let inventoryData = [];

const statusFilter = document.getElementById("status-filter");
const productSearch = document.getElementById("product-search");
const refreshButton = document.getElementById("refresh-data");
const tableBody = document.getElementById("inventory-table-body");

document.addEventListener("DOMContentLoaded", () => {
  statusFilter.addEventListener("change", applyFilters);
  productSearch.addEventListener("input", applyFilters);
  refreshButton.addEventListener("click", loadInventoryData);

  loadInventoryData();
});

async function loadInventoryData() {
  const loadingMessage = document.getElementById("loading-message");
  const errorMessage = document.getElementById("error-message");

  loadingMessage.hidden = false;
  errorMessage.hidden = true;
  tableBody.innerHTML = "";

  try {
    const response = await fetch(`${DATA_FILE}?refresh=${Date.now()}`, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Unable to load data. Status: ${response.status}`);
    }

    const csvText = await response.text();
    const rows = parseCSV(csvText);

    inventoryData = rows
      .map(cleanInventoryRow)
      .filter((item) => item.productName);

    updateSummaryCards(inventoryData);
    applyFilters();

    loadingMessage.hidden = true;
  } catch (error) {
    loadingMessage.hidden = true;
    errorMessage.hidden = false;
    errorMessage.textContent =
      "FreshRoute could not load the inventory file. Please refresh the page.";
    console.error(error);
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
    const row = {};

    headers.forEach((header, index) => {
      row[header] = values[index] ? values[index].trim() : "";
    });

    return row;
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

function cleanInventoryRow(row) {
  const currentStock = toNumber(row.quantity_in_stock_literskg);
  const minimumLevel = toNumber(row.minimum_stock_threshold_literskg);
  const reorderQuantity = toNumber(row.reorder_quantity_literskg);

  return {
    productName: cleanText(row.product_name, "Unknown product"),
    brand: cleanText(row.brand, "Unknown brand"),
    currentStock,
    minimumLevel,
    reorderQuantity,
    daysToExpiry: calculateDaysToExpiry(row.date, row.expiration_date),
    status: classifyInventory(
      currentStock,
      minimumLevel,
      reorderQuantity
    )
  };
}

function classifyInventory(currentStock, minimumLevel, reorderQuantity) {
  if (currentStock === null || minimumLevel === null) {
    return "needs-review";
  }

  if (currentStock <= minimumLevel) {
    return "low-stock";
  }

  const reorderBuffer =
    reorderQuantity === null ? minimumLevel * 0.25 : reorderQuantity;

  if (currentStock <= minimumLevel + reorderBuffer) {
    return "reorder-soon";
  }

  return "stock-level-good";
}

function calculateDaysToExpiry(snapshotDate, expirationDate) {
  if (!snapshotDate || !expirationDate) {
    return null;
  }

  const start = new Date(`${snapshotDate}T00:00:00Z`);
  const end = new Date(`${expirationDate}T00:00:00Z`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  const millisecondsPerDay = 1000 * 60 * 60 * 24;
  return Math.round((end - start) / millisecondsPerDay);
}

function updateSummaryCards(items) {
  document.getElementById("total-products").textContent = items.length;

  document.getElementById("low-stock-count").textContent =
    items.filter((item) => item.status === "low-stock").length;

  document.getElementById("reorder-soon-count").textContent =
    items.filter((item) => item.status === "reorder-soon").length;

  document.getElementById("good-stock-count").textContent =
    items.filter((item) => item.status === "stock-level-good").length;
}

function applyFilters() {
  const selectedStatus = statusFilter.value;
  const searchText = productSearch.value.trim().toLowerCase();

  const filteredItems = inventoryData
    .filter((item) => {
      const matchesStatus =
        selectedStatus === "all" || item.status === selectedStatus;

      const searchableText =
        `${item.productName} ${item.brand}`.toLowerCase();

      const matchesSearch = searchableText.includes(searchText);

      return matchesStatus && matchesSearch;
    })
    .sort(sortByPriority);

  renderInventoryTable(filteredItems);
}

function sortByPriority(firstItem, secondItem) {
  const priorityOrder = {
    "low-stock": 1,
    "reorder-soon": 2,
    "needs-review": 3,
    "stock-level-good": 4
  };

  const statusDifference =
    priorityOrder[firstItem.status] - priorityOrder[secondItem.status];

  if (statusDifference !== 0) {
    return statusDifference;
  }

  const firstExpiry = firstItem.daysToExpiry ?? Number.MAX_SAFE_INTEGER;
  const secondExpiry = secondItem.daysToExpiry ?? Number.MAX_SAFE_INTEGER;

  return firstExpiry - secondExpiry;
}

function renderInventoryTable(items) {
  const resultsSummary = document.getElementById("results-summary");
  const visibleItems = items.slice(0, 200);

  tableBody.innerHTML = "";

  resultsSummary.textContent =
    items.length > 200
      ? `Showing 200 of ${items.length} matching products.`
      : `Showing ${items.length} matching products.`;

  if (items.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="6">No products match this search.</td>
      </tr>
    `;
    return;
  }

  visibleItems.forEach((item) => {
    const row = document.createElement("tr");

    row.innerHTML = `
      <td>
        <span class="status-badge ${item.status}">
          ${getStatusLabel(item.status)}
        </span>
      </td>
      <td>${escapeHTML(item.productName)}</td>
      <td>${escapeHTML(item.brand)}</td>
      <td>${formatNumber(item.currentStock)}</td>
      <td>${formatNumber(item.minimumLevel)}</td>
      <td>${formatExpiry(item.daysToExpiry)}</td>
    `;

    tableBody.appendChild(row);
  });
}

function getStatusLabel(status) {
  const labels = {
    "low-stock": "Low Stock",
    "reorder-soon": "Reorder Soon",
    "stock-level-good": "Stock Level Good",
    "needs-review": "Needs Review"
  };

  return labels[status] || "Needs Review";
}

function formatExpiry(days) {
  if (days === null) {
    return "No date";
  }

  if (days < 0) {
    return `Expired ${Math.abs(days)} days ago`;
  }

  if (days === 0) {
    return "Expires today";
  }

  return `${days} days`;
}

function formatNumber(value) {
  if (value === null) {
    return "Missing";
  }

  return value.toLocaleString(undefined, {
    maximumFractionDigits: 2
  });
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value, fallback) {
  const cleanedValue = String(value || "").trim();
  return cleanedValue || fallback;
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
