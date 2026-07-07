import { createServiceClient } from "@/lib/supabase/server";
import * as qb from "@/lib/integrations/quickbooks";
import * as amazon from "@/lib/integrations/amazon";
import * as shopify from "@/lib/integrations/shopify";
import * as amplifier from "@/lib/integrations/amplifier";

type SyncResult = {
  job: string;
  status: "success" | "error";
  records: number;
  error?: string;
};

async function startLog(jobName: string): Promise<string> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("cron_logs")
    .insert({ job_name: jobName, status: "running" })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to create cron_log: ${error.message}`);
  return data.id;
}

async function finishLog(
  logId: string,
  status: "success" | "error",
  recordsProcessed: number,
  errorMessage?: string
) {
  const supabase = createServiceClient();
  await supabase
    .from("cron_logs")
    .update({
      status,
      records_processed: recordsProcessed,
      error_message: errorMessage || null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", logId);
}

async function resolveProductByMapping(
  externalId: string,
  source: string
): Promise<string | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("sku_mappings")
    .select("product_id")
    .eq("external_id", externalId)
    .eq("source", source)
    .eq("active", true)
    .limit(1)
    .single();
  return data?.product_id || null;
}

async function trackUnmappedSku(
  externalId: string,
  source: string
): Promise<void> {
  if (!externalId) return;
  const supabase = createServiceClient();
  await supabase.from("unmapped_skus").upsert(
    {
      external_id: externalId,
      source,
      last_seen_at: new Date().toISOString(),
      dismissed: false,
    },
    { onConflict: "external_id,source" }
  );
}

export async function syncQBProducts(): Promise<SyncResult> {
  const logId = await startLog("syncQBProducts");
  try {
    const { inventory, groups } = await qb.fetchAllItems();
    const supabase = createServiceClient();
    let count = 0;

    // Fetch images for all items
    const allItemIds = [
      ...inventory.map((i) => i.Id),
      ...groups.map((g) => g.Id),
    ];
    const imageMap = await qb.fetchItemImages(allItemIds);

    // 1. Upsert inventory items
    for (const item of inventory) {
      const { error } = await supabase
        .from("products")
        .upsert(
          {
            quickbooks_id: item.Id,
            quickbooks_name: item.Name,
            sku: item.Sku || null,
            unit_cost: item.PurchaseCost || null,
            active: item.Active,
            item_type: "inventory",
            image_url: imageMap.get(item.Id) || null,
          },
          { onConflict: "quickbooks_id" }
        );

      if (error) {
        console.error(`Failed to upsert product ${item.Id}:`, error.message);
        continue;
      }

      // Zero out sales price in QB if it's non-zero
      if (item.UnitPrice && item.UnitPrice > 0) {
        try {
          await qb.updateItem(item.Id, { UnitPrice: 0 });
        } catch (err) {
          console.error(`Failed to zero UnitPrice for ${item.Id}:`, err);
        }
      }

      const { data: product } = await supabase
        .from("products")
        .select("id")
        .eq("quickbooks_id", item.Id)
        .single();

      if (product && item.QtyOnHand !== undefined) {
        await supabase.from("inventory_snapshots").insert({
          product_id: product.id,
          source: "quickbooks",
          quantity: Math.floor(item.QtyOnHand),
          raw_payload: item,
        });
      }

      count++;
    }

    // 2. Upsert group/bundle items
    for (const group of groups) {
      const { error } = await supabase
        .from("products")
        .upsert(
          {
            quickbooks_id: group.Id,
            quickbooks_name: group.Name,
            sku: group.Sku || null,
            unit_cost: group.PurchaseCost || null,
            active: group.Active,
            item_type: "bundle",
            image_url: imageMap.get(group.Id) || null,
          },
          { onConflict: "quickbooks_id" }
        );

      if (error) {
        console.error(`Failed to upsert bundle ${group.Id}:`, error.message);
        continue;
      }

      // Get the bundle's product id
      const { data: bundleProduct } = await supabase
        .from("products")
        .select("id")
        .eq("quickbooks_id", group.Id)
        .single();

      if (!bundleProduct) continue;

      // Link component items to this bundle (legacy fields + product_bom table)
      const lines = group.ItemGroupDetail?.ItemGroupLine || [];
      for (const line of lines) {
        // Update legacy bundle_id (last-write-wins for multi-parent components)
        await supabase
          .from("products")
          .update({
            bundle_id: bundleProduct.id,
            bundle_quantity: line.Qty,
          })
          .eq("quickbooks_id", line.ItemRef.value);

        // Upsert into product_bom for multi-parent support
        const { data: compProduct } = await supabase
          .from("products")
          .select("id")
          .eq("quickbooks_id", line.ItemRef.value)
          .single();
        if (compProduct) {
          await supabase.from("product_bom").upsert(
            { parent_id: bundleProduct.id, component_id: compProduct.id, quantity: line.Qty },
            { onConflict: "parent_id,component_id" }
          );
        }
      }

      count++;
    }

    await finishLog(logId, "success", count);
    return { job: "syncQBProducts", status: "success", records: count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishLog(logId, "error", 0, msg);
    return { job: "syncQBProducts", status: "error", records: 0, error: msg };
  }
}

async function cacheExternalSku(
  externalId: string,
  source: string,
  extra?: {
    label?: string;
    title?: string;
    image_url?: string;
    price?: number;
    parent_asin?: string;
    item_type?: string;
    quantity?: number;
    seller_sku?: string;
  }
): Promise<void> {
  if (!externalId) return;
  const supabase = createServiceClient();
  await supabase.from("external_skus").upsert(
    {
      external_id: externalId,
      source,
      label: extra?.label || null,
      title: extra?.title || null,
      image_url: extra?.image_url || null,
      price: extra?.price || null,
      parent_asin: extra?.parent_asin || null,
      item_type: extra?.item_type || null,
      quantity: extra?.quantity ?? null,
      seller_sku: extra?.seller_sku || null,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "external_id,source" }
  );
}

export async function syncAmazonInventory(): Promise<SyncResult> {
  const logId = await startLog("syncAmazonInventory");
  try {
    const summaries = await amazon.fetchFBAInventory();
    const supabase = createServiceClient();
    let count = 0;

    // Accumulate FBA inventory per ASIN (multiple seller SKUs can share one ASIN)
    const fbaAccum = new Map<string, { asin: string; fulfillable: number; inbound: number; reserved: number; transit: number }>();

    // Fetch catalog data for all ASINs (titles, images, prices, parent/child)
    const allAsins = Array.from(new Set(summaries.map((s) => s.asin)));
    const catalogItems = await amazon.fetchCatalogItems(allAsins);
    const catalogMap = new Map(catalogItems.map((c) => [c.asin, c]));

    for (const s of summaries) {
      const catalog = catalogMap.get(s.asin);

      // Skip parent ASINs — only cache child/standalone
      if (catalog?.classification === "VARIATION_PARENT") continue;

      // Cache ASIN with rich metadata + quantity
      // If catalog data unavailable (delisted/suppressed), use seller SKU as fallback title
      const fallbackTitle = catalog?.title || `${s.sellerSku} (${s.asin})`;
      await cacheExternalSku(s.asin, "amazon", {
        label: s.sellerSku !== s.asin ? `SKU: ${s.sellerSku}` : undefined,
        title: fallbackTitle,
        image_url: catalog?.imageUrl || undefined,
        price: catalog?.price || undefined,
        parent_asin: catalog?.parentAsin || undefined,
        item_type: catalog
          ? catalog.classification === "VARIATION_CHILD" ? "child" : "standalone"
          : "unknown",
        quantity: s.totalFulfillableQuantity,
        seller_sku: s.sellerSku,
      });

      // Accumulate FBA data per ASIN (multiple seller SKUs can share one ASIN)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const details = (s.inventoryDetails || {}) as any;
      const fulfillable = details.fulfillableQuantity || 0;
      const inbound = (details.inboundShippedQuantity || 0) + (details.inboundReceivingQuantity || 0);
      const reserved = details.reservedQuantity?.totalReservedQuantity || 0;
      const transitQty = (details.inboundWorkingQuantity || 0) + inbound + reserved;

      const asinKey = `${s.asin}::${new Date().toISOString().split("T")[0]}`;
      if (!fbaAccum.has(asinKey)) {
        fbaAccum.set(asinKey, { asin: s.asin, fulfillable: 0, inbound: 0, reserved: 0, transit: 0 });
      }
      const acc = fbaAccum.get(asinKey)!;
      acc.fulfillable += fulfillable;
      acc.inbound += inbound;
      acc.reserved += reserved;
      acc.transit += transitQty;

      // Try to resolve by ASIN first, then sellerSku
      const productId =
        (await resolveProductByMapping(s.asin, "amazon")) ||
        (await resolveProductByMapping(s.sellerSku, "amazon"));

      if (!productId) {
        await trackUnmappedSku(s.asin, "amazon");
        if (s.sellerSku !== s.asin) {
          await trackUnmappedSku(s.sellerSku, "amazon");
        }
        continue;
      }

      await supabase.from("inventory_snapshots").insert({
        product_id: productId,
        source: "amazon_fba",
        quantity: s.totalFulfillableQuantity,
        raw_payload: s as unknown as Record<string, unknown>,
      });

      count++;
    }

    // Write accumulated FBA snapshots (summed across seller SKUs per ASIN)
    // Delete today's existing rows first, then insert fresh (upsert has issues)
    const snapshotDate = new Date().toISOString().split("T")[0];
    await supabase.from("amazon_inventory_snapshots").delete().eq("snapshot_date", snapshotDate);
    for (const acc of Array.from(fbaAccum.values())) {
      await supabase.from("amazon_inventory_snapshots").insert({
        asin: acc.asin,
        quantity_fulfillable: acc.fulfillable,
        quantity_inbound: acc.inbound,
        quantity_reserved: acc.reserved,
        quantity_transit: acc.transit,
        snapshot_date: snapshotDate,
      });
    }

    await finishLog(logId, "success", count);
    return { job: "syncAmazonInventory", status: "success", records: count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishLog(logId, "error", 0, msg);
    return {
      job: "syncAmazonInventory",
      status: "error",
      records: 0,
      error: msg,
    };
  }
}

export async function sync3PLInventory(): Promise<SyncResult> {
  const logId = await startLog("sync3PLInventory");
  try {
    const items = await amplifier.fetchInventory();
    const supabase = createServiceClient();
    let count = 0;

    // Fetch all items from Amplifier catalog to get names + discontinued status
    const catalogItems = await amplifier.fetchAllItems();
    const catalogMap = new Map(catalogItems.map((ci) => [ci.sku, ci]));

    for (const item of items) {
      const catalogItem = catalogMap.get(item.sku);
      const isDiscontinued = catalogItem?.discontinued ?? false;

      // Cache 3PL SKU — auto-dismiss if discontinued
      await cacheExternalSku(item.sku, "3pl", {
        label: item.sku,
        title: catalogItem?.name || undefined,
        quantity: item.quantity_available,
      });

      // Write to dedicated 3PL snapshot table
      await supabase.from("tpl_inventory_snapshots").upsert(
        {
          sku: item.sku,
          name: catalogItem?.name || null,
          quantity_on_hand: item.quantity_on_hand,
          quantity_available: item.quantity_available,
          quantity_committed: item.quantity_committed,
          quantity_expected: item.quantity_expected,
          snapshot_date: new Date().toISOString().split("T")[0],
        },
        { onConflict: "sku,snapshot_date" }
      );

      if (isDiscontinued) {
        const supabaseForStatus = createServiceClient();
        await supabaseForStatus
          .from("external_skus")
          .update({ status: "discontinued" })
          .eq("external_id", item.sku)
          .eq("source", "3pl");
        continue;
      }

      const productId = await resolveProductByMapping(item.sku, "3pl");
      if (!productId) {
        await trackUnmappedSku(item.sku, "3pl");
        continue;
      }

      await supabase.from("inventory_snapshots").insert({
        product_id: productId,
        source: "3pl",
        quantity: item.quantity_available,
        raw_payload: item as unknown as Record<string, unknown>,
      });

      count++;
    }

    await finishLog(logId, "success", count);
    return { job: "sync3PLInventory", status: "success", records: count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishLog(logId, "error", 0, msg);
    return { job: "sync3PLInventory", status: "error", records: 0, error: msg };
  }
}

export async function sync3PLSnapshot(): Promise<SyncResult> {
  const logId = await startLog("sync3PLSnapshot");
  try {
    const items = await amplifier.fetchInventory();
    const catalogItems = await amplifier.fetchAllItems();
    const nameMap = new Map(catalogItems.map((ci) => [ci.sku, ci.name]));
    const supabase = createServiceClient();
    const today = new Date().toISOString().split("T")[0];
    let count = 0;

    for (const item of items) {
      await supabase.from("tpl_inventory_snapshots").upsert(
        {
          sku: item.sku,
          name: nameMap.get(item.sku) || null,
          quantity_on_hand: item.quantity_on_hand,
          quantity_available: item.quantity_available,
          quantity_committed: item.quantity_committed,
          quantity_expected: item.quantity_expected,
          snapshot_date: today,
        },
        { onConflict: "sku,snapshot_date" }
      );
      count++;
    }

    await finishLog(logId, "success", count);
    return { job: "sync3PLSnapshot", status: "success", records: count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishLog(logId, "error", 0, msg);
    return { job: "sync3PLSnapshot", status: "error", records: 0, error: msg };
  }
}

function getMonthRange(offset: number = 0): {
  start: string;
  end: string;
  period: string;
} {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const nextMonth = new Date(target.getFullYear(), target.getMonth() + 1, 1);
  const period = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`;
  return {
    start: target.toISOString(),
    end: nextMonth.toISOString(),
    period,
  };
}

