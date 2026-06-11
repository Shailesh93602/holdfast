CREATE TABLE "inventory" (
	"sku" text PRIMARY KEY NOT NULL,
	"available" integer NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "inventory_available_nonneg" CHECK ("inventory"."available" >= 0),
	CONSTRAINT "inventory_reserved_nonneg" CHECK ("inventory"."reserved" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text,
	"sku" text NOT NULL,
	"qty" integer NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "orders_qty_pos" CHECK ("orders"."qty" > 0),
	CONSTRAINT "orders_status_chk" CHECK ("orders"."status" IN ('HELD','CONFIRMED','RELEASED','FULFILLED'))
);
--> statement-breakpoint
CREATE TABLE "products" (
	"sku" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_sku_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."products"("sku") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_sku_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."products"("sku") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_orders_status_expires" ON "orders" USING btree ("status","expires_at");