import { createServiceClient } from "@/lib/supabase/server";
import { getCredentials } from "@/lib/credentials";
import sharp from "sharp";

const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QB_TOKENS_TABLE = "qb_tokens";

let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getStoredTokens(): Promise<{
  refresh_token: string | null;
  realm_id: string | null;
}> {
  try {
    const supabase = createServiceClient();
    const { data } = await supabase
      .from(QB_TOKENS_TABLE)
      .select("refresh_token, realm_id")
      .eq("id", "current")
      .single();
    return {
      refresh_token: data?.refresh_token || null,
      realm_id: data?.realm_id || null,
    };
  } catch {
    return { refresh_token: null, realm_id: null };
  }
}

async function storeRefreshToken(refreshToken: string): Promise<void> {
  const supabase = createServiceClient();

  // Always use upsert to handle both insert and update cases
  // Explicitly preserve realm_id by reading it first
  const { data: existing } = await supabase
    .from(QB_TOKENS_TABLE)
    .select("realm_id")
    .eq("id", "current")
    .single();

  const { error } = await supabase
    .from(QB_TOKENS_TABLE)
    .upsert({
      id: "current",
      refresh_token: refreshToken,
      realm_id: existing?.realm_id || null,
      updated_at: new Date().toISOString(),
    });

  if (error) {
    console.error("CRITICAL: Failed to store QB refresh token:", error.message);
    throw new Error(`Failed to store QB refresh token: ${error.message}`);
  }
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires_at - 60_000) {
    return cachedToken.access_token;
  }

  const stored = await getStoredTokens();
  const refreshToken = stored.refresh_token;

  if (!refreshToken) {
    throw new Error(
      "No QB refresh token available. Connect QuickBooks at /api/qb/connect"
    );
  }

  const creds = await getCredentials("quickbooks");
  const basicAuth = Buffer.from(
    `${creds.client_id}:${creds.client_secret}`
  ).toString("base64");

  const res = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `QB token refresh failed (${res.status}): ${text}. Re-authorize at /api/qb/connect`
    );
  }

  const data = await res.json();
  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };

  // QB issues a new refresh token on every refresh — store it
  if (data.refresh_token) {
    await storeRefreshToken(data.refresh_token);
  }

  return data.access_token;
}

