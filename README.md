# FreshRoute Inventory Dashboard

FreshRoute is a data-connected dairy inventory dashboard built with HTML, CSS, and vanilla JavaScript. It turns the source CSV into a prioritized SKU view for restocking and expiry follow-up, with no build step or backend.

## Source data and aggregation

The dashboard reads `dairy_goods_sales_cleaned.csv`, which contains **4,325 inventory records**. Those rows are historical inventory observations—not 4,325 separate products.

The interface creates one dashboard item for each unique `product_id + brand` combination. If a combination appears more than once, FreshRoute keeps the row with the most recent `date` value (and the last source row if dates tie). The current file aggregates to **40 Unique SKUs**.

This aggregation is intentionally limited to the fields available in the CSV. It does not combine brands that happen to sell the same product name, infer inventory movements between rows, or correct inconsistent source dates. Some latest rows have an `expiration_date` earlier than their inventory `date`; the dashboard preserves these records and marks them as expired rather than silently changing the source data.

Days to expiry is calculated for the selected latest row as:

```text
expiration_date - date
```

It is not calculated from the current calendar date.

## Inventory logic

Stock status uses the source row's `quantity_in_stock_literskg` and `minimum_stock_threshold_literskg`. The minimum threshold is rounded upward with `Math.ceil()` to create the dashboard's **Restock At** value. That rounded threshold is used for both classification and display; Current Stock and Restock At are shown as whole numbers. The CSV's reorder quantity remains unchanged but is not used for status classification.

- **Expired:** the expiration date is earlier than the row's inventory date. These SKUs are flagged for removal instead of restocking.
- **Expires Today:** the expiration date matches the row's inventory date.
- **Low Stock:** current stock is at or below Restock At.
- **Reorder Soon:** current stock is above Restock At, but no more than 20% above it.
- **Expiring Soon:** the SKU expires in 1–14 days. This expiry status takes priority over stock status.
- **Healthy Stock:** current stock is more than 20% above Restock At and the SKU has no higher-priority expiry status.

Rows are sorted by operational urgency: Expired, Expires Today, Low Stock, Reorder Soon, Expiring Soon, then Healthy Stock. Missing stock fields fall back to a Needs Review status.

The Expired and Expiring Soon metrics are separate: expired rows are never included in the Expiring Soon summary, while a SKU expiring today is included in that summary total. Its table status remains Expires Today, and the Expiring Soon filter remains limited to the 1–14 day window.

## Features

- Summary metrics for Unique SKUs, Needs Restock, Expiring Soon, Expired, Healthy Stock, and Requests Sent
- A compact critical alert showing up to three SKUs already expired or due within 72 hours, plus a remaining-item count
- Search by product, brand, or product ID and filter by dashboard status
- Urgency sorting and responsive, 10-item pagination above and below the table
- First, Previous, numbered page, Next, Last, jump-to-page, and page-position controls
- Restock requests only for Low Stock and Reorder Soon items; expired items instead provide a Flag for Removal action
- Persistent restock requests, removal flags, and dark/light theme preference through `localStorage`
- Semantic table and form markup, keyboard focus styles, responsive layouts, and reduced-motion support

Restock requests and removal flags are local dashboard state only. They do not send an email or update an external inventory system. Clearing browser storage resets action and theme preferences.

## Run locally

Because the browser loads the CSV with `fetch`, serve the repository over HTTP instead of opening `index.html` directly. From the repository root, run:

```bash
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000) in a browser. Stop the server with `Ctrl+C`.

No package installation or build command is required.
