-- Comprehensive test script for Optimystic plugin
-- Tests: CREATE TABLE, multiple INSERTs, SELECT with WHERE clause

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  age INTEGER
) USING optimystic('tree://test/users', transactor='local');

-- Insert multiple users
INSERT INTO users (id, name, email, age) VALUES ('1', 'Alice', 'alice@example.com', 30);
INSERT INTO users (id, name, email, age) VALUES ('2', 'Bob', 'bob@example.com', 25);
INSERT INTO users (id, name, email, age) VALUES ('3', 'Charlie', 'charlie@example.com', 35);
INSERT INTO users (id, name, email, age) VALUES ('4', 'Diana', 'diana@example.com', 28);

-- Query all users
SELECT * FROM users;

-- Query with WHERE clause
SELECT * FROM users WHERE age > 28;

-- Query specific user
SELECT name, email FROM users WHERE id = '2';

