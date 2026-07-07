-- Internal (shopcx) sales snapshots.
-- shopcx (sibling app) ships native "internal" orders — storefront checkouts, native
-- subscription renewals, and comps — that fulfill through Amplifier (3PL) but never touched
-- Shopify or Amazon. shoptics only pulled Shopify+Amazon sales, so these went uncounted:
-- revenue + COGS undercounted, and the 3PL fulfillment burn showed as phantom shrinkage in
-- month-end. This table is the daily snapshot of those orders, keyed line-level so it feeds
-- both the inventory audit (units/day/product) and the JE (revenue by account, tax, processor).
--
-- Order-level money fields (order_total/discount/tax/shipping) are populated ONLY on
-- line_index = 0 and left 0 on the other lines, so summing them over a month counts each
-- order exactly once. Per-line fields (units, gross_cents, product_id, sku) are per line.

create table if not exists public.internal_sales_snapshots (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,                 -- shopcx orders.id (uuid as text)
  order_number text,                      -- e.g. SHOPCX28 / SC129467
  line_index int not null default 0,
  sale_date date not null,                -- bucket = orders.created_at::date
  source_name text,                       -- storefront | internal_subscription_renewal | comp_order
  financial_status text,
  processor text,                         -- braintree (all internal today) | other
  sku text,
  variant_id text,
  product_id uuid,                        -- resolved shoptics product (null if unmapped)
  units integer not null default 0,       -- quantity * unit_multiplier
  gross_cents integer not null default 0, -- line gross (unit price * qty), pre-discount

  -- order-level, populated ONLY on line_index = 0 (0 on other lines):
  order_total_cents integer not null default 0,
  discount_cents integer not null default 0,
  tax_cents integer not null default 0,
  shipping_cents integer not null default 0,

  raw_payload jsonb,
  snapshot_taken_at timestamptz default now(),
  created_at timestamptz default now(),
  unique (order_id, line_index)
);

create index if not exists internal_sales_snapshots_sale_date_idx
  on public.internal_sales_snapshots (sale_date);
create index if not exists internal_sales_snapshots_product_id_idx
  on public.internal_sales_snapshots (product_id);

alter table public.internal_sales_snapshots enable row level security;
-- Service role bypasses RLS; no policies = server-only access, consistent with the other
-- *_sales_snapshots tables.
