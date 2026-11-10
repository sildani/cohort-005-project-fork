DROP INDEX `refunds_purchase_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_purchase_idx` ON `refunds` (`purchase_id`);