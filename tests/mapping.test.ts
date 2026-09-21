import { describe, expect, test } from 'bun:test';
import { editionStatus } from '../src/mapping.ts';

describe('editionStatus', () => {
  test('convertit les identifiants de l’API', () => {
    expect(editionStatus(1)).toBe('in_progress');
    expect(editionStatus(2)).toBe('completed');
    expect(editionStatus(3)).toBe('on_hold');
    expect(editionStatus(4)).toBe('abandoned');
  });

  test('un identifiant inconnu donne null, pour conserver le statut en base', () => {
    expect(editionStatus(5)).toBeNull();
    expect(editionStatus(0)).toBeNull();
  });
});
