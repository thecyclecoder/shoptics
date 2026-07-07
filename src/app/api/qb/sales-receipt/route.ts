import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getCredentials } from "@/lib/credentials";
import { getQBMappings } from "@/lib/qb-mappings";

export const dynamic = "force-dynamic";

const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

export async function POST(request: NextRequest) {
  try {
  const body = await request.json();
  const { channel, month, debug } = body as { channel: "amazon" | "shopify" | "internal"; month: string; debug?: boolean };

  if (!channel || !month || !["amazon", "shopify", "internal"].includes(channel)) {
    return NextResponse.json({ error: "channel (amazon|shopify|internal) and month (YYYY-MM) required" }, { status: 400 });
  }

  // Parse month to get date range and last day
  const [year, mon] = month.split("-").map(Number);
  const lastDay = new Date(year, mon, 0);
  // In debug mode, use today's date so QB applies entries immediately
  const txnDate = debug
    ? new Date().toISOString().split("T")[0]
    : lastDay.toISOString().split("T")[0];
  const startDate = `${month}-01`;
  const endDate = lastDay.toISOString().split("T")[0];

  const supabase = createServiceClient();

  // Get sales data for the month
  let salesByProduct: Map<string, { product_id: string; units: number }>;

  if (channel === "amazon") {
    const { data } = await supabase
      .from("amazon_sales_snapshots")
      .select("asin, units_shipped")
      .gte("sale_date", startDate)
      .lte("sale_date", endDate);

    // Get mappings to resolve ASINs to products (filter active in JS)
    const { data: allMappings } = await supabase
      .from("sku_mappings")
      .select("external_id, product_id, unit_multiplier, active")
      .eq("source", "amazon");

    const mappingLookup = new Map<string, { product_id: string; multiplier: number }>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const m of (allMappings || []).filter((m: any) => m.active)) {
      mappingLookup.set(m.external_id, { product_id: m.product_id, multiplier: m.unit_multiplier || 1 });
    }

    salesByProduct = new Map();
    for (const row of data || []) {
      const mapping = mappingLookup.get(row.asin);
      if (!mapping) continue;
      const key = mapping.product_id;
      if (!salesByProduct.has(key)) {
        salesByProduct.set(key, { product_id: key, units: 0 });
      }
      salesByProduct.get(key)!.units += row.units_shipped * mapping.multiplier;
    }
  } else if (channel === "shopify") {
    const { data } = await supabase
      .from("shopify_sales_snapshots")
      .select("variant_id, units_sold")
      .gte("sale_date", startDate)
      .lte("sale_date", endDate);

    const { data: allMappings2 } = await supabase
      .from("sku_mappings")
      .select("external_id, product_id, unit_multiplier, active")
      .eq("source", "shopify");

    const mappingLookup = new Map<string, { product_id: string; multiplier: number }>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const m of (allMappings2 || []).filter((m: any) => m.active)) {
      mappingLookup.set(m.external_id, { product_id: m.product_id, multiplier: m.unit_multiplier || 1 });
    }

    salesByProduct = new Map();
    for (const row of data || []) {
      const mapping = mappingLookup.get(row.variant_id);
      if (!mapping) continue;
      const key = mapping.product_id;
      if (!salesByProduct.has(key)) {
        salesByProduct.set(key, { product_id: key, units: 0 });
      }
      salesByProduct.get(key)!.units += row.units_sold * mapping.multiplier;
    }
  } else {
    // internal (shopcx) — units already resolved to product_id with multiplier applied at sync time
    const { data } = await supabase
      .from("internal_sales_snapshots")
      .select("product_id, units")
      .gte("sale_date", startDate)
      .lte("sale_date", endDate);

    salesByProduct = new Map();
    for (const row of data || []) {
      if (!row.product_id) continue;
      const key = row.product_id;
      if (!salesByProduct.has(key)) {
        salesByProduct.set(key, { product_id: key, units: 0 });
      }
      salesByProduct.get(key)!.units += row.units;
    }
  }

  if (salesByProduct.size === 0) {
    return NextResponse.json({ error: "No sales data found for " + month + " on " + channel }, { status: 400 });
  }

  // Get QB item IDs for each product (need quickbooks_id)
  const productIds = Array.from(salesByProduct.keys());
  const { data: products } = await supabase
    .from("products")
    .select("id, quickbooks_id, quickbooks_name, item_type")
    .in("id", productIds);

  // Build Sales Receipt line items
  // Bundle/Group items use GroupLineDetail, regular items use SalesItemLineDetail
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines: any[] = [];

  for (const product of products || []) {
    const sales = salesByProduct.get(product.id);
    if (!sales || sales.units <= 0) continue;

    if (product.item_type === "bundle") {
      // Group items require GroupLineDetail
      lines.push({
        DetailType: "GroupLineDetail",
        GroupLineDetail: {
          GroupItemRef: { value: product.quickbooks_id },
          Quantity: sales.units,
        },
      });
    } else {
      // Regular inventory items use SalesItemLineDetail
      lines.push({
        DetailType: "SalesItemLineDetail",
        Amount: 0,
        SalesItemLineDetail: {
          ItemRef: { value: product.quickbooks_id },
          Qty: sales.units,
          UnitPrice: 0,
        },
      });
    }
  }

  if (lines.length === 0) {
    return NextResponse.json({ error: "No line items to create" }, { status: 400 });
  }

  // Get QB access token (direct REST to avoid caching)
  const qbCreds = await getCredentials("quickbooks");
  const qbTokensRes = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/qb_tokens?id=eq.current&select=refresh_token,realm_id`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
      },
      cache: "no-store",
    }
  );
  const qbTokensArr = await qbTokensRes.json();
  const qbTokens = qbTokensArr?.[0];

  if (!qbTokens) {
    return NextResponse.json({ error: "QuickBooks not connected" }, { status: 400 });
  }

  const basicAuth = Buffer.from(`${qbCreds.client_id}:${qbCreds.client_secret}`).toString("base64");
  const tokenRes = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basicAuth}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: qbTokens.refresh_token }),
  });

  if (!tokenRes.ok) {
    return NextResponse.json({ error: "QB token refresh failed" }, { status: 500 });
  }

  const tokenData = await tokenRes.json();

  // Store rotated token
  await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/qb_tokens?id=eq.current`,
    {
      method: "PATCH",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: tokenData.refresh_token, updated_at: new Date().toISOString() }),
    }
  );

  // Get configurable QB mappings (keys follow the {channel}_customer / {channel}_deposit_account convention)
  const customerKey = `${channel}_customer`;
  const depositKey = `${channel}_deposit_account`;
  const qbMappings = await getQBMappings([customerKey, depositKey]);

  // Create Sales Receipt
  const channelCode = channel === "amazon" ? "AMZ" : channel === "shopify" ? "SHOP" : "INT";
  const [yr, mo] = month.split("-");
  const docNumber = `${channelCode}-${mo}-${yr}`;
  const memo = channel === "amazon" ? "Amazon COGS - " : channel === "shopify" ? "Shopify COGS - " : "Internal COGS - ";

  const receiptBody = {
    DocNumber: docNumber,
    TxnDate: txnDate,
    CustomerRef: { value: qbMappings[customerKey].qb_id },
    DepositToAccountRef: { value: qbMappings[depositKey].qb_id },
    PrivateNote: memo + month,
    Line: lines,
  };

  const createRes = await fetch(
    `https://quickbooks.api.intuit.com/v3/company/${qbTokens.realm_id}/salesreceipt?minorversion=65`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(receiptBody),
    }
  );

  if (!createRes.ok) {
    const errText = await createRes.text();
    return NextResponse.json({ error: "Failed to create Sales Receipt", details: errText }, { status: 500 });
  }

  const result = await createRes.json();
  const receipt = result.SalesReceipt;

  return NextResponse.json({
    success: true,
    receipt_id: receipt.Id,
    doc_number: receipt.DocNumber,
    txn_date: receipt.TxnDate,
    line_count: lines.length,
    total_units: lines.reduce((s: number, l: { GroupLineDetail?: { Quantity: number }; SalesItemLineDetail?: { Qty: number } }) => s + (l.GroupLineDetail?.Quantity || l.SalesItemLineDetail?.Qty || 0), 0),
    channel,
    month,
  });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Unhandled error: " + message }, { status: 500 });
  }
}
