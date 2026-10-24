// Imported first by tests that load src/config.js: gives it safe values so tests never depend on a real .env file.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret-test';
process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
process.env.UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret-for-unit-tests';
process.env.REQUIRE_TERMS_ACCEPTANCE = 'false'; // existing tests create accounts without ticking the box; terms tests switch it on
