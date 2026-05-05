import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getCredentials } from "@/lib/credentials";
import { getQBMapping } from "@/lib/qb-mappings";

export const dynamic = "force-dynamic";

const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface StepResult {
  step: number;
  name: string;
  status: "success" | "error" | "skipped";
  message: string;
  details?: unknown;
}

async function getQBToken() {
  const qbCreds = await getCredentials("quickbooks");
  const tokensRes = await fetch(`${SUPABASE_URL}/rest/v1/qb_tokens?id=eq.current&select=refresh_token,realm_id`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    cache: "no-store",
  });
  const tokens = await tokensRes.json();
  if (!tokens?.[0]) throw new Error("QB not connected");

  const basicAuth = Buffer.from(`${qbCreds.client_id}:${qbCreds.client_secret}`).toString("base64");
  const tokenRes = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basicAuth}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens[0].refresh_token }),
  });
  const td = await tokenRes.json();
  if (!td.access_token) throw new Error("QB token refresh failed");

  await fetch(`${SUPABASE_URL}/rest/v1/qb_tokens?id=eq.current`, {
    method: "PATCH",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: td.refresh_token, updated_at: new Date().toISOString() }),
  });

  return { token: td.access_token, realmId: tokens[0].realm_id };
}

async function qbQuery(token: string, realmId: string, query: string) {
  const res = await fetch(
    `https://quickbooks.api.intuit.com/v3/company/${realmId}/query?query=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
  );
  return res.json();
}

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const debug = searchParams.get("debug") === "true";
  const body = await request.json();
  const { month } = body as { month: string };

  if (!month) {
    return NextResponse.json({ error: "month (YYYY-MM) required" }, { status: 400 });
  }

  // Forward both cookie (for UI sessions) and authorization (for CRON_SECRET) to
  // internal API calls so they pass middleware auth in either invocation mode.
  const forwardAuth: Record<string, string> = {};
  const cookie = request.headers.get("cookie");
  const authz = request.headers.get("authorization");
  if (cookie) forwardAuth.cookie = cookie;
  if (authz) forwardAuth.authorization = authz;

  // Check if after 1st of next month (or debug mode)
  const [year, mon] = month.split("-").map(Number);
  const nextMonth = new Date(year, mon, 1); // 1st of month AFTER closing month
  if (!debug && new Date() < nextMonth) {
    return NextResponse.json({ error: "Month-end closing can only run after the 1st of the following month" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const steps: StepResult[] = [];

  // Check if already run
  const { data: existingAll } = await supabase.from("month_end_closings").select("*");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = (existingAll || []).find((r: any) => r.closing_month === month);
  if (existing && existing.status === "completed") {
    return NextResponse.json({
      error: "Month-end closing already completed for " + month,
      closing: existing,
    }, { status: 400 });
  }

  // Create or update closing record
  let closingId: string;
  if (existing) {
    closingId = existing.id;
    await supabase.from("month_end_closings").update({ status: "running", error_message: null, started_at: new Date().toISOString() }).eq("id", closingId);
  } else {
    const { data: newClosing } = await supabase.from("month_end_closings").insert({ closing_month: month, status: "running" }).select("id").single();
    closingId = newClosing!.id;
  }

  try {
    const { token, realmId } = await getQBToken();
    // In debug mode, use today's date so QB applies entries immediately
    const txnDate = debug
      ? new Date().toISOString().split("T")[0]
      : new Date(year, mon, 0).toISOString().split("T")[0];

    // ============ STEP 1: Snapshot QB Inventory ============
    const step1Start = Date.now();
    try {
      const qbItemsData = await qbQuery(token, realmId, "SELECT * FROM Item WHERE Type = 'Inventory' MAXRESULTS 1000");
      const qbItems = qbItemsData.QueryResponse?.Item || [];

      for (const item of qbItems) {
        const { data: product } = await supabase.from("products").select("id").eq("quickbooks_id", item.Id).single();
        if (product && item.QtyOnHand !== undefined) {
          await supabase.from("inventory_snapshots").insert({
            product_id: product.id,
            source: "quickbooks",
            quantity: Math.floor(item.QtyOnHand),
            raw_payload: { snapshot_type: "month_end_pre", month },
          });
        }
      }

      await supabase.from("month_end_closings").update({ pre_snapshot_at: new Date().toISOString() }).eq("id", closingId);
      steps.push({ step: 1, name: "QB Inventory Snapshot (Pre-Closing)", status: "success", message: `Snapshotted ${qbItems.length} items in ${Date.now() - step1Start}ms` });
    } catch (err) {
      steps.push({ step: 1, name: "QB Inventory Snapshot (Pre-Closing)", status: "error", message: err instanceof Error ? err.message : String(err) });
      throw err;
    }

    // ============ STEP 2: Inventory Adjustment ============

    try {
      // Get shrinkage account from configurable mappings
      const shrinkageMapping = await getQBMapping("shrinkage_account");
      const shrinkageAcctId = shrinkageMapping.qb_id;

      // Get inventory audit data scoped to the closing month so variances reflect
      // the period being closed — uses post-prior-month-close QB snapshot as start,
      // FBA/3PL snapshots dated end of the closing month, and sales filtered to that
      // month only. Without the month param, the audit would use CURRENT snapshots
      // and sales-since-last-close, which drifts as channel inventory changes (kitting,
      // FBA replenishment, May sales etc) between period end and the closing run date.
      const auditRes = await fetch(`${request.nextUrl.origin}/api/inventory-audit?month=${month}`, {
        headers: forwardAuth,
        cache: "no-store",
      });
      const auditData = await auditRes.json();

      // Build adjustment lines from BOM components and standalone FG.
      // The audit now computes component variance using total burn across ALL parent
      // Groups, so the variance is correct even for multi-parent components.
      // Deduplicate by product_id since the same component may appear under multiple parents.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adjLines: any[] = [];
      const adjustedComponents = new Set<string>();

      // BOM component variances (deduplicated)
      // Round QtyDiff to whole numbers — QB inventory only supports integers,
      // and fractional BOM quantities (e.g., ×0.2) can produce decimal variances.
      for (const fg of auditData.finished_goods_with_bom || []) {
        for (const comp of fg.bom_items || []) {
          if (adjustedComponents.has(comp.product_id)) continue; // Already handled via another parent
          adjustedComponents.add(comp.product_id);
          const rounded = Math.round(comp.variance);
          if (rounded !== 0) {
            const { data: prod } = await supabase.from("products").select("quickbooks_id").eq("id", comp.product_id).single();
            if (prod) {
              adjLines.push({
                DetailType: "ItemAdjustmentLineDetail",
                ItemAdjustmentLineDetail: {
                  ItemRef: { value: prod.quickbooks_id },
                  QtyDiff: rounded,
                },
              });
            }
          }
        }
      }

      // Standalone FG variances
      for (const item of auditData.standalone_finished_goods || []) {
        const rounded = Math.round(item.variance);
        if (rounded !== 0) {
          const { data: prod } = await supabase.from("products").select("quickbooks_id").eq("id", item.product_id).single();
          if (prod) {
            adjLines.push({
              DetailType: "ItemAdjustmentLineDetail",
              ItemAdjustmentLineDetail: {
                ItemRef: { value: prod.quickbooks_id },
                QtyDiff: rounded,
              },
            });
          }
        }
      }

      if (adjLines.length === 0) {
        steps.push({ step: 2, name: "Inventory Adjustment", status: "skipped", message: "No variances to adjust" });
      } else {
        const adjBody = {
          TxnDate: txnDate,
          AdjustAccountRef: { value: shrinkageAcctId },
          Line: adjLines,
        };

        const adjRes = await fetch(
          `https://quickbooks.api.intuit.com/v3/company/${realmId}/inventoryadjustment?minorversion=65`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(adjBody),
          }
        );

        if (!adjRes.ok) {
          const errText = await adjRes.text();
          throw new Error("QB Inventory Adjustment failed: " + errText.substring(0, 300));
        }

        const adjResult = await adjRes.json();
        await supabase.from("month_end_closings").update({ inventory_adjustment_id: adjResult.InventoryAdjustment?.Id }).eq("id", closingId);
        steps.push({ step: 2, name: "Inventory Adjustment", status: "success", message: `Adjusted ${adjLines.length} items, QB ID: ${adjResult.InventoryAdjustment?.Id}`, details: { adj_id: adjResult.InventoryAdjustment?.Id } });
      }
    } catch (err) {
      steps.push({ step: 2, name: "Inventory Adjustment", status: "error", message: err instanceof Error ? err.message : String(err) });
      throw err;
    }

    // ============ STEP 3: Amazon Sales Receipt ============
    
    try {
      const receiptRes = await fetch(`${request.nextUrl.origin}/api/qb/sales-receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...forwardAuth },
        body: JSON.stringify({ channel: "amazon", month, debug }),
      });
      const receiptData = await receiptRes.json();

      if (receiptRes.ok && receiptData.success) {
        await supabase.from("month_end_closings").update({
          amazon_receipt_id: receiptData.receipt_id,
          amazon_receipt_doc: receiptData.doc_number,
        }).eq("id", closingId);
        steps.push({ step: 3, name: "Amazon Sales Receipt", status: "success", message: `Receipt #${receiptData.doc_number} — ${receiptData.total_units} units` });
      } else if (receiptData.error?.includes("No sales data")) {
        steps.push({ step: 3, name: "Amazon Sales Receipt", status: "skipped", message: "No Amazon sales data for this month" });
      } else {
        throw new Error(receiptData.error || "Failed to create Amazon receipt");
      }
    } catch (err) {
      steps.push({ step: 3, name: "Amazon Sales Receipt", status: "error", message: err instanceof Error ? err.message : String(err) });
      // Don't throw — continue to Shopify
    }

    // ============ STEP 4: Shopify Sales Receipt ============
    try {
      const receiptRes = await fetch(`${request.nextUrl.origin}/api/qb/sales-receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...forwardAuth },
        body: JSON.stringify({ channel: "shopify", month, debug }),
      });
      const receiptData = await receiptRes.json();

      if (receiptRes.ok && receiptData.success) {
        await supabase.from("month_end_closings").update({
          shopify_receipt_id: receiptData.receipt_id,
          shopify_receipt_doc: receiptData.doc_number,
        }).eq("id", closingId);
        steps.push({ step: 4, name: "Shopify Sales Receipt", status: "success", message: `Receipt #${receiptData.doc_number} — ${receiptData.total_units} units` });
      } else if (receiptData.error?.includes("No sales data")) {
        steps.push({ step: 4, name: "Shopify Sales Receipt", status: "skipped", message: "No Shopify sales data for this month" });
      } else {
        throw new Error(receiptData.error || "Failed to create Shopify receipt");
      }
    } catch (err) {
      steps.push({ step: 4, name: "Shopify Sales Receipt", status: "error", message: err instanceof Error ? err.message : String(err) });
    }

    // ============ STEP 5: Re-snapshot QB Inventory (Post-Closing) ============
    // Build a map of post-closing QB quantities for variance check
    const postQbByProduct = new Map<string, number>();
    try {
      // Need fresh token since sales receipts used the previous one
      const { token: freshToken, realmId: freshRealmId } = await getQBToken();
      const qbItemsData = await qbQuery(freshToken, freshRealmId, "SELECT * FROM Item WHERE Type = 'Inventory' MAXRESULTS 1000");
      const qbItems = qbItemsData.QueryResponse?.Item || [];

      for (const item of qbItems) {
        const { data: product } = await supabase.from("products").select("id").eq("quickbooks_id", item.Id).single();
        if (product && item.QtyOnHand !== undefined) {
          postQbByProduct.set(product.id, Math.floor(item.QtyOnHand));
          await supabase.from("inventory_snapshots").insert({
            product_id: product.id,
            source: "quickbooks",
            quantity: Math.floor(item.QtyOnHand),
            raw_payload: { snapshot_type: "month_end_post", month },
          });
        }
      }

      await supabase.from("month_end_closings").update({ post_snapshot_at: new Date().toISOString() }).eq("id", closingId);
      steps.push({ step: 5, name: "QB Inventory Snapshot (Post-Closing)", status: "success", message: `Snapshotted ${qbItems.length} items` });
    } catch (err) {
      steps.push({ step: 5, name: "QB Inventory Snapshot (Post-Closing)", status: "error", message: err instanceof Error ? err.message : String(err) });
    }

    // ============ STEP 6: Variance Check ============
    // Compare post-closing QB inventory directly against channel inventory (FBA + 3PL + Manual).
    // Do NOT re-run the full inventory-audit formula (QB Start - Sales = Expected) because
    // after closing, QB already reflects the adjustment + sales receipts — that would double-count.
    // Use the month-scoped audit so we compare against the same FBA/3PL snapshots (dated period
    // end) that drove the adjustment in Step 2 — otherwise the variance check false-alarms by
    // the amount of channel inventory consumed since period end.
    try {
      const auditRes = await fetch(`${request.nextUrl.origin}/api/inventory-audit?month=${month}`, {
        headers: forwardAuth,
        cache: "no-store",
      });
      const auditData = await auditRes.json();

      let totalVariance = 0;
      const variances: Array<{ name: string; variance: number }> = [];

      // For FG with BOM: compare post-closing QB (component level) vs actual channel inventory
      // Deduplicate by product_id since multi-parent components appear under multiple FGs
      const checkedComponents = new Set<string>();
      for (const fg of auditData.finished_goods_with_bom || []) {
        for (const comp of fg.bom_items || []) {
          if (checkedComponents.has(comp.product_id)) continue;
          checkedComponents.add(comp.product_id);
          const qbQty = postQbByProduct.get(comp.product_id);
          if (qbQty === undefined) continue;
          const actual = comp.actual_total;
          const diff = Math.round((actual - qbQty) * 100) / 100; // avoid floating point noise
          if (diff !== 0) {
            variances.push({ name: comp.name, variance: diff });
            totalVariance += Math.abs(diff);
          }
        }
      }

      // For standalone FG: compare post-closing QB vs actual channel inventory
      for (const item of auditData.standalone_finished_goods || []) {
        const qbQty = postQbByProduct.get(item.product_id);
        if (qbQty === undefined) continue;
        const actual = item.total;
        const diff = Math.round((actual - qbQty) * 100) / 100;
        if (diff !== 0) {
          variances.push({ name: item.name, variance: diff });
          totalVariance += Math.abs(diff);
        }
      }

      const passed = totalVariance === 0;
      await supabase.from("month_end_closings").update({
        variance_check_passed: passed,
        variance_details: variances.length > 0 ? variances : null,
      }).eq("id", closingId);

      steps.push({
        step: 6,
        name: "Variance Check",
        status: passed ? "success" : "error",
        message: passed
          ? "All variances are zero — QB matches channel inventory!"
          : `${variances.length} items still have variance (total: ${totalVariance})`,
        details: variances.length > 0 ? variances : undefined,
      });
    } catch (err) {
      steps.push({ step: 6, name: "Variance Check", status: "error", message: err instanceof Error ? err.message : String(err) });
    }

    // ============ STEP 7: Shopify Journal Entry ============
    try {
      // Sync processor data first
      await fetch(`${request.nextUrl.origin}/api/qb/sync-processors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });

      const jeRes = await fetch(`${request.nextUrl.origin}/api/qb/journal-entry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, debug }),
      });
      const jeData = await jeRes.json();

      if (jeRes.ok && jeData.success) {
        await supabase.from("month_end_closings").update({
          shopify_journal_entry_id: jeData.journal_entry_id,
          shopify_journal_entry_doc: jeData.doc_number,
        }).eq("id", closingId);
        steps.push({
          step: 7,
          name: "Shopify Journal Entry",
          status: "success",
          message: `JE #${jeData.doc_number} — ${jeData.line_count} lines, ${jeData.updated ? "updated" : "created"}`,
        });
      } else {
        throw new Error(jeData.error || "Failed to create journal entry");
      }
    } catch (err) {
      steps.push({ step: 7, name: "Shopify Journal Entry", status: "error", message: err instanceof Error ? err.message : String(err) });
    }

    // Mark complete
    const allSuccess = steps.every((s) => s.status === "success" || s.status === "skipped");
    await supabase.from("month_end_closings").update({
      status: allSuccess ? "completed" : "completed_with_errors",
      completed_at: new Date().toISOString(),
    }).eq("id", closingId);

    // Send push notification
    try {
      const monthName = new Date(year, mon - 1).toLocaleString("en-US", { month: "long", year: "numeric" });
      const statusMsg = allSuccess ? "completed successfully" : "completed with some issues";
      await fetch(`${request.nextUrl.origin}/api/push/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.PUSH_SECRET}` },
        body: JSON.stringify({
          title: "Month-End Closing " + (allSuccess ? "Complete" : "Done"),
          body: `${monthName} closing ${statusMsg}. ${steps.filter(s => s.status === "success").length}/${steps.length} steps passed.`,
          type: "month_end",
        }),
      });
    } catch {
      // Don't fail the close if notification fails
    }

    return NextResponse.json({ steps, closing_id: closingId });
  } catch (err) {
    await supabase.from("month_end_closings").update({
      status: "error",
      error_message: err instanceof Error ? err.message : String(err),
      completed_at: new Date().toISOString(),
    }).eq("id", closingId);

    return NextResponse.json({ steps, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
