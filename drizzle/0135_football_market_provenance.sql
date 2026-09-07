ALTER TABLE `games` ADD `football_schedule_id` varchar(100);
--> statement-breakpoint
ALTER TABLE `games` ADD `football_an_event_id` varchar(32);
--> statement-breakpoint
ALTER TABLE `games` ADD `football_vsin_game_id` varchar(40);
--> statement-breakpoint
ALTER TABLE `games` ADD `football_binding` json;
--> statement-breakpoint
ALTER TABLE `games` ADD `football_market_state` json;
--> statement-breakpoint
CREATE UNIQUE INDEX `games_football_schedule_unique` ON `games` (`football_schedule_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `games_football_an_unique` ON `games` (`sport`,`football_an_event_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `games_football_vsin_unique` ON `games` (`football_vsin_game_id`);
--> statement-breakpoint
ALTER TABLE `odds_history` ADD `provider` varchar(16);
--> statement-breakpoint
ALTER TABLE `odds_history` ADD `replay_key` varchar(64);
--> statement-breakpoint
ALTER TABLE `odds_history` ADD `provider_observation` json;
--> statement-breakpoint
CREATE UNIQUE INDEX `odds_history_replay_unique` ON `odds_history` (`replay_key`);
--> statement-breakpoint
CREATE INDEX `odds_history_game_cursor` ON `odds_history` (`gameId`,`scrapedAt`,`id`);
