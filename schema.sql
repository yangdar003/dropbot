CREATE TABLE IF NOT EXISTS discord_users (
  user_id BIGINT UNSIGNED PRIMARY KEY,
  username VARCHAR(120),
  global_name VARCHAR(120),
  avatar VARCHAR(64),
  email VARCHAR(255),
  locale VARCHAR(16),
  consented_at DATETIME NOT NULL,
  last_login_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS discord_tokens (
  user_id BIGINT UNSIGNED PRIMARY KEY,
  access_token VARCHAR(255) NOT NULL,
  refresh_token VARCHAR(255) NOT NULL,
  token_type VARCHAR(16) NOT NULL,
  scope VARCHAR(255) NOT NULL,
  expires_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  CONSTRAINT fk_tokens_user FOREIGN KEY (user_id) REFERENCES discord_users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS guild_join_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  guild_id BIGINT UNSIGNED NOT NULL,
  status ENUM('pending','joined','already','failed') NOT NULL,
  error_text TEXT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  INDEX (guild_id),
  INDEX (status)
);