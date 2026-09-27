/**
 * The integration fixture: a schema that follows templates/nextjs-postgres (text UUID
 * keys without DB default, `created_at`/`updated_at`, BetterAuth tables, `internal` and
 * `drizzle` schemas, enums, `*_file`/`*_image` jsonb, a bridge) plus the awkward cases
 * the CMS must handle (a table without a primary key, a self reference, an empty table,
 * a name with `%`, `_` and `\`, empty strings).
 */

const stamps = `created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()`;

export const SCHEMA_SQL = `
CREATE TYPE user_role AS ENUM ('user', 'admin');
CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');

CREATE TABLE "user" (
  id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false, image text,
  role user_role NOT NULL DEFAULT 'user', ${stamps});
CREATE TABLE session (
  id text PRIMARY KEY, expires_at timestamptz NOT NULL, token text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, ${stamps});
CREATE TABLE account (
  id text PRIMARY KEY, account_id text NOT NULL, provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, password text, ${stamps});
CREATE TABLE verification (
  id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL, ${stamps});

CREATE SCHEMA internal;
CREATE TABLE internal.rate_limit (id text PRIMARY KEY, key text NOT NULL UNIQUE, count integer NOT NULL DEFAULT 0, ${stamps});
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);

CREATE TABLE customer (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text,
  phone varchar(40),
  notes text,
  bio text CHECK (char_length(bio) <= 280),
  vip boolean NOT NULL DEFAULT false,
  credit_limit numeric(10,2),
  visits integer NOT NULL DEFAULT 0,
  birth_date date,
  last_seen_at timestamptz,
  avatar_image jsonb,
  documents_file jsonb NOT NULL DEFAULT '[]'::jsonb,
  preferences jsonb,
  tags text[],
  owner_id text REFERENCES "user"(id) ON DELETE SET NULL,
  metadata jsonb,
  ${stamps});
COMMENT ON TABLE customer IS 'People who buy';
COMMENT ON COLUMN customer.notes IS 'Internal notes';

CREATE TABLE product (
  id text PRIMARY KEY, name text NOT NULL, sku varchar(32) UNIQUE, price numeric(10,2) NOT NULL,
  stock integer NOT NULL DEFAULT 0,
  photos_image jsonb CHECK (photos_image IS NULL OR jsonb_typeof(photos_image) = 'array'),
  manual_file jsonb,
  ${stamps});

CREATE TABLE "order" (
  id text PRIMARY KEY, number integer NOT NULL, status order_status NOT NULL DEFAULT 'pending',
  history order_status[], total numeric(10,2),
  customer_id text REFERENCES customer(id) ON DELETE CASCADE,
  placed_at timestamptz, receipt_file jsonb, note text,
  ${stamps});

CREATE TABLE order_product (
  order_id text NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, product_id));

CREATE TABLE category (id text PRIMARY KEY, name text NOT NULL, parent_id text REFERENCES category(id), ${stamps});
CREATE TABLE event_log (at timestamptz NOT NULL DEFAULT now(), message text);
CREATE TABLE empty_thing (id text PRIMARY KEY, label text, ${stamps});
`;

export const SEED_SQL = `
INSERT INTO "user" (id, name, email, role) VALUES ('usr_1', 'Ada Admin', 'ada@example.com', 'admin');
INSERT INTO session (id, expires_at, token, user_id) VALUES ('ses_1', now() + interval '1 day', 'tok', 'usr_1');

INSERT INTO customer (id, name, email, phone, vip, credit_limit, visits, birth_date, last_seen_at,
  avatar_image, owner_id, tags, created_at, updated_at)
SELECT 'cus_' || lpad(i::text, 3, '0'),
       'Customer ' || lpad(i::text, 3, '0'),
       CASE WHEN i % 3 = 0 THEN NULL ELSE 'c' || i || '@example.com' END,
       '+34 600 000 ' || lpad(i::text, 3, '0'),
       i % 10 = 0,
       CASE WHEN i % 7 = 0 THEN NULL ELSE i * 10.5 END,
       i % 5,
       DATE '1990-01-01' + i,
       CASE WHEN i % 2 = 0 THEN TIMESTAMPTZ '2026-06-01T12:00:00Z' + (i || ' hours')::interval END,
       CASE WHEN i % 4 = 0 THEN jsonb_build_object('name', 'avatar-' || i || '.png') END,
       CASE WHEN i % 2 = 0 THEN 'usr_1' END,
       CASE WHEN i % 6 = 0 THEN ARRAY['a', 'b'] END,
       TIMESTAMPTZ '2026-01-01T00:00:00Z' + (i || ' hours')::interval,
       TIMESTAMPTZ '2026-01-01T00:00:00Z' + (i || ' hours')::interval
FROM generate_series(1, 120) AS i;
INSERT INTO customer (id, name, email, notes, created_at) VALUES
  ('cus_x01', '50%_off \\ deal', 'deal@example.com', 'weird name', TIMESTAMPTZ '2025-12-01T00:00:00Z'),
  ('cus_x02', '5000 off deal', '', '', TIMESTAMPTZ '2025-12-02T00:00:00Z');

INSERT INTO product (id, name, sku, price, stock, photos_image, manual_file, created_at)
SELECT 'prd_' || lpad(i::text, 2, '0'), 'Product ' || i, 'SKU-' || i, i * 10, i,
       CASE WHEN i % 2 = 0 THEN jsonb_build_array(jsonb_build_object('name', 'p' || i || '.jpg')) END,
       CASE WHEN i = 1 THEN '[{"name": "manual.pdf"}]'::jsonb END,
       TIMESTAMPTZ '2026-02-01T00:00:00Z' + (i || ' hours')::interval
FROM generate_series(1, 10) AS i;

INSERT INTO "order" (id, number, status, history, total, customer_id, placed_at, created_at)
SELECT 'ord_' || lpad(i::text, 2, '0'), i,
       (ARRAY['pending', 'paid', 'shipped', 'cancelled'])[1 + i % 4]::order_status,
       CASE WHEN i % 4 = 2 THEN ARRAY['pending', 'paid', 'shipped']::order_status[] END,
       i * 3,
       CASE WHEN i = 60 THEN NULL ELSE 'cus_' || lpad((1 + i % 20)::text, 3, '0') END,
       TIMESTAMPTZ '2026-03-01T10:00:00Z' + (i || ' days')::interval,
       TIMESTAMPTZ '2026-03-01T00:00:00Z' + (i || ' hours')::interval
FROM generate_series(1, 60) AS i;

INSERT INTO order_product (order_id, product_id)
SELECT 'ord_' || lpad(i::text, 2, '0'), 'prd_' || lpad((1 + i % 10)::text, 2, '0') FROM generate_series(1, 60) AS i
UNION
SELECT 'ord_' || lpad(i::text, 2, '0'), 'prd_' || lpad((1 + (i + 3) % 10)::text, 2, '0') FROM generate_series(1, 60) AS i;

INSERT INTO category (id, name, parent_id) VALUES ('cat_1', 'Root', NULL), ('cat_2', 'Child', 'cat_1');
INSERT INTO event_log (message) VALUES ('hello');
`;
