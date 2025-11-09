#!/usr/bin/env node

/**
 * Generate a test JWT token for local development
 * Usage: node generate-token.js
 */

import jwt from 'jsonwebtoken';

const JWT_SECRET = 'local-dev-secret-change-in-production';

const token = jwt.sign(
  {
    sub: 'test-user-123',
    userId: 'test-user-123',
    email: 'test@example.com',
  },
  JWT_SECRET,
  { expiresIn: '24h' }
);

console.log(token);
