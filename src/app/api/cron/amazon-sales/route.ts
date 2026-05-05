import { NextRequest, NextResponse } from "next/server";
import { syncAmazonSalesSnapshot } from "@/lib/sync-engine";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Backfill mode: ?start=YYYY-MM-DD&end=YYYY-MM-DD wipes and re-syncs the range.
  // Default (no params) = cron mode = re-pull rolling [today-9, today-2] window.
  const start = request.nextUrl.searchParams.get("start") || undefined;
  const end = request.nextUrl.searchParams.get("end") || undefined;

  try {
    const result = await syncAmazonSalesSnapshot(start, end);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    console.error("Amazon sales cron failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
