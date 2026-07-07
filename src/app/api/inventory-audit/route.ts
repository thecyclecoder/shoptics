import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { fetchInventoryReceiptsByItem } from "@/lib/integrations/quickbooks";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = createServiceClient();

  // Optional ?month=YYYY-MM puts the audit into "monthly view" mode:
  // - QB start = post-close snapshot of the prior month (= start of target month)
  // - FBA/3PL = snapshots dated on/closest to the last day of target month
  // - Sales = filtered to that month only
  // - Manual inventory = current (no historical snapshots; UI should warn)
  const monthParam = request.nextUrl.searchParams.get("month");
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let priorMonth: string | null = null;
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const [y, m] = monthParam.split("-").map(Number);
    periodStart = `${monthParam}-01`;
    periodEnd = new Date(y, m, 0).toISOString().split("T")[0];
    const pm = m === 1 ? 12 : m - 1;
    const py = m === 1 ? y - 1 : y;
    priorMonth = `${py}-${String(pm).padStart(2, "0")}`;
  }

  // 1. Products
  const { data: products } = await supabase
    .from("products")
    .select("id, quickbooks_id, quickbooks_name, sku, image_url, item_type, product_category, bundle_id, bundle_quantity, unit_cost")
    .eq("active", true);

  // 1b. BOM relationships (multi-parent support)
  const { data: bomRows } = await supabase
    .from("product_bom")
    .select("parent_id, component_id, quantity");

  // 2. SKU Mappings
  const { data: mappings } = await supabase
    .from("sku_mappings")
    .select("external_id, source, product_id, unit_multiplier")
    .eq("active", true);

  // 3. FBA inventory — latest snapshot, OR snapshot on/closest-before periodEnd in monthly view
  const { data: fbaDateRow } = periodEnd
    ? await supabase
        .from("amazon_inventory_snapshots")
        .select("snapshot_date")
        .lte("snapshot_date", periodEnd)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .single()
    : await supabase
        .from("amazon_inventory_snapshots")
        .select("snapshot_date")
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .single();

  const fbaByAsin = new Map<string, { fulfillable: number; transit: number }>();
  if (fbaDateRow) {
    const { data: fbaSnaps } = await supabase
      .from("amazon_inventory_snapshots")
      .select("asin, quantity_fulfillable, quantity_transit")
      .eq("snapshot_date", fbaDateRow.snapshot_date);
    for (const s of fbaSnaps || []) {
      fbaByAsin.set(s.asin, { fulfillable: s.quantity_fulfillable, transit: s.quantity_transit || 0 });
    }
  }

  // 4. 3PL inventory — same pattern as FBA
  const { data: tplDateRow } = periodEnd
    ? await supabase
        .from("tpl_inventory_snapshots")
        .select("snapshot_date")
        .lte("snapshot_date", periodEnd)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .single()
    : await supabase
        .from("tpl_inventory_snapshots")
        .select("snapshot_date")
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .single();

  const tplBySku = new Map<string, number>();
  if (tplDateRow) {
    const { data: tplSnaps } = await supabase
      .from("tpl_inventory_snapshots")
      .select("sku, quantity_available")
      .eq("snapshot_date", tplDateRow.snapshot_date);
    for (const s of tplSnaps || []) {
      tplBySku.set(s.sku, s.quantity_available);
    }
  }

  // 5. Manual inventory — use direct REST call to bypass any client caching
  const manualRes = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/manual_inventory?select=product_id,quantity,location,note,active`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
      },
      cache: "no-store",
    }
  );
  const manualEntriesAll = await manualRes.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const manualEntries = (manualEntriesAll || []).filter((m: any) => m.active);

  const manualByProduct = new Map<string, Array<{ quantity: number; location: string; note: string | null }>>();
  for (const m of manualEntries || []) {
    const list = manualByProduct.get(m.product_id) || [];
    list.push({ quantity: m.quantity, location: m.location, note: m.note });
    manualByProduct.set(m.product_id, list);
  }

  // 6. QB inventory snapshots
  // Live mode: latest snapshot per product
  // Monthly view: post-close snapshot of the prior month (= QB at start of target month)
  const qbInventory = new Map<string, number>();
  let qbSnapshotDate: string | null = null;
  if (priorMonth) {
    // Pull all QB snapshots, then filter for the post-close of prior month in JS
    // (Postgrest filtering on JSON keys is awkward; in-memory is simpler and rows are small)
    const { data: qbSnapshots } = await supabase
      .from("inventory_snapshots")
      .select("product_id, quantity, snapshot_at, raw_payload")
      .eq("source", "quickbooks")
      .order("snapshot_at", { ascending: true });
    for (const snap of qbSnapshots || []) {
      const p = (snap.raw_payload || {}) as { snapshot_type?: string; month?: string };
      if (p.snapshot_type === "month_end_post" && p.month === priorMonth) {
        qbInventory.set(snap.product_id, snap.quantity);
        if (!qbSnapshotDate) qbSnapshotDate = snap.snapshot_at?.split("T")[0] || null;
      }
    }
  } else {
    const { data: qbSnapshots } = await supabase
      .from("inventory_snapshots")
      .select("product_id, quantity, snapshot_at")
      .eq("source", "quickbooks")
      .order("snapshot_at", { ascending: false });
    for (const snap of qbSnapshots || []) {
      if (!qbInventory.has(snap.product_id)) {
        qbInventory.set(snap.product_id, snap.quantity);
      }
    }
    qbSnapshotDate = qbSnapshots?.[0]?.snapshot_at?.split("T")[0] || null;
  }

  // 7. Sales window
  // Live mode: since last close
  // Monthly view: filtered to that month only
  let salesSince: string;
  let salesUntil: string | null = null;
  if (periodStart && periodEnd) {
    salesSince = periodStart;
    salesUntil = periodEnd;
  } else {
    const { data: lastClosing } = await supabase
      .from("month_end_closings")
      .select("closing_month, status")
      .in("status", ["completed", "completed_with_errors"])
      .order("closing_month", { ascending: false })
      .limit(1)
      .single();
    if (lastClosing) {
      const [y, m] = lastClosing.closing_month.split("-").map(Number);
      const nextMonth = m === 12 ? 1 : m + 1;
      const nextYear = m === 12 ? y + 1 : y;
      salesSince = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
    } else {
      salesSince = "2026-03-01";
    }
  }

  let amazonSalesQuery = supabase
    .from("amazon_sales_snapshots")
    .select("asin, units_shipped")
    .gte("sale_date", salesSince);
  if (salesUntil) amazonSalesQuery = amazonSalesQuery.lte("sale_date", salesUntil);
  const { data: amazonSales } = await amazonSalesQuery;

  let shopifySalesQuery = supabase
    .from("shopify_sales_snapshots")
    .select("variant_id, units_sold")
    .gte("sale_date", salesSince);
  if (salesUntil) shopifySalesQuery = shopifySalesQuery.lte("sale_date", salesUntil);
  const { data: shopifySales } = await shopifySalesQuery;

  const amzSalesByAsin = new Map<string, number>();
  for (const r of amazonSales || []) {
    amzSalesByAsin.set(r.asin, (amzSalesByAsin.get(r.asin) || 0) + r.units_shipped);
  }
  const shopSalesByVariant = new Map<string, number>();
  for (const r of shopifySales || []) {
    shopSalesByVariant.set(r.variant_id, (shopSalesByVariant.get(r.variant_id) || 0) + r.units_sold);
  }

  // Internal (shopcx) sales — native storefront/subscription/comp orders fulfilled via 3PL.
  // Already resolved to product_id with unit_multiplier applied at sync time, so key by
  // product_id directly (no per-mapping multiply) and fold into the burn like the other channels.
  let internalSalesQuery = supabase
    .from("internal_sales_snapshots")
    .select("product_id, units")
    .gte("sale_date", salesSince);
  if (salesUntil) internalSalesQuery = internalSalesQuery.lte("sale_date", salesUntil);
  const { data: internalSales } = await internalSalesQuery;

  const internalSalesByProduct = new Map<string, number>();
  for (const r of internalSales || []) {
    if (!r.product_id) continue;
    internalSalesByProduct.set(r.product_id, (internalSalesByProduct.get(r.product_id) || 0) + r.units);
  }

  // Receipts term (monthly mode only): inventory RECEIVED via QB purchases (Bill/ItemReceipt/
  // Purchase) during the period. Expected = start − sold + received. Without +received, a
  // mid-month PO (e.g. a carton purchase) reads as a positive variance and Step 2 would post a
  // phantom adjustment ON TOP of the PO QB already holds (the historical Mixed-Berry swings).
  // Live mode uses current QB (already reflects receipts), so this stays empty there.
  const receivedByProduct = new Map<string, number>();
  if (periodStart && periodEnd) {
    try {
      const receiptsByQbItem = await fetchInventoryReceiptsByItem(periodStart, periodEnd);
      const qbItemToProduct = new Map<string, string>();
      for (const p of products || []) {
        if (p.quickbooks_id) qbItemToProduct.set(String(p.quickbooks_id), p.id);
      }
      for (const [qbItemId, qty] of Array.from(receiptsByQbItem)) {
        const pid = qbItemToProduct.get(String(qbItemId));
        if (pid) receivedByProduct.set(pid, (receivedByProduct.get(pid) || 0) + qty);
      }
    } catch {
      // QB unavailable — degrade to received = 0 (same as pre-receipts-term behavior)
    }
  }
  const getReceived = (productId: string) => receivedByProduct.get(productId) || 0;

  // Build indexes
  interface ProductInfo {
    id: string; name: string; sku: string | null; image_url: string | null;
    item_type: string; product_category: string | null;
    bundle_id: string | null; bundle_quantity: number | null;
  }
  const productById = new Map<string, ProductInfo>();
  for (const p of products || []) {
    productById.set(p.id, { id: p.id, name: p.quickbooks_name, sku: p.sku, image_url: p.image_url, item_type: p.item_type, product_category: p.product_category, bundle_id: p.bundle_id, bundle_quantity: p.bundle_quantity });
  }

  // Build BOM indexes from product_bom table (multi-parent support)
  // parentToComponents: parent_id → [{component_id, quantity}]
  // componentToParents: component_id → [{parent_id, quantity}]
  const parentToComponents = new Map<string, Array<{ component_id: string; quantity: number }>>();
  const componentToParents = new Map<string, Array<{ parent_id: string; quantity: number }>>();
  const componentIds = new Set<string>();

  for (const row of bomRows || []) {
    const pList = parentToComponents.get(row.parent_id) || [];
    pList.push({ component_id: row.component_id, quantity: Number(row.quantity) });
    parentToComponents.set(row.parent_id, pList);

    const cList = componentToParents.get(row.component_id) || [];
    cList.push({ parent_id: row.parent_id, quantity: Number(row.quantity) });
    componentToParents.set(row.component_id, cList);

    componentIds.add(row.component_id);
  }

  const mappingsByProduct = new Map<string, Array<{ external_id: string; source: string; multiplier: number }>>();
  for (const m of mappings || []) {
    const list = mappingsByProduct.get(m.product_id) || [];
    list.push({ external_id: m.external_id, source: m.source, multiplier: m.unit_multiplier || 1 });
    mappingsByProduct.set(m.product_id, list);
  }

  function getChannelInventory(productId: string) {
    const pm = mappingsByProduct.get(productId) || [];
    let fba = 0, fbaTransit = 0, tpl = 0;
    for (const m of pm) {
      // Floor each physical-channel value at 0: a negative snapshot quantity (oversold or a
      // glitched sync) is not real inventory and must not subtract from sibling stock. Manual
      // adjustments ARE intentional (e.g. misprint write-downs) and may legitimately be
      // negative — they are kept as-is and combined into the total below.
      if (m.source === "amazon") {
        const snap = fbaByAsin.get(m.external_id);
        fba += Math.max(0, snap?.fulfillable || 0) * m.multiplier;
        fbaTransit += Math.max(0, snap?.transit || 0) * m.multiplier;
      } else if (m.source === "3pl") {
        tpl += Math.max(0, tplBySku.get(m.external_id) || 0) * m.multiplier;
      }
    }
    const manualList = manualByProduct.get(productId) || [];
    const manual = manualList.reduce((s, m) => s + m.quantity, 0);
    return { fba, fba_transit: fbaTransit, tpl, manual, total: fba + fbaTransit + tpl + manual };
  }

  function getSalesBurn(productId: string) {
    const pm = mappingsByProduct.get(productId) || [];
    let amzSold = 0, shopSold = 0;
    for (const m of pm) {
      if (m.source === "amazon") { amzSold += (amzSalesByAsin.get(m.external_id) || 0) * m.multiplier; }
      else if (m.source === "shopify") { shopSold += (shopSalesByVariant.get(m.external_id) || 0) * m.multiplier; }
    }
    // Internal units are keyed by product_id with the multiplier already applied at sync time.
    const intSold = internalSalesByProduct.get(productId) || 0;
    return { amazon_sold: amzSold, shopify_sold: shopSold, internal_sold: intSold, total_sold: amzSold + shopSold + intSold };
  }

  // Pre-compute total component burn across ALL parent Groups
  // For each component, sum (parent_sales × bom_qty) across all parents
  const componentTotalBurn = new Map<string, { amazon_sold: number; shopify_sold: number; internal_sold: number; total_sold: number }>();
  for (const [compId, parents] of Array.from(componentToParents)) {
    let totalAmz = 0, totalShop = 0, totalInt = 0;
    for (const { parent_id, quantity } of parents) {
      const parentBurn = getSalesBurn(parent_id);
      totalAmz += parentBurn.amazon_sold * quantity;
      totalShop += parentBurn.shopify_sold * quantity;
      totalInt += parentBurn.internal_sold * quantity;
    }
    componentTotalBurn.set(compId, { amazon_sold: totalAmz, shopify_sold: totalShop, internal_sold: totalInt, total_sold: totalAmz + totalShop + totalInt });
  }

  // Pre-compute total implied inventory for each component across ALL parents
  const componentTotalImplied = new Map<string, { fba: number; fba_transit: number; tpl: number; manual: number; total: number }>();
  for (const [compId, parents] of Array.from(componentToParents)) {
    let totalFba = 0, totalTransit = 0, totalTpl = 0, totalManual = 0;
    for (const { parent_id, quantity } of parents) {
      const parentInv = getChannelInventory(parent_id);
      totalFba += parentInv.fba * quantity;
      totalTransit += parentInv.fba_transit * quantity;
      totalTpl += parentInv.tpl * quantity;
      totalManual += parentInv.manual * quantity;
    }
    // Floor the implied total at 0 — a component's implied stock can never be negative.
    const total = Math.max(0, totalFba + totalTransit + totalTpl + totalManual);
    componentTotalImplied.set(compId, { fba: totalFba, fba_transit: totalTransit, tpl: totalTpl, manual: totalManual, total });
  }

  // Classify
  const bundles: ProductInfo[] = [];
  for (const p of Array.from(productById.values())) {
    if (p.item_type === "bundle") bundles.push(p);
  }

  const standaloneFinished: ProductInfo[] = [];
  const unattachedComponents: ProductInfo[] = [];
  for (const p of Array.from(productById.values())) {
    if (p.item_type === "bundle" || componentIds.has(p.id)) continue;
    if (p.product_category === "component") { unattachedComponents.push(p); }
    else { standaloneFinished.push(p); }
  }

  // Build output
  const finishedGoodsWithBOM = bundles.map((bundle) => {
    const inv = getChannelInventory(bundle.id);
    const burn = getSalesBurn(bundle.id);
    const components = parentToComponents.get(bundle.id) || [];

    // QB Start comes FROM the "-F" component (the rollup item) in the BOM
    // Only components with SKUs ending in "-F" represent the actual finished product
    // Other components (IFC boxes, etc.) should not drive the parent's QB starting count
    let qbStart = 0;
    if (components.length > 0) {
      const rollupComponents = components.filter(({ component_id }) => {
        const comp = productById.get(component_id);
        return comp?.sku?.endsWith("-F");
      });
      if (rollupComponents.length > 0) {
        const componentStarts = rollupComponents.map(({ component_id, quantity }) => {
          const compQb = qbInventory.get(component_id) || 0;
          return Math.floor(compQb / quantity);
        });
        qbStart = Math.min(...componentStarts);
      }
    }

    const expected = qbStart - burn.total_sold + getReceived(bundle.id);

    const bomItems = components.map(({ component_id, quantity: bomQty }) => {
      const comp = productById.get(component_id);
      if (!comp) return null;

      // QB Start: actual QB value for this component
      const compQbStart = qbInventory.get(comp.id) || 0;

      // Sales burn: use TOTAL burn across ALL parent Groups (not just this parent)
      const totalBurn = componentTotalBurn.get(comp.id) || { amazon_sold: 0, shopify_sold: 0, internal_sold: 0, total_sold: 0 };
      const compReceived = getReceived(comp.id);
      const compExpected = compQbStart - totalBurn.total_sold + compReceived;

      // Implied inventory from THIS parent only (for display)
      const impliedFba = inv.fba * bomQty;
      const impliedFbaTransit = inv.fba_transit * bomQty;
      const impliedTpl = inv.tpl * bomQty;
      const impliedManual = inv.manual * bomQty;
      const impliedTotal = inv.total * bomQty;

      // Total implied across ALL parents (for variance calculation)
      const totalImplied = componentTotalImplied.get(comp.id) || { fba: 0, fba_transit: 0, tpl: 0, manual: 0, total: 0 };

      const compInv = getChannelInventory(comp.id);
      // Combine implied-from-parents with this component's own stock (manual offsets included)
      // BEFORE flooring, so an intentional negative manual write-down still reduces the actual,
      // but the final actual can never read negative.
      const actualTotal = Math.max(0, totalImplied.total + compInv.total);
      const compVariance = actualTotal - compExpected;

      return {
        product_id: comp.id, name: comp.name, sku: comp.sku, image_url: comp.image_url,
        bom_quantity: bomQty,
        qb_starting: compQbStart,
        amazon_sold: totalBurn.amazon_sold,
        shopify_sold: totalBurn.shopify_sold,
        internal_sold: totalBurn.internal_sold,
        total_sold: totalBurn.total_sold,
        received: compReceived,
        expected_remaining: compExpected,
        implied_fba: impliedFba,
        implied_fba_transit: impliedFbaTransit,
        implied_tpl: impliedTpl,
        implied_manual: impliedManual,
        implied_total: impliedTotal,
        standalone_fba: compInv.fba,
        standalone_fba_transit: compInv.fba_transit,
        standalone_tpl: compInv.tpl,
        standalone_manual: compInv.manual,
        standalone_total: compInv.total,
        actual_total: actualTotal,
        variance: compVariance,
      };
    }).filter(Boolean);

    return {
      product_id: bundle.id, name: bundle.name, sku: bundle.sku, image_url: bundle.image_url,
      fba: inv.fba, fba_transit: inv.fba_transit, tpl: inv.tpl, manual: inv.manual, finished_good_units: Math.max(0, inv.total),
      qb_starting: qbStart, amazon_sold: burn.amazon_sold, shopify_sold: burn.shopify_sold,
      internal_sold: burn.internal_sold, received: getReceived(bundle.id),
      total_sold: burn.total_sold, expected_remaining: expected,
      variance: Math.max(0, inv.total) - expected,
      bom_items: bomItems,
    };
  });

  const standaloneItems = standaloneFinished.map((p) => {
    const inv = getChannelInventory(p.id);
    const burn = getSalesBurn(p.id);
    const qbStart = qbInventory.get(p.id) || 0;
    const received = getReceived(p.id);
    const expected = qbStart - burn.total_sold + received;
    return {
      product_id: p.id, name: p.name, sku: p.sku, image_url: p.image_url,
      fba: inv.fba, fba_transit: inv.fba_transit, tpl: inv.tpl, manual: inv.manual, total: Math.max(0, inv.total),
      qb_starting: qbStart, amazon_sold: burn.amazon_sold, shopify_sold: burn.shopify_sold,
      internal_sold: burn.internal_sold, received,
      total_sold: burn.total_sold, expected_remaining: expected,
      variance: Math.max(0, inv.total) - expected,
    };
  });

  const unattachedItems = unattachedComponents.map((p) => {
    const inv = getChannelInventory(p.id);
    return {
      product_id: p.id, name: p.name, sku: p.sku, image_url: p.image_url,
      fba: inv.fba, fba_transit: inv.fba_transit, tpl: inv.tpl, manual: inv.manual, total: Math.max(0, inv.total),
    };
  });

  const response = NextResponse.json({
    finished_goods_with_bom: finishedGoodsWithBOM.filter((fg) => fg.finished_good_units > 0 || fg.qb_starting > 0 || fg.bom_items.some((b) => b !== null && (b as { actual_total: number }).actual_total > 0)),
    standalone_finished_goods: standaloneItems.filter((i) => i.total > 0 || i.qb_starting > 0),
    unattached_components: unattachedItems.filter((i) => i.total > 0),
    meta: {
      mode: monthParam ? "monthly" : "live",
      month: monthParam,
      period_start: periodStart,
      period_end: periodEnd,
      qb_snapshot_date: qbSnapshotDate,
      qb_snapshot_basis: priorMonth ? `month_end_post snapshot for ${priorMonth}` : "latest",
      sales_since: salesSince,
      sales_until: salesUntil,
      fba_snapshot_date: fbaDateRow?.snapshot_date || null,
      tpl_snapshot_date: tplDateRow?.snapshot_date || null,
      manual_entries_count: manualEntries.length,
      manual_caveat: monthParam ? "manual_inventory has no historical snapshots — values shown are CURRENT" : null,
    },
  });
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  return response;
}
