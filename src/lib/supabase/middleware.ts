import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Public routes
  if (
    pathname === "/login" ||
    pathname === "/restricted" ||
    pathname === "/manifest.json" ||
    pathname === "/sw.js" ||
    pathname === "/auth/callback" ||
    pathname.startsWith("/legal/") ||
    pathname.startsWith("/api/cron/") ||
    pathname === "/api/push/send" ||
    pathname.startsWith("/api/amazon/") ||
    pathname.startsWith("/api/qb/sync-processors") ||
    pathname.startsWith("/api/qb/journal-entry") ||
    // Allow month-end-closing + sales-receipt when called with a valid CRON_SECRET
    // bearer token. UI calls (no header) still fall through to the admin-only path.
    // sales-receipt needs the bypass too because month-end-closing makes internal
    // HTTP calls to it and needs to forward its own auth.
    ((pathname.startsWith("/api/qb/month-end-closing") || pathname.startsWith("/api/qb/sales-receipt"))
      && request.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`) ||
    pathname.startsWith("/api/overview/") ||
    pathname === "/api/inventory-audit" ||
    pathname === "/api/sales-data" ||
    pathname.startsWith("/invite/") ||
    pathname === "/api/team/accept"
  ) {
    return supabaseResponse;
  }

  // Unauthenticated → login
  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Check access: ADMIN_EMAILS or accepted team member
  const userEmail = user.email?.toLowerCase() || "";
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const isAdmin = adminEmails.includes(userEmail);

  if (!isAdmin) {
    // Check team_members table via direct REST (service role to bypass RLS)
    const teamRes = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/team_members?email=eq.${encodeURIComponent(userEmail)}&status=eq.accepted&select=role`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
        },
        cache: "no-store",
      }
    );
    const teamRows = await teamRes.json();
    const teamMember = Array.isArray(teamRows) ? teamRows[0] : null;

    if (!teamMember) {
      // API routes get JSON 403, pages get redirect
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      const url = request.nextUrl.clone();
      url.pathname = "/restricted";
      return NextResponse.redirect(url);
    }

    // Role-based route restrictions
    const role = teamMember.role as string;
    if (role === "view_only") {
      // Block write operations
      if (request.method !== "GET" && !pathname.startsWith("/api/push/")) {
        return NextResponse.json({ error: "View-only access" }, { status: 403 });
      }
    }
    if (role === "logistics") {
      // Block admin-only actions (not viewing connections/mappings)
      const adminOnlyRoutes = [
        "/api/qb/month-end-closing",
        "/api/qb/journal-entry",
        "/dashboard/month-end",
        "/api/team",
        "/api/qb/connect",
        "/api/qb/disconnect",
        "/api/shopify/connect",
        "/api/connections/credentials",
      ];
      if (adminOnlyRoutes.some((r) => pathname.startsWith(r))) {
        if (pathname.startsWith("/api/")) {
          return NextResponse.json({ error: "Admin access required" }, { status: 403 });
        }
        const url = request.nextUrl.clone();
        url.pathname = "/restricted";
        return NextResponse.redirect(url);
      }
    }
  }

  return supabaseResponse;
}
