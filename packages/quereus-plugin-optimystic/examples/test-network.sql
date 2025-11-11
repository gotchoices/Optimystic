-- Test script to verify Optimystic plugin with NetworkTransactor
-- This uses a single-node libp2p network with full distributed capabilities

-- Create an Optimystic table with network transactor
-- Note: Optimystic trees use string keys, so PRIMARY KEY must be TEXT
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT
) USING optimystic('tree://test/users', transactor='network', keyNetwork='libp2p');

-- Insert some data
INSERT INTO users (id, name, email) VALUES ('1', 'Alice', 'alice@example.com');

-- Query the data
SELECT * FROM users;

-- Query with WHERE clause
SELECT * FROM users WHERE id = '1';

