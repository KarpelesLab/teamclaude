import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  crashLogPath, envVar, proxySettingsFrom, readProxySettings, resolveConfigPath, serviceUnitPath,
} from '../src/services/backend-config';

const HOME = join('/', 'home', 'u');

describe('envVar', () => {
  it('prefers the TEAMROUTER_ prefix, even when empty', () => {
    expect(envVar('PORT', { TEAMCLAUDE_PORT: '1' })).toBe('1');
    expect(envVar('PORT', { TEAMROUTER_PORT: '2', TEAMCLAUDE_PORT: '1' })).toBe('2');
    expect(envVar('PORT', { TEAMROUTER_PORT: '', TEAMCLAUDE_PORT: '1' })).toBe('');
  });
});

describe('resolveConfigPath', () => {
  it('uses the env override first', () => {
    expect(resolveConfigPath({ TEAMCLAUDE_CONFIG: '/c.json' }, HOME, () => false)).toBe('/c.json');
  });

  it('prefers teamrouter.json when it exists, else teamclaude.json, under XDG_CONFIG_HOME', () => {
    const dir = join(HOME, '.config');
    expect(resolveConfigPath({}, HOME, () => false)).toBe(join(dir, 'teamclaude.json'));
    expect(resolveConfigPath({}, HOME, p => p.endsWith('teamrouter.json'))).toBe(join(dir, 'teamrouter.json'));
    expect(resolveConfigPath({ XDG_CONFIG_HOME: '/x' }, HOME, () => false)).toBe(join('/x', 'teamclaude.json'));
  });

  it('names the crash log and the systemd unit like the backend does', () => {
    expect(crashLogPath('/a/teamclaude.json')).toBe('/a/teamclaude-crash.log');
    expect(crashLogPath('/a/conf')).toBe('/a/conf-crash.log');
    expect(serviceUnitPath({}, HOME)).toBe(join(HOME, '.config', 'systemd', 'user', 'teamclaude.service'));
  });
});

describe('proxySettingsFrom', () => {
  it('defaults to loopback 3456', () => {
    expect(proxySettingsFrom({}, {})).toEqual({
      bindHost: '127.0.0.1', connectHost: '127.0.0.1', port: 3456, apiKey: null, trustLoopback: true, accountCount: 0,
    });
  });

  it('connects to loopback when the server binds a wildcard', () => {
    const s = proxySettingsFrom({ proxy: { host: '0.0.0.0', port: 9000, apiKey: 'k' }, accounts: [{}, {}] }, {});
    expect(s).toMatchObject({ bindHost: '0.0.0.0', connectHost: '127.0.0.1', port: 9000, apiKey: 'k', accountCount: 2 });
  });

  it('ignores an invalid port and honours the HOST env var', () => {
    expect(proxySettingsFrom({ proxy: { port: 70000 } }, { TEAMCLAUDE_HOST: '::1' })).toMatchObject({ port: 3456, bindHost: '::1' });
  });
});

describe('readProxySettings', () => {
  it('treats a missing file as defaults, not an error', () => {
    const r = readProxySettings('/none.json', {}, () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); });
    expect(r).toMatchObject({ exists: false, error: null });
  });

  it('reports unreadable and invalid files without quoting their content', () => {
    const denied = readProxySettings('/c.json', {}, () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); });
    expect(denied.error).toContain('EACCES');
    const bad = readProxySettings('/c.json', {}, () => '{"proxy": {"apiKey": "sk-secret"');
    expect(bad.error).toBe('the config file is not valid JSON');
    expect(bad.settings.apiKey).toBeNull();
  });
});
