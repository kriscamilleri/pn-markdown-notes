import { describe, expect, it } from 'vitest';
import { withImageAuthToken } from '../../src/utils/imageUrl.js';

describe('image URL authentication', () => {
  it('preserves a shared-space qualifier when adding the image query token', () => {
    expect(withImageAuthToken(
      '/images/11111111-1111-4111-8111-111111111111?space=22222222-2222-4222-8222-222222222222',
      'jwt-token',
      { origin: 'https://panino.test', absolute: false },
    )).toBe(
      '/images/11111111-1111-4111-8111-111111111111?space=22222222-2222-4222-8222-222222222222&token=jwt-token',
    );
  });

  it('keeps the legacy personal URL shape and supports absolute development URLs', () => {
    expect(withImageAuthToken('/images/image-a', 'jwt-token', {
      origin: 'http://localhost:8000',
      absolute: true,
    })).toBe('http://localhost:8000/images/image-a?token=jwt-token');
    expect(withImageAuthToken('/images/image-a', '', {
      origin: 'http://localhost:8000',
      absolute: true,
    })).toBe('/images/image-a');
  });
});
