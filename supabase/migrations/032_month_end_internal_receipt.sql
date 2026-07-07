-- Track the internal (shopcx) sales receipt on the month-end closing record, symmetric with
-- the existing amazon_receipt_* / shopify_receipt_* columns. Lets the closing store the QB
-- receipt id + doc number for the internal channel (and void it on a re-close).
alter table public.month_end_closings
  add column if not exists internal_receipt_id text,
  add column if not exists internal_receipt_doc text;
