import { NextRequest, NextResponse } from "next/server";
import { syncShopifySalesSnapshot } from "@/lib/sync-engine";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Backfill mode: pass ?start=YYYY-MM-DD&end=YYYY-MM-DD to wipe and re-sync a range.
  // Default (no params) = cron mode = pull yesterday only, skip if already present.
  const start = request.nextUrl.searchParams.get("start") || undefined;
  const end = request.nextUrl.searchParams.get("end") || undefined;

  try {
    const result = await syncShopifySalesSnapshot(start, end);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    console.error("Shopify sales cron failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
