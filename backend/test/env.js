// Imported first by tests that load src/config.js: gives it safe values so tests never depend on a real .env file.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret-test';
process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
process.env.UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret-for-unit-tests';
process.env.REQUIRE_TERMS_ACCEPTANCE = 'false'; // existing tests create accounts without ticking the box; terms tests switch it on
process.env.WA_WARMUP_DAYS ??= '0'; // the new-number daily limit has its own tests; the others use fresh accounts and send freely
process.env.REQUIRE_EMAIL_VERIFICATION = 'false'; // your real .env may switch it on; the tests that need it set config.requireEmailVerification themselves
process.env.DEFAULT_PLAN_KEY = ''; // new test accounts use the platform defaults; the plan tests set it themselves
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';