function parseAmount(amountObj: { Amount?: string; CurrencyCode?: string } | undefined): number {
  return amountObj?.Amount ? parseFloat(amountObj.Amount) : 0;
}

export async function syncAmazonSales(
  monthOffset: number = 0
): Promise<SyncResult> {
  const logId = await startLog("syncAmazonSales");
  try {
    const { start, end, period } = getMonthRange(monthOffset);
    const orders = await amazon.fetchOrders(start, end);
    const supabase = createServiceClient();
    let count = 0;

    for (const order of orders) {
      const items = await amazon.fetchOrderItems(order.AmazonOrderId);

      for (const item of items) {
        const productId =
          (await resolveProductByMapping(item.ASIN, "amazon")) ||
          (await resolveProductByMapping(item.SellerSKU, "amazon"));
        if (!productId) {
          await trackUnmappedSku(item.ASIN, "amazon");
          continue;
        }

        const gross = parseAmount(item.ItemPrice);
        const fees = parseAmount(item.ItemTax);

        // Check if this order item already exists
        const { data: existing } = await supabase
          .from("sale_records")
          .select("id")
          .eq("order_id", order.AmazonOrderId)
          .eq("product_id", productId)
          .limit(1)
          .single();

        if (existing) continue;

        await supabase.from("sale_records").insert({
          product_id: productId,
          channel: "amazon",
          order_id: order.AmazonOrderId,
          quantity: item.QuantityOrdered,
          gross_amount: gross,
          refund_amount: 0,
          fee_amount: fees,
          net_amount: gross - fees,
          sale_date: order.PurchaseDate.split("T")[0],
          period_month: period,
          raw_payload: { order, item },
        });

        count++;
      }
    }

    await finishLog(logId, "success", count);
    return { job: "syncAmazonSales", status: "success", records: count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishLog(logId, "error", 0, msg);
    return { job: "syncAmazonSales", status: "error", records: 0, error: msg };
  }
}

export async function syncShopifySales(
  monthOffset: number = 0
): Promise<SyncResult> {
  const logId = await startLog("syncShopifySales");
  try {
    const { start, end, period } = getMonthRange(monthOffset);
    const orders = await shopify.fetchOrders(start, end);
    const supabase = createServiceClient();
    let count = 0;

    for (const order of orders) {
      const totalRefunds = order.refunds?.reduce(
        (sum: number, r: { refund_line_items?: { subtotal: string }[] }) =>
          sum +
          (r.refund_line_items || []).reduce(
            (s: number, li: { subtotal: string }) => s + parseFloat(li.subtotal || "0"),
            0
          ),
        0
      ) || 0;

      for (const item of order.line_items) {
        if (!item.sku) continue;

        const productId = await resolveProductByMapping(item.sku, "shopify");
        if (!productId) {
          await trackUnmappedSku(item.sku, "shopify");
          continue;
        }

        const { data: existing } = await supabase
          .from("sale_records")
          .select("id")
          .eq("order_id", String(order.id))
          .eq("product_id", productId)
          .limit(1)
          .single();

        if (existing) continue;

        const gross = parseFloat(item.price) * item.quantity;
        const lineRefund =
          totalRefunds > 0
            ? (gross / parseFloat(order.total_price || "1")) * totalRefunds
            : 0;

        await supabase.from("sale_records").insert({
          product_id: productId,
          channel: "shopify",
          order_id: String(order.id),
          quantity: item.quantity,
          gross_amount: gross,
          refund_amount: lineRefund,
          fee_amount: 0,
          net_amount: gross - lineRefund,
          sale_date: order.created_at.split("T")[0],
          period_month: period,
          raw_payload: { order: { id: order.id, name: order.name }, item },
        });

        count++;
      }
    }

    await finishLog(logId, "success", count);
    return { job: "syncShopifySales", status: "success", records: count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishLog(logId, "error", 0, msg);
    return {
      job: "syncShopifySales",
      status: "error",
      records: 0,
      error: msg,
    };
  }
}

export async function syncShopifyProducts(): Promise<SyncResult> {
  const logId = await startLog("syncShopifyProducts");
  try {
    const items = await shopify.fetchProductsWithVariants();
    let count = 0;

    for (const item of items) {
      // Use product_id-variant_id as external_id (unique), SKU as label
      // Multiple variants can share the same SKU across different products
      const externalId = `${item.variant.product_id}-${item.variant.id}`;
      await cacheExternalSku(externalId, "shopify", {
        label: item.variant.sku || undefined,
        title: item.productTitle,
        image_url: item.productImage || undefined,
        price: item.variant.price ? parseFloat(item.variant.price) : undefined,
        quantity: item.variant.inventory_quantity,
        seller_sku: item.variant.sku,
      });
      count++;
    }

    await finishLog(logId, "success", count);
    return { job: "syncShopifyProducts", status: "success", records: count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishLog(logId, "error", 0, msg);
    return { job: "syncShopifyProducts", status: "error", records: 0, error: msg };
  }
}

// QB-only sync — manual trigger only (month-end closing)
export async function syncQB(): Promise<SyncResult[]> {
  const results = await Promise.allSettled([syncQBProducts()]);
  return results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : {
          job: "syncQBProducts",
          status: "error" as const,
          records: 0,
          error: r.reason?.message || String(r.reason),
        }
  );
}

// Amazon sales snapshot — fetches report for last 7 days, re-snapshots to catch status updates
export async function syncAmazonSalesSnapshot(
  startDateStr?: string,
  endDateStr?: string
): Promise<SyncResult> {
  const logId = await startLog("syncAmazonSalesSnapshot");
  try {
    const supabase = createServiceClient();

    // Sale-date window in marketplace-local dates (Pacific for US).
    // Default cron mode: target [today-9, today-2] local — gives 2-day lag for new
    // orders to settle and 7 days of re-pull to catch Pending → Shipped transitions.
    // Backfill mode: pass explicit start+end.
    const endDate = endDateStr || (() => {
      const d = new Date();
      d.setDate(d.getDate() - 2);
      return d.toISOString().split("T")[0];
    })();
    const startDate = startDateStr || (() => {
      const d = new Date();
      d.setDate(d.getDate() - 9);
      return d.toISOString().split("T")[0];
    })();

    // Amazon returns purchaseDate in marketplace-local time (e.g. PST -07:00 for US).
    // Pad the UTC fetch range by ±1 day so we capture all orders whose local sale_date
    // falls within the target window, then discard orders whose local date is outside.
    const fetchStart = new Date(startDate + "T00:00:00Z");
    fetchStart.setUTCDate(fetchStart.getUTCDate() - 1);
    const fetchEnd = new Date(endDate + "T23:59:59Z");
    fetchEnd.setUTCDate(fetchEnd.getUTCDate() + 1);

    const rows = await amazon.fetchOrderReport(
      fetchStart.toISOString().replace(/\.\d+Z$/, "Z"),
      fetchEnd.toISOString().replace(/\.\d+Z$/, "Z")
    );

    // Wipe existing rows in the target sale_date window so re-syncing is idempotent —
    // necessary because Amazon orders DO change after the fact (Pending → Shipped → Cancelled),
    // and partial overwrites from a sliding window were the source of historical undercounts.
    await supabase.from("amazon_sales_snapshots")
      .delete()
      .gte("sale_date", startDate)
      .lte("sale_date", endDate);

    // Group by ASIN + sale_date
    const grouped = new Map<
      string,
      {
        asin: string;
        seller_sku: string;
        product_name: string;
        sale_date: string;
        shipped: { units: number; revenue: number };
        pending: number;
        cancelled: number;
        recurring: { units: number; revenue: number };
        sns_checkout: { units: number; revenue: number };
        one_time: { units: number; revenue: number };
      }
    >();

    for (const row of rows) {
      const saleDate = row.purchaseDate.split("T")[0];
      if (!saleDate || !row.asin) continue;
      // Drop orders whose marketplace-local sale_date falls outside the target window
      // (they're inside our padded UTC fetch range but belong to a different day)
      if (saleDate < startDate || saleDate > endDate) continue;

      const key = `${row.asin}::${saleDate}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          asin: row.asin,
          seller_sku: row.sku,
          product_name: row.productName,
          sale_date: saleDate,
          shipped: { units: 0, revenue: 0 },
          pending: 0,
          cancelled: 0,
          recurring: { units: 0, revenue: 0 },
          sns_checkout: { units: 0, revenue: 0 },
          one_time: { units: 0, revenue: 0 },
        });
      }

      const g = grouped.get(key)!;

      if (row.orderStatus === "Shipped" || row.orderStatus === "Shipping") {
        g.shipped.units += row.quantity;
        g.shipped.revenue += row.itemPrice;

        // Bucket by promotion type
        if (row.promotionIds.includes("FBA Subscribe & Save Discount")) {
          g.recurring.units += row.quantity;
          g.recurring.revenue += row.itemPrice;
        } else if (row.promotionIds.includes("Subscribe and Save Promotion V2")) {
          g.sns_checkout.units += row.quantity;
          g.sns_checkout.revenue += row.itemPrice;
        } else {
          g.one_time.units += row.quantity;
          g.one_time.revenue += row.itemPrice;
        }
      } else if (row.orderStatus === "Pending") {
        g.pending += row.quantity;
      } else if (row.orderStatus === "Cancelled") {
        g.cancelled += row.quantity;
      }
    }

    // Insert fresh — we wiped the target sale_date range above.
    let count = 0;
    for (const g of Array.from(grouped.values())) {
      await supabase.from("amazon_sales_snapshots").insert({
        asin: g.asin,
        seller_sku: g.seller_sku,
        product_name: g.product_name,
        sale_date: g.sale_date,
        units_shipped: g.shipped.units,
        revenue: g.shipped.revenue,
        units_pending: g.pending,
        units_cancelled: g.cancelled,
        recurring_units: g.recurring.units,
        recurring_revenue: g.recurring.revenue,
        sns_checkout_units: g.sns_checkout.units,
        sns_checkout_revenue: g.sns_checkout.revenue,
        one_time_units: g.one_time.units,
        one_time_revenue: g.one_time.revenue,
        snapshot_taken_at: new Date().toISOString(),
      });
      count++;
    }

    await finishLog(logId, "success", count);
    return { job: "syncAmazonSalesSnapshot", status: "success", records: count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishLog(logId, "error", 0, msg);
    return { job: "syncAmazonSalesSnapshot", status: "error", records: 0, error: msg };
  }
}

// Shopify sales snapshot — fetches orders for a date range, groups by variant+date
export async function syncShopifySalesSnapshot(
  startDateStr?: string,
  endDateStr?: string
): Promise<SyncResult> {
  const logId = await startLog("syncShopifySalesSnapshot");
  try {
    const supabase = createServiceClient();

    // Sale-date window in store-local dates.
    // Default cron mode: yesterday only — Shopify orders are final once captured,
    // so we never re-pull past dates. Backfill mode: pass explicit start+end.
    const endDate = endDateStr || (() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d.toISOString().split("T")[0];
    })();
    const startDate = startDateStr || endDate;
    const isBackfill = !!startDateStr;

    // Shopify returns created_at in store-local time; we bucket by that local date.
    // The API filter is in UTC. Pad the UTC fetch range by 1 day on each side to
    // safely cover any timezone offset, then discard orders whose local date falls
    // outside the target sale-date window.
    const fetchStart = new Date(startDate + "T00:00:00Z");
    fetchStart.setUTCDate(fetchStart.getUTCDate() - 1);
    const fetchEnd = new Date(endDate + "T23:59:59Z");
    fetchEnd.setUTCDate(fetchEnd.getUTCDate() + 1);

    const orders = await shopify.fetchOrdersForSales(
      fetchStart.toISOString().replace(/\.\d+Z$/, "Z"),
      fetchEnd.toISOString().replace(/\.\d+Z$/, "Z")
    );

    // Backfill: wipe existing rows in the target range so re-running is idempotent.
    // Cron mode (single day): skip if rows already exist for that date.
    if (isBackfill) {
      await supabase.from("shopify_sales_snapshots")
        .delete()
        .gte("sale_date", startDate)
        .lte("sale_date", endDate);
    } else {
      const { data: existing } = await supabase
        .from("shopify_sales_snapshots")
        .select("id")
        .eq("sale_date", startDate)
        .limit(1);
      if (existing && existing.length > 0) {
        await finishLog(logId, "success", 0);
        return { job: "syncShopifySalesSnapshot", status: "success", records: 0 };
      }
    }

    // Group by variant_id + sale_date
    const grouped = new Map<
      string,
      {
        variant_id: string;
        sku: string;
        product_name: string;
        sale_date: string;
        units: number;
        revenue: number;
        recurring: { units: number; revenue: number };
        first_sub: { units: number; revenue: number };
        one_time: { units: number; revenue: number };
        refund_units: number;
        refund_amount: number;
      }
    >();

    for (const order of orders) {
      if (order.financial_status === "voided") continue;

      const saleDate = order.created_at.split("T")[0];
      // Drop orders whose store-local sale_date falls outside the target window
      // (they're inside our padded UTC fetch range but belong to a different day)
      if (saleDate < startDate || saleDate > endDate) continue;

      const isRecurring = order.source_name === "subscription_contract_checkout_one";
      const isFirstSub = !isRecurring && (order.tags || "").includes("First Subscription");

      for (const item of order.line_items) {
        const variantKey = item.product_id + "-" + item.variant_id;
        const key = `${variantKey}::${saleDate}`;

        if (!grouped.has(key)) {
          grouped.set(key, {
            variant_id: variantKey,
            sku: item.sku || "",
            product_name: item.name,
            sale_date: saleDate,
            units: 0,
            revenue: 0,
            recurring: { units: 0, revenue: 0 },
            first_sub: { units: 0, revenue: 0 },
            one_time: { units: 0, revenue: 0 },
            refund_units: 0,
            refund_amount: 0,
          });
        }

        const g = grouped.get(key)!;
        const lineRevenue = parseFloat(item.price) * item.quantity;

        if (order.financial_status === "refunded") {
          g.refund_units += item.quantity;
          g.refund_amount += lineRevenue;
        } else {
          g.units += item.quantity;
          g.revenue += lineRevenue;

          if (isRecurring) {
            g.recurring.units += item.quantity;
            g.recurring.revenue += lineRevenue;
          } else if (isFirstSub) {
            g.first_sub.units += item.quantity;
            g.first_sub.revenue += lineRevenue;
          } else {
            g.one_time.units += item.quantity;
            g.one_time.revenue += lineRevenue;
          }
        }
      }
    }

    // Insert fresh rows (we either wiped the range above for backfill,
    // or skipped early for cron mode if rows already existed).
    let count = 0;
    for (const g of Array.from(grouped.values())) {
      await supabase.from("shopify_sales_snapshots").insert({
        variant_id: g.variant_id,
        sku: g.sku,
        product_name: g.product_name,
        sale_date: g.sale_date,
        units_sold: g.units,
        revenue: g.revenue,
        recurring_units: g.recurring.units,
        recurring_revenue: g.recurring.revenue,
        first_sub_units: g.first_sub.units,
        first_sub_revenue: g.first_sub.revenue,
        one_time_units: g.one_time.units,
        one_time_revenue: g.one_time.revenue,
        refund_units: g.refund_units,
        refund_amount: g.refund_amount,
        snapshot_taken_at: new Date().toISOString(),
      });
      count++;
    }

    await finishLog(logId, "success", count);
    return { job: "syncShopifySalesSnapshot", status: "success", records: count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishLog(logId, "error", 0, msg);
    return { job: "syncShopifySalesSnapshot", status: "error", records: 0, error: msg };
  }
}

// Automated sync — excludes QB (QB requires manual trigger)
export async function syncAll(): Promise<SyncResult[]> {
  const results = await Promise.allSettled([
    syncAmazonInventory(),
    sync3PLInventory(),
  ]);

  return results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : {
          job: "unknown",
          status: "error" as const,
          records: 0,
          error: r.reason?.message || String(r.reason),
        }
  );
}

// ============================================================================
// Internal (shopcx) sales snapshot
// ----------------------------------------------------------------------------
// shopcx ships native "internal" orders (storefront, native subscription renewals,
// comps) that fulfill through Amplifier (3PL) but never touched Shopify or Amazon.
// This pulls them from the shopcx Supabase (read-only) into internal_sales_snapshots
// so they feed the inventory audit (units burn) + the QB internal sales receipt (COGS)
// + the Shopify JE (revenue/tax/processor). SKUs resolve via sku_mappings source "3pl".
// ============================================================================

const SHOPCX_URL = process.env.SHOPCX_SUPABASE_URL;
const SHOPCX_KEY = process.env.SHOPCX_SUPABASE_SERVICE_ROLE_KEY;
const SHOPCX_WORKSPACE = process.env.SHOPCX_SUPERFOODS_WORKSPACE_ID || "fdc11e10-b89f-4989-8b73-ed6526c4d906";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function shopcxQuery(path: string): Promise<any[]> {
  if (!SHOPCX_URL || !SHOPCX_KEY) throw new Error("SHOPCX_SUPABASE_URL / SHOPCX_SUPABASE_SERVICE_ROLE_KEY not configured");
  const res = await fetch(`${SHOPCX_URL}/rest/v1/${path}`, {
    headers: { apikey: SHOPCX_KEY, Authorization: `Bearer ${SHOPCX_KEY}`, Range: "0-99999" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`shopcx query failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function syncInternalSalesSnapshot(
  startDateStr?: string,
  endDateStr?: string
): Promise<SyncResult> {
  const logId = await startLog("syncInternalSalesSnapshot");
  try {
    const supabase = createServiceClient();

    // Default cron mode: yesterday only. Backfill: explicit start+end.
    const endDate = endDateStr || (() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d.toISOString().split("T")[0];
    })();
    const startDate = startDateStr || endDate;
    const isBackfill = !!startDateStr;

    // shopcx orders.created_at is a UTC timestamp; bucket sale_date by its date.
    // Pad the fetch window ±1 day and discard out-of-window rows after bucketing.
    const fetchStart = new Date(startDate + "T00:00:00Z");
    fetchStart.setUTCDate(fetchStart.getUTCDate() - 1);
    const fetchEnd = new Date(endDate + "T23:59:59Z");
    fetchEnd.setUTCDate(fetchEnd.getUTCDate() + 1);

    // Internal orders = shopify_order_id IS NULL, Superfoods workspace, not voided/cancelled.
    const orders = await shopcxQuery(
      `orders?select=id,order_number,source_name,financial_status,created_at,total_cents,line_items,payment_details,avalara_total_tax_cents,shipping_protection_amount_cents` +
        `&shopify_order_id=is.null&workspace_id=eq.${SHOPCX_WORKSPACE}` +
        `&created_at=gte.${fetchStart.toISOString()}&created_at=lte.${fetchEnd.toISOString()}` +
        `&order=created_at.asc`
    );

    // 3PL SKU → product mapping (internal orders fulfill from Amplifier).
    const { data: allMappings } = await supabase
      .from("sku_mappings")
      .select("external_id, product_id, unit_multiplier, active")
      .eq("source", "3pl");
    const mappingLookup = new Map<string, { product_id: string; multiplier: number }>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const m of (allMappings || []).filter((m: any) => m.active)) {
      mappingLookup.set(m.external_id, { product_id: m.product_id, multiplier: m.unit_multiplier || 1 });
    }

    // Idempotency: backfill wipes the date range; cron mode skips if the day is present.
    if (isBackfill) {
      await supabase.from("internal_sales_snapshots").delete().gte("sale_date", startDate).lte("sale_date", endDate);
    } else {
      const { data: existing } = await supabase
        .from("internal_sales_snapshots").select("id").eq("sale_date", startDate).limit(1);
      if (existing && existing.length > 0) {
        await finishLog(logId, "success", 0);
        return { job: "syncInternalSalesSnapshot", status: "success", records: 0 };
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = [];
    for (const order of orders) {
      const status = String(order.financial_status || "").toLowerCase();
      if (status === "voided" || status === "cancelled" || status === "canceled") continue;

      const saleDate = String(order.created_at).split("T")[0];
      if (saleDate < startDate || saleDate > endDate) continue;

      const pd = order.payment_details || {};
      const processor = pd.gateway || "unknown";
      // shipping income = shipping + shipping protection
      const shippingCents = Number(pd.shipping_cents || 0) + Number(pd.protection_cents ?? order.shipping_protection_amount_cents ?? 0);
      const taxCents = Number(pd.tax_cents ?? order.avalara_total_tax_cents ?? 0);
      const discountCents = Number(pd.discount_cents || 0);

      const lineItems = (order.line_items || []) as Array<{ sku?: string; quantity?: number; price_cents?: number; unit_price_cents?: number; variant_id?: string }>;
      let lineIndex = 0;
      for (const li of lineItems) {
        const sku = (li.sku || "").trim();
        if (!sku) continue;
        const mapping = mappingLookup.get(sku);
        if (!mapping) await trackUnmappedSku(sku, "internal");
        const unitPrice = Number(li.price_cents ?? li.unit_price_cents ?? 0);
        const qty = Number(li.quantity || 0);
        rows.push({
          order_id: String(order.id),
          order_number: order.order_number || null,
          line_index: lineIndex,
          sale_date: saleDate,
          source_name: order.source_name || null,
          financial_status: order.financial_status || null,
          processor,
          sku,
          variant_id: li.variant_id || null,
          product_id: mapping?.product_id || null,
          units: qty * (mapping?.multiplier || 1),
          gross_cents: Math.round(unitPrice * qty),
          // order-level fields only on line_index 0 (0 elsewhere) to count each order once
          order_total_cents: lineIndex === 0 ? Number(order.total_cents || 0) : 0,
          discount_cents: lineIndex === 0 ? discountCents : 0,
          tax_cents: lineIndex === 0 ? taxCents : 0,
          shipping_cents: lineIndex === 0 ? shippingCents : 0,
          raw_payload: { source_name: order.source_name, payment_details: pd },
        });
        lineIndex++;
      }
    }

    let count = 0;
    if (rows.length > 0) {
      // upsert on (order_id, line_index) so re-runs are idempotent even in cron mode
      const { error } = await supabase.from("internal_sales_snapshots").upsert(rows, { onConflict: "order_id,line_index" });
      if (error) throw new Error(error.message);
      count = rows.length;
    }

    await finishLog(logId, "success", count);
    return { job: "syncInternalSalesSnapshot", status: "success", records: count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishLog(logId, "error", 0, msg);
    return { job: "syncInternalSalesSnapshot", status: "error", records: 0, error: msg };
  }
}
