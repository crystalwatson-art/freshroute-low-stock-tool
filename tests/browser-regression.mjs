"use strict";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CHROME = process.env.CHROME_BIN || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].find((candidate) => existsSync(candidate));
const ROOT = normalize(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const checks = [];

function pass(message) {
  checks.push(message);
  console.log(`PASS ${message}`);
}

async function waitFor(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${message}`);
}

class CDP {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else {
        this.events.push(message);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || "Browser evaluation failed");
    }
    return response.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function getOpenPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function startStaticServer() {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".csv": "text/csv; charset=utf-8"
  };
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (pathname === "/api/config") {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ commercialConfigured: false }));
        return;
      }
      const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
      const filePath = normalize(join(ROOT, relative));
      if (!filePath.startsWith(`${ROOT}/`)) throw new Error("Invalid path");
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new Error("Not a file");
      response.writeHead(200, { "Content-Type": types[extname(filePath)] || "application/octet-stream" });
      response.end(await readFile(filePath));
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  return server;
}

async function pressKey(cdp, key, code = key) {
  const windowsVirtualKeyCode = key === "Enter" ? 13 : key === " " ? 32 : key.charCodeAt(0);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
}

async function run() {
  const server = startStaticServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const appPort = server.address().port;
  const debugPort = await getOpenPort();
  const profile = await mkdtemp(join(tmpdir(), "freshroute-browser-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "about:blank"
  ], { stdio: "ignore" });
  let cdp;

  try {
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok;
      } catch {
        return false;
      }
    }, "Chrome debugging endpoint");
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.open();
    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
      cdp.send("Network.enable"),
      cdp.send("Log.enable")
    ]);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false
    });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}/` });
    await waitFor(
      () => cdp.evaluate('document.readyState === "complete" && document.getElementById("unique-sku-count").textContent === "40"'),
      "demo inventory to load"
    );
    pass("dashboard loads the 40-SKU demo inventory");

    const criticalAlert = await cdp.evaluate(`(() => {
      const criticalCount = inventoryData.filter((item) => item.daysToExpiry !== null && item.daysToExpiry <= 3).length;
      const more = document.querySelector("[data-critical-expiry-more]");
      return {
        criticalCount,
        moreText: more?.textContent.trim(),
        moreAccessibleName: more?.getAttribute("aria-label")
      };
    })()`);
    assert.ok(criticalAlert.criticalCount > 3);
    assert.equal(criticalAlert.moreText, `+ ${criticalAlert.criticalCount - 3} more`);
    assert.match(criticalAlert.moreAccessibleName, /Show all/);
    await cdp.evaluate('document.querySelector("[data-critical-expiry-more]").click()');
    assert.equal(await cdp.evaluate('!document.getElementById("inventory-page").hidden'), true);
    assert.equal(await cdp.evaluate('document.getElementById("status-filter").value'), "critical-expiry");
    assert.match(
      await cdp.evaluate('document.getElementById("results-summary").textContent'),
      new RegExp(`of ${criticalAlert.criticalCount} matching SKUs`)
    );
    pass("critical expiry alert opens Inventory with the complete critical set and matching count");

    const pageNavigation = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll("[data-page-target]")];
      const results = buttons.map((button) => {
        button.click();
        const target = document.getElementById(button.dataset.pageTarget + "-page");
        return {
          page: button.dataset.pageTarget,
          visible: !target.hidden,
          activeButton: button.getAttribute("aria-selected") === "true",
          visiblePages: [...document.querySelectorAll(".page-workspace[data-page]")].filter((page) => !page.hidden).map((page) => page.dataset.page)
        };
      });
      document.getElementById("dashboard-button").click();
      return results;
    })()`);
    assert.deepEqual(pageNavigation.map((result) => result.page), ["dashboard", "inventory", "receiving", "reconciliation", "import-data", "settings"]);
    assert.equal(pageNavigation.every((result) => result.visible && result.activeButton && result.visiblePages.length === 1), true);
    pass("primary navigation opens one clear workspace for every page");

    await cdp.evaluate(`document.getElementById("receiving-button").focus()`);
    await pressKey(cdp, "Enter", "Enter");
    assert.equal(await cdp.evaluate('!document.getElementById("receiving-page").hidden'), true);
    pass("keyboard opens the Receive Delivery workspace");

    await cdp.evaluate(`(() => {
      const supplier = document.getElementById("delivery-supplier");
      supplier.value = "Unfinished Supplier Draft";
      supplier.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("inventory-button").click();
      document.getElementById("receiving-button").click();
    })()`);
    assert.equal(await cdp.evaluate('document.getElementById("delivery-supplier").value'), "Unfinished Supplier Draft");
    pass("switching pages preserves an unfinished receiving draft");

    await cdp.evaluate('document.getElementById("receiving-form").requestSubmit()');
    assert.match(
      await cdp.evaluate('document.getElementById("receiving-feedback").textContent'),
      /Boxes per row is required/
    );
    await cdp.evaluate(`(() => {
      const field = document.getElementById("boxes-per-row");
      field.value = "2";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    assert.doesNotMatch(
      await cdp.evaluate('document.getElementById("receiving-feedback").textContent'),
      /Boxes per row is required/
    );
    await cdp.evaluate(`(() => {
      const values = {
        "receiving-sku": "VALIDATION-SKU",
        "receiving-product-name": "Validation Product",
        "receiving-brand": "Validation Brand",
        "receiving-layers": "1",
        "units-per-box": "4",
        "damaged-boxes": "3",
        "damaged-units": "0"
      };
      Object.entries(values).forEach(([id, value]) => {
        const field = document.getElementById(id);
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      document.getElementById("receiving-form").requestSubmit();
    })()`);
    assert.match(
      await cdp.evaluate('document.getElementById("receiving-feedback").textContent'),
      /Damaged boxes cannot exceed total boxes/
    );
    await cdp.evaluate(`(() => {
      const field = document.getElementById("damaged-boxes");
      field.value = "0";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    assert.equal(await cdp.evaluate('document.getElementById("receiving-feedback").hidden'), true);
    pass("receiving validation updates as fields are corrected while retaining invalid-record checks");

    const product = await cdp.evaluate(`(() => {
      const item = inventoryData.find((entry) => Number.isFinite(entry.currentStock));
      return { id: item.productId, name: item.productName, brand: item.brand, before: item.currentStock };
    })()`);
    await cdp.evaluate(`(() => {
      const values = ${JSON.stringify({
        "delivery-supplier": "Browser Test Supplier",
        "receiving-sku": "__SKU__",
        "receiving-product-name": "__NAME__",
        "receiving-brand": "__BRAND__",
        "boxes-per-row": "2",
        "receiving-layers": "2",
        "units-per-box": "6",
        "damaged-boxes": "1",
        "damaged-units": "2"
      }).replace("__SKU__", product.id).replace("__NAME__", product.name).replace("__BRAND__", product.brand)};
      Object.entries(values).forEach(([id, value]) => {
        const field = document.getElementById(id);
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      document.getElementById("receiving-form").requestSubmit();
      document.getElementById("save-receiving-record").click();
    })()`);
    await cdp.evaluate('document.getElementById("reconciliation-button").click()');
    assert.equal(await cdp.evaluate('!document.getElementById("reconciliation-page").hidden'), true);
    assert.equal(await cdp.evaluate('document.querySelectorAll("[data-review-record]").length'), 1);
    assert.match(await cdp.evaluate('document.getElementById("saved-receiving-count").textContent'), /1 saved locally/);
    assert.match(
      await cdp.evaluate('document.getElementById("saved-receiving-description").textContent'),
      /only in this browser/i
    );
    pass("receiving record saves locally with damaged quantities separated");

    await cdp.evaluate('document.querySelector("[data-review-record]").click()');
    const comparison = await cdp.evaluate(`(() => {
      const cells = [...document.querySelectorAll(".reconciliation-table tbody td")].map((cell) => cell.textContent.trim());
      return { cells, warning: document.querySelector(".prototype-warning").textContent.trim() };
    })()`);
    assert.ok(comparison.cells.includes("24"));
    assert.ok(comparison.cells.includes("8"));
    assert.ok(comparison.cells.includes("16"));
    assert.match(comparison.warning, /does not authenticate a supervisor/i);
    pass("review shows received, damaged, usable, before, and after quantities with prototype warning");

    await cdp.evaluate(`(() => {
      document.getElementById("decision-supervisor").value = "Morgan Supervisor";
      document.querySelector('[data-decision="approve"]').click();
    })()`);
    assert.match(
      await cdp.evaluate('document.getElementById("reconciliation-feedback").textContent'),
      /Confirm that you reviewed/
    );
    assert.equal(
      await cdp.evaluate(`inventoryData.find((item) => item.productId === ${JSON.stringify(product.id)}).currentStock`),
      product.before
    );
    pass("inventory cannot change without explicit approval confirmation");

    await cdp.evaluate(`(() => {
      document.querySelector('#supervisor-decision-form [name="confirmation"]').checked = true;
      document.querySelector('[data-decision="approve"]').click();
    })()`);
    assert.equal(
      await cdp.evaluate(`inventoryData.find((item) => item.productId === ${JSON.stringify(product.id)}).currentStock`),
      product.before + 16
    );
    assert.equal(await cdp.evaluate('JSON.parse(localStorage.getItem("freshroute-reconciliation-ledger")).filter((entry) => entry.type === "approval").length'), 1);
    assert.equal(await cdp.evaluate('Boolean(document.getElementById("supervisor-decision-form"))'), false);
    pass("approval adds usable units once and removes the approval controls");

    await cdp.evaluate(`(() => {
      const form = document.getElementById("inventory-correction-form");
      form.elements.deltaUnits.value = "-1";
      form.elements.deltaUnits.dispatchEvent(new Event("input", { bubbles: true }));
      form.elements.correctedBy.value = "Morgan Supervisor";
      form.elements.reason.value = "One unit damaged after count";
      form.elements.confirmation.checked = true;
      form.requestSubmit(form.querySelector('button[type="submit"]'));
    })()`);
    assert.equal(
      await cdp.evaluate(`inventoryData.find((item) => item.productId === ${JSON.stringify(product.id)}).currentStock`),
      product.before + 15
    );
    assert.match(await cdp.evaluate('document.querySelector(".correction-history").textContent'), /One unit damaged after count/);
    pass("correction is a separate traceable adjustment");

    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(
      () => cdp.evaluate('document.readyState === "complete" && document.getElementById("unique-sku-count").textContent === "40"'),
      "dashboard reload"
    );
    assert.equal(
      await cdp.evaluate(`inventoryData.find((item) => item.productId === ${JSON.stringify(product.id)}).currentStock`),
      product.before + 15
    );
    pass("local approval and correction survive reload without applying twice");

    await cdp.evaluate(`(() => {
      document.getElementById("receiving-button").click();
      const values = {
        "delivery-supplier": "Rejected Supplier",
        "receiving-sku": ${JSON.stringify(product.id)},
        "receiving-product-name": ${JSON.stringify(product.name)},
        "receiving-brand": ${JSON.stringify(product.brand)},
        "boxes-per-row": "1",
        "receiving-layers": "1",
        "units-per-box": "4",
        "damaged-boxes": "0",
        "damaged-units": "0"
      };
      Object.entries(values).forEach(([id, value]) => {
        const field = document.getElementById(id);
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      document.getElementById("receiving-form").requestSubmit();
      document.getElementById("save-receiving-record").click();
      document.querySelector("[data-review-record]").click();
      document.getElementById("decision-supervisor").value = "Morgan Supervisor";
      document.getElementById("decision-reason").value = "Delivery documentation did not match";
      document.querySelector('[data-decision="reject"]').click();
    })()`);
    assert.equal(
      await cdp.evaluate(`inventoryData.find((item) => item.productId === ${JSON.stringify(product.id)}).currentStock`),
      product.before + 15
    );
    assert.match(await cdp.evaluate('document.querySelector(".rejected-decision").textContent'), /inventory unchanged/i);
    pass("rejected delivery records a reason and leaves inventory unchanged");

    await cdp.evaluate(`(() => {
      document.getElementById("receiving-button").click();
      const values = {
        "delivery-supplier": "Unknown SKU Supplier",
        "receiving-sku": "UNKNOWN-BROWSER-1",
        "receiving-product-name": "New Browser Product",
        "receiving-brand": "New Browser Brand",
        "boxes-per-row": "2",
        "receiving-layers": "1",
        "units-per-box": "5",
        "damaged-boxes": "0",
        "damaged-units": "0"
      };
      Object.entries(values).forEach(([id, value]) => {
        const field = document.getElementById(id);
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      document.getElementById("receiving-form").requestSubmit();
      document.getElementById("save-receiving-record").click();
      document.getElementById("reconciliation-button").click();
      document.querySelector("[data-review-record]").click();
    })()`);
    assert.equal(await cdp.evaluate('Boolean(document.querySelector("[data-new-product-review]"))'), true);
    assert.match(await cdp.evaluate('document.querySelector(".prototype-warning").textContent'), /DEMONSTRATION MODE/);
    await cdp.evaluate(`(() => {
      const form = document.querySelector("[data-new-product-review]");
      form.elements.actedBy.value = "Demo Supervisor";
      form.elements.reason.value = "Thresholds need correction before approval.";
      form.elements.lowStockThreshold.value = "10";
      form.elements.reorderThreshold.value = "5";
      form.querySelector('[data-new-product-decision="approve"]').click();
    })()`);
    assert.match(await cdp.evaluate('document.getElementById("reconciliation-feedback").textContent'), /Reorder threshold/);
    await cdp.evaluate(`(() => {
      const form = document.querySelector("[data-new-product-review]");
      form.elements.reason.value = "Verified SKU, identity, measurement, quantity, and thresholds.";
      form.elements.reorderThreshold.value = "12";
      form.querySelector('[data-new-product-decision="approve"]').click();
    })()`);
    assert.match(await cdp.evaluate('document.getElementById("reconciliation-feedback").textContent'), /approved in demonstration mode/i);
    assert.equal(await cdp.evaluate('inventoryData.filter((item) => item.productId === "UNKNOWN-BROWSER-1").length'), 1);
    assert.equal(await cdp.evaluate('JSON.parse(localStorage.getItem("freshroute-reconciliation-ledger")).filter((entry) => entry.type === "new_product_review" && entry.decision === "approved").length'), 1);
    pass("unknown SKU receives a dedicated demo review, validates thresholds, and posts accepted quantity once");

    await cdp.evaluate(`(() => {
      document.getElementById("receiving-button").click();
      const values = {
        "delivery-supplier": "Correction Supplier",
        "receiving-sku": "UNKNOWN-BROWSER-2",
        "receiving-product-name": "Needs Correction",
        "receiving-brand": "Correction Brand",
        "boxes-per-row": "1",
        "receiving-layers": "1",
        "units-per-box": "3",
        "damaged-boxes": "0",
        "damaged-units": "0"
      };
      Object.entries(values).forEach(([id, value]) => {
        const field = document.getElementById(id);
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      document.getElementById("receiving-form").requestSubmit();
      document.getElementById("save-receiving-record").click();
      document.getElementById("reconciliation-button").click();
      document.querySelector("[data-review-record]").click();
      const form = document.querySelector("[data-new-product-review]");
      form.elements.actedBy.value = "Demo Supervisor";
      form.elements.reason.value = "Product name must be corrected.";
      form.querySelector('[data-new-product-decision="request_correction"]').click();
    })()`);
    assert.match(await cdp.evaluate('document.querySelector(".correction-decision").textContent'), /Corrections requested/);
    pass("new-product review can request corrections while preserving the delivery");

    await cdp.evaluate('document.getElementById("import-data-button").click()');
    const documentNode = await cdp.send("DOM.getDocument");
    const inputNode = await cdp.send("DOM.querySelector", {
      nodeId: documentNode.root.nodeId,
      selector: "#inventory-file"
    });
    await cdp.send("DOM.setFileInputFiles", {
      nodeId: inputNode.nodeId,
      files: [join(ROOT, "dairy_goods_sales_cleaned.csv")]
    });
    await waitFor(
      () => cdp.evaluate('!document.getElementById("column-mapping-panel").hidden'),
      "CSV mapping panel"
    );
    await cdp.evaluate('document.getElementById("column-mapping-panel").requestSubmit()');
    await waitFor(
      () => cdp.evaluate('document.getElementById("data-mode-badge").textContent === "Customer inventory"'),
      "customer inventory import"
    );
    assert.equal(
      await cdp.evaluate(`inventoryData.find((item) => item.productId === ${JSON.stringify(product.id)}).currentStock`),
      product.before
    );
    pass("customer CSV inventory stays separate from demo reconciliation adjustments");

    await cdp.evaluate('document.getElementById("use-demo-data").click()');
    await waitFor(
      () => cdp.evaluate('document.getElementById("data-mode-badge").textContent === "Demo mode"'),
      "demo mode restore"
    );
    assert.equal(
      await cdp.evaluate(`inventoryData.find((item) => item.productId === ${JSON.stringify(product.id)}).currentStock`),
      product.before + 15
    );
    pass("returning to demo mode restores only demo adjustments");

    await cdp.evaluate(`(() => {
      document.getElementById("status-filter").value = "all";
      document.getElementById("product-search").value = "";
      document.getElementById("status-filter").dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector('#pagination-top [data-page="2"]').click();
    })()`);
    assert.match(await cdp.evaluate('document.querySelector("#pagination-top .page-indicator").textContent'), /Page 2 of 5/);
    assert.match(await cdp.evaluate('document.querySelector("#pagination-bottom .page-indicator").textContent'), /Page 2 of 5/);
    await cdp.evaluate(`(() => {
      const form = document.querySelector("#pagination-bottom .jump-form");
      form.elements.page.value = "4";
      form.requestSubmit();
    })()`);
    assert.match(await cdp.evaluate('document.querySelector("#pagination-top .page-indicator").textContent'), /Page 4 of 5/);
    pass("top and bottom pagination plus page jump still work");

    const originalTheme = await cdp.evaluate('document.documentElement.dataset.theme');
    await cdp.evaluate('document.getElementById("settings-button").click(); document.getElementById("theme-toggle").click()');
    assert.notEqual(await cdp.evaluate('document.documentElement.dataset.theme'), originalTheme);
    await cdp.evaluate('document.getElementById("theme-toggle").click()');
    assert.equal(await cdp.evaluate('!document.getElementById("settings-page").hidden && document.getElementById("help-title").textContent === "Help"'), true);
    pass("settings, theme switching, and Help content still work");

    await cdp.evaluate(`(() => {
      document.getElementById("status-filter").value = "expired";
      document.getElementById("status-filter").dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector("[data-removal-key]").click();
    })()`);
    assert.match(await cdp.evaluate('document.getElementById("active-inventory-summary").textContent'), /1 flagged for removal/);
    assert.match(await cdp.evaluate('document.querySelector("[data-removal-key]").textContent'), /Removal Flagged/);
    pass("expired-item removal flags and active-inventory progress still work");

    await cdp.evaluate(`(() => {
      document.getElementById("dashboard-button").click();
      const card = document.querySelector('.summary-card[data-status-filter="needs-restock"]');
      card.focus();
    })()`);
    await pressKey(cdp, " ", "Space");
    assert.equal(await cdp.evaluate('document.getElementById("status-filter").value'), "needs-restock");
    await cdp.evaluate(`(() => {
      document.getElementById("product-search").value = ${JSON.stringify(product.name)};
      document.getElementById("product-search").dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    assert.ok((await cdp.evaluate('document.getElementById("results-summary").textContent')).length > 0);
    pass("summary-card keyboard filtering and search still work");

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true
    });
    assert.equal(await cdp.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    assert.equal(await cdp.evaluate('getComputedStyle(document.querySelector(".reconciliation-totals")).gridTemplateColumns.split(" ").length'), 1);
    assert.equal(await cdp.evaluate('getComputedStyle(document.querySelector("#boxes-per-row")).minHeight'), "48px");
    assert.equal(await cdp.evaluate('getComputedStyle(document.querySelector(".table-wrapper")).overflowX'), "auto");
    pass("mobile layout fits at 375px without page-level horizontal overflow");

    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }]
    });
    await cdp.evaluate('window.scrollTo(0, document.body.scrollHeight); window.dispatchEvent(new Event("scroll"))');
    await waitFor(() => cdp.evaluate('!document.getElementById("back-to-top").hidden'), "Back to Top visibility");
    await cdp.evaluate('document.getElementById("back-to-top").focus()');
    await pressKey(cdp, " ", "Space");
    await waitFor(() => cdp.evaluate('window.scrollY === 0'), "Back to Top action");
    pass("Back to Top remains keyboard accessible and honors reduced motion");

    const failures = cdp.events.filter((event) =>
      event.method === "Runtime.exceptionThrown" ||
      (event.method === "Log.entryAdded" && event.params.entry.level === "error") ||
      (event.method === "Network.responseReceived" && event.params.response.status >= 400)
    );
    assert.deepEqual(failures, []);
    pass("browser run has no runtime, console, or failed-request errors");
    console.log(`\n${checks.length} browser checks passed.`);
  } finally {
    cdp?.close();
    chrome.kill("SIGTERM");
    await new Promise((resolve) => chrome.once("exit", resolve));
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
