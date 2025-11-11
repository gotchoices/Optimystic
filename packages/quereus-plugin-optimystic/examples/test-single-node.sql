-- Test script for single-node network setup
-- This uses NetworkTransactor with libp2p

-- Create an Optimystic table with network transactor
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT
) USING optimystic('tree://test/users');

-- Insert some data
INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com');
INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@example.com');

-- Query the data
SELECT * FROM users;

-- Query with WHERE clause
SELECT * FROM users WHERE id = 1;

