-- Test script with multiple INSERTs using NetworkTransactor
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT
) USING optimystic('tree://test/users', transactor='network', keyNetwork='libp2p');

INSERT INTO users (id, name, email) VALUES ('1', 'Alice', 'alice@example.com');
INSERT INTO users (id, name, email) VALUES ('2', 'Bob', 'bob@example.com');
SELECT * FROM users;

