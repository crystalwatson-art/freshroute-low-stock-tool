"use strict";

const FreshRouteDataAccess = ((units) => {
  const ROLES = Object.freeze({
    WORKER: "worker",
    SUPERVISOR: "supervisor",
    ADMINISTRATOR: "administrator"
  });

  const PERMISSIONS = Object.freeze({
    INVENTORY_READ: "inventory.read",
    RECEIVING_CREATE: "receiving.create",
    INVENTORY_TRANSFER: "inventory.transfer",
    WAREHOUSE_MANAGE: "warehouse.manage",
    ADJUSTMENT_APPROVE: "adjustment.approve",
    CORRECTION_CREATE: "correction.create",
    MEMBERS_MANAGE: "members.manage"
  });

  const ROLE_PERMISSIONS = Object.freeze({
    [ROLES.WORKER]: Object.freeze([
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.RECEIVING_CREATE,
      PERMISSIONS.INVENTORY_TRANSFER
    ]),
    [ROLES.SUPERVISOR]: Object.freeze([
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.RECEIVING_CREATE,
      PERMISSIONS.INVENTORY_TRANSFER,
      PERMISSIONS.ADJUSTMENT_APPROVE,
      PERMISSIONS.CORRECTION_CREATE
    ]),
    [ROLES.ADMINISTRATOR]: Object.freeze(Object.values(PERMISSIONS))
  });

  const REQUIRED_ADAPTER_METHODS = Object.freeze([
    "listProducts",
    "getInventoryBalances",
    "listMovements",
    "listWarehouses",
    "listLocations",
    "listPallets",
    "getLocationBalances",
    "createWarehouse",
    "createLocation",
    "registerPallet",
    "transferInventory",
    "approveAdjustment",
    "createCorrection"
  ]);

  class RepositoryError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "RepositoryError";
      this.code = code;
    }
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function requireText(value, label) {
    const text = String(value ?? "").trim();
    if (!text) throw new RepositoryError("INVALID_INPUT", `${label} is required.`);
    return text;
  }

  function hasPermission(role, permission) {
    return ROLE_PERMISSIONS[role]?.includes(permission) || false;
  }

  function createDataAccess(adapter) {
    if (!adapter || typeof adapter !== "object") {
      throw new RepositoryError("INVALID_ADAPTER", "A data-access adapter is required.");
    }
    REQUIRED_ADAPTER_METHODS.forEach((method) => {
      if (typeof adapter[method] !== "function") {
        throw new RepositoryError("INVALID_ADAPTER", `Adapter is missing ${method}().`);
      }
    });

    return Object.freeze({
      mode: adapter.mode || "unknown",
      listProducts: (context) => adapter.listProducts(context),
      getInventoryBalances: (context) => adapter.getInventoryBalances(context),
      listMovements: (context) => adapter.listMovements(context),
      listWarehouses: (context) => adapter.listWarehouses(context),
      listLocations: (context, query) => adapter.listLocations(context, query),
      listPallets: (context, query) => adapter.listPallets(context, query),
      getLocationBalances: (context, query) => adapter.getLocationBalances(context, query),
      createWarehouse: (context, command) => adapter.createWarehouse(context, command),
      createLocation: (context, command) => adapter.createLocation(context, command),
      registerPallet: (context, command) => adapter.registerPallet(context, command),
      transferInventory: (context, command) => adapter.transferInventory(context, command),
      approveAdjustment: (context, command) => adapter.approveAdjustment(context, command),
      createCorrection: (context, command) => adapter.createCorrection(context, command)
    });
  }

  function createInMemoryCommercialAdapter(seed = {}) {
    const state = {
      businesses: clone(seed.businesses || []),
      memberships: clone(seed.memberships || []),
      products: clone(seed.products || []),
      warehouses: clone(seed.warehouses || []),
      locations: clone(seed.locations || []),
      pallets: clone(seed.pallets || []),
      transactions: clone(seed.transactions || []),
      movements: clone(seed.movements || [])
    };
    let sequence = state.transactions.length + state.movements.length;

    function nextId(prefix) {
      sequence += 1;
      return `${prefix}-local-${sequence}`;
    }

    function authorize(context, permission) {
      const userId = requireText(context?.userId, "User ID");
      const businessId = requireText(context?.businessId, "Business ID");
      const businessExists = state.businesses.some((business) => business.id === businessId);
      if (!businessExists) {
        throw new RepositoryError("BUSINESS_NOT_FOUND", "The requested business does not exist.");
      }

      const membership = state.memberships.find((item) =>
        item.userId === userId &&
        item.businessId === businessId &&
        item.status === "active" &&
        Boolean(item.invitationAcceptedAt)
      );
      if (!membership) {
        throw new RepositoryError(
          "ACCESS_DENIED",
          "An accepted, active invitation is required for this business."
        );
      }
      if (!hasPermission(membership.role, permission)) {
        throw new RepositoryError("PERMISSION_DENIED", "This role is not allowed to perform that action.");
      }
      return { userId, businessId, role: membership.role };
    }

    function businessProducts(businessId) {
      return state.products.filter((product) => product.businessId === businessId);
    }

    function parseStoredDecimal(value) {
      const text = String(value ?? "").trim();
      if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
      const negative = text.startsWith("-");
      const unsigned = negative ? text.slice(1) : text;
      const [wholeRaw, fractionRaw = ""] = unsigned.split(".");
      if (fractionRaw.length > 12) return null;
      const fraction = fractionRaw.replace(/0+$/, "");
      const digits = BigInt(String(wholeRaw || "0") + fraction);
      return { digits: negative ? -digits : digits, scale: fraction.length };
    }

    function addDecimal(first, second) {
      const left = parseStoredDecimal(first);
      const right = parseStoredDecimal(second);
      if (!left || !right) {
        throw new RepositoryError("INVALID_QUANTITY", "Stored normalized quantity is invalid.");
      }
      const scale = Math.max(left.scale, right.scale);
      const leftDigits = left.digits * (10n ** BigInt(scale - left.scale));
      const rightDigits = right.digits * (10n ** BigInt(scale - right.scale));
      const total = leftDigits + rightDigits;
      const negative = total < 0n;
      const absolute = negative ? -total : total;
      let text = absolute.toString().padStart(scale + 1, "0");
      if (scale > 0) {
        const splitAt = text.length - scale;
        text = `${text.slice(0, splitAt)}.${text.slice(splitAt)}`.replace(/\.?0+$/, "");
      }
      if (!text) text = "0";
      return negative && text !== "0" ? `-${text}` : text;
    }

    function balancesFor(businessId) {
      const balances = new Map(businessProducts(businessId).map((product) => [product.id, "0"]));
      state.movements.forEach((movement) => {
        if (movement.businessId !== businessId || !balances.has(movement.productId)) return;
        balances.set(
          movement.productId,
          addDecimal(balances.get(movement.productId), movement.normalizedQuantity)
        );
      });
      return balances;
    }

    function validateIdempotency(businessId, idempotencyKey) {
      const key = requireText(idempotencyKey, "Idempotency key");
      if (state.transactions.some((transaction) =>
        transaction.businessId === businessId && transaction.idempotencyKey === key
      )) {
        throw new RepositoryError("DUPLICATE_TRANSACTION", "This transaction was already applied.");
      }
      return key;
    }

    function prepareLines(actor, lines, { allowNegative = false } = {}) {
      if (!Array.isArray(lines) || lines.length === 0) {
        throw new RepositoryError("INVALID_INPUT", "At least one inventory line is required.");
      }
      const products = businessProducts(actor.businessId);

      return lines.map((line) => {
        const productId = requireText(line?.productId, "Product ID");
        const product = products.find((item) => item.id === productId);
        if (!product) {
          throw new RepositoryError(
            "PRODUCT_NOT_FOUND",
            "The product does not belong to the active business."
          );
        }

        const converted = units.convertQuantity({
          quantity: line.quantity,
          unit: line.unit,
          profile: product.conversionProfile,
          allowNegative
        });
        if (!converted.valid) {
          throw new RepositoryError("INVALID_CONVERSION", converted.errors.join(" "));
        }
        if (converted.measurement.normalizedQuantity === "0") {
          throw new RepositoryError("INVALID_QUANTITY", "Inventory movement quantity cannot be zero.");
        }

        return {
          product,
          measurement: converted.measurement,
          lotId: line.lotId || null,
          warehouseId: line.warehouseId || null,
          locationId: line.locationId || null,
          palletId: line.palletId || null
        };
      });
    }

    function recordTransaction(actor, command, type, preparedLines, extra = {}) {
      const transactionId = nextId("transaction");
      const occurredAt = command.occurredAt || new Date().toISOString();
      const transaction = {
        id: transactionId,
        businessId: actor.businessId,
        idempotencyKey: command.idempotencyKey,
        type,
        sourceId: requireText(command.sourceId, "Source record ID"),
        actorUserId: actor.userId,
        actorRole: actor.role,
        occurredAt,
        ...extra
      };
      const movements = preparedLines.map(({
        product, measurement, lotId, warehouseId, locationId, palletId
      }, index) => ({
        id: nextId("movement"),
        businessId: actor.businessId,
        transactionId,
        lineNumber: index + 1,
        productId: product.id,
        sku: product.sku,
        originalQuantity: measurement.originalQuantity,
        originalUnit: measurement.originalUnit,
        normalizedQuantity: measurement.normalizedQuantity,
        normalizedUnit: measurement.normalizedUnit,
        conversionFactor: measurement.factorToBase,
        conversionSource: measurement.conversionSource,
        lotId,
        warehouseId,
        locationId,
        palletId,
        occurredAt
      }));

      state.transactions.push(transaction);
      state.movements.push(...movements);
      return { transaction: clone(transaction), movements: clone(movements) };
    }

    function sameDimension(left, right) {
      return (left || null) === (right || null);
    }

    function locationBalance({ businessId, warehouseId, locationId, productId, lotId, palletId }) {
      return state.movements.reduce((quantity, movement) => {
        if (
          movement.businessId !== businessId ||
          movement.warehouseId !== warehouseId ||
          movement.locationId !== locationId ||
          movement.productId !== productId ||
          !sameDimension(movement.lotId, lotId) ||
          !sameDimension(movement.palletId, palletId)
        ) return quantity;
        return addDecimal(quantity, movement.normalizedQuantity);
      }, "0");
    }

    return {
      mode: "commercial-local-test",

      listProducts(context) {
        const actor = authorize(context, PERMISSIONS.INVENTORY_READ);
        return clone(businessProducts(actor.businessId));
      },

      getInventoryBalances(context) {
        const actor = authorize(context, PERMISSIONS.INVENTORY_READ);
        const balances = balancesFor(actor.businessId);
        return businessProducts(actor.businessId).map((product) => ({
          productId: product.id,
          sku: product.sku,
          quantity: balances.get(product.id),
          unit: product.conversionProfile.baseUnit
        }));
      },

      listMovements(context) {
        const actor = authorize(context, PERMISSIONS.INVENTORY_READ);
        return clone(state.movements.filter((movement) => movement.businessId === actor.businessId));
      },

      listWarehouses(context) {
        const actor = authorize(context, PERMISSIONS.INVENTORY_READ);
        return clone(state.warehouses.filter((warehouse) => warehouse.businessId === actor.businessId));
      },

      listLocations(context, query = {}) {
        const actor = authorize(context, PERMISSIONS.INVENTORY_READ);
        return clone(state.locations.filter((location) =>
          location.businessId === actor.businessId &&
          (!query.warehouseId || location.warehouseId === query.warehouseId)
        ));
      },

      listPallets(context, query = {}) {
        const actor = authorize(context, PERMISSIONS.INVENTORY_READ);
        return clone(state.pallets.filter((pallet) =>
          pallet.businessId === actor.businessId &&
          (!query.warehouseId || pallet.warehouseId === query.warehouseId)
        ));
      },

      getLocationBalances(context, query = {}) {
        const actor = authorize(context, PERMISSIONS.INVENTORY_READ);
        const balances = new Map();
        state.movements.forEach((movement) => {
          if (
            movement.businessId !== actor.businessId ||
            !movement.warehouseId || !movement.locationId ||
            (query.warehouseId && movement.warehouseId !== query.warehouseId)
          ) return;
          const key = [
            movement.warehouseId, movement.locationId, movement.productId,
            movement.lotId || "", movement.palletId || "", movement.normalizedUnit
          ].join("|");
          const current = balances.get(key) || {
            businessId: actor.businessId,
            warehouseId: movement.warehouseId,
            locationId: movement.locationId,
            productId: movement.productId,
            lotId: movement.lotId || null,
            palletId: movement.palletId || null,
            unit: movement.normalizedUnit,
            quantity: "0"
          };
          current.quantity = addDecimal(current.quantity, movement.normalizedQuantity);
          balances.set(key, current);
        });
        return clone([...balances.values()].filter((balance) => balance.quantity !== "0"));
      },

      createWarehouse(context, command = {}) {
        const actor = authorize(context, PERMISSIONS.WAREHOUSE_MANAGE);
        const code = requireText(command.code, "Warehouse code");
        const name = requireText(command.name, "Warehouse name");
        if (state.warehouses.some((warehouse) =>
          warehouse.businessId === actor.businessId && warehouse.code.toLowerCase() === code.toLowerCase()
        )) {
          throw new RepositoryError("DUPLICATE_WAREHOUSE", "Warehouse codes must be unique within a business.");
        }
        const warehouse = {
          id: nextId("warehouse"),
          businessId: actor.businessId,
          code,
          name,
          active: true,
          createdBy: actor.userId
        };
        state.warehouses.push(warehouse);
        return clone(warehouse);
      },

      createLocation(context, command = {}) {
        const actor = authorize(context, PERMISSIONS.WAREHOUSE_MANAGE);
        const warehouseId = requireText(command.warehouseId, "Warehouse ID");
        const warehouse = state.warehouses.find((item) =>
          item.id === warehouseId && item.businessId === actor.businessId && item.active !== false
        );
        if (!warehouse) throw new RepositoryError("WAREHOUSE_NOT_FOUND", "The warehouse does not belong to the active business.");
        const code = requireText(command.code, "Location code");
        const name = requireText(command.name, "Location name");
        const kinds = ["area", "zone", "aisle", "rack", "shelf", "bin"];
        const purposes = ["receiving", "staging", "storage", "quarantine", "shipping"];
        if (!kinds.includes(command.kind) || !purposes.includes(command.purpose)) {
          throw new RepositoryError("INVALID_LOCATION", "Location kind and purpose must use supported values.");
        }
        if (state.locations.some((location) =>
          location.businessId === actor.businessId && location.warehouseId === warehouseId &&
          String(location.code).toLowerCase() === code.toLowerCase()
        )) {
          throw new RepositoryError("DUPLICATE_LOCATION", "Location codes must be unique within a warehouse.");
        }
        const parentLocationId = command.parentLocationId || null;
        if (!parentLocationId && command.kind !== "area") {
          throw new RepositoryError("INVALID_LOCATION", "A top-level location must be an area.");
        }
        if (parentLocationId) {
          const parent = state.locations.find((location) =>
            location.id === parentLocationId && location.businessId === actor.businessId &&
            location.warehouseId === warehouseId
          );
          if (!parent || parent.purpose !== command.purpose || kinds.indexOf(parent.kind) >= kinds.indexOf(command.kind)) {
            throw new RepositoryError("INVALID_LOCATION", "The parent does not form a valid warehouse hierarchy.");
          }
        }
        const location = {
          id: nextId("location"),
          businessId: actor.businessId,
          warehouseId,
          parentLocationId,
          code,
          name,
          kind: command.kind,
          purpose: command.purpose,
          acceptsInventory: command.acceptsInventory === true,
          active: true,
          createdBy: actor.userId
        };
        state.locations.push(location);
        return clone(location);
      },

      registerPallet(context, command = {}) {
        const actor = authorize(context, PERMISSIONS.RECEIVING_CREATE);
        const warehouseId = requireText(command.warehouseId, "Warehouse ID");
        if (!state.warehouses.some((warehouse) =>
          warehouse.id === warehouseId && warehouse.businessId === actor.businessId && warehouse.active !== false
        )) {
          throw new RepositoryError("WAREHOUSE_NOT_FOUND", "The warehouse does not belong to the active business.");
        }
        const lpn = requireText(command.lpn, "Pallet LPN");
        if (state.pallets.some((pallet) =>
          pallet.businessId === actor.businessId && pallet.lpn.toLowerCase() === lpn.toLowerCase()
        )) {
          throw new RepositoryError("DUPLICATE_PALLET", "Pallet LPNs must be unique within a business.");
        }
        const pallet = {
          id: nextId("pallet"),
          businessId: actor.businessId,
          warehouseId,
          lpn,
          status: "active",
          createdBy: actor.userId
        };
        state.pallets.push(pallet);
        return clone(pallet);
      },

      transferInventory(context, command = {}) {
        const actor = authorize(context, PERMISSIONS.INVENTORY_TRANSFER);
        const idempotencyKey = validateIdempotency(actor.businessId, command.idempotencyKey);
        const warehouseId = requireText(command.warehouseId, "Warehouse ID");
        const sourceLocationId = requireText(command.sourceLocationId, "Source location ID");
        const destinationLocationId = requireText(command.destinationLocationId, "Destination location ID");
        const type = command.type === "putaway" ? "putaway" : command.type === "relocation" ? "relocation" : null;
        if (!type) throw new RepositoryError("INVALID_TRANSFER", "Transfer type must be putaway or relocation.");
        if (sourceLocationId === destinationLocationId) {
          throw new RepositoryError("INVALID_TRANSFER", "Source and destination locations must be different.");
        }

        const warehouse = state.warehouses.find((item) =>
          item.id === warehouseId && item.businessId === actor.businessId && item.active !== false
        );
        if (!warehouse) {
          throw new RepositoryError("WAREHOUSE_NOT_FOUND", "The warehouse does not belong to the active business.");
        }
        const findLocation = (locationId) => state.locations.find((item) =>
          item.id === locationId && item.businessId === actor.businessId &&
          item.warehouseId === warehouseId && item.active !== false && item.acceptsInventory === true
        );
        const source = findLocation(sourceLocationId);
        const destination = findLocation(destinationLocationId);
        if (!source) throw new RepositoryError("INVALID_SOURCE", "The source location is invalid or cannot hold inventory.");
        if (!destination) throw new RepositoryError("INVALID_DESTINATION", "The destination location is invalid or cannot hold inventory.");
        if (type === "putaway" && (
          !["receiving", "staging"].includes(source.purpose) ||
          !["staging", "storage", "quarantine"].includes(destination.purpose)
        )) {
          throw new RepositoryError("INVALID_DESTINATION", "Put-away must follow the receiving workflow.");
        }

        const palletId = command.palletId || null;
        if (palletId && !state.pallets.some((pallet) =>
          pallet.id === palletId && pallet.businessId === actor.businessId &&
          pallet.warehouseId === warehouseId && pallet.status === "active"
        )) {
          throw new RepositoryError("INVALID_PALLET", "The pallet is inactive or belongs to another warehouse.");
        }

        const prepared = prepareLines(actor, command.lines).map((line) => ({
          ...line,
          warehouseId,
          locationId: sourceLocationId,
          palletId
        }));
        const requested = new Map();
        prepared.forEach((line) => {
          const key = `${line.product.id}|${line.lotId || ""}`;
          requested.set(key, addDecimal(requested.get(key) || "0", line.measurement.normalizedQuantity));
        });
        prepared.forEach((line) => {
          const key = `${line.product.id}|${line.lotId || ""}`;
          if (!requested.has(key)) return;
          const available = locationBalance({
            businessId: actor.businessId,
            warehouseId,
            locationId: sourceLocationId,
            productId: line.product.id,
            lotId: line.lotId,
            palletId
          });
          if (parseStoredDecimal(addDecimal(available, `-${requested.get(key)}`)).digits < 0n) {
            throw new RepositoryError("INSUFFICIENT_INVENTORY", "The source location does not have enough inventory.");
          }
          requested.delete(key);
        });

        const transactionId = nextId("transaction");
        const transferId = nextId("transfer");
        const occurredAt = command.occurredAt || new Date().toISOString();
        const transaction = {
          id: transactionId,
          transferId,
          businessId: actor.businessId,
          warehouseId,
          sourceLocationId,
          destinationLocationId,
          palletId,
          idempotencyKey,
          type: "inventory_transfer",
          transferType: type,
          note: String(command.note || "").trim(),
          actorUserId: actor.userId,
          actorRole: actor.role,
          occurredAt
        };
        const movements = prepared.flatMap((line, index) => {
          const common = {
            businessId: actor.businessId,
            transactionId,
            transferId,
            transferLineId: `${transferId}-line-${index + 1}`,
            lineNumber: index + 1,
            productId: line.product.id,
            sku: line.product.sku,
            lotId: line.lotId,
            palletId,
            originalUnit: line.measurement.originalUnit,
            normalizedUnit: line.measurement.normalizedUnit,
            conversionFactor: line.measurement.factorToBase,
            conversionSource: line.measurement.conversionSource,
            warehouseId,
            occurredAt
          };
          return [
            {
              ...common,
              id: nextId("movement"),
              movementRole: "transfer_source",
              locationId: sourceLocationId,
              originalQuantity: `-${line.measurement.originalQuantity}`,
              normalizedQuantity: `-${line.measurement.normalizedQuantity}`
            },
            {
              ...common,
              id: nextId("movement"),
              movementRole: "transfer_destination",
              locationId: destinationLocationId,
              originalQuantity: line.measurement.originalQuantity,
              normalizedQuantity: line.measurement.normalizedQuantity
            }
          ];
        });

        state.transactions.push(transaction);
        state.movements.push(...movements);
        return { transaction: clone(transaction), movements: clone(movements) };
      },

      approveAdjustment(context, command = {}) {
        const actor = authorize(context, PERMISSIONS.ADJUSTMENT_APPROVE);
        const idempotencyKey = validateIdempotency(actor.businessId, command.idempotencyKey);
        const prepared = prepareLines(actor, command.lines);
        return recordTransaction(
          actor,
          { ...command, idempotencyKey },
          "receiving_approval",
          prepared
        );
      },

      createCorrection(context, command = {}) {
        const actor = authorize(context, PERMISSIONS.CORRECTION_CREATE);
        const idempotencyKey = validateIdempotency(actor.businessId, command.idempotencyKey);
        const reason = requireText(command.reason, "Correction reason");
        const reference = state.transactions.find((transaction) =>
          transaction.id === command.correctsTransactionId && transaction.businessId === actor.businessId
        );
        if (!reference) {
          throw new RepositoryError(
            "REFERENCE_NOT_FOUND",
            "The corrected transaction does not belong to the active business."
          );
        }
        const prepared = prepareLines(actor, command.lines, { allowNegative: true });
        const balances = balancesFor(actor.businessId);
        prepared.forEach(({ product, measurement }) => {
          const projected = addDecimal(balances.get(product.id), measurement.normalizedQuantity);
          if (parseStoredDecimal(projected).digits < 0n) {
            throw new RepositoryError("NEGATIVE_INVENTORY", "A correction cannot make inventory negative.");
          }
          balances.set(product.id, projected);
        });

        return recordTransaction(
          actor,
          { ...command, idempotencyKey },
          "correction",
          prepared,
          { correctsTransactionId: reference.id, reason }
        );
      }
    };
  }

  function createClassroomDemoAdapter(inventoryProvider) {
    if (typeof inventoryProvider !== "function") {
      throw new RepositoryError("INVALID_ADAPTER", "Demo inventory provider must be a function.");
    }
    const readOnly = () => {
      throw new RepositoryError(
        "DEMO_READ_ONLY",
        "The classroom demo is separate from commercial inventory and cannot be persisted here."
      );
    };
    const readInventory = () => clone(inventoryProvider() || []);

    return {
      mode: "classroom-demo",
      listProducts: readInventory,
      getInventoryBalances: readInventory,
      listMovements: () => [],
      listWarehouses: () => [],
      listLocations: () => [],
      listPallets: () => [],
      getLocationBalances: () => [],
      createWarehouse: readOnly,
      createLocation: readOnly,
      registerPallet: readOnly,
      transferInventory: readOnly,
      approveAdjustment: readOnly,
      createCorrection: readOnly
    };
  }

  return {
    ROLES,
    PERMISSIONS,
    ROLE_PERMISSIONS,
    REQUIRED_ADAPTER_METHODS,
    RepositoryError,
    hasPermission,
    createDataAccess,
    createInMemoryCommercialAdapter,
    createClassroomDemoAdapter
  };
})(
  typeof module !== "undefined" && module.exports
    ? require("./unit-conversion.js")
    : window.FreshRouteUnits
);

if (typeof module !== "undefined" && module.exports) {
  module.exports = FreshRouteDataAccess;
}

if (typeof window !== "undefined") {
  window.FreshRouteDataAccess = FreshRouteDataAccess;
}
