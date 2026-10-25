USE personal_cloud;

SET @add_is_pinned = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'cloud_folders' AND column_name = 'is_pinned') = 0,
  'ALTER TABLE cloud_folders ADD COLUMN is_pinned TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1'
);
PREPARE add_is_pinned_stmt FROM @add_is_pinned;
EXECUTE add_is_pinned_stmt;
DEALLOCATE PREPARE add_is_pinned_stmt;

SET @add_pin_order = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'cloud_folders' AND column_name = 'pin_order') = 0,
  'ALTER TABLE cloud_folders ADD COLUMN pin_order INT UNSIGNED NOT NULL DEFAULT 0',
  'SELECT 1'
);
PREPARE add_pin_order_stmt FROM @add_pin_order;
EXECUTE add_pin_order_stmt;
DEALLOCATE PREPARE add_pin_order_stmt;

SET @add_pin_index = IF(
  (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'cloud_folders' AND index_name = 'cloud_folders_pinned_idx') = 0,
  'ALTER TABLE cloud_folders ADD INDEX cloud_folders_pinned_idx (owner_id, is_pinned, pin_order)',
  'SELECT 1'
);
PREPARE add_pin_index_stmt FROM @add_pin_index;
EXECUTE add_pin_index_stmt;
DEALLOCATE PREPARE add_pin_index_stmt;
