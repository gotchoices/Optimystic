-- Test script to verify Optimystic plugin is loaded and working
-- Note: Currently limited to single INSERT due to test transactor limitations

-- Create an Optimystic table with test transactor
-- Note: Optimystic trees use string keys, so PRIMARY KEY must be TEXT
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT
) USING optimystic('tree://test/users', transactor='test', keyNetwork='test');

-- Insert some data
INSERT INTO users (id, name, email) VALUES ('1', 'Alice', 'alice@example.com');

-- Query the data
SELECT * FROM users;

-- Query with WHERE clause
SELECT * FROM users WHERE id = '1';

