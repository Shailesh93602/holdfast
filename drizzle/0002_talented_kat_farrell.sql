CREATE TABLE "inventory_shards" (
	"sku" text NOT NULL,
	"shard" integer NOT NULL,
	"available" integer NOT NULL,
	CONSTRAINT "inventory_shards_sku_shard_pk" PRIMARY KEY("sku","shard"),
	CONSTRAINT "inventory_shards_available_nonneg" CHECK ("inventory_shards"."available" >= 0)
);
--> statement-breakpoint
ALTER TABLE "inventory_shards" ADD CONSTRAINT "inventory_shards_sku_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."products"("sku") ON DELETE no action ON UPDATE no action;