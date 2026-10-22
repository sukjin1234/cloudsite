REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'cloudsite'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON personal_cloud.* TO 'cloudsite'@'%';
