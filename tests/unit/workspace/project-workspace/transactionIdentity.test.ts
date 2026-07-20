import { parseTransactionId } from '@/common/types/project-workspace/identity';

describe('project transaction identity', () => {
  it('accepts only canonical lowercase UUIDv4 operation identities', () => {
    expect(parseTransactionId('44444444-4444-4444-8444-444444444444')).toBe('44444444-4444-4444-8444-444444444444');
  });

  it.each([
    '11111111-1111-1111-8111-111111111111',
    '55555555-5555-5555-8555-555555555555',
    '77777777-7777-7777-8777-777777777777',
    'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
  ])('rejects non-v4 or non-canonical transaction identity %s', (candidate) => {
    expect(() => parseTransactionId(candidate)).toThrow('identity.invalid');
  });
});
