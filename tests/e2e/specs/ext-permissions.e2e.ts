/**
 * Extensions – Permissions & Risk Level tests.
 *
 * Validates the current AionCore contract exposed by the extension bridge.
 */
import { test, expect } from '../fixtures';
import { invokeBridge } from '../helpers';

type PermissionDetail = {
  permission: string;
  description: string;
  level: 'full' | 'limited' | 'none';
};

type RiskLevel = 'safe' | 'moderate' | 'dangerous';

type PermissionsResponse = {
  permissions: Record<string, boolean | string>;
  risk_level: RiskLevel;
  details: PermissionDetail[];
};

type RiskLevelResponse = { riskLevel: RiskLevel };

test.describe('Extension: Permissions Query', () => {
  test('hello-world exposes its declared permission summary', async ({ page }) => {
    const result = (await invokeBridge(page, 'extensions.get-permissions', {
      name: 'hello-world',
    })) as PermissionsResponse;

    expect(result.permissions).toMatchObject({
      storage: true,
      network: false,
      shell: false,
      filesystem: 'extension-only',
      events: true,
    });
    expect(result.risk_level).toBe('moderate');
    expect(result.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ permission: 'storage', level: 'full' }),
        expect.objectContaining({ permission: 'filesystem', level: 'limited' }),
        expect.objectContaining({ permission: 'shell', level: 'none' }),
      ])
    );
  });

  test('e2e-full-extension has no implicit permissions and remains safe by default', async ({ page }) => {
    const result = (await invokeBridge(page, 'extensions.get-permissions', {
      name: 'e2e-full-extension',
    })) as PermissionsResponse;

    expect(result.permissions).toEqual({});
    expect(result.risk_level).toBe('safe');
    expect(result.details).toHaveLength(7);
    expect(result.details.every((detail) => detail.level === 'none')).toBe(true);
  });

  test('permissions query for nonexistent extension returns an explicit not-found error', async ({ page }) => {
    await expect(
      invokeBridge(page, 'extensions.get-permissions', { name: 'nonexistent-extension-xyz' })
    ).rejects.toThrow(/404.*Extension not found: nonexistent-extension-xyz/);
  });
});

test.describe('Extension: Risk Level Assessment', () => {
  test('hello-world risk level matches its current permissions', async ({ page }) => {
    const result = (await invokeBridge(page, 'extensions.get-risk-level', {
      name: 'hello-world',
    })) as RiskLevelResponse;

    expect(result.riskLevel).toBe('moderate');
  });

  test('e2e-full-extension risk level is safe by default', async ({ page }) => {
    const result = (await invokeBridge(page, 'extensions.get-risk-level', {
      name: 'e2e-full-extension',
    })) as RiskLevelResponse;

    expect(result.riskLevel).toBe('safe');
  });

  test('risk level query for nonexistent extension returns an explicit not-found error', async ({ page }) => {
    await expect(
      invokeBridge(page, 'extensions.get-risk-level', { name: 'nonexistent-extension-xyz' })
    ).rejects.toThrow(/404.*Extension not found: nonexistent-extension-xyz/);
  });
});
