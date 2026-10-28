import { describe, expect, test } from 'bun:test';
import { threadStatus } from '../src/mapping.ts';

describe('threadStatus', () => {
  test('convertit les identifiants de l’API', () => {
    expect(threadStatus(1)).toBe('in_progress');
    expect(threadStatus(2)).toBe('completed');
    expect(threadStatus(3)).toBe('on_hold');
    expect(threadStatus(4)).toBe('abandoned');
  });

  test('un identifiant inconnu donne null, pour que l’appelant conserve son statut', () => {
    expect(threadStatus(5)).toBeNull();
    expect(threadStatus(0)).toBeNull();
  });
});