async function baseUrl(): Promise<string> {
  const creds = await getCredentials("quickbooks");
  return creds.environment === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

/**
 * Sum inventory quantity RECEIVED via purchases (Bill / ItemReceipt / Purchase) with
 * TxnDate in [startDate, endDate], keyed by QB item id. Feeds the inventory audit's
 * receipts term so a mid-month PO (e.g. a carton purchase) raises "expected" instead of
 * reading as a positive variance and triggering a phantom adjustment. Fails soft: an
 * unsupported/empty entity is skipped, so a QB hiccup degrades to received = 0.
 */
export async function fetchInventoryReceiptsByItem(
  startDate: string,
  endDate: string
): Promise<Map<string, number>> {
  const { token, realmId } = await getRealmAndToken();
  const base = await baseUrl();
  const received = new Map<string, number>();

  for (const entity of ["Bill", "ItemReceipt", "Purchase"]) {
    const query = `SELECT * FROM ${entity} WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000`;
    let res: Response;
    try {
      res = await fetch(
        `${base}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
      );
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const data = await res.json();
    const rows = data.QueryResponse?.[entity] || [];
    for (const txn of rows) {
      for (const line of txn.Line || []) {
        const d = line.ItemBasedExpenseLineDetail;
        if (!d?.ItemRef?.value || d.Qty === undefined) continue;
        const qty = Number(d.Qty) || 0;
        if (qty === 0) continue;
        received.set(d.ItemRef.value, (received.get(d.ItemRef.value) || 0) + qty);
      }
    }
  }
  return received;
}

export async function updateItem(
  itemId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updates: Record<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { token, realmId } = await getRealmAndToken();

  // QB requires full item for update, so fetch first
  const current = await fetchItemById(token, realmId, itemId);

  const merged = { ...current, ...updates };

  const res = await fetch(
    `${await baseUrl()}/v3/company/${realmId}/item?minorversion=65`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(merged),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QB item update failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.Item;
}

export async function fetchItemImages(
  itemIds: string[]
): Promise<Map<string, string>> {
  const { token, realmId } = await getRealmAndToken();
  const supabase = createServiceClient();
  const imageMap = new Map<string, string>();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;

  // Query attachables for all items in batches
  for (let i = 0; i < itemIds.length; i += 50) {
    const batch = itemIds.slice(i, i + 50);
    const inList = batch.map((id) => `'${id}'`).join(",");
    const query = encodeURIComponent(
      `SELECT * FROM Attachable WHERE AttachableRef.EntityRef.Type = 'Item' AND AttachableRef.EntityRef.value IN (${inList}) MAXRESULTS 1000`
    );

    const res = await fetch(
      `${await baseUrl()}/v3/company/${realmId}/query?query=${query}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      }
    );

    if (!res.ok) continue;

    const data = await res.json();
    for (const att of data.QueryResponse?.Attachable || []) {
      if (!att.TempDownloadUri) continue;
      // Find which item this attachment belongs to
      for (const ref of att.AttachableRef || []) {
        if (ref.EntityRef?.type === "Item" && ref.EntityRef?.value) {
          if (imageMap.has(ref.EntityRef.value)) continue;

          try {
            // Download image from QB temp URL
            const imgRes = await fetch(att.TempDownloadUri);
            if (!imgRes.ok) continue;

            const imgBuffer = await imgRes.arrayBuffer();

            // Resize to 400x400 max and convert to webp
            const resized = await sharp(Buffer.from(imgBuffer))
              .resize(400, 400, { fit: "inside", withoutEnlargement: true })
              .webp({ quality: 80 })
              .toBuffer();

            const fileName = `qb-${ref.EntityRef.value}.webp`;

            // Upload to Supabase Storage (overwrite if exists)
            await supabase.storage
              .from("product-images")
              .upload(fileName, resized, {
                contentType: "image/webp",
                upsert: true,
              });

            // Build permanent public URL
            const publicUrl = `${supabaseUrl}/storage/v1/object/public/product-images/${fileName}`;
            imageMap.set(ref.EntityRef.value, publicUrl);
          } catch {
            // Skip if download/upload fails
          }
        }
      }
    }
  }

  return imageMap;
}

export interface QBGroupLine {
  ItemRef: { value: string; name: string; type: string };
  Qty: number;
}

export interface QBItem {
  Id: string;
  Name: string;
  Sku?: string;
  Type: string;
  QtyOnHand?: number;
  UnitPrice?: number;
  PurchaseCost?: number;
  SyncToken?: string;
  Active: boolean;
  ItemGroupDetail?: {
    ItemGroupLine: QBGroupLine[];
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

async function getRealmAndToken(): Promise<{ token: string; realmId: string }> {
  const token = await getAccessToken();
  const stored = await getStoredTokens();
  const realmId = stored.realm_id || process.env.QB_REALM_ID;
  if (!realmId) {
    throw new Error("No QB Realm ID. Connect QuickBooks at /api/qb/connect");
  }
  return { token, realmId };
}

async function queryItems(
  token: string,
  realmId: string,
  typeFilter: string
): Promise<QBItem[]> {
  const items: QBItem[] = [];
  let startPosition = 1;
  const maxResults = 1000;

  while (true) {
    const query = encodeURIComponent(
      `SELECT * FROM Item WHERE Type = '${typeFilter}' STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`
    );

    const res = await fetch(
      `${await baseUrl()}/v3/company/${realmId}/query?query=${query}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`QB query failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    const batch: QBItem[] = data.QueryResponse?.Item || [];
    items.push(...batch);

    if (batch.length < maxResults) break;
    startPosition += maxResults;
  }

  return items;
}

export async function fetchItemById(
  token: string,
  realmId: string,
  itemId: string
): Promise<QBItem> {
  const res = await fetch(
    `${await baseUrl()}/v3/company/${realmId}/item/${itemId}?minorversion=65`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QB item fetch failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.Item;
}

export async function fetchInventoryItems(): Promise<QBItem[]> {
  const { token, realmId } = await getRealmAndToken();
  return queryItems(token, realmId, "Inventory");
}

export async function fetchGroupItems(): Promise<QBItem[]> {
  const { token, realmId } = await getRealmAndToken();
  const groups = await queryItems(token, realmId, "Group");

  // Fetch full details for each group to get ItemGroupDetail
  const detailed: QBItem[] = [];
  for (const group of groups) {
    const full = await fetchItemById(token, realmId, group.Id);
    detailed.push(full);
  }

  return detailed;
}

export async function fetchAllItems(): Promise<{
  inventory: QBItem[];
  groups: QBItem[];
}> {
  const { token, realmId } = await getRealmAndToken();
  const [inventory, groupSparse] = await Promise.all([
    queryItems(token, realmId, "Inventory"),
    queryItems(token, realmId, "Group"),
  ]);

  // Fetch full details for groups to get component items
  const groups: QBItem[] = [];
  for (const group of groupSparse) {
    const full = await fetchItemById(token, realmId, group.Id);
    groups.push(full);
  }

  return { inventory, groups };
}
