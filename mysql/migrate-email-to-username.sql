USE personal_cloud;

ALTER TABLE cloud_users
  CHANGE COLUMN email username VARCHAR(320) NOT NULL,
  DROP INDEX cloud_users_email_uq,
  ADD UNIQUE KEY cloud_users_username_uq (username);
