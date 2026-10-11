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
    ADJUSTMENT_APPROVE: "adjustment.approve",
    CORRECTION_CREATE: "correction.create",
    MEMBERS_MANAGE: "members.manage"
  });

  const ROLE_PERMISSIONS = Object.freeze({
    [ROLES.WORKER]: Object.freeze([
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.RECEIVING_CREATE
    ]),
    [ROLES.SUPERVISOR]: Object.freeze([
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.RECEIVING_CREATE,
      PERMISSIONS.ADJUSTMENT_APPROVE,
      PERMISSIONS.CORRECTION_CREATE
    ]),
    [ROLES.ADMINISTRATOR]: Object.freeze(Object.values(PERMISSIONS))
  });

  const REQUIRED_ADAPTER_METHODS = Object.freeze([
    "listProducts",
    "getInventoryBalances",
    "listMovements",
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
      approveAdjustment: (context, command) => adapter.approveAdjustment(context, command),
      createCorrection: (context, command) => adapter.createCorrection(context, command)
    });
  }

  function createInMemoryCommercialAdapter(seed = {}) {
    const state = {
      businesses: clone(seed.businesses || []),
      memberships: clone(seed.memberships || []),
      products: clone(seed.products || []),
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

        return { product, measurement: converted.measurement };
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
      const movements = preparedLines.map(({ product, measurement }, index) => ({
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
        occurredAt
      }));

      state.transactions.push(transaction);
      state.movements.push(...movements);
      return { transaction: clone(transaction), movements: clone(movements) };
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
