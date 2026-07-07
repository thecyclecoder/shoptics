import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getCredentials } from "@/lib/credentials";
import { getQBMappings } from "@/lib/qb-mappings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface JELine {
  postingType: "Debit" | "Credit";
  accountId: string;
  accountName: string;
  amount: number;
  description: string;
}

// GET: preview the journal entry without creating it
// POST: create or update the journal entry in QuickBooks
export async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get("month");
  if (!month) return NextResponse.json({ error: "month required" }, { status: 400 });

  try {
    const data = await buildJournalEntryData(month);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { month, overrides, debug } = body as {
      month: string;
      overrides?: { braintree_fees?: number };
      debug?: boolean;
    };
    if (!month) return NextResponse.json({ error: "month required" }, { status: 400 });

    const data = await buildJournalEntryData(month, overrides);

    // Persist Braintree fee override so GET preview stays consistent
    if (overrides?.braintree_fees !== undefined) {
      const supabaseWrite = createServiceClient();
      await supabaseWrite.from("payment_processor_summaries")
        .update({ processing_fees: overrides.braintree_fees })
        .eq("closing_month", month)
        .eq("processor", "braintree");
    }

    // Validate balance
    const totalDebits = data.lines.filter((l: JELine) => l.postingType === "Debit").reduce((s: number, l: JELine) => s + l.amount, 0);
    const totalCredits = data.lines.filter((l: JELine) => l.postingType === "Credit").reduce((s: number, l: JELine) => s + l.amount, 0);
    const diff = Math.abs(totalDebits - totalCredits);
    if (diff > 0.01) {
      return NextResponse.json({
        error: `Journal entry does not balance. Debits: $${totalDebits.toFixed(2)}, Credits: $${totalCredits.toFixed(2)}, Diff: $${diff.toFixed(2)}`,
        data,
      }, { status: 400 });
    }

    // Build QB Journal Entry payload
    const [yr, mo] = month.split("-");
    // In debug mode, use today's date so QB applies it immediately
    const txnDate = debug
      ? new Date().toISOString().split("T")[0]
      : new Date(Number(yr), Number(mo), 0).toISOString().split("T")[0];
    const docNumber = `SHOPIFY-${mo}${yr.substring(2)}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qbLines: any[] = data.lines.map((line: JELine) => ({
      Amount: Math.round(line.amount * 100) / 100,
      DetailType: "JournalEntryLineDetail",
      Description: line.description,
      JournalEntryLineDetail: {
        PostingType: line.postingType,
        AccountRef: { value: line.accountId, name: line.accountName },
      },
    }));

    // Get QB token
    const qbCreds = await getCredentials("quickbooks");
    const qbTokensRes = await fetch(
      `${SUPABASE_URL}/rest/v1/qb_tokens?id=eq.current&select=refresh_token,realm_id`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }, cache: "no-store" }
    );
    const qbTokens = (await qbTokensRes.json())?.[0];
    if (!qbTokens) return NextResponse.json({ error: "QB not connected" }, { status: 400 });

    const basicAuth = Buffer.from(`${qbCreds.client_id}:${qbCreds.client_secret}`).toString("base64");
    const tokenRes = await fetch(QB_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basicAuth}` },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: qbTokens.refresh_token }),
    });
    const td = await tokenRes.json();
    if (!td.access_token) return NextResponse.json({ error: "QB token refresh failed" }, { status: 500 });

    await fetch(`${SUPABASE_URL}/rest/v1/qb_tokens?id=eq.current`, {
      method: "PATCH",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: td.refresh_token, updated_at: new Date().toISOString() }),
    });

    // Check if JE already exists for this month (update instead of create)
    const supabase = createServiceClient();
    const { data: existingClosings } = await supabase
      .from("month_end_closings")
      .select("shopify_journal_entry_id")
      .eq("closing_month", month);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingJeId = (existingClosings || []).find((c: any) => c.shopify_journal_entry_id)?.shopify_journal_entry_id;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jePayload: any = {
      DocNumber: docNumber,
      TxnDate: txnDate,
      PrivateNote: `Shopify Monthly Journal Entry - ${month}`,
      Line: qbLines,
    };

    let qbUrl: string;
    if (existingJeId) {
      // Fetch current SyncToken to update
      const fetchRes = await fetch(
        `https://quickbooks.api.intuit.com/v3/company/${qbTokens.realm_id}/journalentry/${existingJeId}?minorversion=65`,
        { headers: { Authorization: `Bearer ${td.access_token}`, Accept: "application/json" } }
      );
      const existing = await fetchRes.json();
      jePayload.Id = existingJeId;
      jePayload.SyncToken = existing.JournalEntry?.SyncToken || "0";
      qbUrl = `https://quickbooks.api.intuit.com/v3/company/${qbTokens.realm_id}/journalentry?minorversion=65`;
    } else {
      qbUrl = `https://quickbooks.api.intuit.com/v3/company/${qbTokens.realm_id}/journalentry?minorversion=65`;
    }

    const createRes = await fetch(qbUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${td.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(jePayload),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      return NextResponse.json({ error: "QB Journal Entry failed", details: errText.substring(0, 500) }, { status: 500 });
    }

    const result = await createRes.json();
    const je = result.JournalEntry;

    return NextResponse.json({
      success: true,
      journal_entry_id: je.Id,
      doc_number: je.DocNumber,
      txn_date: je.TxnDate,
      total_debits: totalDebits,
      total_credits: totalCredits,
      line_count: qbLines.length,
      updated: !!existingJeId,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

async function buildJournalEntryData(month: string, overrides?: { braintree_fees?: number }) {
  const supabase = createServiceClient();

  // 0. Data completeness checks
  const warnings: string[] = [];

  // 1. Get processor summaries
  const { data: processorData } = await supabase
    .from("payment_processor_summaries")
    .select("*")
    .eq("closing_month", month);

  // Check all processors have data
  const processorNames = (processorData || []).map((p) => p.processor);
  if (!processorNames.includes("shopify_payments")) warnings.push("Missing Shopify Payments data — run processor sync first");
  if (!processorNames.includes("paypal")) warnings.push("Missing PayPal data — run processor sync first");
  if (!processorNames.includes("braintree")) warnings.push("Missing Braintree data — run processor sync first");

  const processors: Record<string, { gross: number; fees: number; refunds: number; chargebacks: number; adjustments: number }> = {};
  for (const p of processorData || []) {
    processors[p.processor] = {
      gross: Number(p.gross_sales),
      fees: Number(p.processing_fees),
      refunds: Number(p.refunds),
      chargebacks: Number(p.chargebacks),
      adjustments: Number(p.adjustments),
    };
  }

  // Apply overrides
  if (overrides?.braintree_fees !== undefined && processors.braintree) {
    processors.braintree.fees = overrides.braintree_fees;
  }

  // 2. Get Shopify revenue by product (from orders, NOT amazon)
  const shopTokens = await fetch(`${SUPABASE_URL}/rest/v1/shopify_tokens?select=shop_domain,access_token&limit=1`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    cache: "no-store",
  });
  const shopToken = (await shopTokens.json())?.[0];
  if (!shopToken) throw new Error("Shopify not connected");

  // Get gateway mappings
  const { data: gatewayMaps } = await supabase.from("gateway_mappings").select("gateway_name, processor");
  const gatewayLookup = new Map<string, string>();
  for (const g of gatewayMaps || []) gatewayLookup.set(g.gateway_name, g.processor);

  // Get SKU mappings (shopify variant → product)
  const { data: allMappings } = await supabase
    .from("sku_mappings")
    .select("external_id, product_id, unit_multiplier, active")
    .eq("source", "shopify");
  const mappingLookup = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of (allMappings || []).filter((m: any) => m.active)) {
    mappingLookup.set(m.external_id, m.product_id);
  }

  // Get product revenue account mappings
  const { data: products } = await supabase
    .from("products")
    .select("id, quickbooks_name, revenue_account_id, revenue_account_name");
  const productLookup = new Map<string, { name: string; rev_acct_id: string | null; rev_acct_name: string | null }>();
  for (const p of products || []) {
    productLookup.set(p.id, { name: p.quickbooks_name, rev_acct_id: p.revenue_account_id, rev_acct_name: p.revenue_account_name });
  }

  // Get shipping protection product IDs
  const { data: shippingProtectionRows } = await supabase
    .from("shipping_protection_products")
    .select("shopify_product_id");
  const shippingProtectionIds = new Set((shippingProtectionRows || []).map((r) => r.shopify_product_id));

  // Fetch all Shopify orders for the month (paginated)
  const [year, mon] = month.split("-").map(Number);
  const lastDay = new Date(year, mon, 0).getDate();
  const startDate = `${month}-01T00:00:00Z`;
  const endDate = `${month}-${String(lastDay).padStart(2, "0")}T23:59:59Z`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let allOrders: any[] = [];
  let orderUrl: string | null = `https://${shopToken.shop_domain}/admin/api/2024-01/orders.json?status=any&limit=250&created_at_min=${startDate}&created_at_max=${endDate}&fields=id,line_items,total_shipping_price_set,total_tax,total_discounts,subtotal_price,total_price,payment_gateway_names,financial_status`;

  while (orderUrl) {
    const res: Response = await fetch(orderUrl, {
      headers: { "X-Shopify-Access-Token": shopToken.access_token },
    });
    if (!res.ok) throw new Error(`Shopify Orders API error: ${res.status}`);
    const data = await res.json();
    // Only include paid/partially_refunded orders (not voided/refunded)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const validOrders = (data.orders || []).filter((o: any) =>
      o.financial_status === "paid" || o.financial_status === "partially_refunded" || o.financial_status === "refunded"
    );
    allOrders = allOrders.concat(validOrders);

    const lh: string = res.headers.get("link") || "";
    const nm: RegExpMatchArray | null = lh.match(/<([^>]+)>;\s*rel="next"/);
    orderUrl = nm ? nm[1] : null;
  }

  // Data completeness checks on orders
  if (allOrders.length === 0) warnings.push("No Shopify orders found for this month");

  // Basic order count sanity check
  const [checkYear, checkMon] = month.split("-").map(Number);
  const checkLastDay = new Date(checkYear, checkMon, 0).getDate();
  const expectedMinOrders = checkLastDay * 2; // expect at least 2 orders/day
  if (allOrders.length > 0 && allOrders.length < expectedMinOrders) {
    warnings.push(`Only ${allOrders.length} orders for ${checkLastDay} days — verify data completeness`);
  }

  // Aggregate revenue by revenue account AND gross by processor (from order gateway)
  const revenueByAccount = new Map<string, { id: string; name: string; amount: number }>();
  const grossByProcessor = new Map<string, number>(); // from order total_price grouped by gateway
  let totalShipping = 0;
  let totalTax = 0;
  let totalDiscounts = 0;
  let unmappedRevenue = 0;

  for (const order of allOrders) {
    totalShipping += Number(order.total_shipping_price_set?.shop_money?.amount || 0);
    totalTax += Number(order.total_tax || 0);
    totalDiscounts += Number(order.total_discounts || 0);

    // Track gross by processor (from payment gateway on order)
    // For split-payment orders, divide total equally among gateways (rare case)
    const gateways = (order.payment_gateway_names || []) as string[];
    const orderTotal = Number(order.total_price || 0);
    const perGateway = gateways.length > 0 ? orderTotal / gateways.length : 0;
    for (const gw of gateways) {
      const processor = gatewayLookup.get(gw) || "other";
      grossByProcessor.set(processor, (grossByProcessor.get(processor) || 0) + perGateway);
    }

    // Revenue per line item
    for (const item of order.line_items || []) {
      const lineRevenue = Number(item.price || 0) * (item.quantity || 1);

      // Check if this is a shipping protection product → route to shipping income
      if (shippingProtectionIds.has(String(item.product_id))) {
        totalShipping += lineRevenue;
        continue;
      }

      const variantKey = `${item.product_id}-${item.variant_id}`;
      const productId = mappingLookup.get(variantKey);
      const product = productId ? productLookup.get(productId) : null;

      if (product?.rev_acct_id && product?.rev_acct_name) {
        const existing = revenueByAccount.get(product.rev_acct_id) || { id: product.rev_acct_id, name: product.rev_acct_name, amount: 0 };
        existing.amount += lineRevenue;
        revenueByAccount.set(product.rev_acct_id, existing);
      } else {
        unmappedRevenue += lineRevenue;
      }
    }
  }

  // === INTERNAL (shopcx) ORDERS ===
  // Native storefront/subscription/comp orders — not in Shopify, so aggregate them separately and
  // emit a dedicated, self-balancing block below. Self-balancing because per order,
  // order_total = subtotal − discount + tax + shipping, so (revenue+shipping+tax credits) ==
  // (discount + gross-to-clearing debits). Fees/refunds/chargebacks are NOT added — they already
  // live in the Braintree processor summary (same merchant account). Amounts are stored in cents.
  const internalRevenueByAccount = new Map<string, { id: string; name: string; amount: number }>();
  let internalUnmappedRevenue = 0;
  let internalShipping = 0, internalTax = 0, internalDiscount = 0, internalGross = 0;
  let internalOrderCount = 0;
  {
    const { data: internalRows } = await supabase
      .from("internal_sales_snapshots")
      .select("product_id, gross_cents, order_total_cents, tax_cents, discount_cents, shipping_cents, line_index")
      .gte("sale_date", `${month}-01`)
      .lte("sale_date", `${month}-${String(lastDay).padStart(2, "0")}`);
    for (const r of internalRows || []) {
      const gross = Number(r.gross_cents || 0) / 100;
      if (gross > 0) {
        const product = r.product_id ? productLookup.get(r.product_id) : null;
        if (product?.rev_acct_id && product?.rev_acct_name) {
          const ex = internalRevenueByAccount.get(product.rev_acct_id) || { id: product.rev_acct_id, name: product.rev_acct_name, amount: 0 };
          ex.amount += gross;
          internalRevenueByAccount.set(product.rev_acct_id, ex);
        } else {
          internalUnmappedRevenue += gross;
        }
      }
      // order-level fields live only on line_index 0 (0 elsewhere)
      if (r.line_index === 0) {
        internalOrderCount++;
        internalTax += Number(r.tax_cents || 0) / 100;
        internalDiscount += Number(r.discount_cents || 0) / 100;
        internalShipping += Number(r.shipping_cents || 0) / 100;
        internalGross += Number(r.order_total_cents || 0) / 100;
      }
    }
    if (internalUnmappedRevenue > 0) warnings.push(`$${round2(internalUnmappedRevenue).toFixed(2)} internal revenue had no product revenue account`);
  }

  // 3. Get QB account mappings
  const mappingKeys = [
    "discounts_account", "sales_tax_payable", "shipping_income",
    "chargebacks_account", "refunds_account",
    "shopify_clearing", "shopify_txn_fees",
    "paypal_clearing", "paypal_txn_fees",
    "braintree_clearing", "braintree_txn_fees",
    "walmart_clearing", "gift_card_liability", "shopify_other_adjustments",
    "internal_deposit_account",
  ];
  const qbMappings = await getQBMappings(mappingKeys);

  // 4. Build journal entry lines
  const lines: JELine[] = [];

  // === CREDIT SIDE (Revenue) ===
  // Product revenue by account
  for (const [, acct] of Array.from(revenueByAccount)) {
    if (acct.amount > 0) {
      lines.push({
        postingType: "Credit",
        accountId: acct.id,
        accountName: acct.name,
        amount: round2(acct.amount),
        description: `${acct.name} - ${month}`,
      });
    }
  }

  // Shipping income
  if (totalShipping > 0) {
    lines.push({
      postingType: "Credit",
      accountId: qbMappings.shipping_income.qb_id,
      accountName: qbMappings.shipping_income.qb_name,
      amount: round2(totalShipping),
      description: `Shipping Income - ${month}`,
    });
  }

  // Sales tax
  if (totalTax > 0) {
    lines.push({
      postingType: "Credit",
      accountId: qbMappings.sales_tax_payable.qb_id,
      accountName: qbMappings.sales_tax_payable.qb_name,
      amount: round2(totalTax),
      description: `Sales Tax Collected - ${month}`,
    });
  }

  // === DEBIT SIDE (Contra-revenue) ===
  // Discounts
  if (totalDiscounts > 0) {
    lines.push({
      postingType: "Debit",
      accountId: qbMappings.discounts_account.qb_id,
      accountName: qbMappings.discounts_account.qb_name,
      amount: round2(totalDiscounts),
      description: `Discounts & Coupons - ${month}`,
    });
  }

  // === PROCESSOR LINES ===
  // Gross clearing debits come from ORDER data (accrual basis, grouped by gateway).
  // Fees, refunds, chargebacks come from PROCESSOR APIs (payout/transaction data).
  const processorConfigs = [
    { key: "shopify_payments", clearingKey: "shopify_clearing", feeKey: "shopify_txn_fees", label: "Shopify Payments" },
    { key: "paypal", clearingKey: "paypal_clearing", feeKey: "paypal_txn_fees", label: "PayPal" },
    { key: "braintree", clearingKey: "braintree_clearing", feeKey: "braintree_txn_fees", label: "Braintree" },
  ];

  for (const config of processorConfigs) {
    const proc = processors[config.key] || { gross: 0, fees: 0, refunds: 0, chargebacks: 0, adjustments: 0 };
    const orderGross = round2(grossByProcessor.get(config.key) || 0);

    const clearingMapping = qbMappings[config.clearingKey];
    const feeMapping = qbMappings[config.feeKey];

    // Gross from orders → DEBIT clearing (accrual basis)
    if (orderGross > 0) {
      lines.push({
        postingType: "Debit",
        accountId: clearingMapping.qb_id,
        accountName: clearingMapping.qb_name,
        amount: orderGross,
        description: `${config.label} deposits - ${month}`,
      });
    }

    // Processing fees → DEBIT expense
    if (proc.fees > 0) {
      lines.push({
        postingType: "Debit",
        accountId: feeMapping.qb_id,
        accountName: feeMapping.qb_name,
        amount: round2(proc.fees),
        description: `${config.label} transaction fees - ${month}`,
      });
    }

    // Refunds → DEBIT contra-revenue
    if (proc.refunds > 0) {
      lines.push({
        postingType: "Debit",
        accountId: qbMappings.refunds_account.qb_id,
        accountName: qbMappings.refunds_account.qb_name,
        amount: round2(proc.refunds),
        description: `Refunds - ${config.label} - ${month}`,
      });
    }

    // Chargebacks → DEBIT contra-revenue
    if (proc.chargebacks > 0) {
      lines.push({
        postingType: "Debit",
        accountId: qbMappings.chargebacks_account.qb_id,
        accountName: qbMappings.chargebacks_account.qb_name,
        amount: round2(proc.chargebacks),
        description: `Chargebacks - ${config.label} - ${month}`,
      });
    }

    // Net deductions (fees + refunds + chargebacks) → CREDIT clearing
    const deductions = round2(proc.fees + proc.refunds + proc.chargebacks);
    if (deductions > 0) {
      lines.push({
        postingType: "Credit",
        accountId: clearingMapping.qb_id,
        accountName: clearingMapping.qb_name,
        amount: deductions,
        description: `${config.label} deductions - ${month}`,
      });
    }
  }

  // Other processors from orders (walmart, gift_card, other)
  const otherProcessors: Array<{ key: string; clearingKey: string; label: string }> = [
    { key: "walmart", clearingKey: "walmart_clearing", label: "Walmart" },
  ];
  for (const config of otherProcessors) {
    const orderGross = round2(grossByProcessor.get(config.key) || 0);
    if (orderGross > 0) {
      const clearingMapping = qbMappings[config.clearingKey];
      if (clearingMapping) {
        lines.push({
          postingType: "Debit",
          accountId: clearingMapping.qb_id,
          accountName: clearingMapping.qb_name,
          amount: orderGross,
          description: `${config.label} deposits - ${month}`,
        });
      }
    }
  }

  // Gift card payments → debit gift card liability (reduces the liability)
  const giftCardGross = round2(grossByProcessor.get("gift_card") || 0);
  if (giftCardGross > 0 && qbMappings.gift_card_liability) {
    lines.push({
      postingType: "Debit",
      accountId: qbMappings.gift_card_liability.qb_id,
      accountName: qbMappings.gift_card_liability.qb_name,
      amount: giftCardGross,
      description: `Gift card redemptions - ${month}`,
    });
  }

  // "Other" gateway payments (unmapped gateways) → debit other adjustments
  const otherGross = round2(grossByProcessor.get("other") || 0);
  if (otherGross > 0 && qbMappings.shopify_other_adjustments) {
    lines.push({
      postingType: "Debit",
      accountId: qbMappings.shopify_other_adjustments.qb_id,
      accountName: qbMappings.shopify_other_adjustments.qb_name,
      amount: otherGross,
      description: `Other payment methods - ${month}`,
    });
  }

  // === INTERNAL (shopcx) LINES — dedicated, self-balancing block ===
  for (const [, acct] of Array.from(internalRevenueByAccount)) {
    if (acct.amount > 0) {
      lines.push({ postingType: "Credit", accountId: acct.id, accountName: acct.name, amount: round2(acct.amount), description: `${acct.name} - Internal - ${month}` });
    }
  }
  if (internalShipping > 0) {
    lines.push({ postingType: "Credit", accountId: qbMappings.shipping_income.qb_id, accountName: qbMappings.shipping_income.qb_name, amount: round2(internalShipping), description: `Shipping Income - Internal - ${month}` });
  }
  if (internalTax > 0) {
    lines.push({ postingType: "Credit", accountId: qbMappings.sales_tax_payable.qb_id, accountName: qbMappings.sales_tax_payable.qb_name, amount: round2(internalTax), description: `Sales Tax Collected - Internal - ${month}` });
  }
  if (internalDiscount > 0) {
    lines.push({ postingType: "Debit", accountId: qbMappings.discounts_account.qb_id, accountName: qbMappings.discounts_account.qb_name, amount: round2(internalDiscount), description: `Discounts & Coupons - Internal - ${month}` });
  }
  // Internal gross (customer charges) → DEBIT the configured internal deposit account (Braintree clearing).
  if (round2(internalGross) > 0 && qbMappings.internal_deposit_account) {
    lines.push({ postingType: "Debit", accountId: qbMappings.internal_deposit_account.qb_id, accountName: qbMappings.internal_deposit_account.qb_name, amount: round2(internalGross), description: `Internal deposits - ${month}` });
  } else if (round2(internalGross) > 0) {
    warnings.push("Internal orders present but no internal_deposit_account mapping — JE will not balance");
  }

  // Calculate totals
  const totalDebits = lines.filter((l) => l.postingType === "Debit").reduce((s, l) => s + l.amount, 0);
  const totalCredits = lines.filter((l) => l.postingType === "Credit").reduce((s, l) => s + l.amount, 0);

  // If there's a rounding difference, add an adjustment line
  const balanceDiff = round2(totalDebits - totalCredits);
  if (balanceDiff !== 0 && Math.abs(balanceDiff) <= 1) {
    if (balanceDiff > 0) {
      // Debits > Credits — need more credit
      const adjustAcct = qbMappings.shopify_other_adjustments;
      lines.push({
        postingType: "Credit",
        accountId: adjustAcct.qb_id,
        accountName: adjustAcct.qb_name,
        amount: Math.abs(balanceDiff),
        description: `Rounding adjustment - ${month}`,
      });
    } else {
      // Credits > Debits — need more debit
      const adjustAcct = qbMappings.shopify_other_adjustments;
      lines.push({
        postingType: "Debit",
        accountId: adjustAcct.qb_id,
        accountName: adjustAcct.qb_name,
        amount: Math.abs(balanceDiff),
        description: `Rounding adjustment - ${month}`,
      });
    }
  }

  // Add warnings for data issues
  if (unmappedRevenue > 0) {
    warnings.push(`$${unmappedRevenue.toFixed(2)} in revenue from unmapped Shopify products — map them in Revenue Mapping`);
  }

  // Check revenue accounts are mapped
  const productsWithoutRevAcct = (products || []).filter((p) => {
    const mapped = mappingLookup.has(`${p.id}`); // at least appears in mappings
    return !p.revenue_account_id && mapped;
  });
  if (productsWithoutRevAcct.length > 0) {
    warnings.push(`${productsWithoutRevAcct.length} products missing revenue account mapping`);
  }

  // Check QB account mappings exist
  const requiredMappings = ["shipping_income", "sales_tax_payable", "discounts_account", "refunds_account", "chargebacks_account"];
  for (const key of requiredMappings) {
    if (!qbMappings[key]?.qb_id) warnings.push(`Missing QB account mapping: ${key}`);
  }

  return {
    month,
    lines,
    warnings,
    summary: {
      revenue_accounts: Array.from(revenueByAccount.values()),
      unmapped_revenue: unmappedRevenue,
      shipping: totalShipping,
      tax: totalTax,
      discounts: totalDiscounts,
      processors,
      gross_by_processor: Object.fromEntries(Array.from(grossByProcessor)),
      order_count: allOrders.length,
      internal: {
        order_count: internalOrderCount,
        revenue_accounts: Array.from(internalRevenueByAccount.values()),
        unmapped_revenue: round2(internalUnmappedRevenue),
        shipping: round2(internalShipping),
        tax: round2(internalTax),
        discounts: round2(internalDiscount),
        gross_to_clearing: round2(internalGross),
      },
      total_debits: round2(lines.filter((l) => l.postingType === "Debit").reduce((s, l) => s + l.amount, 0)),
      total_credits: round2(lines.filter((l) => l.postingType === "Credit").reduce((s, l) => s + l.amount, 0)),
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
